// LinkUp push-notify Edge Function
//
// Replaces push-sender.js's polling loop with an event-driven Database
// Webhook: Postgres calls this function (via supabase_functions.http_request
// triggers - see the postviews_unique.sql-style migration that wires these
// up) immediately after a row is inserted into notifications/messages/
// calls/groupcalls, and this sends the Web Push right away instead of
// waiting on a script that has to be kept running 24/7 on a separate server.
//
// Required secrets (Project Settings > Edge Functions > Secrets, or
// `supabase secrets set`): VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE')!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function getUser(id: string | null) {
  if (!id) return null;
  const { data } = await sb.from('profiles').select('id,username').eq('id', id).single();
  return data;
}
async function getGroup(id: string) {
  const { data } = await sb.from('groups').select('id,name').eq('id', id).single();
  return data;
}
async function getGroupMemberIds(id: string): Promise<string[]> {
  const { data } = await sb.from('group_members').select('user_id').eq('group_id', id);
  return (data || []).map((r: { user_id: string }) => r.user_id);
}

function messageFor(n: { type: string; text?: string }, actorName?: string | null) {
  const who = actorName || 'Someone';
  switch (n.type) {
    case 'like': return { title: 'LinkUp', body: who + ' liked your post' };
    case 'comment': return { title: who, body: 'commented: ' + (n.text || '') };
    case 'reply': return { title: who, body: 'replied: ' + (n.text || '') };
    case 'commentlike': return { title: 'LinkUp', body: who + ' liked your comment' };
    case 'follow': return { title: 'LinkUp', body: who + ' started following you' };
    case 'tag': return { title: 'LinkUp', body: who + ' tagged you in a post' };
    case 'storylike': return { title: 'LinkUp', body: who + ' liked your story' };
    default: return { title: 'LinkUp', body: n.text || 'New activity' };
  }
}

async function sendToUser(userId: string, payload: Record<string, unknown>) {
  const { data: subs, error } = await sb.from('push_subs').select('*').eq('user_id', userId);
  if (error || !subs || !subs.length) return;
  for (const row of subs) {
    try {
      await webpush.sendNotification(row.sub, JSON.stringify(payload));
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await sb.from('push_subs').delete().eq('id', row.id);
      } else {
        console.error('push send error', statusCode, err);
      }
    }
  }
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    if (payload.type !== 'INSERT' || !payload.record) return new Response('ignored', { status: 200 });
    const r = payload.record;

    switch (payload.table) {
      case 'notifications': {
        if (!r.user_id || r.user_id === r.actor_id) break;
        const actor = await getUser(r.actor_id);
        const msg = messageFor(r, actor?.username) as Record<string, unknown>;
        msg.url = '/';
        msg.tag = r.type + ':' + (r.post_id || r.actor_id);
        await sendToUser(r.user_id, msg);
        break;
      }
      case 'messages': {
        const from = await getUser(r.sender_id);
        const fromName = from?.username || 'Someone';
        const body = r.audio_url ? 'Voice message' : r.image_url ? 'Photo' : r.post_id ? 'Shared a post' : (r.text || 'New message');
        if (r.group_id) {
          const g = await getGroup(r.group_id);
          const members = await getGroupMemberIds(r.group_id);
          const msg = { title: g?.name || 'Group', body: fromName + ': ' + body, type: 'message', url: '/', tag: 'grp:' + r.group_id };
          for (const uid of members) if (uid !== r.sender_id) await sendToUser(uid, msg);
        } else if (r.receiver_id && r.receiver_id !== r.sender_id) {
          const msg = { title: fromName, body, type: 'message', url: '/', tag: 'msg:' + r.conversation };
          await sendToUser(r.receiver_id, msg);
        }
        break;
      }
      case 'calls': {
        if (r.status !== 'ringing') break;
        const from = await getUser(r.caller_id);
        const msg = {
          title: from?.username || 'Incoming call',
          body: r.kind === 'video' ? 'Incoming video call' : 'Incoming voice call',
          type: 'call', kind: r.kind, callId: r.id, url: '/#call=' + r.id, tag: 'call:' + r.id
        };
        await sendToUser(r.callee_id, msg);
        break;
      }
      case 'groupcalls': {
        if (!r.active) break;
        const g = await getGroup(r.group_id);
        const members = await getGroupMemberIds(r.group_id);
        const msg = {
          title: g?.name || 'Group',
          body: r.kind === 'video' ? 'Incoming group video call' : 'Incoming group voice call',
          type: 'call', kind: r.kind, url: '/#gcall=' + r.group_id, tag: 'gcall:' + r.group_id
        };
        for (const uid of members) if (uid !== r.starter_id) await sendToUser(uid, msg);
        break;
      }
    }
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('push-notify error', e);
    return new Response('error', { status: 500 });
  }
});
