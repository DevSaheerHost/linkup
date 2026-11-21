-- Fixes from a health check of the live project, two months in.

-- 1. pg_cron never prunes its own run history. publish-due-posts runs every
--    minute, so job_run_details had reached 16 MB - about 35x all of the
--    app's real data put together - and was adding ~260 KB a day, forever.
--    Keep a week, which is plenty to debug a failing job.
delete from cron.job_run_details where end_time < now() - interval '7 days';

select cron.schedule(
  'purge-cron-history',
  '23 4 * * *',
  $cron$ delete from cron.job_run_details where end_time < now() - interval '7 days' $cron$
);

-- 2. Foreign keys without a covering index. Each of these is on the side a
--    cascade walks: deleting a post scans collection_items for it, deleting a
--    story scans highlight_items, deleting a profile scans the rest.
create index if not exists collection_items_post_idx         on public.collection_items (post_id);
create index if not exists highlight_items_story_idx         on public.highlight_items (story_id);
create index if not exists mutes_muted_idx                   on public.mutes (muted_id);
create index if not exists reports_reviewed_by_idx           on public.reports (reviewed_by);
create index if not exists suggestion_dismissals_dismissed_idx on public.suggestion_dismissals (dismissed_id);

-- 3. highlights / highlight_items each had two permissive SELECT policies,
--    because the owner's FOR ALL policy covers reads too - so every row was
--    checked twice. The visibility policy already lets an owner read their
--    own (can_view_account is true for yourself), so the owner policy only
--    needs the writes.
drop policy if exists "owners manage their own highlights" on public.highlights;
create policy "owners create their own highlights" on public.highlights
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "owners edit their own highlights" on public.highlights
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "owners delete their own highlights" on public.highlights
  for delete to authenticated using (owner_id = (select auth.uid()));

drop policy if exists "owners manage their own highlight items" on public.highlight_items;
create policy "owners add to their own highlights" on public.highlight_items
  for insert to authenticated
  with check (exists (select 1 from public.highlights h where h.id = highlight_id and h.owner_id = (select auth.uid())));
create policy "owners edit their own highlight items" on public.highlight_items
  for update to authenticated
  using (exists (select 1 from public.highlights h where h.id = highlight_id and h.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.highlights h where h.id = highlight_id and h.owner_id = (select auth.uid())));
create policy "owners remove from their own highlights" on public.highlight_items
  for delete to authenticated
  using (exists (select 1 from public.highlights h where h.id = highlight_id and h.owner_id = (select auth.uid())));

-- 4. Approving a follow request told nobody. The requester sat on
--    "Requested" until they happened to look again.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type = any (array['like','comment','reply','commentlike','tag','storylike',
                           'follow','followreq','followaccept','digest','recap']));

create or replace function public.approve_follow_request(p_requester uuid)
returns void language plpgsql security definer set search_path to 'public'
as $$
declare v_me uuid := (select auth.uid());
begin
  if v_me is null then
    raise exception 'not signed in' using errcode = 'PT401';
  end if;
  if not exists (select 1 from public.follow_requests where requester_id = p_requester and target_id = v_me) then
    raise exception 'no such follow request' using errcode = 'PT404';
  end if;
  delete from public.follow_requests where requester_id = p_requester and target_id = v_me;
  insert into public.follows (follower_id, following_id) values (p_requester, v_me) on conflict do nothing;
  -- The request notification is now stale; replace it with the answer.
  delete from public.notifications where user_id = v_me and actor_id = p_requester and type = 'followreq';
  insert into public.notifications (user_id, actor_id, type, read)
       values (p_requester, v_me, 'followaccept', false);
end;
$$;
