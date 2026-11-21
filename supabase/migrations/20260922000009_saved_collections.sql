-- Saves were a flat list, which turns into a graveyard the moment it has
-- more than a screenful in it. Named collections make it a tool.
--
-- A save can sit in several collections, or in none - "no collection" is
-- the default bucket, not a special row - so this is a join table beside
-- the existing saves rather than a column on it.
--
-- (Applied to the live project on 2026-09-22; this file was added later to
-- bring the repo back in line with the database.)

create table if not exists public.collections (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  constraint collections_name_len check (length(btrim(name)) between 1 and 40),
  constraint collections_name_unique unique (owner_id, name)
);

create table if not exists public.collection_items (
  collection_id uuid not null references public.collections(id) on delete cascade,
  post_id       uuid not null references public.posts(id) on delete cascade,
  added_at      timestamptz not null default now(),
  primary key (collection_id, post_id)
);

create index if not exists collection_items_recent_idx
  on public.collection_items (collection_id, added_at desc);

alter table public.collections enable row level security;
alter table public.collection_items enable row level security;

-- What you saved is nobody else's business, so unlike highlights these are
-- strictly private - no visibility rules to share, just the owner.
drop policy if exists "owners manage their own collections" on public.collections;
create policy "owners manage their own collections"
  on public.collections for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists "owners manage their own collection items" on public.collection_items;
create policy "owners manage their own collection items"
  on public.collection_items for all to authenticated
  using (exists (select 1 from public.collections c where c.id = collection_id and c.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.collections c where c.id = collection_id and c.owner_id = (select auth.uid())));

drop trigger if exists rate_limit_collections on public.collections;
create trigger rate_limit_collections before insert on public.collections
  for each row execute function public.rate_limit_trigger('collections', '50', '1 hour');
