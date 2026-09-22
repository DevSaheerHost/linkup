-- Private accounts, plus a fix for the visibility predicates they build on.
--
-- THE PRE-EXISTING BUG: is_blocked() and can_view_post() are plain STABLE
-- functions, so their subqueries run under the *caller's* RLS - and both
-- `blocks` and `closefriends` are owner-only. Read from a viewer's session:
--
--   * is_blocked(author, viewer) could not see the author's block row, so it
--     returned false and a blocked person still saw everything the account
--     posted;
--   * can_view_post() could not see the author's closefriends row, so a
--     close-friends post was invisible to the close friends it was for.
--
-- Both were verified against the live database before this migration. The
-- For You / Reels RPCs were unaffected (they are SECURITY DEFINER, so the
-- predicates ran as owner inside them) - it was every direct read of `posts`
-- that was wrong: the Following feed, profile grids, post view, comments,
-- likes. Making the predicates SECURITY DEFINER fixes all of it, and is a
-- precondition for private accounts, which need the same kind of lookup.

create or replace function public.is_blocked(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.blocks
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
  );
$$;

alter table public.profiles
  add column if not exists is_private boolean not null default false;

-- Pending requests to follow a private account. Approving one moves it into
-- `follows`; denying deletes it. Existing followers of an account that later
-- goes private keep their access, same as every other app that does this.
create table if not exists public.follow_requests (
  requester_id uuid not null references public.profiles(id) on delete cascade,
  target_id    uuid not null references public.profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (requester_id, target_id),
  constraint follow_requests_not_self check (requester_id <> target_id)
);

create index if not exists follow_requests_target_idx
  on public.follow_requests (target_id, created_at desc);

alter table public.follow_requests enable row level security;

drop policy if exists "requester and target can see a follow request" on public.follow_requests;
create policy "requester and target can see a follow request"
  on public.follow_requests for select to authenticated
  using (requester_id = (select auth.uid()) or target_id = (select auth.uid()));

-- Only worth requesting if the target is actually private, isn't blocking
-- you, and isn't already followed.
drop policy if exists "users request to follow as themselves" on public.follow_requests;
create policy "users request to follow as themselves"
  on public.follow_requests for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and exists (select 1 from public.profiles p where p.id = target_id and p.is_private)
    and not public.is_blocked(requester_id, target_id)
    and not exists (
      select 1 from public.follows f
      where f.follower_id = requester_id and f.following_id = target_id
    )
  );

-- The requester withdraws; the target denies. Same row, same statement.
drop policy if exists "requester cancels, target denies" on public.follow_requests;
create policy "requester cancels, target denies"
  on public.follow_requests for delete to authenticated
  using (requester_id = (select auth.uid()) or target_id = (select auth.uid()));

drop trigger if exists rate_limit_follow_requests on public.follow_requests;
create trigger rate_limit_follow_requests before insert on public.follow_requests
  for each row execute function public.rate_limit_trigger('follow requests', '100', '1 hour');

-- A private account can only be followed by approval, so the direct insert
-- path is closed off and the request table becomes the only way in.
drop policy if exists "users can follow as themselves" on public.follows;
create policy "users can follow as themselves"
  on public.follows for insert to authenticated
  with check (
    (select auth.uid()) = follower_id
    and not public.is_blocked(follower_id, following_id)
    and not exists (
      select 1 from public.profiles p where p.id = following_id and p.is_private
    )
  );

-- Approval has to write a follows row on someone else's behalf, which no
-- client-side policy should ever allow - hence a definer function that
-- checks the caller really is the target.
create or replace function public.approve_follow_request(p_requester uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_me uuid := (select auth.uid());
begin
  if v_me is null then
    raise exception 'not signed in' using errcode = 'PT401';
  end if;
  if not exists (
    select 1 from public.follow_requests
    where requester_id = p_requester and target_id = v_me
  ) then
    raise exception 'no such follow request' using errcode = 'PT404';
  end if;

  delete from public.follow_requests
   where requester_id = p_requester and target_id = v_me;

  insert into public.follows (follower_id, following_id)
       values (p_requester, v_me)
  on conflict do nothing;
end;
$$;

revoke execute on function public.approve_follow_request(uuid) from public;
revoke execute on function public.approve_follow_request(uuid) from anon;
grant  execute on function public.approve_follow_request(uuid) to authenticated;

-- Is `viewer` allowed to see `owner`'s content and social graph? Definer, so
-- it can read `follows` even where the policy below hides rows, and so it
-- does not recurse when used inside that same policy.
create or replace function public.can_view_account(p_owner uuid, viewer uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    p_owner = viewer
    or not exists (select 1 from public.profiles p where p.id = p_owner and p.is_private)
    or exists (
      select 1 from public.follows f
      where f.following_id = p_owner and f.follower_id = viewer
    );
$$;

grant execute on function public.can_view_account(uuid, uuid) to authenticated;

create or replace function public.can_view_post(p_author uuid, p_audience text, viewer uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    not public.is_blocked(p_author, viewer)
    and public.can_view_account(p_author, viewer)
    and (
      p_audience = 'public'
      or p_author = viewer
      or exists (select 1 from public.closefriends where owner_id = p_author and friend_id = viewer)
    );
$$;

-- Stories had only a block check; a private account's stories were readable
-- by anyone signed in.
drop policy if exists "stories viewable unless blocked" on public.stories;
create policy "stories viewable unless blocked"
  on public.stories for select to authenticated
  using (
    not public.is_blocked(author_id, (select auth.uid()))
    and public.can_view_account(author_id, (select auth.uid()))
  );

-- Who follows whom was world-readable, which would have left a private
-- account's follower list public - the one thing people go private to hide.
drop policy if exists "follows are viewable by authenticated users" on public.follows;
create policy "follows are viewable by authenticated users"
  on public.follows for select to authenticated
  using (
    follower_id = (select auth.uid())
    or following_id = (select auth.uid())
    or (
      public.can_view_account(follower_id, (select auth.uid()))
      and public.can_view_account(following_id, (select auth.uid()))
    )
  );

-- "X wants to follow you" needs a type of its own.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type = any (array['like','comment','reply','commentlike','tag','storylike','follow','followreq','digest','recap']));
