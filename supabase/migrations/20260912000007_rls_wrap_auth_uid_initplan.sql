-- Supabase's performance advisor flags every RLS policy that calls
-- auth.uid() bare: Postgres re-evaluates it per row instead of once per
-- query. Fix is mechanical (wrap in a scalar subquery so the planner can
-- hoist it into an InitPlan) and behavior-preserving - same value, same
-- access rules, just evaluated once. Every policy in this project uses
-- only auth.uid() (confirmed via pg_policies before writing this), so
-- this rewrites every policy definition from the catalog itself rather
-- than hand-retyping ~69 policies across ~30 tables.
do $$
declare
  pol record;
  new_qual text;
  new_check text;
  stmt text;
begin
  for pol in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
  loop
    new_qual := pol.qual;
    new_check := pol.with_check;

    if new_qual is not null then
      new_qual := regexp_replace(new_qual, 'auth\.uid\(\)', '(select auth.uid())', 'g');
    end if;
    if new_check is not null then
      new_check := regexp_replace(new_check, 'auth\.uid\(\)', '(select auth.uid())', 'g');
    end if;

    if (new_qual is distinct from pol.qual) or (new_check is distinct from pol.with_check) then
      stmt := format('alter policy %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);
      if new_qual is distinct from pol.qual then
        stmt := stmt || format(' using (%s)', new_qual);
      end if;
      if new_check is distinct from pol.with_check then
        stmt := stmt || format(' with check (%s)', new_check);
      end if;
      execute stmt;
    end if;
  end loop;
end $$;
