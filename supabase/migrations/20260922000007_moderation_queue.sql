-- Reports were write-only: the UI said "Report submitted. Thank you." and the
-- row went into a table nobody could read, with no policy granting SELECT to
-- anyone. A report button that implies someone is looking, when nobody is, is
-- worse than no button.
--
-- This gives the official account a real queue: read the reports, see the
-- reported content, and either dismiss it or remove the post - with who did
-- it and when recorded on the row.

alter table public.profiles
  add column if not exists is_moderator boolean not null default false;

alter table public.reports
  add column if not exists status      text not null default 'open',
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists resolution  text;

alter table public.reports drop constraint if exists reports_status_check;
alter table public.reports add constraint reports_status_check
  check (status in ('open', 'actioned', 'dismissed'));

create index if not exists reports_open_idx
  on public.reports (created_at desc) where status = 'open';

-- Definer, so the check does not depend on the caller's view of profiles.
create or replace function public.is_moderator(uid uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((select p.is_moderator from public.profiles p where p.id = uid), false);
$$;

grant execute on function public.is_moderator(uuid) to authenticated;

drop policy if exists "moderators and the reporter can read reports" on public.reports;
create policy "moderators and the reporter can read reports"
  on public.reports for select to authenticated
  using (
    reporter_id = (select auth.uid())
    or public.is_moderator((select auth.uid()))
  );

-- Only a moderator resolves one, and only through the RPCs below in
-- practice; the policy is the backstop.
drop policy if exists "moderators resolve reports" on public.reports;
create policy "moderators resolve reports"
  on public.reports for update to authenticated
  using (public.is_moderator((select auth.uid())))
  with check (public.is_moderator((select auth.uid())));

create or replace function public.resolve_report(p_report_id uuid, p_status text, p_resolution text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_me uuid := (select auth.uid());
begin
  if not public.is_moderator(v_me) then
    raise exception 'not a moderator' using errcode = 'PT403';
  end if;
  if p_status not in ('actioned', 'dismissed') then
    raise exception 'status must be actioned or dismissed' using errcode = 'PT400';
  end if;

  update public.reports
     set status = p_status,
         reviewed_by = v_me,
         reviewed_at = now(),
         resolution = left(coalesce(p_resolution, ''), 500)
   where id = p_report_id;

  if not found then
    raise exception 'no such report' using errcode = 'PT404';
  end if;
end;
$$;

-- Removing a post is the one destructive power here, so it is its own
-- function: it checks the moderator, deletes the post, and closes every
-- open report pointing at it in one go.
create or replace function public.moderator_remove_post(p_post_id uuid, p_resolution text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_me uuid := (select auth.uid());
begin
  if not public.is_moderator(v_me) then
    raise exception 'not a moderator' using errcode = 'PT403';
  end if;

  update public.reports
     set status = 'actioned',
         reviewed_by = v_me,
         reviewed_at = now(),
         resolution = left(coalesce(p_resolution, 'Post removed'), 500)
   where kind = 'post' and target_id = p_post_id and status = 'open';

  delete from public.posts where id = p_post_id;
end;
$$;

revoke execute on function public.resolve_report(uuid, text, text) from public;
revoke execute on function public.resolve_report(uuid, text, text) from anon;
grant  execute on function public.resolve_report(uuid, text, text) to authenticated;

revoke execute on function public.moderator_remove_post(uuid, text) from public;
revoke execute on function public.moderator_remove_post(uuid, text) from anon;
grant  execute on function public.moderator_remove_post(uuid, text) to authenticated;

-- The official account is the moderator on this instance.
update public.profiles set is_moderator = true where username = 'linkup';
