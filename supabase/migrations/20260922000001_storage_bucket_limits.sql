-- Every bucket was created with file_size_limit null and allowed_mime_types
-- null, so the only thing keeping uploads sane was the client: compressImage()
-- and an accept="" on a file input, both of which a direct PostgREST/storage
-- call skips entirely. Anyone with a session could push a multi-gigabyte file,
-- or an SVG/HTML document into a *public* bucket and hand out the URL.
--
-- Limits below are sized off what the app actually stores today (largest real
-- object per bucket: avatars 34 KB, stories 268 KB, chat 2.7 MB, posts 20 MB
-- of video) with room to grow, so nothing already uploaded becomes unusable.
--
-- SVG is deliberately absent from every allowlist: it is a script-bearing
-- document, and these buckets are served from an origin that renders it.

update storage.buckets set
  file_size_limit = 5 * 1024 * 1024,
  allowed_mime_types = array['image/jpeg','image/png','image/webp']
where id = 'avatars';

update storage.buckets set
  file_size_limit = 15 * 1024 * 1024,
  allowed_mime_types = array['image/jpeg','image/png','image/webp']
where id = 'stories';

-- Photos are canvas-compressed to JPEG client-side; voice notes come out of
-- MediaRecorder as webm/opus on Android+desktop and mp4/aac on iOS.
update storage.buckets set
  file_size_limit = 25 * 1024 * 1024,
  allowed_mime_types = array[
    'image/jpeg','image/png','image/webp',
    'audio/webm','audio/mp4','audio/mpeg','audio/ogg'
  ]
where id = 'chat';

-- Video is the one thing uploaded raw (no transcode), and an iPhone hands
-- over video/quicktime, so both it and mp4/webm have to be allowed.
update storage.buckets set
  file_size_limit = 150 * 1024 * 1024,
  allowed_mime_types = array[
    'image/jpeg','image/png','image/webp',
    'video/mp4','video/quicktime','video/webm'
  ]
where id = 'posts';
