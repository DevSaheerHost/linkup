-- Covers the not_interested_post_id_fkey foreign key and the
-- "not exists (... where ni.post_id = p.id ...)" per-candidate lookup
-- in get_feed_for_you/get_reels_for_you.
create index not_interested_post_id_idx on public.not_interested (post_id);
