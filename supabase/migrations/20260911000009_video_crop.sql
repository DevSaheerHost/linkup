-- ============================================================
-- LinkUp: store the chosen pinch-zoom/pan framing for video posts
--
-- Video isn't re-encoded client-side (no ffmpeg.wasm), so the crop
-- is "visual reframe only": {zoom, fx, fy} where fx/fy are the pan
-- center as a fraction (0..1) of the video's natural width/height.
-- The feed re-applies the same transform on render so every viewer
-- sees the framing the poster chose.
-- ============================================================
alter table public.posts add column video_crop jsonb;
