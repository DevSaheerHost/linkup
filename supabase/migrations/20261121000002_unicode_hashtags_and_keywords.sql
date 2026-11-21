-- Hashtags and keywords were extracted with POSIX [:alnum:], which does not
-- include combining marks - the vowel signs and viramas that almost every
-- Indic word is built from. So:
--
--   extract_hashtags('#ലിങ്ക്')   -> {ല}          (cut at the first vowel sign)
--   extract_keywords('മലയാളം ...') -> {}           (split into <4-char shards, all dropped)
--
-- Every Malayalam, Hindi or Tamil tag collapsed into its first letter, and
-- the plain-word half of the ranking was blind to those captions entirely.
--
-- The tag rule is now spelled out as explicit ranges rather than character
-- classes, identically to richText() in app.js, because Postgres and JS
-- disagree about what counts as punctuation or a symbol. A tag runs until
-- whitespace, ASCII punctuation (underscore excepted), curly quotes, an
-- ellipsis or a danda, and must start a word ("x#mid" is not a tag).
-- tests/hashtags.spec.js pins the client to the exact output of this rule.

create or replace function public.extract_hashtags(caption text)
returns text[]
language sql
immutable
set search_path to 'public'
as $$
  select coalesce(array_agg(distinct lower(m[1])), '{}'::text[])
  from regexp_matches(
    coalesce(caption, ''),
    '(?:^|[[:space:]!-/:-@[-^`{-~‘-‟…।॥])#([^[:space:]!-/:-@[-^`{-~‘-‟…।॥]+)',
    'g') as m
$$;

create or replace function public.extract_keywords(caption text)
returns text[]
language sql
immutable
set search_path to 'public'
as $$
  select coalesce(array_agg(distinct w), '{}'::text[])
  from (
    select lower(word) as w
    from regexp_split_to_table(
      -- hashtags are scored separately, so take them out first, by the same rule
      regexp_replace(
        coalesce(caption, ''),
        '(^|[[:space:]!-/:-@[-^`{-~‘-‟…।॥])#[^[:space:]!-/:-@[-^`{-~‘-‟…।॥]+',
        '\1 ', 'g'),
      '[[:space:]!-/:-@[-^`{-~‘-‟…।॥_]+'
    ) as word
    where length(word) >= 4
      and word !~ '^[0-9]+$'
      and lower(word) <> all (array[
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

-- hashtags/keywords are stored generated columns: replacing the function
-- does not touch rows already written. An UPDATE recomputes them. Stand the
-- updated_at trigger down for it, so every post doesn't look freshly edited.
alter table public.posts disable trigger set_posts_updated_at;
update public.posts set caption = caption;
alter table public.posts enable trigger set_posts_updated_at;
