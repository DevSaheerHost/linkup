-- RLS answers "who may write", never "how fast". Nothing stopped a session
-- token from inserting ten thousand posts, following every account on the
-- instance, or flooding a conversation - the client's UI was the only brake,
-- and a direct PostgREST call skips it.
--
-- Fixed-window counters, one row per (user, action, window). A fixed window
-- permits up to 2x the limit across a boundary; that is a deliberate trade
-- for a single cheap upsert per write, and the limits below are set far above
-- anything a person does by hand, so the boundary case still only affects
-- automation.

create table if not exists public.rate_limits (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  action       text        not null,
  window_start timestamptz not null,
  count        integer     not null default 0,
  primary key (user_id, action, window_start)
);

-- No policies by design: the counter is written only by the SECURITY DEFINER
-- function below, and a client that could read or edit its own counters could
-- edit its way out of the limit.
alter table public.rate_limits enable row level security;

create or replace function public.enforce_rate_limit(p_action text, p_limit integer, p_window interval)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user  uuid := (select auth.uid());
  v_secs  double precision := extract(epoch from p_window);
  v_start timestamptz;
  v_count integer;
begin
  -- No auth.uid() means this is the service role, a cron job or a migration:
  -- trusted server-side work (digests, recaps, backfills), not user traffic.
  if v_user is null then return; end if;

  v_start := to_timestamp(floor(extract(epoch from now()) / v_secs) * v_secs);

  insert into public.rate_limits as r (user_id, action, window_start, count)
       values (v_user, p_action, v_start, 1)
  on conflict (user_id, action, window_start)
    do update set count = r.count + 1
    returning r.count into v_count;

  if v_count > p_limit then
    -- PostgREST turns a PTnnn SQLSTATE into that HTTP status, so the client
    -- sees a real 429 instead of a generic failure.
    raise exception 'Too many % - slow down and try again shortly.', p_action
      using errcode = 'PT429';
  end if;
end;
$$;

revoke execute on function public.enforce_rate_limit(text, integer, interval) from public;
revoke execute on function public.enforce_rate_limit(text, integer, interval) from anon;
revoke execute on function public.enforce_rate_limit(text, integer, interval) from authenticated;

-- One trigger function for every table; the limit is passed per trigger, so
-- covering a new table later is a single CREATE TRIGGER.
create or replace function public.rate_limit_trigger()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.enforce_rate_limit(TG_ARGV[0], TG_ARGV[1]::integer, TG_ARGV[2]::interval);
  return new;
end;
$$;

revoke execute on function public.rate_limit_trigger() from public;
revoke execute on function public.rate_limit_trigger() from anon;
revoke execute on function public.rate_limit_trigger() from authenticated;

drop trigger if exists rate_limit_posts         on public.posts;
drop trigger if exists rate_limit_stories       on public.stories;
drop trigger if exists rate_limit_comments      on public.comments;
drop trigger if exists rate_limit_likes         on public.likes;
drop trigger if exists rate_limit_follows       on public.follows;
drop trigger if exists rate_limit_messages      on public.messages;
drop trigger if exists rate_limit_reports       on public.reports;
drop trigger if exists rate_limit_notifications on public.notifications;

create trigger rate_limit_posts    before insert on public.posts
  for each row execute function public.rate_limit_trigger('posts', '20', '1 hour');
create trigger rate_limit_stories  before insert on public.stories
  for each row execute function public.rate_limit_trigger('stories', '30', '1 hour');
create trigger rate_limit_comments before insert on public.comments
  for each row execute function public.rate_limit_trigger('comments', '60', '1 hour');
create trigger rate_limit_likes    before insert on public.likes
  for each row execute function public.rate_limit_trigger('likes', '300', '1 hour');
-- Follow-spam is the classic growth-bot move, so this is the tightest of the set.
create trigger rate_limit_follows  before insert on public.follows
  for each row execute function public.rate_limit_trigger('follows', '100', '1 hour');
create trigger rate_limit_messages before insert on public.messages
  for each row execute function public.rate_limit_trigger('messages', '300', '1 hour');
create trigger rate_limit_reports  before insert on public.reports
  for each row execute function public.rate_limit_trigger('reports', '20', '1 hour');
-- notify() inserts straight from the client, so it needs its own ceiling;
-- generous because one comment can notify every participant in a thread.
create trigger rate_limit_notifications before insert on public.notifications
  for each row execute function public.rate_limit_trigger('notifications', '400', '1 hour');

-- Spent windows are dead weight; keep two days for debugging, drop the rest.
select cron.schedule(
  'purge-rate-limits',
  '17 4 * * *',
  $cron$ delete from public.rate_limits where window_start < now() - interval '2 days' $cron$
);
