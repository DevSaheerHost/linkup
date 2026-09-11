-- ============================================================
-- LinkUp: notify comment authors on replies and comment likes
--
-- Previously only post likes, top-level comments, tags, story likes,
-- and follows generated a notification. Liking someone's comment, or
-- replying to someone's comment, silently notified nobody but the
-- post's author (or nobody at all for comment likes). Adds two new
-- notification types plus a comment_id column so both can link back
-- to the specific comment.
-- ============================================================

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like', 'comment', 'reply', 'commentlike', 'tag', 'storylike', 'follow'));

alter table public.notifications add column comment_id uuid references public.comments(id) on delete cascade;
create index notifications_comment_idx on public.notifications (comment_id);
