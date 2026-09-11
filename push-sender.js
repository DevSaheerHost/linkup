/*
  LinkUp push sender - polls Supabase for new notifications/messages/calls
  and sends a Web Push for each one.

  ONE-TIME SETUP
  1) Install Node 18+ (has built-in fetch).
  2) In a folder you own (no sudo):
        npm init -y
        npm install web-push @supabase/supabase-js
  3) Generate VAPID keys once:
        npx web-push generate-vapid-keys
     Put the PUBLIC key into app.js (VAPID_PUBLIC) and both keys into the
     environment variables below.
  4) Set the environment variables below (never hardcode them in this file):
        SUPABASE_URL                 - from Project Settings > API
        SUPABASE_SERVICE_ROLE_KEY    - from Project Settings > API (service_role secret -
                                        bypasses Row Level Security, so keep it server-side only)
        VAPID_SUBJECT                - e.g. mailto:you@example.com
        VAPID_PUBLIC / VAPID_PRIVATE - from step 3
  5) Run it (keep it alive with pm2, systemd, or screen):
        SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... VAPID_SUBJECT=... \
        VAPID_PUBLIC=... VAPID_PRIVATE=... node push-sender.js

  Note: cleanup of expired call-signaling rows (gsig/calls/groupcalls) is
  handled inside Postgres via pg_cron (see supabase/migrations) - this
  script only needs to watch for new rows and push.
*/

const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

// ===== CONFIG (all from environment - never hardcode secrets here) =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const POLL_MS = 5000; // how often to check for new rows
// =========================================================================

for (const [name, val] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE })) {
  if (!val) { console.error('[push] missing required env var: ' + name); process.exit(1); }
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

let lastSeen = new Date(0).toISOString();   // cursor for notifications
let lastMsg = new Date(0).toISOString();    // cursor for chat messages
let lastCall = new Date(0).toISOString();   // cursor for calls
let lastGcall = new Date(0).toISOString();  // cursor for group calls
const userCache = {};
const groupCache = {};

async function getUser(id) {
  if (!id) return null;
  if (userCache[id]) return userCache[id];
  const { data } = await sb.from('profiles').select('id,username').eq('id', id).single();
  if (data) userCache[id] = data;
  return data || null;
}

async function getGroup(id) {
  if (groupCache[id]) return groupCache[id];
  const { data } = await sb.from('groups').select('id,name').eq('id', id).single();
  if (data) groupCache[id] = data;
  return data || null;
}

async function getGroupMemberIds(id) {
  const { data } = await sb.from('group_members').select('user_id').eq('group_id', id);
  return (data || []).map(r => r.user_id);
}

function messageFor(n, actorName) {
  const who = actorName || 'Someone';
  switch (n.type) {
    case 'like':      return { title: 'LinkUp', body: who + ' liked your post' };
    case 'comment':   return { title: who, body: 'commented: ' + (n.text || '') };
    case 'follow':    return { title: 'LinkUp', body: who + ' started following you' };
    case 'tag':       return { title: 'LinkUp', body: who + ' tagged you in a post' };
    case 'storylike': return { title: 'LinkUp', body: who + ' liked your story' };
    default:          return { title: 'LinkUp', body: n.text || 'New activity' };
  }
}

async function sendToUser(userId, payload) {
  const { data: subs, error } = await sb.from('push_subs').select('*').eq('user_id', userId);
  if (error) { console.error('[push] sub fetch failed', error.message); return; }
  if (!subs || !subs.length) { console.log('[push] no push_subs row for user', userId, '- did they tap Enable alerts?'); return; }

  for (const row of subs) {
    const sub = row.sub; // stored as jsonb, already an object
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      console.log('[push] SENT to', userId, '-', payload.body);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.log('[push] sub expired, deleting', row.id);
        await sb.from('push_subs').delete().eq('id', row.id);
      } else {
        console.error('[push] send error', err.statusCode || err.message, (err.body || ''));
      }
    }
  }
}

