-- SECURITY FIX: get_feed_for_you/get_reels_for_you took viewer_id as a
-- caller-supplied parameter instead of deriving it from the session. A
-- malicious authenticated caller could pass another user's id and receive
-- that person's close-friends-only posts back (can_view_post() would
-- evaluate audience rules for the spoofed viewer_id, but the actual post
-- content is returned to the real, unauthorized caller) - a real access
-- control bypass. Fixed by dropping the parameter entirely and using
-- auth.uid() internally, so there is nothing left to spoof.
drop function if exists public.get_feed_for_you(uuid,float8,timestamptz,uuid,int);
drop function if exists public.get_reels_for_you(uuid,float8,timestamptz,uuid,int);

create or replace function public.get_feed_for_you(
  cursor_score float8 default null,
  cursor_created_at timestamptz default null,
  cursor_id uuid default null,
  page_size int default 9
) returns table (
  id uuid, author_id uuid, caption text, audience text, tags text,
  image_url text, photos text[], video_url text, thumb_url text, poll jsonb,
  created_at timestamptz, updated_at timestamptz, hashtags text[], score float8
) language sql stable security definer set search_path = public as $$
  with my_author_engagement as (
    select author_id, sum(weight * exp(-extract(epoch from (now()-at))/2592000.0)) as val
    from (
      select p.author_id, l.created_at as at, 1.0 as weight from public.likes l join public.posts p on p.id=l.post_id where l.user_id=auth.uid()
      union all
      select p.author_id, c.created_at, 2.0 from public.comments c join public.posts p on p.id=c.post_id where c.user_id=auth.uid()
      union all
      select p.author_id, s.created_at, 1.5 from public.saves s join public.posts p on p.id=s.post_id where s.user_id=auth.uid()
      union all
      select p.author_id, v.created_at, 0.5 from public.postviews v join public.posts p on p.id=v.post_id where v.user_id=auth.uid()
      union all
      select f.following_id, f.created_at, 3.0 from public.follows f where f.follower_id=auth.uid()
    ) e
    group by author_id
  ),
  my_hashtag_engagement as (
    select tag, sum(weight * exp(-extract(epoch from (now()-at))/2592000.0)) as val
    from (
      select unnest(p.hashtags) as tag, l.created_at as at, 1.0 as weight from public.likes l join public.posts p on p.id=l.post_id where l.user_id=auth.uid()
      union all
      select unnest(p.hashtags), c.created_at, 2.0 from public.comments c join public.posts p on p.id=c.post_id where c.user_id=auth.uid()
      union all
      select unnest(p.hashtags), s.created_at, 1.5 from public.saves s join public.posts p on p.id=s.post_id where s.user_id=auth.uid()
      union all
      select unnest(p.hashtags), v.created_at, 0.5 from public.postviews v join public.posts p on p.id=v.post_id where v.user_id=auth.uid()
    ) e
    group by tag
  ),
  candidates as (
    select
      p.id, p.author_id, p.caption, p.audience, p.tags, p.image_url, p.photos,
      p.video_url, p.thumb_url, p.poll, p.created_at, p.updated_at, p.hashtags,
      coalesce((select val from my_author_engagement a where a.author_id=p.author_id), 0) as author_aff,
      coalesce((select sum(h.val) from my_hashtag_engagement h where h.tag = any(p.hashtags)), 0) as topic_aff,
      (select count(*) from public.likes l where l.post_id=p.id)::float8 as like_ct,
      (select count(*) from public.comments c where c.post_id=p.id)::float8 as comment_ct,
      (select count(*) from public.postviews v where v.post_id=p.id)::float8 as view_ct
    from public.posts p
    where p.created_at > now() - interval '60 days'
      and public.can_view_post(p.author_id, p.audience, auth.uid())
  ),
  scored as (
    select *,
      ( 3.0*author_aff + 2.0*topic_aff
        + 1.0*ln(1+like_ct+2*comment_ct+0.1*view_ct)
        + 4.0*exp(-extract(epoch from (now()-created_at))/172800.0)
        + random()*0.5
      ) as _score
    from candidates
  )
  select s.id, s.author_id, s.caption, s.audience, s.tags, s.image_url, s.photos,
         s.video_url, s.thumb_url, s.poll, s.created_at, s.updated_at, s.hashtags, s._score
  from scored s
  where cursor_score is null
     or (s._score, s.created_at, s.id) < (cursor_score, cursor_created_at, cursor_id)
  order by s._score desc, s.created_at desc, s.id desc
  limit page_size
