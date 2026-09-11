-- ============================================================
-- LinkUp: address Supabase security/performance advisor findings
-- ============================================================

-- ---- security: pin search_path on every SECURITY DEFINER / shared function
-- so a session-level search_path can't redirect unqualified references.
alter function public.set_updated_at() set search_path = public;
alter function public.is_blocked(uuid, uuid) set search_path = public;
alter function public.is_group_member(uuid, uuid) set search_path = public;
alter function public.is_group_member_text(text, uuid) set search_path = public;
alter function public.can_view_post(uuid, text, uuid) set search_path = public;
alter function public.protect_message_fields() set search_path = public;
alter function public.handle_new_user() set search_path = public;

-- ---- security: handle_new_user must only run as the auth.users trigger,
-- never as a directly callable RPC for anon/authenticated clients.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---- performance: add covering indexes for every flagged foreign key
create index clikes_user_idx on public.clikes (user_id);
create index closefriends_friend_idx on public.closefriends (friend_id);
create index comments_user_idx on public.comments (user_id);
create index group_reads_user_idx on public.group_reads (user_id);
create index groupcall_participants_user_idx on public.groupcall_participants (user_id);
create index groupcalls_starter_idx on public.groupcalls (starter_id);
create index groups_owner_idx on public.groups (owner_id);
create index gsig_from_idx on public.gsig (from_id);
create index gsig_group_idx on public.gsig (group_id);
create index likes_user_idx on public.likes (user_id);
create index messages_post_idx on public.messages (post_id);
create index messages_reply_to_idx on public.messages (reply_to_id);
create index notifications_actor_idx on public.notifications (actor_id);
create index notifications_post_idx on public.notifications (post_id);
create index pollvotes_user_idx on public.pollvotes (user_id);
create index postviews_user_idx on public.postviews (user_id);
create index push_subs_user_idx on public.push_subs (user_id);
create index reports_reporter_idx on public.reports (reporter_id);
create index story_likes_user_idx on public.story_likes (user_id);
create index typing_user_idx on public.typing (user_id);
