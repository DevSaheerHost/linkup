-- ============================================================
-- LinkUp: posts, engagement, stories
-- ============================================================

-- ---------------- posts ----------------
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  caption text,
  audience text not null default 'public' check (audience in ('public', 'close')),
  tags text,
  image_url text,
  photos text[],
  video_url text,
  thumb_url text,
  poll jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.posts enable row level security;
create index posts_author_idx on public.posts (author_id);
create index posts_created_idx on public.posts (created_at desc);
create index posts_video_idx on public.posts (created_at desc) where video_url is not null;

create trigger set_posts_updated_at
  before update on public.posts
  for each row execute function public.set_updated_at();

create or replace function public.can_view_post(p_author uuid, p_audience text, viewer uuid)
returns boolean language sql stable as $$
  select
    not public.is_blocked(p_author, viewer)
    and (
      p_audience = 'public'
      or p_author = viewer
      or exists (select 1 from public.closefriends where owner_id = p_author and friend_id = viewer)
    );
$$;

create policy "viewable posts"
  on public.posts for select to authenticated
  using (public.can_view_post(author_id, audience, auth.uid()));
create policy "authors create their own posts"
  on public.posts for insert to authenticated with check (auth.uid() = author_id);
create policy "authors manage their own posts"
  on public.posts for update to authenticated using (auth.uid() = author_id);
create policy "authors delete their own posts"
  on public.posts for delete to authenticated using (auth.uid() = author_id);

-- ---------------- comments ----------------
create table public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  text text not null,
  parent_id uuid references public.comments(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.comments enable row level security;
create index comments_post_idx on public.comments (post_id);
create index comments_parent_idx on public.comments (parent_id);

create policy "comments viewable if the post is viewable"
  on public.comments for select to authenticated
  using (exists (
    select 1 from public.posts p
    where p.id = post_id and public.can_view_post(p.author_id, p.audience, auth.uid())
  ));
create policy "authenticated users can comment on viewable posts"
  on public.comments for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.posts p where p.id = post_id and public.can_view_post(p.author_id, p.audience, auth.uid()))
  );
create policy "users manage their own comments"
  on public.comments for update to authenticated using (auth.uid() = user_id);
create policy "users delete their own comments"
  on public.comments for delete to authenticated using (auth.uid() = user_id);

-- ---------------- likes (post likes) ----------------
create table public.likes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);
alter table public.likes enable row level security;
create index likes_post_idx on public.likes (post_id);

create policy "likes viewable if the post is viewable"
  on public.likes for select to authenticated
  using (exists (select 1 from public.posts p where p.id = post_id and public.can_view_post(p.author_id, p.audience, auth.uid())));
create policy "users like as themselves"
  on public.likes for insert to authenticated with check (auth.uid() = user_id);
create policy "users remove their own like"
  on public.likes for delete to authenticated using (auth.uid() = user_id);

-- ---------------- clikes (comment likes) ----------------
create table public.clikes (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (comment_id, user_id)
);
alter table public.clikes enable row level security;
create index clikes_comment_idx on public.clikes (comment_id);

create policy "comment likes viewable if the comment is viewable"
  on public.clikes for select to authenticated
  using (exists (
    select 1 from public.comments c join public.posts p on p.id = c.post_id
    where c.id = comment_id and public.can_view_post(p.author_id, p.audience, auth.uid())
  ));
create policy "users like comments as themselves"
  on public.clikes for insert to authenticated with check (auth.uid() = user_id);
create policy "users remove their own comment like"
  on public.clikes for delete to authenticated using (auth.uid() = user_id);

-- ---------------- saves (bookmarks) ----------------
create table public.saves (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);
alter table public.saves enable row level security;
create index saves_user_idx on public.saves (user_id);

create policy "users view their own saves"
  on public.saves for select to authenticated using (auth.uid() = user_id);
create policy "users save as themselves"
  on public.saves for insert to authenticated with check (auth.uid() = user_id);
create policy "users remove their own save"
  on public.saves for delete to authenticated using (auth.uid() = user_id);

-- ---------------- postviews ----------------
create table public.postviews (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.postviews enable row level security;
create index postviews_post_idx on public.postviews (post_id);

create policy "post author sees view rows; viewer sees their own"
  on public.postviews for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid()));
create policy "authenticated users can record a view"
  on public.postviews for insert to authenticated with check (auth.uid() = user_id);

-- ---------------- pollvotes ----------------
create table public.pollvotes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  choice int not null,
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);
alter table public.pollvotes enable row level security;
create index pollvotes_post_idx on public.pollvotes (post_id);

create policy "poll votes viewable if the post is viewable"
  on public.pollvotes for select to authenticated
  using (exists (select 1 from public.posts p where p.id = post_id and public.can_view_post(p.author_id, p.audience, auth.uid())));
create policy "users vote as themselves on viewable posts"
  on public.pollvotes for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.posts p where p.id = post_id and public.can_view_post(p.author_id, p.audience, auth.uid()))
  );
create policy "users change their own vote"
  on public.pollvotes for update to authenticated using (auth.uid() = user_id);

-- ---------------- stories ----------------
create table public.stories (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  image_url text not null,
  tags text,
  created_at timestamptz not null default now()
);
alter table public.stories enable row level security;
create index stories_author_idx on public.stories (author_id);
create index stories_created_idx on public.stories (created_at);

create policy "stories viewable unless blocked"
  on public.stories for select to authenticated using (not public.is_blocked(author_id, auth.uid()));
create policy "authors create their own stories"
  on public.stories for insert to authenticated with check (auth.uid() = author_id);
create policy "authors delete their own stories"
  on public.stories for delete to authenticated using (auth.uid() = author_id);

-- ---------------- story_views ----------------
create table public.story_views (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (story_id, viewer_id)
);
alter table public.story_views enable row level security;
create index story_views_viewer_idx on public.story_views (viewer_id);

create policy "story author sees viewers; viewer sees their own view"
  on public.story_views for select to authenticated
  using (
    viewer_id = auth.uid()
    or exists (select 1 from public.stories s where s.id = story_id and s.author_id = auth.uid())
  );
create policy "authenticated users can record a story view"
  on public.story_views for insert to authenticated with check (auth.uid() = viewer_id);

-- ---------------- story_likes ----------------
create table public.story_likes (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (story_id, user_id)
);
alter table public.story_likes enable row level security;

create policy "story likes viewable by author and liker"
  on public.story_likes for select to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.stories s where s.id = story_id and s.author_id = auth.uid())
  );
create policy "users like stories as themselves"
  on public.story_likes for insert to authenticated with check (auth.uid() = user_id);
create policy "users remove their own story like"
  on public.story_likes for delete to authenticated using (auth.uid() = user_id);
