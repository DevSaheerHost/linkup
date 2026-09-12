// Drives the real sw.js in a browser context with `self` shadowed by a
// stub, so the notification/push handlers can be invoked directly. Uses the
// browser's real IndexedDB, since the session mirroring the reply depends on
// goes through it.
//
// The bug this exists for: replying from a notification worked once, then a
// second reply silently did nothing - no message, no error - because the
// handler closed the notification and Android kept an un-dispatchable shell.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

const NDATA = {
  url: '/', type: 'message', title: 'linkup', tag: 'msg:conv-1',
  log: [{ name: 'linkup', text: 'Where are you' }],
  reply: { receiverId: 'user-them', conversation: 'conv-1' },
};

async function loadSw(page, { failSend = false } = {}) {
  await page.goto('/');
  await page.evaluate(async ([src, failSend]) => {
    // Seed the session app.js would have mirrored in.
    await new Promise((res, rej) => {
      const rq = indexedDB.open('linkup', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onsuccess = () => {
        const tx = rq.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ access_token: 'tok', refresh_token: 'rt', user_id: 'user-me' }, 'session');
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      };
      rq.onerror = () => rej(rq.error);
    });

    window.__sent = [];
    window.__shown = [];
    const fakeFetch = async (url, opts) => {
      window.__sent.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return { ok: !failSend, status: failSend ? 500 : 201, json: async () => ({}) };
    };
    const handlers = {};
    const fakeSelf = {
      addEventListener: (t, h) => { handlers[t] = h; },
      skipWaiting: () => {},
      clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
      registration: {
        showNotification: async (title, opts) => { window.__shown.push({ title, opts }); },
        getNotifications: async () => [],
      },
    };
    window.__handlers = handlers;
    // `self` and `fetch` are parameters, so they shadow the page's globals.
    new Function('self', 'fetch', src)(fakeSelf, fakeFetch);
  }, [SW_SRC, failSend]);
}

// Invokes notificationclick the way Chrome does for an inline reply.
async function reply(page, text, ndata) {
  return page.evaluate(async ([text, ndata]) => {
    const waits = [];
    await window.__handlers.notificationclick({
      action: 'reply',
      reply: text,
      notification: { data: ndata, tag: ndata.tag, close: () => { window.__closed = true; } },
      waitUntil: (p) => waits.push(p),
    });
    await Promise.all(waits);
  }, [text, ndata]);
}

test('two consecutive inline replies both send', async ({ page }) => {
  await loadSw(page);

  await reply(page, 'At home', NDATA);
  let sent = await page.evaluate(() => window.__sent);
  expect(sent).toHaveLength(1);
  expect(sent[0].url).toContain('/rest/v1/messages');
  expect(sent[0].body.text).toBe('At home');

  // The notification must have been re-shown (not closed) so it can take
  // another reply - this is the regression.
  const closed = await page.evaluate(() => window.__closed);
  expect(closed).toBeUndefined();

  // Reply again into the re-shown notification, carrying its updated data.
  const reshown = await page.evaluate(() => window.__shown[window.__shown.length - 1]);
  expect(reshown.opts.data.reply).toEqual(NDATA.reply);   // reply target survived

  await reply(page, 'And you?', reshown.opts.data);
  sent = await page.evaluate(() => window.__sent);
  expect(sent).toHaveLength(2);
  expect(sent[1].body.text).toBe('And you?');
  expect(sent[1].body.receiver_id).toBe('user-them');
});

test('your own reply is echoed into the notification transcript', async ({ page }) => {
  await loadSw(page);
  await reply(page, 'At home', NDATA);
  const shown = await page.evaluate(() => window.__shown[window.__shown.length - 1]);
  expect(shown.opts.body).toContain('Where are you');
  expect(shown.opts.body).toContain('You: At home');
  expect(shown.opts.tag).toBe('msg:conv-1');            // updates in place
  expect(shown.opts.actions[0].action).toBe('reply');   // still replyable
});

test('a failed send reports instead of vanishing, and keeps the text as a draft', async ({ page }) => {
  await loadSw(page, { failSend: true });
  await reply(page, 'lost message', NDATA);

  const shown = await page.evaluate(() => window.__shown[window.__shown.length - 1]);
  expect(shown.title).toBe('Message not sent');
  expect(shown.opts.body).toContain('lost message');

  const draft = await page.evaluate(() => new Promise((res, rej) => {
    const rq = indexedDB.open('linkup', 1);
    rq.onsuccess = () => {
      const g = rq.result.transaction('kv', 'readonly').objectStore('kv').get('draft:conv-1');
      g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error);
    };
  }));
  expect(draft).toBe('lost message');
});

test('a reply with no target still tells the user instead of discarding it', async ({ page }) => {
  await loadSw(page);
  await reply(page, 'orphan', { url: '/', type: 'message', tag: 't', log: [] });  // no .reply
  const shown = await page.evaluate(() => window.__shown[window.__shown.length - 1]);
  expect(shown.title).toBe('Message not sent');
  expect(shown.opts.body).toContain('orphan');
});
