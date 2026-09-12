-- "Not interested" reuses the exact author/hashtag/keyword affinity
-- machinery already in get_feed_for_you/get_reels_for_you - it's just
-- one more engagement source with a strong negative weight, decayed by
-- recency the same way positive engagement is. That means it naturally
-- combines with everything else already there: tapping "not interested"
-- suppresses that author and that post's topics, and fades out over time
-- like every other signal, with zero changes to the scoring formula.
create table public.not_interested (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  author_id uuid not null,
  hashtags text[] not null default '{}',
  keywords text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (user_id, post_id)
);

alter table public.not_interested enable row level security;

create policy "users manage their own not-interested marks"
on public.not_interested for all
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

-- Security definer so the client only ever names a post_id - it can't
-- spoof which author/tags get penalized, since those are read server-side
-- from the post itself, not trusted from client input.
create or replace function public.mark_not_interested(p_post_id uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.not_interested (user_id, post_id, author_id, hashtags, keywords)
  select auth.uid(), p.id, p.author_id, p.hashtags, p.keywords
  from public.posts p
  where p.id = p_post_id
  on conflict (user_id, post_id) do nothing
$$;
revoke all on function public.mark_not_interested(uuid) from public;
revoke execute on function public.mark_not_interested(uuid) from anon;
grant execute on function public.mark_not_interested(uuid) to authenticated;
