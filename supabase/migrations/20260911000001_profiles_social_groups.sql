-- ============================================================
-- LinkUp: profiles, social graph, groups
-- ============================================================
create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------- profiles ----------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  name text,
  bio text,
  avatar_url text,
  last_seen timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles are viewable by authenticated users"
  on public.profiles for select to authenticated using (true);

create policy "users can update their own profile"
  on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- auto-create a profile row whenever a new auth user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text, 1, 8)),
    new.raw_user_meta_data->>'name',
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------- follows ----------------
create table public.follows (
  id uuid primary key default gen_random_uuid(),
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (follower_id, following_id),
  check (follower_id <> following_id)
);
alter table public.follows enable row level security;
create index follows_follower_idx on public.follows (follower_id);
create index follows_following_idx on public.follows (following_id);

create policy "follows are viewable by authenticated users"
  on public.follows for select to authenticated using (true);
create policy "users can follow as themselves"
  on public.follows for insert to authenticated with check (auth.uid() = follower_id);
create policy "users can unfollow their own follow rows"
  on public.follows for delete to authenticated using (auth.uid() = follower_id);

-- ---------------- closefriends ----------------
create table public.closefriends (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (owner_id, friend_id),
  check (owner_id <> friend_id)
);
alter table public.closefriends enable row level security;
create index closefriends_owner_idx on public.closefriends (owner_id);

create policy "owners manage their own close-friends list"
  on public.closefriends for all to authenticated
  using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- ---------------- blocks ----------------
create table public.blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
alter table public.blocks enable row level security;
create index blocks_blocker_idx on public.blocks (blocker_id);
create index blocks_blocked_idx on public.blocks (blocked_id);

create policy "users manage their own block list"
  on public.blocks for all to authenticated
  using (auth.uid() = blocker_id) with check (auth.uid() = blocker_id);

create or replace function public.is_blocked(a uuid, b uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.blocks
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
  );
$$;

-- ---------------- reports (write-only from the client) ----------------
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('post', 'user')),
  target_id uuid not null,
  reason text,
  created_at timestamptz not null default now()
);
alter table public.reports enable row level security;
create policy "users can file reports"
  on public.reports for insert to authenticated with check (auth.uid() = reporter_id);

-- ---------------- groups ----------------
create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid references public.profiles(id) on delete set null,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.groups enable row level security;

create table public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
alter table public.group_members enable row level security;
create index group_members_user_idx on public.group_members (user_id);

create or replace function public.is_group_member(g uuid, u uuid)
returns boolean language sql stable as $$
  select exists (select 1 from public.group_members where group_id = g and user_id = u);
$$;

create or replace function public.is_group_member_text(g text, u uuid)
returns boolean language sql stable as $$
  select exists (select 1 from public.group_members where group_id::text = g and user_id = u);
$$;

create policy "members can view their groups"
  on public.groups for select to authenticated
  using (public.is_group_member(id, auth.uid()));
create policy "authenticated users can create a group as its owner"
  on public.groups for insert to authenticated with check (auth.uid() = owner_id);
create policy "members can update group settings"
  on public.groups for update to authenticated
  using (public.is_group_member(id, auth.uid()));
create policy "owner can delete the group"
  on public.groups for delete to authenticated using (auth.uid() = owner_id);

create trigger set_groups_updated_at
  before update on public.groups
  for each row execute function public.set_updated_at();

create policy "members can view membership rows for their groups"
  on public.group_members for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));
create policy "members can add themselves or add others to a group they're in"
  on public.group_members for insert to authenticated
  with check (public.is_group_member(group_id, auth.uid()) or user_id = auth.uid());
create policy "members can remove themselves or remove others from a shared group"
  on public.group_members for delete to authenticated
  using (public.is_group_member(group_id, auth.uid()));

create table public.group_reads (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
alter table public.group_reads enable row level security;
create policy "users manage their own group read markers"
  on public.group_reads for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
