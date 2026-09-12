-- tag_synonyms is reference data read internally by normalize_tag()/
-- normalize_tags() (both security definer, so they don't need this to
-- work) - clients have no reason to read or write it directly, so lock
-- it down to authenticated read-only, matching how the rest of this
-- project's reference/internal tables are treated.
alter table public.tag_synonyms enable row level security;

create policy "authenticated users can read tag synonyms"
on public.tag_synonyms for select
to authenticated
using (true);