async function pollMessages() {
  const { data: rows, error } = await sb.from('messages').select('*').gt('created_at', lastMsg).order('created_at').limit(50);
  if (error) { console.error('[push] message poll error', error.message); return; }
  for (const m of rows || []) {
    lastMsg = m.created_at;
    const from = await getUser(m.sender_id);
    const fromName = (from && from.username) || 'Someone';
    const body = m.audio_url ? 'Voice message' : m.image_url ? 'Photo' : m.post_id ? 'Shared a post' : (m.text || 'New message');

    if (m.group_id) {
      const g = await getGroup(m.group_id);
      const members = await getGroupMemberIds(m.group_id);
      const payload = { title: (g && g.name) || 'Group', body: fromName + ': ' + body, type: 'message', url: '/', tag: 'grp:' + m.group_id };
      console.log('[push] group=' + m.group_id + ' from=' + m.sender_id + ' members=' + members.length);
      for (const uid of members) { if (uid !== m.sender_id) await sendToUser(uid, payload); }
      continue;
    }

    if (!m.receiver_id || m.receiver_id === m.sender_id) continue; // DM: don't notify yourself
    const payload = { title: fromName, body, type: 'message', url: '/', tag: 'msg:' + m.conversation };
    console.log('[push] message to=' + m.receiver_id + ' from=' + m.sender_id);
    await sendToUser(m.receiver_id, payload);
  }
}

async function pollGroupCalls() {
  const { data: rows, error } = await sb.from('groupcalls').select('*').gt('created_at', lastGcall).order('created_at').limit(20);
  if (error) { console.error('[push] group call poll error', error.message); return; }
  for (const c of rows || []) {
    lastGcall = c.created_at;
    if (!c.active) continue;
    const g = await getGroup(c.group_id);
    const members = await getGroupMemberIds(c.group_id);
    const payload = {
      title: (g && g.name) || 'Group',
      body: c.kind === 'video' ? 'Incoming group video call' : 'Incoming group voice call',
      type: 'call', kind: c.kind, url: '/#gcall=' + c.group_id, tag: 'gcall:' + c.group_id
    };
    console.log('[push] group call group=' + c.group_id + ' kind=' + c.kind + ' members=' + members.length);
    for (const uid of members) { if (uid !== c.starter_id) await sendToUser(uid, payload); }
  }
}

async function pollCalls() {
  const { data: rows, error } = await sb.from('calls').select('*').gt('created_at', lastCall).order('created_at').limit(20);
  if (error) { console.error('[push] call poll error', error.message); return; }
  for (const c of rows || []) {
    lastCall = c.created_at;
    if (c.status !== 'ringing') continue;
    const from = await getUser(c.caller_id);
    const payload = {
      title: (from && from.username) || 'Incoming call',
      body: c.kind === 'video' ? 'Incoming video call' : 'Incoming voice call',
      type: 'call', kind: c.kind, callId: c.id, url: '/#call=' + c.id, tag: 'call:' + c.id
    };
    console.log('[push] call to=' + c.callee_id + ' kind=' + c.kind);
    await sendToUser(c.callee_id, payload);
  }
}

async function poll() {
  const { data: rows, error } = await sb.from('notifications').select('*').gt('created_at', lastSeen).order('created_at').limit(50);
  if (error) { console.error('[push] poll error', error.message); return; }
  for (const n of rows || []) {
    lastSeen = n.created_at;
    console.log('[push] notification:', n.type, 'to=' + n.user_id, 'from=' + n.actor_id);
    if (!n.user_id || n.user_id === n.actor_id) { console.log('[push] skipped (self-notification)'); continue; }
    const actor = await getUser(n.actor_id);
    const payload = messageFor(n, actor && actor.username);
    payload.url = '/';
    payload.tag = n.type + ':' + (n.post_id || n.actor_id);
    await sendToUser(n.user_id, payload);
  }
}

(async () => {
  try {
    const { count, error } = await sb.from('notifications').select('id', { count: 'exact', head: true });
    if (error) throw error;
    console.log('[push] notifications table OK, total =', count);
  } catch (e) { console.error('[push] cannot read notifications:', e.message); }
  console.log('[push] watching for new rows every', POLL_MS, 'ms');
  setInterval(() => { poll(); pollMessages(); pollCalls(); pollGroupCalls(); }, POLL_MS);
})();
