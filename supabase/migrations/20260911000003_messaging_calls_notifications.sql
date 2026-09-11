-- ============================================================
-- LinkUp: messaging, calls, notifications, push
-- Realtime access control is enforced by RLS (see 20260911000004),
-- not by client-supplied filters, so every SELECT policy below is
-- the real security boundary for both queries and subscriptions.
-- ============================================================

-- ---------------- messages ----------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid references public.profiles(id) on delete cascade,
  group_id uuid references public.groups(id) on delete cascade,
  conversation text not null,
  text text,
  image_url text,
  audio_url text,
  post_id uuid references public.posts(id) on delete set null,
  call text,
  sys text,
  read boolean not null default false,
  played boolean not null default false,
  reply_to_id uuid references public.messages(id) on delete set null,
  reply_meta jsonb,
  reactions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((receiver_id is not null) <> (group_id is not null))
);
alter table public.messages enable row level security;
create index messages_conversation_idx on public.messages (conversation, created_at);
create index messages_group_idx on public.messages (group_id, created_at);
create index messages_sender_idx on public.messages (sender_id);
create index messages_receiver_idx on public.messages (receiver_id);

create trigger set_messages_updated_at
  before update on public.messages
  for each row execute function public.set_updated_at();

create policy "participants view their messages"
  on public.messages for select to authenticated
  using (
    sender_id = auth.uid()
    or receiver_id = auth.uid()
    or (group_id is not null and public.is_group_member(group_id, auth.uid()))
  );
create policy "senders send if not blocked (dm) or a group member"
  on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and (
      (receiver_id is not null and not public.is_blocked(sender_id, receiver_id))
      or (group_id is not null and public.is_group_member(group_id, auth.uid()))
    )
  );
create policy "participants can update a message (read/played/reactions; sender edits content)"
  on public.messages for update to authenticated
  using (
    sender_id = auth.uid()
    or receiver_id = auth.uid()
    or (group_id is not null and public.is_group_member(group_id, auth.uid()))
  );
create policy "sender deletes their own message"
  on public.messages for delete to authenticated using (sender_id = auth.uid());

-- defense in depth: non-senders may only toggle read/played/reactions,
-- never rewrite message content or reroute it to someone else.
create or replace function public.protect_message_fields()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is distinct from old.sender_id then
    if new.text is distinct from old.text
       or new.image_url is distinct from old.image_url
       or new.audio_url is distinct from old.audio_url
       or new.sender_id is distinct from old.sender_id
       or new.receiver_id is distinct from old.receiver_id
       or new.group_id is distinct from old.group_id
       or new.reply_to_id is distinct from old.reply_to_id
       or new.reply_meta is distinct from old.reply_meta
       or new.post_id is distinct from old.post_id
       or new.call is distinct from old.call
       or new.sys is distinct from old.sys
    then
      raise exception 'only the sender may edit message content';
    end if;
  end if;
  return new;
end;
$$;

create trigger protect_messages_before_update
  before update on public.messages
  for each row execute function public.protect_message_fields();

-- ---------------- typing ----------------
create table public.typing (
  conversation text not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (conversation, user_id)
);
alter table public.typing enable row level security;

create policy "typing visible to conversation participants"
  on public.typing for select to authenticated
  using (
    user_id = auth.uid()
    or conversation = (least(auth.uid()::text, user_id::text) || '_' || greatest(auth.uid()::text, user_id::text))
  );
create policy "users set their own typing row"
  on public.typing for insert to authenticated with check (auth.uid() = user_id);
create policy "users update their own typing row"
  on public.typing for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users delete their own typing row"
  on public.typing for delete to authenticated using (auth.uid() = user_id);

-- ---------------- calls (1:1 signaling) ----------------
create table public.calls (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references public.profiles(id) on delete cascade,
  callee_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('audio', 'video')),
  status text not null default 'ringing' check (status in ('ringing', 'accepted', 'declined', 'ended', 'missed')),
  offer text,
  answer text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.calls enable row level security;
create index calls_caller_idx on public.calls (caller_id);
create index calls_callee_idx on public.calls (callee_id);

