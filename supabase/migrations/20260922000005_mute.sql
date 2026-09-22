-- Mute: the soft alternative to blocking. Blocking is a wall - it hides you
-- both ways and is socially expensive, so nobody uses it on a friend who
-- simply posts too much. Mute stops serving someone's posts and/or stories
-- without unfollowing them and without telling them.
--
-- Unlike blocks this is a preference, not a security boundary: muted content
-- is still perfectly visible if you go and look at their profile. That is
-- the point of it.

create table if not exists public.mutes (
  muter_id     uuid not null references public.profiles(id) on delete cascade,
  muted_id     uuid not null references public.profiles(id) on delete cascade,
  mute_posts   boolean not null default true,
  mute_stories boolean not null default true,
  created_at   timestamptz not null default now(),
  primary key (muter_id, muted_id),
  constraint mutes_not_self check (muter_id <> muted_id)
);

alter table public.mutes enable row level security;

drop policy if exists "users manage their own mute list" on public.mutes;
create policy "users manage their own mute list"
  on public.mutes for all to authenticated
  using ((select auth.uid()) = muter_id)
  with check ((select auth.uid()) = muter_id);

drop trigger if exists rate_limit_mutes on public.mutes;
create trigger rate_limit_mutes before insert on public.mutes
  for each row execute function public.rate_limit_trigger('mutes', '200', '1 hour');

-- For You and Reels are keyset-paginated, so a muted author has to be
-- dropped in the query - filtering client-side would hand back short pages
-- and eventually an empty one that looks like the end of the feed.
--
-- Both ranking functions are ~130 lines each and only need one clause added
-- to their candidate filter. Re-pasting them here would mean two large
-- copies that can silently drift from what is deployed, so instead the
-- deployed definition is read back, the clause spliced in, and the result
-- re-executed. The guard makes a missed match fail the migration rather
-- than quietly leaving mute half-wired.
do $$
declare
  v_name text;
  v_def  text;
  v_new  text;
  v_old  constant text := 'and public.can_view_post(p.author_id, p.audience, auth.uid())';
  v_add  constant text := 'and public.can_view_post(p.author_id, p.audience, auth.uid())'
    || ' and not exists (select 1 from public.mutes m'
    || ' where m.muter_id = auth.uid() and m.muted_id = p.author_id and m.mute_posts)';
begin
  foreach v_name in array array['get_feed_for_you', 'get_reels_for_you'] loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = v_name;

    if v_def is null then
      raise exception 'rate: % not found', v_name;
    end if;
    if position(v_old in v_def) = 0 then
      raise exception '% does not contain the expected can_view_post filter', v_name;
    end if;
    if position('public.mutes' in v_def) > 0 then
      continue;                              -- already patched, migration re-run
    end if;

    v_new := replace(v_def, v_old, v_add);
    execute v_new;
  end loop;
end $$;
