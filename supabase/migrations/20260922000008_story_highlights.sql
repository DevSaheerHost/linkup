-- Stories vanish after 24h and leave nothing behind, so a profile has only
-- a grid on it. Highlights are the one thing that makes a profile worth
-- revisiting, and the whole story pipeline already exists.
--
-- Rows in `stories` are never purged (only hidden by the 24h filter in the
-- tray), so a highlight can reference the story itself rather than copying
-- the image into a second bucket.
--
-- (Applied to the live project on 2026-09-22; this file was added later to
-- bring the repo back in line with the database. Its owner policies were
-- split by 20261121000001_audit_fixes.)

create table if not exists public.highlights (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  title      text not null,
  cover_url  text,
  created_at timestamptz not null default now(),
  constraint highlights_title_len check (length(btrim(title)) between 1 and 40)
);

create index if not exists highlights_owner_idx on public.highlights (owner_id, created_at);

create table if not exists public.highlight_items (
  highlight_id uuid not null references public.highlights(id) on delete cascade,
  story_id     uuid not null references public.stories(id) on delete cascade,
  position     integer not null default 0,
  primary key (highlight_id, story_id)
);

create index if not exists highlight_items_order_idx on public.highlight_items (highlight_id, position);

alter table public.highlights enable row level security;
alter table public.highlight_items enable row level security;

drop policy if exists "highlights follow the owner's visibility" on public.highlights;
create policy "highlights follow the owner's visibility"
  on public.highlights for select to authenticated
  using (
    not public.is_blocked(owner_id, (select auth.uid()))
    and public.can_view_account(owner_id, (select auth.uid()))
  );

drop policy if exists "owners manage their own highlights" on public.highlights;
create policy "owners manage their own highlights"
  on public.highlights for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists "highlight items follow their highlight" on public.highlight_items;
create policy "highlight items follow their highlight"
  on public.highlight_items for select to authenticated
  using (exists (select 1 from public.highlights h where h.id = highlight_id));

drop policy if exists "owners manage their own highlight items" on public.highlight_items;
create policy "owners manage their own highlight items"
  on public.highlight_items for all to authenticated
  using (exists (select 1 from public.highlights h where h.id = highlight_id and h.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.highlights h where h.id = highlight_id and h.owner_id = (select auth.uid())));

drop trigger if exists rate_limit_highlights on public.highlights;
create trigger rate_limit_highlights before insert on public.highlights
  for each row execute function public.rate_limit_trigger('highlights', '50', '1 hour');
