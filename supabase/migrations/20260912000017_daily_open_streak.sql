-- Consecutive days the user opened the app. Deliberately gentle: there is
-- no "you lost your streak" state anywhere - breaking one just quietly
-- starts over at 1. The only feedback is positive, at milestones.
alter table public.profiles
  add column streak_days int not null default 0,
  add column streak_last date;

-- Called once per app open. Idempotent within a day, so opening the app
-- ten times doesn't inflate anything. Returns whether it actually moved,
-- so the client only celebrates a milestone on the day it's reached.
create or replace function public.touch_open_streak()
returns table (streak int, bumped boolean)
language plpgsql security definer set search_path = public as $$
declare
  last_d date;
  cur int;
  did boolean := false;
begin
  select streak_last, streak_days into last_d, cur
  from public.profiles where id = auth.uid();

  if last_d is null or last_d < current_date - 1 then
    cur := 1; did := true;                       -- first open, or the run lapsed
  elsif last_d = current_date - 1 then
    cur := coalesce(cur,0) + 1; did := true;     -- consecutive day
  else
    did := false;                                -- already counted today
  end if;

  if did then
    update public.profiles
      set streak_days = cur, streak_last = current_date
      where id = auth.uid();
  end if;

  return query select coalesce(cur,0), did;
end;
$$;

revoke all on function public.touch_open_streak() from public;
revoke execute on function public.touch_open_streak() from anon;
grant execute on function public.touch_open_streak() to authenticated;
