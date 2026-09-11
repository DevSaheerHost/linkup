/*
  LinkUp push sender - runs on your Debian box next to PocketBase.
  It watches the `notifications` collection and sends a Web Push for each new row.

  ONE-TIME SETUP
  1) Install Node 18+ (has built-in fetch).
  2) In a folder you own (no sudo):
        npm init -y
        npm install web-push
  3) Generate VAPID keys once:
        npx web-push generate-vapid-keys
     Put the PUBLIC key into linkup.html (VAPID_PUBLIC) and the PUBLIC+PRIVATE below.
  4) Fill in the CONFIG block below (PB url, superuser email/password, VAPID keys).
  5) Run it (keep it alive with pm2, systemd, or screen):
        node push-sender.js
*/

const webpush = require('web-push');

// ===== CONFIG =====
const PB_URL    = 'http://127.0.0.1:8090';        // PocketBase, local to this box
const SU_EMAIL  = 'admin@linkup.local';
const SU_PASS   = 'admin123456';
const VAPID_SUBJECT = 'mailto:cloud15storage@gmail.com';
const VAPID_PUBLIC  = 'BPLpuSaEpdNinEn-atyqiVIbbo7wIrbX5FjO4iPVdo2czZADIpVYHjwcd9V3k9Oxse6HI6cFaPNIsYKOcx-BMB8';
const VAPID_PRIVATE = '7DG8k5WtAah6Ze2-J0_Fpi-GDWo0gVKpw-IZ1xr1owo';
const POLL_MS = 5000;                              // how often to check for new notifications
// ==================

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

let token = '';
let lastSeen = new Date().toISOString().replace('T', ' ');   // PocketBase datetime format (space, not T)
let lastMsg  = new Date().toISOString().replace('T', ' ');   // cursor for chat messages
let lastCall = new Date().toISOString().replace('T', ' ');   // cursor for calls
let lastGcall = new Date().toISOString().replace('T', ' ');  // cursor for group calls
const userCache = {};

async function api(path, opts = {}) {
  const res = await fetch(PB_URL + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}), ...(opts.headers || {}) }
  });
  if (!res.ok) throw new Error(res.status + ' ' + (await res.text()));
  return res.json();
}

async function delRecord(path) {
  const res = await fetch(PB_URL + path, { method: 'DELETE', headers: token ? { Authorization: token } : {} });
  if (!res.ok && res.status !== 204) throw new Error(res.status + '');
}

async function authSuperuser() {
  const r = await api('/api/collections/_superusers/auth-with-password', {
    method: 'POST',
    body: JSON.stringify({ identity: SU_EMAIL, password: SU_PASS })
  });
  token = r.token;
  console.log('[push] authenticated as superuser');
}

async function getUser(id) {
  if (userCache[id]) return userCache[id];
  try { const u = await api('/api/collections/users/records/' + id); userCache[id] = u; return u; } catch { return null; }
}

function messageFor(n, actorName) {
  const who = actorName || 'Someone';
  switch (n.type) {
    case 'like':      return { title: 'LinkUp', body: who + ' liked your post' };
    case 'comment':   return { title: who, body: 'commented: ' + (n.text || '') };
    case 'follow':    return { title: 'LinkUp', body: who + ' started following you' };
    case 'tag':       return { title: 'LinkUp', body: who + ' tagged you in a post' };
    case 'storylike': return { title: 'LinkUp', body: who + ' liked your story' };
    case 'message':   return { title: who, body: n.text || 'sent you a message' };
    default:          return { title: 'LinkUp', body: n.text || 'New activity' };
  }
}

async function sendToUser(userId, payload) {
  let subs;
  try {
    const filter = encodeURIComponent('user="' + userId + '"');
    const r = await api('/api/collections/push_subs/records?perPage=200&filter=' + filter);
    subs = r.items || [];
  } catch (e) { console.error('[push] sub fetch failed', e.message); return; }

  if (!subs.length) { console.log('[push] no push_subs row for user', userId, '- did they tap Enable alerts?'); return; }

  for (const row of subs) {
    let sub;
    try { sub = JSON.parse(row.sub); } catch { continue; }
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      console.log('[push] SENT to', userId, '-', payload.body);
    } catch (err) {
      // 404/410 means the subscription expired, so delete it
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.log('[push] sub expired, deleting', row.id);
        try { await api('/api/collections/push_subs/records/' + row.id, { method: 'DELETE' }); } catch {}
      } else {
        console.error('[push] send error', err.statusCode || err.message, (err.body || ''));
      }
    }
  }
}

async function pollMessages() {
  try {
    const filter = encodeURIComponent('created > "' + lastMsg + '"');
    const r = await api('/api/collections/messages/records?perPage=50&sort=created&filter=' + filter);
    for (const m of r.items) {
      lastMsg = m.created;
      const from = await getUser(m.sender);
      const fromName = (from && from.username) || 'Someone';
      const body = m.audio ? 'Voice message' : m.image ? 'Photo' : m.post ? 'Shared a post' : (m.text || 'New message');

      if (m.group) {
        // group message: push to every member except the sender
        let g;
        try { g = await api('/api/collections/groups/records/' + m.group); }
        catch (e) { console.error('[push] group fetch failed', m.group, e.message); continue; }
        const members = String(g.members || '').split(/\s+/).filter(Boolean);
        const payload = {
          title: g.name || 'Group',
          body: fromName + ': ' + body,
          type: 'message',
          url: '/',
          tag: 'grp:' + m.group
        };
        console.log('[push] group=' + m.group + ' from=' + m.sender + ' members=' + members.length);
        for (const uid of members) {
          if (uid === m.sender) continue;
          await sendToUser(uid, payload);
        }
        continue;
      }

      if (!m.receiver || m.receiver === m.sender) continue;     // DM: don't notify yourself
      const payload = {
        title: fromName,
        body: body,
        type: 'message',
        url: '/',
        tag: 'msg:' + (m.conversation || m.sender)
      };
      console.log('[push] message to=' + m.receiver + ' from=' + m.sender);
      await sendToUser(m.receiver, payload);
    }
  } catch (e) {
    if (String(e.message).startsWith('401')) { try { await authSuperuser(); } catch {} }
    else console.error('[push] message poll error', e.message);
  }
}

