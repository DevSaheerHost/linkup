-- Event-driven push delivery: call the push-notify Edge Function the moment
-- a row lands in notifications/messages/calls/groupcalls, instead of relying
-- on push-sender.js (a script nobody was actually running continuously
-- anywhere, so nothing ever sent a push regardless of client subscriptions).

create extension if not exists pg_net;

create or replace function public.notify_push() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://prfdrpmnftegbiaglugh.supabase.co/functions/v1/push-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- anon key: safe to embed, it's the same public key already shipped in app.js,
      -- and is only used here to satisfy the Edge Function's JWT check.
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InByZmRycG1uZnRlZ2JpYWdsdWdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxMDEzMTksImV4cCI6MjEwNDY3NzMxOX0.DcDjxeN6G5NCuvcARg6_c4VPoNiWVtfFMv0dufA6thM'
    ),
    body := jsonb_build_object('type', 'INSERT', 'table', TG_TABLE_NAME, 'schema', 'public', 'record', to_jsonb(NEW), 'old_record', null),
    timeout_milliseconds := 8000
  );
  return NEW;
end;
$$;

create trigger notify_push_on_notification after insert on public.notifications
  for each row execute function public.notify_push();
create trigger notify_push_on_message after insert on public.messages
  for each row execute function public.notify_push();
create trigger notify_push_on_call after insert on public.calls
  for each row execute function public.notify_push();
create trigger notify_push_on_groupcall after insert on public.groupcalls
  for each row execute function public.notify_push();
