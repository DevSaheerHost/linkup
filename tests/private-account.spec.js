// Private accounts: what a stranger sees, what a request does, and what the
// owner sees. RLS is proven separately against the real database; this covers
// the UI that has to explain it.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const PRIV = 'aaaaaaaa-0000-4000-8000-000000000002';
const OPEN = 'aaaaaaaa-0000-4000-8000-000000000003';
const now = new Date().toISOString();

const P = (id, username, is_private) => ({
  id, username, name: username, bio: '', avatar_url: null,
  is_verified: false, is_private: !!is_private, last_seen: now,
});

async function boot(page, extra = {}) {
  await installSupabaseMocks(page, {
    userId: ME, email: 'smoke@test.local', profile: P(ME, 'smoketest'),
    tables: {
      profiles: [P(ME, 'smoketest'), P(PRIV, 'locked_up', true), P(OPEN, 'wide_open')],
      follows: [], follow_requests: [], posts: [],
      ...extra,
    },
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

test("a private account you don't follow shows a lock, not an empty grid", async ({ page }) => {
  await boot(page);
  await page.evaluate((id) => window.openProfile(id), PRIV);

  await expect(page.locator('#sProfile .locked')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#sProfile .lktitle')).toHaveText('This account is private');
  // Follower/following counts stop being tappable - the list is part of
  // what going private is meant to hide.
  await expect(page.locator('#sProfile .pstats div[onclick]')).toHaveCount(0);
  await expect(page.locator('#followBtn')).toHaveText('Request');
});

test('a public account is unaffected', async ({ page }) => {
  await boot(page);
  await page.evaluate((id) => window.openProfile(id), OPEN);
  await expect(page.locator('#followBtn')).toHaveText('Follow', { timeout: 10000 });
  await expect(page.locator('#sProfile .locked')).toHaveCount(0);
  await expect(page.locator('#sProfile .pstats div[onclick]')).toHaveCount(2);
});

test('tapping Request writes a follow request, not a follow', async ({ page }) => {
  await boot(page);
  const writes = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/rest\/v1\/(follows|follow_requests)/.test(r.url())) {
      writes.push(r.url().split('/rest/v1/')[1].split('?')[0]);
    }
  });

  await page.evaluate((id) => window.openProfile(id), PRIV);
  await expect(page.locator('#followBtn')).toHaveText('Request', { timeout: 10000 });
  await page.locator('#followBtn').click();

  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(writes).toContain('follow_requests');
  expect(writes).not.toContain('follows');   // the insert policy would refuse it anyway
});

test('the Follow button on a post asks instead of following, for a private author', async ({ page }) => {
  await boot(page);
  const writes = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/rest\/v1\/(follows|follow_requests)/.test(r.url())) {
      writes.push(r.url().split('/rest/v1/')[1].split('?')[0]);
    }
  });

  await page.evaluate(async (priv) => {
    const host = document.createElement('div');
    host.id = 'probe';
    // Floated above the app chrome so the click lands on the button and not
    // on whatever fixed layer happens to cover the end of <body>.
    host.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:9999;background:#000;padding:8px';
    host.innerHTML = window.followBtnHtml(priv);
    document.body.appendChild(host);
  }, PRIV);
  await page.locator('#probe .followbtn').click();

  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(writes).toContain('follow_requests');
  expect(writes).not.toContain('follows');
});

test('the owner gets a Requests button and can approve', async ({ page }) => {
  await boot(page, {
    profiles: [P(ME, 'smoketest', true), P(PRIV, 'locked_up', true), P(OPEN, 'wide_open')],
    follow_requests: [{ requester_id: OPEN, target_id: ME, created_at: now }],
  });
  await page.evaluate((id) => window.openProfile(id), ME);

  const reqBtn = page.locator('#sProfile .pbtns button', { hasText: 'Requests' });
  await expect(reqBtn).toBeVisible({ timeout: 10000 });
  await reqBtn.click();

  await expect(page.locator('#listTitle')).toHaveText('Follow requests');
  await expect(page.locator('#listBody .row')).toHaveCount(1);
  await expect(page.locator('#listBody .snip')).toContainText('wide_open');

  const rpc = [];
  page.on('request', (r) => { if (r.url().includes('/rpc/approve_follow_request')) rpc.push(r.postData()); });
  await page.locator('#listBody .reqbtns button', { hasText: 'Approve' }).click();

  // Approval writes a follows row on someone else's behalf, so it has to go
  // through the definer RPC - a direct insert would be refused.
  await expect.poll(() => rpc.length).toBeGreaterThan(0);
  expect(JSON.parse(rpc[0]).p_requester).toBe(OPEN);
});
