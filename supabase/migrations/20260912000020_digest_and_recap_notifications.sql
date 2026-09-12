-- Digest/recap pushes. These reuse the existing delivery path entirely:
-- inserting into notifications fires the notify_push() trigger, which
-- calls the push-notify Edge Function. So they also show up in the
-- in-app notification list for free.
--
-- They're attributed to the official account rather than a person,
-- because there's no single actor behind "12 people liked your posts" -
-- and notifications.actor_id is NOT NULL with an FK to profiles.
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like','comment','reply','commentlike','tag','storylike','follow','digest','recap'));

-- "You got 12 new likes and 3 comments since yesterday"
-- Only for people who are actually away: if someone has been in the app in
-- the last 12h they've already seen the activity, and a push telling them
-- about it is pure noise. That targeting is the whole difference between a
-- useful digest and spam.
create or replace function public.send_daily_digest()
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid; n int := 0;
begin
  select id into v_actor from public.profiles where username = 'linkup' limit 1;
  if v_actor is null then return 0; end if;

  with since as (select now() - interval '24 hours' as t),
  activity as (
    select p.author_id as uid, count(*) filter (where src='like') as likes,
           count(*) filter (where src='comment') as comments
    from (
      select l.post_id, 'like' as src, l.user_id as actor, l.created_at from public.likes l
      union all
      select c.post_id, 'comment', c.user_id, c.created_at from public.comments c
    ) e
    join public.posts p on p.id = e.post_id
    cross join since s
    where e.created_at > s.t and e.actor <> p.author_id
    group by p.author_id
  ),
  eligible as (
    select a.uid, a.likes, a.comments
    from activity a
    join public.profiles pr on pr.id = a.uid
    cross join since s
    where a.uid <> v_actor
      and (a.likes + a.comments) > 0
      -- away from the app: otherwise they've already seen all of it
      and (pr.last_seen is null or pr.last_seen < now() - interval '12 hours')
      -- at most one digest a day
      and not exists (
        select 1 from public.notifications n
        where n.user_id = a.uid and n.type = 'digest'
          and n.created_at > now() - interval '20 hours'
      )
  ), ins as (
    insert into public.notifications (user_id, actor_id, type, text)
    select e.uid, v_actor, 'digest',
      case
        when e.likes > 0 and e.comments > 0 then
          e.likes || ' new ' || case when e.likes = 1 then 'like' else 'likes' end ||
          ' and ' || e.comments || ' ' || case when e.comments = 1 then 'comment' else 'comments' end ||
          ' since yesterday'
        when e.likes > 0 then
          e.likes || ' new ' || case when e.likes = 1 then 'like' else 'likes' end || ' since yesterday'
        else
          e.comments || ' new ' || case when e.comments = 1 then 'comment' else 'comments' end || ' since yesterday'
      end
    from eligible e
    returning 1
  )
  select count(*) into n from ins;
  return n;
end $$;

-- "Your top post this week got 24 likes" - links straight to the post.
create or replace function public.send_weekly_recap()
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid; n int := 0;
begin
  select id into v_actor from public.profiles where username = 'linkup' limit 1;
  if v_actor is null then return 0; end if;

  with scored as (
    select p.id, p.author_id,
      (select count(*) from public.likes l where l.post_id = p.id) as likes,
      (select count(*) from public.comments c where c.post_id = p.id) as comments
    from public.posts p
    where p.created_at > now() - interval '7 days'
  ),
  best as (
    select distinct on (author_id) author_id, id, likes, comments
    from scored
    where likes + comments > 0
    order by author_id, (likes + comments) desc, id
  ), ins as (
    insert into public.notifications (user_id, actor_id, type, post_id, text)
    select b.author_id, v_actor, 'recap', b.id,
      'Your top post this week got ' || b.likes || ' ' ||
      case when b.likes = 1 then 'like' else 'likes' end ||
      case when b.comments > 0 then ' and ' || b.comments || ' ' ||
        case when b.comments = 1 then 'comment' else 'comments' end else '' end
    from best b
    where b.author_id <> v_actor
      and not exists (
        select 1 from public.notifications n
        where n.user_id = b.author_id and n.type = 'recap'
          and n.created_at > now() - interval '6 days'
      )
    returning 1
  )
  select count(*) into n from ins;
  return n;
end $$;

-- Cron-only: no client role should be able to fan out notifications.
revoke all on function public.send_daily_digest() from public, anon, authenticated;
revoke all on function public.send_weekly_recap() from public, anon, authenticated;

-- 09:00 UTC daily, and Sunday 18:00 UTC for the weekly recap.
select cron.schedule('linkup-daily-digest', '0 9 * * *', $cron$select public.send_daily_digest()$cron$);
select cron.schedule('linkup-weekly-recap', '0 18 * * 0', $cron$select public.send_weekly_recap()$cron$);
