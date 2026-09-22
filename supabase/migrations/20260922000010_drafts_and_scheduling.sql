-- The composer was all-or-nothing: write it now and publish now, or lose it.
--
-- A draft is a real post row that is not published yet, which means the
-- media pipeline does not change at all - the photo/video is uploaded and
-- the row written exactly as before, just with a different status. The same
-- shape gives scheduling for free: a status plus the time it should go out.

alter table public.posts
  add column if not exists status     text not null default 'published',
  add column if not exists publish_at timestamptz;

alter table public.posts drop constraint if exists posts_status_check;
alter table public.posts add constraint posts_status_check
  check (status in ('draft', 'scheduled', 'published'));

-- A scheduled post without a time would never go out; a draft with one is
-- just confusing. Keep the two coherent at the database level.
alter table public.posts drop constraint if exists posts_schedule_check;
alter table public.posts add constraint posts_schedule_check
  check ((status = 'scheduled') = (publish_at is not null));

create index if not exists posts_due_idx
  on public.posts (publish_at) where status = 'scheduled';

-- Everything that reads posts goes through this policy, so this one clause
-- keeps unpublished posts out of every feed, profile grid and search at
-- once - while leaving them visible to their own author.
drop policy if exists "viewable posts" on public.posts;
create policy "viewable posts"
  on public.posts for select to authenticated
  using (
    (status = 'published' or author_id = (select auth.uid()))
    and public.can_view_post(author_id, audience, (select auth.uid()))
  );

-- The ranking functions bypass RLS (SECURITY DEFINER), so they need the
-- same filter stated explicitly. Spliced into the deployed definitions for
-- the same reason as the mute clause: two ~130-line copies pasted here
-- would drift from what is actually running.
do $$
declare
  v_name text;
  v_def  text;
  v_old  constant text := 'and public.can_view_post(p.author_id, p.audience, auth.uid())';
  v_add  constant text := 'and p.status = ''published'' and public.can_view_post(p.author_id, p.audience, auth.uid())';
begin
  foreach v_name in array array['get_feed_for_you', 'get_reels_for_you', 'get_missed_posts'] loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = v_name;

    if v_def is null then
      raise exception '% not found', v_name;
    end if;
    if position('p.status = ''published''' in v_def) > 0 then
      continue;                                  -- already patched
    end if;
    if position(v_old in v_def) = 0 then
      raise exception '% does not contain the expected can_view_post filter', v_name;
    end if;

    execute replace(v_def, v_old, v_add);
  end loop;
end $$;

-- Due posts go out on the minute. Publishing clears publish_at so the
-- schedule constraint still holds for the now-published row.
create or replace function public.publish_due_posts()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare n integer;
begin
  update public.posts
     set status = 'published',
         publish_at = null,
         created_at = now()      -- it enters the feed now, not when it was written
   where status = 'scheduled' and publish_at <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.publish_due_posts() from public;
revoke execute on function public.publish_due_posts() from anon;
revoke execute on function public.publish_due_posts() from authenticated;

select cron.schedule('publish-due-posts', '* * * * *', $cron$ select public.publish_due_posts() $cron$);
