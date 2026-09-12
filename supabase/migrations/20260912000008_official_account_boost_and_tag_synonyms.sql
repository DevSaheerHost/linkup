-- 1) Verified/official flag - doubles as the ranking boost signal and the
--    badge UI signal, so one column serves both instead of two.
alter table public.profiles add column is_verified boolean not null default false;
update public.profiles set is_verified = true where username = 'linkup';

-- 2) Hashtag/keyword synonym grouping. Real data already shows the exact
-- problem this solves: saheer_babu posted #developer, signal_guest posted
-- #development - same topic, zero affinity carries over between them
-- today because matching is exact-string. Also a real typo, #amartphone
-- for #smartphone, means that post gets no topic credit at all. This is
-- a lookup table (not a code change) so it's trivially extensible later -
-- just insert more rows, no migration needed for new synonyms.
create table public.tag_synonyms (
  tag text primary key,
  canonical text not null
);
insert into public.tag_synonyms (tag, canonical) values
  ('development','developer'),
  ('dev','developer'),
  ('coding','coder'),
  ('programming','coder'),
  ('js','javascript'),
  ('reactjs','react'),
  ('nodejs','node'),
  ('amartphone','smartphone'),
  ('mobilephone','smartphone');

create or replace function public.normalize_tag(t text) returns text
language sql immutable set search_path = public as $$
  select coalesce((select canonical from public.tag_synonyms where tag_synonyms.tag = t), t)
$$;

create or replace function public.normalize_tags(tags text[]) returns text[]
language sql immutable set search_path = public as $$
  select coalesce(array_agg(distinct public.normalize_tag(x)), '{}'::text[])
  from unnest(tags) x
$$;
