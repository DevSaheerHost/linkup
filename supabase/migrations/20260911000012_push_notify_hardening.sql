-- notify_push() is a trigger-only function; nothing should call it directly
-- via PostgREST RPC (flagged by the security advisor since SECURITY DEFINER
-- functions in public are executable by anon/authenticated by default).
revoke execute on function public.notify_push() from public, anon, authenticated;