$$;
revoke execute on function public.get_feed_for_you(float8,timestamptz,uuid,int) from public, anon;
grant execute on function public.get_feed_for_you(float8,timestamptz,uuid,int) to authenticated;

create or replace function public.get_reels_for_you(
  cursor_score float8 default null,
  cursor_created_at timestamptz default null,
  cursor_id uuid default null,
  page_size int default 4
) returns table (
  id uuid, author_id uuid, caption text, audience text, tags text,
  image_url text, photos text[], video_url text, thumb_url text, poll jsonb,
  created_at timestamptz, updated_at timestamptz, hashtags text[], score float8
) language sql stable security definer set search_path = public as $$
  with my_author_engagement as (
    select author_id, sum(weight * exp(-extract(epoch from (now()-at))/2592000.0)) as val
    from (
      select p.author_id, l.created_at as at, 1.0 as weight from public.likes l join public.posts p on p.id=l.post_id where l.user_id=auth.uid()
      union all
      select p.author_id, c.created_at, 2.0 from public.comments c join public.posts p on p.id=c.post_id where c.user_id=auth.uid()
      union all
      select p.author_id, s.created_at, 1.5 from public.saves s join public.posts p on p.id=s.post_id where s.user_id=auth.uid()
      union all
      select p.author_id, v.created_at, 0.5 from public.postviews v join public.posts p on p.id=v.post_id where v.user_id=auth.uid()
      union all
      select f.following_id, f.created_at, 3.0 from public.follows f where f.follower_id=auth.uid()
    ) e
    group by author_id
  ),
  my_hashtag_engagement as (
    select tag, sum(weight * exp(-extract(epoch from (now()-at))/2592000.0)) as val
    from (
      select unnest(p.hashtags) as tag, l.created_at as at, 1.0 as weight from public.likes l join public.posts p on p.id=l.post_id where l.user_id=auth.uid()
      union all
      select unnest(p.hashtags), c.created_at, 2.0 from public.comments c join public.posts p on p.id=c.post_id where c.user_id=auth.uid()
      union all
      select unnest(p.hashtags), s.created_at, 1.5 from public.saves s join public.posts p on p.id=s.post_id where s.user_id=auth.uid()
      union all
      select unnest(p.hashtags), v.created_at, 0.5 from public.postviews v join public.posts p on p.id=v.post_id where v.user_id=auth.uid()
    ) e
    group by tag
  ),
  candidates as (
    select
      p.id, p.author_id, p.caption, p.audience, p.tags, p.image_url, p.photos,
      p.video_url, p.thumb_url, p.poll, p.created_at, p.updated_at, p.hashtags,
      coalesce((select val from my_author_engagement a where a.author_id=p.author_id), 0) as author_aff,
      coalesce((select sum(h.val) from my_hashtag_engagement h where h.tag = any(p.hashtags)), 0) as topic_aff,
      (select count(*) from public.likes l where l.post_id=p.id)::float8 as like_ct,
      (select count(*) from public.comments c where c.post_id=p.id)::float8 as comment_ct,
      (select count(*) from public.postviews v where v.post_id=p.id)::float8 as view_ct
    from public.posts p
    where p.video_url is not null
      and p.created_at > now() - interval '60 days'
      and public.can_view_post(p.author_id, p.audience, auth.uid())
  ),
  scored as (
    select *,
      ( 3.0*author_aff + 2.0*topic_aff
        + 1.0*ln(1+like_ct+2*comment_ct+0.1*view_ct)
        + 4.0*exp(-extract(epoch from (now()-created_at))/172800.0)
        + random()*0.5
      ) as _score
    from candidates
  )
  select s.id, s.author_id, s.caption, s.audience, s.tags, s.image_url, s.photos,
         s.video_url, s.thumb_url, s.poll, s.created_at, s.updated_at, s.hashtags, s._score
  from scored s
  where cursor_score is null
     or (s._score, s.created_at, s.id) < (cursor_score, cursor_created_at, cursor_id)
  order by s._score desc, s.created_at desc, s.id desc
  limit page_size
$$;
revoke execute on function public.get_reels_for_you(float8,timestamptz,uuid,int) from public, anon;
grant execute on function public.get_reels_for_you(float8,timestamptz,uuid,int) to authenticated;
