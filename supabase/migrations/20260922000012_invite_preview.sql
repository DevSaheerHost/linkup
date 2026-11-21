-- A shared profile link lands a logged-out visitor on the auth card, which
-- should say who invited them. profiles is authenticated-only and should
-- stay that way, so this is the one deliberate pre-login surface: exactly
-- the four fields a profile card shows, for a username the visitor already
-- holds - matched case-insensitively, length-bounded, one row.
--
-- (Applied to the live project on 2026-09-22; this file was added later to
-- bring the repo back in line with the database.)

create or replace function public.invite_preview(p_username text)
returns table (username text, name text, avatar_url text, is_verified boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.username, p.name, p.avatar_url, p.is_verified
    from public.profiles p
   where lower(p.username) = lower(trim(coalesce(p_username, '')))
     and p_username is not null
     and length(trim(p_username)) between 1 and 64
   limit 1;
$$;

revoke execute on function public.invite_preview(text) from public;
grant  execute on function public.invite_preview(text) to anon;
grant  execute on function public.invite_preview(text) to authenticated;
