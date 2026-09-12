-- Today a new comment notifies the post author, and the parent comment's
-- author if it's a reply. Anyone else already in that thread hears
-- nothing - so a conversation you're part of can carry on without you,
-- which is exactly the conversation you'd have come back for.
--
-- Server-side because the client only ever has a partial view of a thread
-- (the feed renders the last couple of comments), and because the post's
-- author and the thread's membership shouldn't be client-supplied.
create or replace function public.notify_thread_participants(p_comment_id uuid)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_post uuid; v_root uuid; v_text text; v_parent uuid;
  v_post_author uuid; v_parent_author uuid; n int;
begin
  -- Only the comment's own author can trigger this, for their own comment.
  select c.post_id, coalesce(c.parent_id, c.id), c.text, c.parent_id
    into v_post, v_root, v_text, v_parent
  from public.comments c
  where c.id = p_comment_id and c.user_id = auth.uid();
  if v_post is null then return 0; end if;

  select author_id into v_post_author from public.posts where id = v_post;
  if v_parent is not null then
    select user_id into v_parent_author from public.comments where id = v_parent;
  end if;

  with parts as (
    select distinct c.user_id
    from public.comments c
    where c.post_id = v_post
      and coalesce(c.parent_id, c.id) = v_root
      and c.user_id <> auth.uid()                       -- not me
      and c.user_id is distinct from v_post_author      -- already notified
      and c.user_id is distinct from v_parent_author    -- already notified
      and not public.is_blocked(c.user_id, auth.uid())
  ), ins as (
    insert into public.notifications (user_id, actor_id, type, post_id, comment_id, text)
    select p.user_id, auth.uid(), 'reply', v_post, v_root, left(coalesce(v_text,''),80)
    from parts p
    -- One ping per thread per hour per person: a fast back-and-forth
    -- between two people shouldn't buzz everyone else once per message.
    where not exists (
      select 1 from public.notifications nx
      where nx.user_id = p.user_id
        and nx.actor_id = auth.uid()
        and nx.type = 'reply'
        and nx.comment_id = v_root
        and nx.created_at > now() - interval '1 hour'
    )
    returning 1
  )
  select count(*) into n from ins;
  return n;
end $$;

revoke all on function public.notify_thread_participants(uuid) from public;
revoke execute on function public.notify_thread_participants(uuid) from anon;
grant execute on function public.notify_thread_participants(uuid) to authenticated;
