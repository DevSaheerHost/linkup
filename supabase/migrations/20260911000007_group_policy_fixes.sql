-- ============================================================
-- LinkUp: tighten group authorization policies
--
-- Three gaps found while mapping the schema onto the app's actual
-- UI-gated behavior (owner-only rename, owner-only remove-others,
-- invite-only membership):
--
-- 1. groups UPDATE allowed ANY member to rename/re-avatar the group;
--    only the owner should.
-- 2. group_members INSERT's "or user_id = auth.uid()" bootstrap
--    escape hatch let ANY authenticated user self-join ANY group by
--    guessing its id, at any time -- not just the creator adding
--    themselves once at creation.
-- 3. group_members DELETE let any member remove any OTHER member;
--    only the owner should be able to remove someone else (anyone
--    can still remove themselves, i.e. leave).
-- ============================================================

drop policy "members can update group settings" on public.groups;
create policy "owner updates group settings"
  on public.groups for update to authenticated
  using (owner_id = auth.uid());

drop policy "members can add themselves or add others to a group they're in" on public.group_members;
create policy "owner or existing members can add members"
  on public.group_members for insert to authenticated
  with check (
    public.is_group_member(group_id, auth.uid())
    or exists (select 1 from public.groups g where g.id = group_id and g.owner_id = auth.uid())
  );

drop policy "members can remove themselves or remove others from a shared group" on public.group_members;
create policy "leave yourself, or the owner removes anyone"
  on public.group_members for delete to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.groups g where g.id = group_id and g.owner_id = auth.uid())
  );
