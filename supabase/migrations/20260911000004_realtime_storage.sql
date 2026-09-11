-- ============================================================
-- LinkUp: realtime publication + storage buckets/policies
-- ============================================================

-- ---------------- realtime ----------------
-- Clients subscribe broadly (no client-supplied filter); Postgres RLS
-- (the SELECT policies from the previous migrations) decides which
-- rows of each change are actually delivered to a given subscriber.
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.typing;
alter publication supabase_realtime add table public.notifications;
alter publication supabase_realtime add table public.posts;
alter publication supabase_realtime add table public.calls;
alter publication supabase_realtime add table public.gsig;
alter publication supabase_realtime add table public.groupcalls;
alter publication supabase_realtime add table public.pollvotes;
alter publication supabase_realtime add table public.profiles;

-- ---------------- storage buckets ----------------
insert into storage.buckets (id, name, public)
values
  ('avatars', 'avatars', true),
  ('posts', 'posts', true),
  ('stories', 'stories', true),
  ('chat', 'chat', false)
on conflict (id) do nothing;

-- avatars: public read, write restricted to the user's own folder (<uid>/...)
create policy "avatar images are publicly readable"
  on storage.objects for select using (bucket_id = 'avatars');
create policy "users upload their own avatar"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users update their own avatar"
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users delete their own avatar"
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- posts media: public read (feed content), write restricted to the author's folder
create policy "post media is publicly readable"
  on storage.objects for select using (bucket_id = 'posts');
create policy "authors upload their own post media"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'posts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "authors update their own post media"
  on storage.objects for update to authenticated
  using (bucket_id = 'posts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "authors delete their own post media"
  on storage.objects for delete to authenticated
  using (bucket_id = 'posts' and (storage.foldername(name))[1] = auth.uid()::text);

-- stories media: public read, write restricted to the author's folder
create policy "story media is publicly readable"
  on storage.objects for select using (bucket_id = 'stories');
create policy "authors upload their own story media"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'stories' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "authors delete their own story media"
  on storage.objects for delete to authenticated
  using (bucket_id = 'stories' and (storage.foldername(name))[1] = auth.uid()::text);

-- chat media: private bucket. Path convention: <conversation-or-group-id>/<file>.
-- Read is only granted if a messages row actually references that folder AND
-- the requester is a participant (sender, receiver, or group member) — so
-- knowing a file's path alone is not enough to read it.
create policy "chat media readable by conversation participants"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'chat'
    and exists (
      select 1 from public.messages m
      where (
        (m.group_id is not null and (storage.foldername(name))[1] = m.group_id::text)
        or (m.group_id is null and (storage.foldername(name))[1] = m.conversation)
      )
      and (
        m.sender_id = auth.uid()
        or m.receiver_id = auth.uid()
        or (m.group_id is not null and public.is_group_member(m.group_id, auth.uid()))
      )
    )
  );
create policy "authenticated users upload chat media into a conversation they belong to"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat'
    and (
      public.is_group_member_text((storage.foldername(name))[1], auth.uid())
      or (storage.foldername(name))[1] like '%' || auth.uid()::text || '%'
    )
  );
