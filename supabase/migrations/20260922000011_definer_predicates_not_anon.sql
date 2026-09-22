-- Fixes a regression from 20260922000004: making is_blocked() and
-- can_view_post() SECURITY DEFINER (so they could see the owner-only
-- `blocks` and `closefriends` rows they need) also left them callable by
-- `anon` through /rest/v1/rpc, where they answer questions nobody signed
-- out should be able to ask:
--
--   is_blocked(a, b)                  -> do these two users block each other
--   can_view_account(owner, viewer)   -> is this account private, does X follow Y
--   can_view_post(author, aud, viewer)-> is X in Y's close friends
--   is_moderator(uid)                 -> who moderates this instance
--
-- They exist to be evaluated inside RLS policies, which run as the
-- authenticated role, so anon never needed them.
--
-- invite_preview() stays open to anon on purpose: it is the one deliberate
-- pre-login surface, and returns only what a profile card already shows.

revoke execute on function public.is_blocked(uuid, uuid) from public, anon;
grant  execute on function public.is_blocked(uuid, uuid) to authenticated;

revoke execute on function public.can_view_account(uuid, uuid) from public, anon;
grant  execute on function public.can_view_account(uuid, uuid) to authenticated;

revoke execute on function public.can_view_post(uuid, text, uuid) from public, anon;
grant  execute on function public.can_view_post(uuid, text, uuid) to authenticated;

revoke execute on function public.is_moderator(uuid) from public, anon;
grant  execute on function public.is_moderator(uuid) to authenticated;
