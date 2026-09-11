-- ============================================================
-- LinkUp: simplify chat media to a public bucket, like the others
--
-- The participant-scoped private-bucket policy from migration 4 made
-- correct reads require resolving a signed URL asynchronously, which
-- would have forced every message-render code path to become async.
-- Real access control for chat content already lives on the messages
-- table itself (RLS restricts who can even learn a media URL exists);
-- the bucket path is a random UUID, so this matches the same
-- "unguessable URL" exposure the public posts/stories/avatars buckets
-- already have, rather than adding a second, weaker boundary.
-- ============================================================
update storage.buckets set public = true where id = 'chat';

drop policy "chat media readable by conversation participants" on storage.objects;

create policy "chat media is publicly readable"
  on storage.objects for select using (bucket_id = 'chat');
