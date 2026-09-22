-- DM photos and voice notes were in a public bucket with a `public`-role
-- SELECT policy, so anyone holding (or stumbling onto) the URL could fetch a
-- private message's media without being logged in at all. The URLs are random
-- UUIDs, so this was unguessable rather than browsable - but "unguessable" is
-- not the privacy guarantee a messaging app owes its users.
--
-- Reads now require being in the conversation, mirroring the INSERT policy
-- that already governs uploads: either a member of the group whose id names
-- the folder, or a participant in the `a_b` conversation key that does.

update storage.buckets set public = false where id = 'chat';

drop policy if exists "chat media is publicly readable" on storage.objects;

create policy "chat media is readable by the conversation's participants"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'chat'
    and (
      public.is_group_member_text((storage.foldername(name))[1], (select auth.uid()))
      or (storage.foldername(name))[1] like '%' || (select auth.uid())::text || '%'
    )
  );

-- Media columns held a full public URL, which no longer resolves. Store the
-- object path instead and sign it at render time. (The client also accepts
-- the old shape, so a row missed here still renders.)
--
-- protect_message_fields() refuses any edit to message content by someone
-- who is not the sender, and a migration has no auth.uid() - correct
-- behaviour, so stand the guard down for this rewrite only and put it back
-- in the same transaction rather than weakening the rule.
alter table public.messages disable trigger protect_messages_before_update;

update public.messages
   set image_url = regexp_replace(image_url, '^.*/storage/v1/object/public/chat/', '')
 where image_url like '%/storage/v1/object/public/chat/%';

update public.messages
   set audio_url = regexp_replace(audio_url, '^.*/storage/v1/object/public/chat/', '')
 where audio_url like '%/storage/v1/object/public/chat/%';

alter table public.messages enable trigger protect_messages_before_update;
