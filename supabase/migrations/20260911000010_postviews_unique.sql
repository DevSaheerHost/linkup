-- View counts were counting every insert instead of unique viewers: nothing
-- enforced the intended one-row-per-(post,user) semantics server-side, so a
-- viewer reopening the app (which resets the client's in-memory de-dupe set)
-- kept adding new rows for posts/reels they'd already viewed.

-- Collapse existing duplicate view rows down to one per (post_id, user_id)
-- pair before the unique constraint can be added.
delete from public.postviews
where ctid not in (
  select min(ctid) from public.postviews group by post_id, user_id
);

alter table public.postviews
  add constraint postviews_post_user_uniq unique (post_id, user_id);
