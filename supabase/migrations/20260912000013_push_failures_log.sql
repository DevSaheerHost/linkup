-- push-notify's only error visibility today is console.error, which
-- lands in Supabase's ephemeral Edge Function logs (limited retention,
-- easy to miss, nothing alerts on it). This gives failures a durable,
-- queryable home. No RLS policies on purpose: only the Edge Function's
-- service-role client writes here (which bypasses RLS entirely), and
-- reading it is an operator/SQL action, not something any client role
-- should do - RLS enabled with zero policies denies all client access
-- by default while leaving service-role writes unaffected.
create table public.push_failures (
  id uuid primary key default gen_random_uuid(),
  event_table text not null,
  event_id uuid,
  user_id uuid,
  message text not null,
  created_at timestamptz not null default now()
);
alter table public.push_failures enable row level security;
create index push_failures_created_idx on public.push_failures (created_at desc);
