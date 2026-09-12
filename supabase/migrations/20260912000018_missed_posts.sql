-- "You might have missed": a post you scrolled past without engaging,
-- from someone you actually care about.
--
-- Deliberately a SEPARATE function rather than softening the seen-post
-- penalty in get_feed_for_you. That penalty is what stops the feed
-- repeating itself, it's been verified, and loosening it would put every
-- seen post back in play. This instead pulls a handful of specific posts
-- and the client shows them in their own labelled strip, so resurfacing
-- is explicit and bounded rather than leaking into the main ranking.
create or replace function public.get_missed_posts(page_size int default 3)
returns table (
  id uuid, author_id uuid, caption text, audience text, tags text,
  image_url text, photos text[], video_url text, thumb_url text, poll jsonb,
  created_at timestamptz, updated_at timestamptz, hashtags text[], score float8
) language sql stable security definer set search_path = public as $$
  with my_authors as (
    select author_id, sum(w) as aff
    from (
      select f.following_id as author_id, 3.0 as w
        from public.follows f where f.follower_id = auth.uid()
      union all
      select p.author_id, 1.0 from public.likes l join public.posts p on p.id = l.post_id
        where l.user_id = auth.uid() and l.created_at > now() - interval '30 days'
      union all
      select p.author_id, 2.0 from public.comments c join public.posts p on p.id = c.post_id
        where c.user_id = auth.uid() and c.created_at > now() - interval '30 days'
      union all
      select p.author_id, 1.5 from public.saves s join public.posts p on p.id = s.post_id
        where s.user_id = auth.uid()
    ) e
    group by author_id
  )
  select p.id, p.author_id, p.caption, p.audience, p.tags, p.image_url, p.photos,
         p.video_url, p.thumb_url, p.poll, p.created_at, p.updated_at, p.hashtags,
         a.aff::float8
  from public.posts p
  join my_authors a on a.author_id = p.author_id
  join public.postviews v on v.post_id = p.id and v.user_id = auth.uid()
  where p.author_id <> auth.uid()
    and p.created_at > now() - interval '14 days'
    -- seen long enough ago to genuinely read as "missed", but not so long
    -- ago that resurfacing it feels random
    and v.created_at < now() - interval '12 hours'
    and v.created_at > now() - interval '7 days'
    and public.can_view_post(p.author_id, p.audience, auth.uid())
    -- any engagement at all means it wasn't missed
    and not exists (select 1 from public.likes l where l.post_id = p.id and l.user_id = auth.uid())
    and not exists (select 1 from public.comments c where c.post_id = p.id and c.user_id = auth.uid())
    and not exists (select 1 from public.saves s where s.post_id = p.id and s.user_id = auth.uid())
    -- and an explicit "not interested" must never be walked back
    and not exists (select 1 from public.not_interested ni where ni.post_id = p.id and ni.user_id = auth.uid())
  order by a.aff desc, p.created_at desc
  limit page_size
$$;

revoke all on function public.get_missed_posts(int) from public;
revoke execute on function public.get_missed_posts(int) from anon;
grant execute on function public.get_missed_posts(int) to authenticated;