create trigger set_calls_updated_at
  before update on public.calls
  for each row execute function public.set_updated_at();

create policy "participants view their calls"
  on public.calls for select to authenticated using (caller_id = auth.uid() or callee_id = auth.uid());
create policy "caller starts a call if not blocked"
  on public.calls for insert to authenticated
  with check (caller_id = auth.uid() and not public.is_blocked(caller_id, callee_id));
create policy "participants update call state"
  on public.calls for update to authenticated using (caller_id = auth.uid() or callee_id = auth.uid());

-- ---------------- groupcalls ----------------
create table public.groupcalls (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  kind text not null check (kind in ('audio', 'video')),
  starter_id uuid not null references public.profiles(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.groupcalls enable row level security;
create index groupcalls_group_idx on public.groupcalls (group_id, active);

create trigger set_groupcalls_updated_at
  before update on public.groupcalls
  for each row execute function public.set_updated_at();

create policy "group members view their group calls"
  on public.groupcalls for select to authenticated using (public.is_group_member(group_id, auth.uid()));
create policy "group members can start a group call"
  on public.groupcalls for insert to authenticated
  with check (starter_id = auth.uid() and public.is_group_member(group_id, auth.uid()));
create policy "group members update call state"
  on public.groupcalls for update to authenticated using (public.is_group_member(group_id, auth.uid()));

create table public.groupcall_participants (
  groupcall_id uuid not null references public.groupcalls(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (groupcall_id, user_id)
);
alter table public.groupcall_participants enable row level security;

create policy "group members view participants of their group calls"
  on public.groupcall_participants for select to authenticated
  using (exists (
    select 1 from public.groupcalls gc where gc.id = groupcall_id and public.is_group_member(gc.group_id, auth.uid())
  ));
create policy "group members can join a group call"
  on public.groupcall_participants for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.groupcalls gc where gc.id = groupcall_id and public.is_group_member(gc.group_id, auth.uid()))
  );
create policy "users remove themselves from a group call"
  on public.groupcall_participants for delete to authenticated using (user_id = auth.uid());

-- ---------------- gsig (group call WebRTC signaling) ----------------
create table public.gsig (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  from_id uuid not null references public.profiles(id) on delete cascade,
  to_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('offer', 'answer', 'leave')),
  data text,
  created_at timestamptz not null default now()
);
alter table public.gsig enable row level security;
create index gsig_to_idx on public.gsig (to_id, created_at);

create policy "recipient reads their signaling messages"
  on public.gsig for select to authenticated using (to_id = auth.uid());
create policy "group members send signaling as themselves"
  on public.gsig for insert to authenticated
  with check (from_id = auth.uid() and public.is_group_member(group_id, auth.uid()));

-- gsig is pure signaling exhaust; prune it hourly so it never grows unbounded
create extension if not exists pg_cron;
select cron.schedule('gsig-cleanup', '*/15 * * * *', $$delete from public.gsig where created_at < now() - interval '1 hour'$$);
select cron.schedule('calls-cleanup', '0 * * * *', $$delete from public.calls where status in ('ended','declined','missed') and created_at < now() - interval '24 hours'$$);
select cron.schedule('groupcalls-cleanup', '0 * * * *', $$delete from public.groupcalls where active = false and created_at < now() - interval '24 hours'$$);

-- ---------------- notifications ----------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('like', 'comment', 'tag', 'storylike', 'follow')),
  post_id uuid references public.posts(id) on delete cascade,
  text text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.notifications enable row level security;
create index notifications_user_created_idx on public.notifications (user_id, created_at desc);
create index notifications_user_read_idx on public.notifications (user_id, read);

create policy "users view their own notifications"
  on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "authenticated users can notify someone else"
  on public.notifications for insert to authenticated with check (actor_id = auth.uid() and user_id <> auth.uid());
create policy "recipients mark their notifications read"
  on public.notifications for update to authenticated using (user_id = auth.uid());

-- ---------------- push_subs ----------------
create table public.push_subs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  sub jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;

create trigger set_push_subs_updated_at
  before update on public.push_subs
  for each row execute function public.set_updated_at();

create policy "users manage their own push subscriptions"
  on public.push_subs for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
