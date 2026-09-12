-- Posts and stories only supported a single heart. DMs already had six
-- reaction types (like/love/haha/wow/sad/fire) - this brings the same
-- vocabulary to posts and stories. Both tables already have a unique
-- (target, user_id) row per user, so a reaction column fits without any
-- new table: existing rows keep meaning what they meant (the heart, i.e.
-- 'love'), and a plain tap still writes 'love' so nothing about the
-- current UX changes for people who never long-press.
alter table public.likes
  add column reaction text not null default 'love'
  check (reaction in ('like','love','haha','wow','sad','fire'));

alter table public.story_likes
  add column reaction text not null default 'love'
  check (reaction in ('like','love','haha','wow','sad','fire'));

-- Changing your reaction is an UPDATE; neither table had an UPDATE policy
-- (they were insert/delete only), so without this the client would have to
-- delete and re-insert, which would churn ids and lose created_at ordering.
create policy "users change their own reaction"
on public.likes for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "users change their own story reaction"
on public.story_likes for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));
