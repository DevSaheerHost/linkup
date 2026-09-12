-- Topic affinity previously only looked at explicit #hashtags, so a caption
-- like "Made pasta tonight" (relevant to someone into cooking, no #tag)
-- got zero topic credit. Adds a second, lower-confidence signal: plain
-- caption words (stopwords/hashtags/short words filtered out), matched the
-- same way hashtags are but weighted less in the final score - an explicit
-- #cooking is a deliberate signal, a stray word in a sentence is weaker
-- evidence of topic.
create or replace function public.extract_keywords(caption text) returns text[]
language sql immutable set search_path = public as $$
  select coalesce(array_agg(distinct w), '{}'::text[])
  from (
    select lower(word) as w
    from regexp_split_to_table(
      regexp_replace(coalesce(caption,''), '#[[:alnum:]_]+', ' ', 'g'), -- strip hashtags first, they're their own signal
      '[^[:alnum:]]+'
    ) as word
    where length(word) >= 4
      and word !~ '^[0-9]+$'
      and lower(word) <> all (array[
        -- standard English stopwords
        'this','that','these','those','with','from','have','has','had','just','when','what','your',
        'yours','their','theirs','there','here','were','been','they','them','then','than','some',
        'more','most','very','over','into','about','after','before','while','also','only','still',
        'even','back','around','will','would','could','should','shall','must','being','does','doing',
        'done','going','look','looks','looking','want','wants','wanted','need','needs','needed',
        'know','knows','knew','feel','feels','felt','thing','things','people','everyone','everybody',
        'everything','anyone','anything','someone','something','nobody','nothing','which','where',
        'whom','whose','because','since','until','unless','although','though','however','therefore',
        'each','every','both','either','neither','other','another','such','same','again','further',
        'once','here','above','below','between','under','again','once','myself','yourself','himself',
        'herself','itself','ourselves','yourselves','themselves','ours','mine','yours'
      ])
  ) t
$$;

alter table public.posts add column keywords text[]
  generated always as (public.extract_keywords(caption)) stored;
create index posts_keywords_gin on public.posts using gin (keywords);

create or replace function public.get_feed_for_you(
  cursor_score float8 default null,
  cursor_created_at timestamptz default null,
  cursor_id uuid default null,
  page_size int default 9
) returns table (
  id uuid, author_id uuid, caption text, audience text, tags text,
  image_url text, photos text[], video_url text, thumb_url text, poll jsonb,
  created_at timestamptz, updated_at timestamptz, hashtags text[], score float8
) language sql stable security definer set search_path = public as $$
  with my_author_engagement as (
    select author_id, sum(weight * exp(-extract(epoch from (now()-at))/2592000.0)) as val
    from (
      select p.author_id, l.created_at as at, 1.0 as weight from public.likes l join public.posts p on p.id=l.post_id where l.user_id=auth.uid()
      union all
      select p.author_id, c.created_at, 2.0 from public.comments c join public.posts p on p.id=c.post_id where c.user_id=auth.uid()
      union all
      select p.author_id, s.created_at, 1.5 from public.saves s join public.posts p on p.id=s.post_id where s.user_id=auth.uid()
      union all
      select p.author_id, v.created_at, 0.5 from public.postviews v join public.posts p on p.id=v.post_id where v.user_id=auth.uid()
      union all
      select f.following_id, f.created_at, 3.0 from public.follows f where f.follower_id=auth.uid()
    ) e
    group by author_id
  ),
  my_hashtag_engagement as (
    select tag, sum(weight * exp(-extract(epoch from (now()-at))/2592000.0)) as val
    from (
      select unnest(p.hashtags) as tag, l.created_at as at, 1.0 as weight from public.likes l join public.posts p on p.id=l.post_id where l.user_id=auth.uid()
      union all
      select unnest(p.hashtags), c.created_at, 2.0 from public.comments c join public.posts p on p.id=c.post_id where c.user_id=auth.uid()
      union all
      select unnest(p.hashtags), s.created_at, 1.5 from public.saves s join public.posts p on p.id=s.post_id where s.user_id=auth.uid()
      union all
      select unnest(p.hashtags), v.created_at, 0.5 from public.postviews v join public.posts p on p.id=v.post_id where v.user_id=auth.uid()
    ) e
    group by tag
  ),
  my_keyword_engagement as (
    select word, sum(weight * exp(-extract(epoch from (now()-at))/2592000.0)) as val
    from (
      select unnest(p.keywords) as word, l.created_at as at, 1.0 as weight from public.likes l join public.posts p on p.id=l.post_id where l.user_id=auth.uid()
      union all
      select unnest(p.keywords), c.created_at, 2.0 from public.comments c join public.posts p on p.id=c.post_id where c.user_id=auth.uid()
      union all
      select unnest(p.keywords), s.created_at, 1.5 from public.saves s join public.posts p on p.id=s.post_id where s.user_id=auth.uid()
      union all
      select unnest(p.keywords), v.created_at, 0.5 from public.postviews v join public.posts p on p.id=v.post_id where v.user_id=auth.uid()
    ) e
    group by word
  ),
  candidates as (
    select
      p.id, p.author_id, p.caption, p.audience, p.tags, p.image_url, p.photos,
      p.video_url, p.thumb_url, p.poll, p.created_at, p.updated_at, p.hashtags,
      coalesce((select val from my_author_engagement a where a.author_id=p.author_id), 0) as author_aff,
      coalesce((select sum(h.val) from my_hashtag_engagement h where h.tag = any(p.hashtags)), 0) as topic_aff,
      coalesce((select sum(k.val) from my_keyword_engagement k where k.word = any(p.keywords)), 0) as keyword_aff,
      (select count(*) from public.likes l where l.post_id=p.id)::float8 as like_ct,
      (select count(*) from public.comments c where c.post_id=p.id)::float8 as comment_ct,
      (select count(*) from public.postviews v where v.post_id=p.id)::float8 as view_ct
    from public.posts p
    where p.created_at > now() - interval '60 days'
      and p.author_id <> auth.uid()
      and public.can_view_post(p.author_id, p.audience, auth.uid())
  ),
  scored as (
    select *,
      ( 3.0*author_aff + 2.0*topic_aff + 0.6*keyword_aff
        + 1.0*ln(1+like_ct+2*comment_ct+0.1*view_ct)
        + 4.0*exp(-extract(epoch from (now()-created_at))/172800.0)
        + random()*0.5
      ) as _score
    from candidates
  )
  select s.id, s.author_id, s.caption, s.audience, s.tags, s.image_url, s.photos,
         s.video_url, s.thumb_url, s.poll, s.created_at, s.updated_at, s.hashtags, s._score
  from scored s
  where cursor_score is null
     or (s._score, s.created_at, s.id) < (cursor_score, cursor_created_at, cursor_id)
  order by s._score desc, s.created_at desc, s.id desc
  limit page_size
$$;

create or replace function public.get_reels_for_you(
  cursor_score float8 default null,
  cursor_created_at timestamptz default null,
  cursor_id uuid default null,
  page_size int default 4
) returns table (
  id uuid, author_id uuid, caption text, audience text, tags text,
  image_url text, photos text[], video_url text, thumb_url text, poll jsonb,
  created_at timestamptz, updated_at timestamptz, hashtags text[], score float8
) language sql stable security definer set search_path = public as $$
  with my_author_engagement as (
    select author_id, sum(weight * exp(-extract(epoch from (now()-at))/2592000.0)) as val
    from (
      select p.author_id, l.created_at as at, 1.0 as weight from public.likes l join public.posts p on p.id=l.post_id where l.user_id=auth.uid()
      union all
      select p.author_id, c.created_at, 2.0 from public.comments c join public.posts p on p.id=c.post_id where c.user_id=auth.uid()
      union all
      select p.author_id, s.created_at, 1.5 from public.saves s join public.posts p on p.id=s.post_id where s.user_id=auth.uid()
      union all
      select p.author_id, v.created_at, 0.5 from public.postviews v join public.posts p on p.id=v.post_id where v.user_id=auth.uid()
      union all
      select f.following_id, f.created_at, 3.0 from public.follows f where f.follower_id=auth.uid()
    ) e
    group by author_id
  ),
  my_hashtag_engagement as (
    select tag, sum(weight * exp(-extract(epoch from (now()-at))/2592000.0)) as val
    from (
      select unnest(p.hashtags) as tag, l.created_at as at, 1.0 as weight from public.likes l join public.posts p on p.id=l.post_id where l.user_id=auth.uid()
      union all
      select unnest(p.hashtags), c.created_at, 2.0 from public.comments c join public.posts p on p.id=c.post_id where c.user_id=auth.uid()
      union all
      select unnest(p.hashtags), s.created_at, 1.5 from public.saves s join public.posts p on p.id=s.post_id where s.user_id=auth.uid()
      union all
      select unnest(p.hashtags), v.created_at, 0.5 from public.postviews v join public.posts p on p.id=v.post_id where v.user_id=auth.uid()
    ) e
    group by tag
  ),
  my_keyword_engagement as (
    select word, sum(weight * exp(-extract(epoch from (now()-at))/2592000.0)) as val
    from (
      select unnest(p.keywords) as word, l.created_at as at, 1.0 as weight from public.likes l join public.posts p on p.id=l.post_id where l.user_id=auth.uid()
      union all
      select unnest(p.keywords), c.created_at, 2.0 from public.comments c join public.posts p on p.id=c.post_id where c.user_id=auth.uid()
      union all
      select unnest(p.keywords), s.created_at, 1.5 from public.saves s join public.posts p on p.id=s.post_id where s.user_id=auth.uid()
      union all
      select unnest(p.keywords), v.created_at, 0.5 from public.postviews v join public.posts p on p.id=v.post_id where v.user_id=auth.uid()
    ) e
    group by word
  ),
  candidates as (
    select
      p.id, p.author_id, p.caption, p.audience, p.tags, p.image_url, p.photos,
      p.video_url, p.thumb_url, p.poll, p.created_at, p.updated_at, p.hashtags,
      coalesce((select val from my_author_engagement a where a.author_id=p.author_id), 0) as author_aff,
      coalesce((select sum(h.val) from my_hashtag_engagement h where h.tag = any(p.hashtags)), 0) as topic_aff,
      coalesce((select sum(k.val) from my_keyword_engagement k where k.word = any(p.keywords)), 0) as keyword_aff,
      (select count(*) from public.likes l where l.post_id=p.id)::float8 as like_ct,
      (select count(*) from public.comments c where c.post_id=p.id)::float8 as comment_ct,
      (select count(*) from public.postviews v where v.post_id=p.id)::float8 as view_ct
    from public.posts p
    where p.video_url is not null
      and p.created_at > now() - interval '60 days'
      and p.author_id <> auth.uid()
      and public.can_view_post(p.author_id, p.audience, auth.uid())
  ),
  scored as (
    select *,
      ( 3.0*author_aff + 2.0*topic_aff + 0.6*keyword_aff
        + 1.0*ln(1+like_ct+2*comment_ct+0.1*view_ct)
        + 4.0*exp(-extract(epoch from (now()-created_at))/172800.0)
        + random()*0.5
      ) as _score
    from candidates
  )
  select s.id, s.author_id, s.caption, s.audience, s.tags, s.image_url, s.photos,
         s.video_url, s.thumb_url, s.poll, s.created_at, s.updated_at, s.hashtags, s._score
  from scored s
  where cursor_score is null
     or (s._score, s.created_at, s.id) < (cursor_score, cursor_created_at, cursor_id)
  order by s._score desc, s.created_at desc, s.id desc
  limit page_size
$$;
