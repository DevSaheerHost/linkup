/* LinkUp service worker - web push (messages + calls) + clicks + inline reply */
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Minimal fetch handler so the app is installable as a PWA.
// Intentionally a pass-through: we do NOT cache, to avoid serving stale HTML.
self.addEventListener('fetch', () => {});

const SUPABASE_URL = 'https://prfdrpmnftegbiaglugh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_es3WrqJR1IuFySgBAV_-2g_f23h-alp'; // must match app.js

async function appIsOpen() {
  const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return cs.some(c => c.focused || c.visibilityState === 'visible');
}

/* Same IndexedDB store app.js mirrors the auth session into (see idbSet/
   saveSessionToIDB there) - this is how a fully-closed app can still send a
   message when the user replies from a notification. */
function idbOpen() { return new Promise((res, rej) => { const rq = indexedDB.open('linkup', 1); rq.onupgradeneeded = () => rq.result.createObjectStore('kv'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); }
async function idbGet(key) { const db = await idbOpen(); return new Promise((res, rej) => { const rq = db.transaction('kv', 'readonly').objectStore('kv').get(key); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); }
async function idbSet(key, val) { const db = await idbOpen(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }

async function refreshSession(refresh_token) {
  const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token })
  });
  if (!res.ok) return null;
  const d = await res.json();
  if (!d.access_token) return null;
  const session = { access_token: d.access_token, refresh_token: d.refresh_token, user_id: d.user && d.user.id, saved_at: Date.now() };
  await idbSet('session', session);
  return session;
}

async function insertMessage(session, row) {
  return fetch(SUPABASE_URL + '/rest/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + session.access_token,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(row)
  });
}

async function updateCall(session, callId, patch) {
  return fetch(SUPABASE_URL + '/rest/v1/calls?id=eq.' + callId, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + session.access_token,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(patch)
  });
}

/* Declining from the notification shouldn't require opening the app - it's
   a single row update (RLS already lets either the caller or callee change
   a call's status), so it can happen right here, same auth pattern as
   sendReplyFromNotification. Without this, "Decline" only closed the
   notification and the caller just sat there ringing for 35s until their
   own no-answer timeout. */
async function declineCallFromNotification(callId) {
  if (!callId) return;
  let session = await idbGet('session').catch(() => null);
  if (!session) return;
  try {
    let res = await updateCall(session, callId, { status: 'declined' });
    if (res.status === 401 && session.refresh_token) {
      session = await refreshSession(session.refresh_token);
      if (session) await updateCall(session, callId, { status: 'declined' });
    }
  } catch (_) { /* best effort - caller's own timeout still applies */ }
}

/* Sends a text reply typed directly into the notification, without ever
   opening the app. Falls back to stashing the text as a draft (picked up by
   restoreDraft() in app.js next time that chat is opened) if there's no
   usable session or the network is unavailable, so the reply is never just
   silently lost. */
async function sendReplyFromNotification(ndata, text) {
  const reply = ndata && ndata.reply;
  if (!reply) return;
  let session = await idbGet('session').catch(() => null);
  if (session) {
    try {
      const row = { sender_id: session.user_id, text, conversation: reply.conversation };
      if (reply.groupId) row.group_id = reply.groupId; else row.receiver_id = reply.receiverId;
      let res = await insertMessage(session, row);
      if (res.status === 401 && session.refresh_token) {
        session = await refreshSession(session.refresh_token);
        if (session) res = await insertMessage(session, row);
      }
      if (res && res.ok) return;
    } catch (_) { /* fall through to draft */ }
  }
  await idbSet('draft:' + reply.conversation, text);
  await self.registration.showNotification('Message not sent', {
    body: 'Open the chat to send: "' + text + '"',
    icon: '/icon-192.png', badge: '/badge-96.png',
    data: { url: ndata.url || '/' }
  });
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data && event.data.text() }; }

    // Incoming call: full notification with Answer / Decline actions
    if (data.type === 'call') {
      if (await appIsOpen()) return;   // app handles ringing in-foreground
      await self.registration.showNotification(data.title || 'Incoming call', {
        body: data.body || '',
        icon: data.icon || '/icon-192.png',
        /* Android renders the badge as a silhouette: it reads only the alpha
           channel and fills it flat white/black itself, ignoring color - a
           full-color icon there shows up as a solid black square. This must
           be a plain white glyph on a transparent background. */
        badge: data.badge || '/badge-96.png',
        tag: data.tag || 'call',
        renotify: true,
        requireInteraction: true,
        vibrate: [400, 250, 400, 250, 400],
        actions: [
          { action: 'answer', title: 'Answer' },
          { action: 'decline', title: 'Decline' }
        ],
        data: { url: data.url || '/', type: 'call', callId: data.callId }
      });
      return;
    }

    if (data.type === 'message') {
      if (await appIsOpen()) return;
      /* Multiple messages in the same conversation must not just replace
         each other (same `tag` = same notification slot) - merge them into
         one running transcript instead, and allow replying without opening
         the app. */
      const existing = await self.registration.getNotifications({ tag: data.tag });
      const log = (existing[0] && existing[0].data && existing[0].data.log) || [];
      log.push({ name: data.senderName, text: data.text });
      while (log.length > 6) log.shift();
      const isGroup = !!(data.reply && data.reply.groupId);
      const body = log.map(m => isGroup ? (m.name + ': ' + m.text) : m.text).join('\n');
      await self.registration.showNotification(data.title || 'LinkUp', {
        body,
        icon: data.icon || '/icon-192.png',
        badge: data.badge || '/badge-96.png',
        tag: data.tag,
        renotify: true,
        actions: [{ action: 'reply', title: 'Reply', type: 'text', placeholder: 'Message ' + (data.title || '') }],
        data: { url: data.url || '/', type: 'message', log, reply: data.reply }
      });
      return;
    }

    await self.registration.showNotification(data.title || 'LinkUp', {
      body: data.body || '',
      icon: data.icon || '/icon-192.png',
      badge: data.badge || '/badge-96.png',
      tag: data.tag || undefined,
      data: { url: data.url || '/' }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  const ndata = event.notification.data || {};

  if (event.action === 'reply') {
    const text = (event.reply || '').trim();
    event.notification.close();
    if (text) event.waitUntil(sendReplyFromNotification(ndata, text));
    return;
  }

  event.notification.close();

  if (event.action === 'decline' && ndata.type === 'call') {
    event.waitUntil(declineCallFromNotification(ndata.callId));
    return;
  }

  /* Answer should skip the extra "now tap Accept inside the app" step -
     jump straight into accepting via a dedicated hash the app treats
     differently from a plain tap on the notification body (which still
     just opens the ringing screen, same as before). */
  const url = (event.action === 'answer' && ndata.type === 'call' && ndata.callId)
    ? '/#autoanswer=' + ndata.callId
    : (ndata.url || '/');
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
