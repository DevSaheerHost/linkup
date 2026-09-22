// The report button used to write into a table nobody could read. The
// moderator boundary itself is proven against the real database; this
// covers the queue UI and, importantly, that it stays invisible to
// everyone else.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');

const MOD = 'aaaaaaaa-0000-4000-8000-000000000001';
const REPORTER = 'aaaaaaaa-0000-4000-8000-000000000002';
const POST = 'bbbbbbbb-0000-4000-8000-000000000001';
const BADUSER = 'aaaaaaaa-0000-4000-8000-000000000003';
const now = new Date().toISOString();

const P = (id, u, mod) => ({ id, username: u, name: u, bio: '', avatar_url: null, is_verified: false, is_private: false, is_moderator: !!mod, last_seen: now });
const R = (id, kind, target, reason) => ({ id, reporter_id: REPORTER, kind, target_id: target, reason, status: 'open', created_at: now });

async function boot(page, isMod, reports) {
  const self = P(MOD, 'linkup', isMod);
  await installSupabaseMocks(page, {
    userId: MOD, email: 'mod@test.local', profile: self,
    tables: { profiles: [self, P(REPORTER, 'reporter'), P(BADUSER, 'spammer')], reports, posts: [], follows: [] },
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

test('a moderator gets a Reports button with the open count', async ({ page }) => {
  await boot(page, true, [R('r1', 'post', POST, 'spam'), R('r2', 'user', BADUSER, 'harassment')]);
  await page.evaluate((id) => window.openProfile(id), MOD);

  const btn = page.locator('#sProfile .pbtns button', { hasText: 'Reports' });
  await expect(btn).toBeVisible({ timeout: 10000 });
  await expect(btn).toContainText('2');
});

test('an ordinary user never sees the queue', async ({ page }) => {
  await boot(page, false, []);
  await page.evaluate((id) => window.openProfile(id), MOD);
  await expect(page.locator('#sProfile .pbtns button', { hasText: 'Edit profile' })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#sProfile .pbtns button', { hasText: 'Reports' })).toHaveCount(0);
});

test('the queue shows each report, with Remove post only for post reports', async ({ page }) => {
  await boot(page, true, [R('r1', 'post', POST, 'spam'), R('r2', 'user', BADUSER, 'harassment')]);
  await page.evaluate(() => window.openReports());

  await expect(page.locator('#listBody .rprow')).toHaveCount(2, { timeout: 10000 });
  await expect(page.locator('#listBody .rprow').nth(0)).toContainText('reported by');
  await expect(page.locator('#listBody .rprow').nth(0)).toContainText('spam');
  // Removing a post is the destructive action; a user report has no such button.
  await expect(page.locator('#listBody .rprow').nth(0).locator('button', { hasText: 'Remove post' })).toHaveCount(1);
  await expect(page.locator('#listBody .rprow').nth(1).locator('button', { hasText: 'Remove post' })).toHaveCount(0);
});

test('dismiss and remove go through the moderator RPCs', async ({ page }) => {
  await boot(page, true, [R('r1', 'post', POST, 'spam')]);
  const rpcs = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rpc\/(resolve_report|moderator_remove_post)/);
    if (m) rpcs.push({ fn: m[1], body: r.postData() });
  });

  await page.evaluate(() => window.openReports());
  await expect(page.locator('#listBody .rprow')).toHaveCount(1, { timeout: 10000 });
  await page.locator('#listBody button', { hasText: 'Dismiss' }).click();
  await expect.poll(() => rpcs.length).toBeGreaterThan(0);
  expect(rpcs[0].fn).toBe('resolve_report');
  expect(JSON.parse(rpcs[0].body).p_status).toBe('dismissed');

  await page.evaluate(() => window.openReports());
  await page.locator('#listBody button', { hasText: 'Remove post' }).click();
  await expect.poll(() => rpcs.length).toBeGreaterThan(1);
  expect(rpcs[rpcs.length - 1].fn).toBe('moderator_remove_post');
  expect(JSON.parse(rpcs[rpcs.length - 1].body).p_post_id).toBe(POST);
});

test('an empty queue says so instead of looking broken', async ({ page }) => {
  await boot(page, true, []);
  await page.evaluate(() => window.openReports());
  await expect(page.locator('#listBody')).toContainText('Nothing to review', { timeout: 10000 });
});