async function cleanupOld(coll, hours) {
  try {
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString().replace('T', ' ');
    const filter = encodeURIComponent('created < "' + cutoff + '"');
    let removed = 0, guard = 0;
    while (guard++ < 20) {
      const r = await api('/api/collections/' + coll + '/records?perPage=200&filter=' + filter);
      if (!r.items.length) break;
      for (const rec of r.items) { try { await delRecord('/api/collections/' + coll + '/records/' + rec.id); removed++; } catch {} }
      if (r.items.length < 200) break;
    }
    if (removed) console.log('[cleanup] ' + coll + ' removed ' + removed);
  } catch (e) {
    if (String(e.message).startsWith('401')) { try { await authSuperuser(); } catch {} }
    else console.error('[cleanup] ' + coll + ' error', e.message);
  }
}
async function cleanup() {
  await cleanupOld('gsig', 24);        // group-call signalling exhaust
  await cleanupOld('groupcalls', 24);  // finished group calls
  await cleanupOld('calls', 24);       // finished 1:1 call records (history lives in messages)
}

async function pollGroupCalls() {
  try {
    const filter = encodeURIComponent('created > "' + lastGcall + '"');
    const r = await api('/api/collections/groupcalls/records?perPage=20&sort=created&filter=' + filter);
    for (const c of r.items) {
      lastGcall = c.created;
      if (!c.active) continue;
      let g;
      try { g = await api('/api/collections/groups/records/' + c.group); }
      catch (e) { console.error('[push] group fetch failed', c.group, e.message); continue; }
      const members = String(g.members || '').split(/\s+/).filter(Boolean);
      const payload = {
        title: g.name || 'Group',
        body: c.kind === 'video' ? 'Incoming group video call' : 'Incoming group voice call',
        type: 'call',
        kind: c.kind,
        url: '/#gcall=' + c.group,
        tag: 'gcall:' + c.group
      };
      console.log('[push] group call group=' + c.group + ' kind=' + c.kind + ' members=' + members.length);
      for (const uid of members) { if (uid !== c.starter) await sendToUser(uid, payload); }
    }
  } catch (e) {
    if (String(e.message).startsWith('401')) { try { await authSuperuser(); } catch {} }
    else console.error('[push] group call poll error', e.message);
  }
}

async function pollCalls() {
  try {
    const filter = encodeURIComponent('created > "' + lastCall + '"');
    const r = await api('/api/collections/calls/records?perPage=20&sort=created&filter=' + filter);
    for (const c of r.items) {
      lastCall = c.created;
      if (c.status !== 'ringing') continue;
      const from = await getUser(c.caller);
      const payload = {
        title: (from && from.username) || 'Incoming call',
        body: c.kind === 'video' ? 'Incoming video call' : 'Incoming voice call',
        type: 'call',
        kind: c.kind,
        callId: c.id,
        url: '/#call=' + c.id,
        tag: 'call:' + c.id
      };
      console.log('[push] call to=' + c.callee + ' kind=' + c.kind);
      await sendToUser(c.callee, payload);
    }
  } catch (e) {
    if (String(e.message).startsWith('401')) { try { await authSuperuser(); } catch {} }
    else console.error('[push] call poll error', e.message);
  }
}

async function poll() {
  try {
    const filter = encodeURIComponent('created > "' + lastSeen + '"');
    const r = await api('/api/collections/notifications/records?perPage=50&sort=created&filter=' + filter);
    for (const n of r.items) {
      lastSeen = n.created;
      console.log('[push] notification:', n.type, 'to=' + n.user, 'from=' + n.actor);
      if (!n.user || n.user === n.actor) { console.log('[push] skipped (self-notification)'); continue; }
      const actor = await getUser(n.actor);
      const payload = messageFor(n, actor && actor.username);
      payload.url = '/';
      payload.tag = n.type + ':' + (n.post || n.actor);
      await sendToUser(n.user, payload);
    }
  } catch (e) {
    if (String(e.message).startsWith('401')) { try { await authSuperuser(); } catch {} }
    else console.error('[push] poll error', e.message);
  }
}

(async () => {
  await authSuperuser();
  try {
    const probe = await api('/api/collections/notifications/records?perPage=1&sort=-created');
    console.log('[push] notifications collection OK, total =', probe.totalItems);
    if (probe.items[0]) console.log('[push] latest stored created =', probe.items[0].created);
  } catch (e) { console.error('[push] cannot read notifications:', e.message); }
  console.log('[push] watching notifications created after', lastSeen);
  cleanup();
  setInterval(cleanup, 3600 * 1000);   // hourly
  setInterval(() => { poll(); pollMessages(); pollCalls(); pollGroupCalls(); }, POLL_MS);
})();
