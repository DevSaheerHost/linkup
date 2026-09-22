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
//
// Error visibility: console.error alone only reaches Supabase's ephemeral
// function logs (easy to miss, limited retention, nothing alerts on it).
// logFailure() also writes a row to public.push_failures (service-role
// only, no client RLS policies) so failures have a durable, queryable
// record - `select * from push_failures order by created_at desc`.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE')!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// The notification's large icon. Everything that has a face behind it (a
// message, a call, a like) shows that person's photo; anything without one
// falls back to the app icon.
const DEFAULT_ICON = '/icon-192.png';
const PUBLIC_STORAGE = SUPABASE_URL.replace(/\/+$/, '') + '/storage/v1/object/public/';

/* avatar_url is user-writable text, and whatever lands in `icon` is fetched
   by the OS itself - unauthenticated, from the recipient's device, on every
   push. An arbitrary URL there would be a tracking beacon the *sender*
   controls (recipient IP + when they're online), so only our own public
   storage is allowed through; anything else quietly becomes the app icon. */
function safeIcon(url?: string | null) {
  return typeof url === 'string' && url.startsWith(PUBLIC_STORAGE) ? url : DEFAULT_ICON;
}

async function logFailure(eventTable: string, eventId: string | null, userId: string | null, message: string) {
  console.error('push-notify failure', eventTable, eventId, message);
  try {
    await sb.from('push_failures').insert({ event_table: eventTable, event_id: eventId, user_id: userId, message });
  } catch (_e) {
    // Logging itself failing must never break notification delivery, and
    // there's nowhere further to report it - console.error above already ran.
  }
}

async function getUser(id: string | null) {
  if (!id) return null;
  const { data, error } = await sb.from('profiles').select('id,username,avatar_url').eq('id', id).single();
  if (error) { await logFailure('profiles', id, null, 'getUser lookup failed: ' + error.message); return null; }
  return data;
}
async function getGroup(id: string) {
  const { data, error } = await sb.from('groups').select('id,name,avatar_url').eq('id', id).single();
  if (error) { await logFailure('groups', id, null, 'getGroup lookup failed: ' + error.message); return null; }
  return data;
}
async function getGroupMemberIds(id: string): Promise<string[]> {
  const { data, error } = await sb.from('group_members').select('user_id').eq('group_id', id);
  if (error) { await logFailure('group_members', id, null, 'getGroupMemberIds lookup failed: ' + error.message); return []; }
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
    case 'followreq': return { title: 'LinkUp', body: who + ' wants to follow you' };
    case 'tag': return { title: 'LinkUp', body: who + ' tagged you in a post' };
    case 'storylike': return { title: 'LinkUp', body: who + ' liked your story' };
    // Digests/recaps are attributed to the official account, so the actor's
    // name would read as "linkup 5 new likes..." - the text stands alone.
    case 'digest': return { title: 'LinkUp', body: n.text || 'New activity on your posts' };
    case 'recap': return { title: 'Your week on LinkUp', body: n.text || 'See how your posts did' };
    default: return { title: 'LinkUp', body: n.text || 'New activity' };
  }
}

async function sendToUser(userId: string, payload: Record<string, unknown>, eventTable: string, eventId: string | null) {
  const { data: subs, error } = await sb.from('push_subs').select('*').eq('user_id', userId);
  if (error) { await logFailure(eventTable, eventId, userId, 'push_subs lookup failed: ' + error.message); return; }
  if (!subs || !subs.length) return;
  for (const row of subs) {
    try {
      await webpush.sendNotification(row.sub, JSON.stringify(payload));
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await sb.from('push_subs').delete().eq('id', row.id);
      } else {
        await logFailure(eventTable, eventId, userId, 'webpush send failed: ' + String((err as Error)?.message || err));
      }
    }
  }
}

Deno.serve(async (req) => {
  let payload: { type?: string; table?: string; record?: Record<string, any> } = {};
  try {
    payload = await req.json();
    if (payload.type !== 'INSERT' || !payload.record) return new Response('ignored', { status: 200 });
    const r = payload.record;

    switch (payload.table) {
      case 'notifications': {
        if (!r.user_id || r.user_id === r.actor_id) break;
        const actor = await getUser(r.actor_id);
        const msg = messageFor(r, actor?.username) as Record<string, unknown>;
        msg.url = '/';
        msg.icon = safeIcon(actor?.avatar_url);
        msg.tag = r.type + ':' + (r.post_id || r.actor_id);
        await sendToUser(r.user_id, msg, 'notifications', r.id);
        break;
      }
      case 'messages': {
        const from = await getUser(r.sender_id);
        const fromName = from?.username || 'Someone';
        const body = r.audio_url ? 'Voice message' : r.image_url ? 'Photo' : r.post_id ? 'Shared a post' : (r.text || 'New message');
        // senderName/text let the service worker build an accumulated,
        // multi-line notification across repeated messages instead of each
        // new push just overwriting the last one's body. reply carries what
        // the SW needs to send a message back on its own (inline reply from
        // the notification, works even with the app fully closed) - for a
        // group it's the group_id, for a DM it's the *other* person's id
        // (the original sender, since the recipient is the one replying).
        if (r.group_id) {
          const g = await getGroup(r.group_id);
          const members = await getGroupMemberIds(r.group_id);
          const msg = {
            title: g?.name || 'Group', body: fromName + ': ' + body, type: 'message', url: '/', tag: 'grp:' + r.group_id,
            // A group shows its own picture; without one, the sender's.
            icon: safeIcon(g?.avatar_url || from?.avatar_url),
            senderName: fromName, text: body, reply: { groupId: r.group_id, conversation: r.group_id }
          };
          for (const uid of members) if (uid !== r.sender_id) await sendToUser(uid, msg, 'messages', r.id);
        } else if (r.receiver_id && r.receiver_id !== r.sender_id) {
          const msg = {
            title: fromName, body, type: 'message', url: '/', tag: 'msg:' + r.conversation,
            icon: safeIcon(from?.avatar_url),
            senderName: fromName, text: body, reply: { receiverId: r.sender_id, conversation: r.conversation }
          };
          await sendToUser(r.receiver_id, msg, 'messages', r.id);
        }
        break;
      }
      case 'calls': {
        if (r.status !== 'ringing') break;
        const from = await getUser(r.caller_id);
        const msg = {
          title: from?.username || 'Incoming call',
          body: r.kind === 'video' ? 'Incoming video call' : 'Incoming voice call',
          icon: safeIcon(from?.avatar_url),
          type: 'call', kind: r.kind, callId: r.id, url: '/#call=' + r.id, tag: 'call:' + r.id
        };
        await sendToUser(r.callee_id, msg, 'calls', r.id);
        break;
      }
      case 'groupcalls': {
        if (!r.active) break;
        const g = await getGroup(r.group_id);
        const members = await getGroupMemberIds(r.group_id);
        const msg = {
          title: g?.name || 'Group',
          body: r.kind === 'video' ? 'Incoming group video call' : 'Incoming group voice call',
          icon: safeIcon(g?.avatar_url),
          type: 'call', kind: r.kind, url: '/#gcall=' + r.group_id, tag: 'gcall:' + r.group_id
        };
        for (const uid of members) if (uid !== r.starter_id) await sendToUser(uid, msg, 'groupcalls', r.id);
        break;
      }
    }
    return new Response('ok', { status: 200 });
  } catch (e) {
    await logFailure(payload.table || 'unknown', payload.record?.id ?? null, null, 'unhandled error: ' + String((e as Error)?.message || e));
    return new Response('error', { status: 500 });
  }
});
