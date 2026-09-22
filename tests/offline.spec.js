// Offline support. sw.js deliberately did not cache, so losing signal meant
// a blank page. Drives the real fetch handler with `self`, `fetch` and
// `caches` shadowed, the same way sw-reply.spec.js drives the push handler.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const ORIGIN = 'http://localhost:8420';

// Loads sw.js with a fake cache and a fetch we control, then returns a
// helper that runs one request through the real fetch handler.
async function loadSw(page, { offline = false, cached = {} } = {}) {
  await page.goto('/');
  await page.evaluate(([src, origin, offline, cached]) => {
    window.__net = [];
    window.__store = new Map(Object.entries(cached));

    const makeRes = (body, ok = true) => ({
      ok, status: ok ? 200 : 404, body,
      clone() { return makeRes(body, ok); },
    });

    const fakeFetch = async (req) => {
      const url = typeof req === 'string' ? req : req.url;
      window.__net.push(url);
      if (offline) throw new TypeError('Failed to fetch');
      return makeRes('network:' + url);
    };

    const cache = {
      add: async (u) => { window.__store.set(origin + u, makeRes('precached:' + u)); },
      put: async (req, res) => { window.__store.set(typeof req === 'string' ? req : req.url, res); },
      match: async (req) => window.__store.get(typeof req === 'string' ? origin + req : req.url),
    };
    window.__caches = {
      open: async () => cache,
      match: async (req) => cache.match(req),
      keys: async () => ['linkup-v1'],
      delete: async () => true,
    };

    const handlers = {};
    const fakeSelf = {
      addEventListener: (t, h) => { handlers[t] = h; },
      location: { origin },
      skipWaiting: () => {},
      clients: { claim: async () => {}, matchAll: async () => [] },
      registration: { showNotification: async () => {}, getNotifications: async () => [] },
    };
    window.__handlers = handlers;
    new Function('self', 'fetch', 'caches', src)(fakeSelf, fakeFetch, window.__caches);
  }, [SW_SRC, ORIGIN, offline, cached]);
}

// Runs one GET through the fetch handler and returns what it responded with.
async function get(page, url, { html = false } = {}) {
  return page.evaluate(async ([url, html]) => {
    let responded;
    const req = {
      url, method: 'GET',
      mode: html ? 'navigate' : 'cors',
      headers: { get: (k) => (k.toLowerCase() === 'accept' && html ? 'text/html' : '') },
    };
    await window.__handlers.fetch({ request: req, respondWith: (p) => { responded = p; } });
    if (responded === undefined) return { passthrough: true };
    try { const r = await responded; return { body: r && r.body }; }
    catch (e) { return { threw: e.message }; }
  }, [url, html]);
}

test('online, HTML comes from the network and is kept for later', async ({ page }) => {
  await loadSw(page);
  const r = await get(page, ORIGIN + '/', { html: true });
  expect(r.body).toBe('network:' + ORIGIN + '/');

  // Cached on the way past, so the offline case below has something to serve.
  const stored = await page.evaluate((o) => window.__store.has(o + '/'), ORIGIN);
  expect(stored).toBe(true);
});

test('offline, HTML falls back to the last page that worked', async ({ page }) => {
  await loadSw(page, { offline: true, cached: { [ORIGIN + '/']: { body: 'cached-shell' } } });
  const r = await get(page, ORIGIN + '/', { html: true });
  // This is the whole point: no signal used to mean a blank page.
  expect(r.body).toBe('cached-shell');
});

test('a cached asset is served without touching the network', async ({ page }) => {
  await loadSw(page, { cached: { [ORIGIN + '/app.js?v=39']: { body: 'cached-app' } } });
  const r = await get(page, ORIGIN + '/app.js?v=39');
  expect(r.body).toBe('cached-app');
  expect(await page.evaluate(() => window.__net)).toHaveLength(0);
});

test('a version bump is a different URL, so new code is still fetched', async ({ page }) => {
  await loadSw(page, { cached: { [ORIGIN + '/app.js?v=39']: { body: 'cached-app' } } });
  const r = await get(page, ORIGIN + '/app.js?v=40');
  // Cache-first is only safe because of this - stale code would be far
  // worse than a blank page.
  expect(r.body).toBe('network:' + ORIGIN + '/app.js?v=40');
  expect(await page.evaluate(() => window.__net)).toHaveLength(1);
});

test('Supabase requests are never intercepted', async ({ page }) => {
  await loadSw(page);
  // Serving a stale row, or a signed URL that has since expired, would be
  // worse than failing - so cross-origin is left alone entirely.
  const r = await get(page, 'https://prfdrpmnftegbiaglugh.supabase.co/rest/v1/posts');
  expect(r.passthrough).toBe(true);
});

test('non-GET requests are left alone', async ({ page }) => {
  await loadSw(page);
  const r = await page.evaluate(async (o) => {
    let responded;
    await window.__handlers.fetch({
      request: { url: o + '/', method: 'POST', mode: 'cors', headers: { get: () => '' } },
      respondWith: (p) => { responded = p; },
    });
    return responded === undefined;
  }, ORIGIN);
  expect(r).toBe(true);
});
