-- People you may know.
--
-- The app has Instagram's whole feature set and almost no social graph -
-- 4 accounts, 3 follow edges. A new account lands on an empty Following tab
-- and gives For You nothing to rank on, so nothing else in the app can work.
-- This is the cold-start fix.
--
-- Signals, strongest first:
--   * they already follow you        - the single highest-converting suggestion
--   * friends of friends             - followed by people you follow
--   * they engaged with your posts   - liked or commented, comments worth more
--   * shared taste                   - they post hashtags you engage with
--   * popular / official             - the fallback for an account with no
--                                      graph at all, which is the case this
--                                      whole function exists for

create table if not exists public.suggestion_dismissals (
  user_id      uuid not null references public.profiles(id) on delete cascade,
  dismissed_id uuid not null references public.profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (user_id, dismissed_id),
  constraint suggestion_dismissals_not_self check (user_id <> dismissed_id)
);

alter table public.suggestion_dismissals enable row level security;

drop policy if exists "users manage their own dismissals" on public.suggestion_dismissals;
create policy "users manage their own dismissals"
  on public.suggestion_dismissals for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop trigger if exists rate_limit_suggestion_dismissals on public.suggestion_dismissals;
create trigger rate_limit_suggestion_dismissals before insert on public.suggestion_dismissals
  for each row execute function public.rate_limit_trigger('dismissals', '300', '1 hour');

create or replace function public.suggest_people(page_size int default 12)
returns table (
  id uuid, username text, name text, avatar_url text,
  is_verified boolean, is_private boolean, reason text, score float8
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select auth.uid() as uid),

  -- Anyone already connected, hidden, or explicitly dismissed.
  excluded as (
    select uid as id from me
    union select f.following_id from public.follows f, me where f.follower_id = me.uid
    union select b.blocked_id   from public.blocks b, me  where b.blocker_id = me.uid
    union select b.blocker_id   from public.blocks b, me  where b.blocked_id = me.uid
    union select m.muted_id     from public.mutes m, me   where m.muter_id = me.uid
    union select r.target_id    from public.follow_requests r, me where r.requester_id = me.uid
    union select d.dismissed_id from public.suggestion_dismissals d, me where d.user_id = me.uid
  ),

  follows_me as (
    select f.follower_id as id from public.follows f, me where f.following_id = me.uid
  ),

  friends_of_friends as (
    select f2.following_id as id, count(distinct f1.following_id)::float8 as n
    from public.follows f1
    join public.follows f2 on f2.follower_id = f1.following_id
    cross join me
    where f1.follower_id = me.uid
    group by f2.following_id
  ),

  engaged_with_me as (
    select id, sum(w)::float8 as n from (
      select l.user_id as id, 1.0 as w
        from public.likes l join public.posts p on p.id = l.post_id cross join me
       where p.author_id = me.uid and l.user_id <> me.uid
      union all
      -- Bothering to write something says more than tapping a heart.
      select c.user_id, 1.5
        from public.comments c join public.posts p on p.id = c.post_id cross join me
       where p.author_id = me.uid and c.user_id <> me.uid
    ) e group by id
  ),

  -- Hashtags on posts I liked, and who else posts under them.
  my_tags as (
    select distinct unnest(p.hashtags) as tag
      from public.likes l join public.posts p on p.id = l.post_id cross join me
     where l.user_id = me.uid and p.hashtags is not null
  ),
  shared_taste as (
    select p.author_id as id, count(distinct t.tag)::float8 as n
      from public.posts p join my_tags t on t.tag = any(p.hashtags) cross join me
     where p.author_id <> me.uid
     group by p.author_id
  ),

  popular as (
    select p.id, p.is_verified, count(f.follower_id)::float8 as followers
      from public.profiles p
      left join public.follows f on f.following_id = p.id
     group by p.id, p.is_verified
  ),

  scored as (
    select id,
           sum(w) as score,
           (array_agg(reason order by w desc))[1] as reason
    from (
      -- The first branch names the columns for the whole union.
      select id, 6.0 as w,               'Follows you' as reason        from follows_me
      union all
      select id, 3.0 * least(n, 5.0),    'Followed by people you follow' from friends_of_friends
      union all
      select id, 2.0 * least(n, 4.0),    'Interacts with your posts'     from engaged_with_me
      union all
      select id, 1.5 * least(n, 4.0),    'Posts things you like'         from shared_taste
      union all
      select id, 0.4 + (case when is_verified then 2.5 else 0 end) + least(followers, 50.0) / 25.0,
                                         'Popular on LinkUp'             from popular
    ) s
    group by id
  )

  select p.id, p.username, p.name, p.avatar_url, p.is_verified, p.is_private,
         s.reason, s.score
    from scored s
    join public.profiles p on p.id = s.id
   cross join me
   where s.id not in (select id from excluded)
     and not public.is_blocked(p.id, me.uid)
   order by s.score desc, p.username
   limit greatest(1, least(coalesce(page_size, 12), 50));
$$;

revoke execute on function public.suggest_people(int) from public;
revoke execute on function public.suggest_people(int) from anon;
grant  execute on function public.suggest_people(int) to authenticated;
