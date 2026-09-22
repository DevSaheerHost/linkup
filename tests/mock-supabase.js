// Fakes just enough of the Supabase backend for a logged-in boot: seeds a
// session into localStorage before app.js runs (so sb.auth.getSession()
// resolves locally, no network needed) and intercepts REST/RPC calls to
// the real project so tests never touch live data.
const fs = require('fs');
const path = require('path');

const PROJECT_REF = 'prfdrpmnftegbiaglugh';
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const SUPABASE_JS_CDN_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
const SUPABASE_JS_LOCAL_PATH = path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeSession(userId, email) {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ sub: userId, email, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 * 24 * 365 });
  const access_token = `${header}.${payload}.fakesig`;
  return {
    access_token,
    refresh_token: 'fake-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600 * 24 * 365,
    expires_in: 3600 * 24 * 365,
    token_type: 'bearer',
    user: { id: userId, email, aud: 'authenticated', role: 'authenticated' },
  };
}

async function installSupabaseMocks(page, { userId, email, profile, tables = {} }) {
  const session = fakeSession(userId, email);
  await page.addInitScript(([ref, sess]) => {
    localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(sess));
  }, [PROJECT_REF, session]);

  // This sandbox can't reach the real CDN; serve the same library from
  // node_modules instead of changing what index.html loads in production.
  await page.route(SUPABASE_JS_CDN_URL, (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(SUPABASE_JS_LOCAL_PATH) })
  );

  /* Content-Range carries the row count for select(..., {count:'exact'}),
     and it is not a CORS-safelisted response header - without
     Access-Control-Expose-Headers the browser hides it from the page and
     every count in the app reads back as null. The real API sends this;
     the mock has to as well or no count is ever testable. */
  const EXPOSE = { 'Access-Control-Expose-Headers': 'Content-Range, Content-Profile' };

  const json = (route, body, status = 200, extraHeaders = {}) =>
    route.fulfill({ status, contentType: 'application/json', headers: { 'Content-Range': '0-0/0', ...EXPOSE, ...extraHeaders }, body: JSON.stringify(body) });

  await page.route(`${PROJECT_URL}/rest/v1/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const table = url.pathname.replace('/rest/v1/', '').split('?')[0];
    const isSingle = (req.headers()['accept'] || '').includes('vnd.pgrst.object');

    // A test can override any table (including profiles, e.g. so a batched
    // .in('id',[...]) lookup returns several users); put the signed-in
    // user's own profile first there, since .single() takes rows[0].
    // RPCs land here too, keyed as e.g. "rpc/get_feed_for_you".
    /* Honour `?id=eq.<uuid>`: several code paths look a single profile up
       by id (getUser), and without this every one of them would get
       whichever row happens to be first. */
    const idFilter = url.searchParams.get('id');
    const byId = (rows) => (idFilter && idFilter.startsWith('eq.'))
      ? rows.filter((r) => r && r.id === idFilter.slice(3))
      : rows;

    if (tables[table] !== undefined) {
      const rows = byId(tables[table]);
      if (req.method() === 'HEAD') {
        return route.fulfill({ status: 200, headers: { 'Content-Range': `0-${Math.max(0, rows.length - 1)}/${rows.length}`, ...EXPOSE }, body: '' });
      }
      return json(route, isSingle ? (rows[0] || null) : rows);
    }
    if (table === 'profiles') {
      const rows = byId([profile]);
      return json(route, isSingle ? (rows[0] || null) : rows);
    }
    // Unhandled table: default to empty, so incidental boot-time fetches
    // (notifications, groups, blocks, close friends, etc.) don't error.
    if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { 'Content-Range': '*/0', ...EXPOSE }, body: '' });
    return json(route, isSingle ? null : []);
  });

  /* Private-bucket media is fetched through a signed URL, so the storage
     sign endpoint has to answer for chat photos/voice notes to render. */
  await page.route(`${PROJECT_URL}/storage/v1/object/sign/**`, async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const paths = body.paths || (body.path ? [body.path] : []);
    return json(route, paths.map((p) => ({ path: p, signedURL: `/storage/v1/object/sign/chat/${p}?token=test`, error: null })));
  });

  await page.route(`${PROJECT_URL}/auth/v1/**`, (route) => json(route, { user: session.user }));

  // Let realtime attempts fail fast instead of hanging the page.
  await page.routeWebSocket(`${PROJECT_URL}/realtime/**`, (ws) => { ws.close(); });
}

module.exports = { installSupabaseMocks, PROJECT_URL, PROJECT_REF };
