-- A DM streak counts consecutive days on which BOTH people sent at least
-- one message (one person talking into the void isn't a streak - that's
-- the rule that makes it mutual and is why the mechanic works).
--
-- A streak stays alive while its most recent qualifying day is today or
-- yesterday: it only breaks once a full day passes with no exchange, so
-- you don't "lose" it just because you haven't messaged yet today.
--
-- Days are UTC. Doing this per-viewer-timezone would need the client to
-- pass an offset and would make the number disagree between the two
-- people in the conversation, which is worse than being an hour off.
create or replace function public.my_dm_streaks()
returns table (other_id uuid, streak int)
language sql stable security definer set search_path = public as $$
  with msgs as (
    select
      case when m.sender_id = auth.uid() then m.receiver_id else m.sender_id end as other_id,
      m.sender_id,
      (m.created_at at time zone 'utc')::date as d
    from public.messages m
    where m.group_id is null
      and m.receiver_id is not null
      and (m.sender_id = auth.uid() or m.receiver_id = auth.uid())
      and m.created_at > now() - interval '400 days'
  ),
  pair_days as (
    select other_id, d,
      count(*) filter (where sender_id = auth.uid()) as mine,
      count(*) filter (where sender_id <> auth.uid()) as theirs
    from msgs
    group by other_id, d
  ),
  qual as (
    select other_id, d from pair_days
    where mine > 0 and theirs > 0 and d <= current_date
  ),
  -- gaps-and-islands: walking back day by day, d + row_number() stays
  -- constant inside one unbroken run, so it identifies the run.
  grouped as (
    select other_id, d,
           d + (row_number() over (partition by other_id order by d desc))::int as anchor
    from qual
  ),
  latest as (select other_id, max(d) as max_d from qual group by other_id)
  select g.other_id, count(*)::int as streak
  from grouped g
  join latest l on l.other_id = g.other_id
  join grouped head on head.other_id = g.other_id and head.d = l.max_d
  where l.max_d >= current_date - 1
    and g.anchor = head.anchor
  group by g.other_id
$$;

revoke all on function public.my_dm_streaks() from public;
revoke execute on function public.my_dm_streaks() from anon;
grant execute on function public.my_dm_streaks() to authenticated;
