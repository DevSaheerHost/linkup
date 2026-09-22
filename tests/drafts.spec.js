// Drafts and scheduling. A draft is a real post row that isn't published
// yet, so the media pipeline is unchanged - only status differs.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const now = new Date().toISOString();
const soon = new Date(Date.now() + 3600000).toISOString();

const PROF = { id: ME, username: 'smoketest', name: 'S', bio: '', avatar_url: null, is_verified: false, is_private: false, is_moderator: false, last_seen: now };
const post = (id, status, publish_at) => ({
  id, author_id: ME, caption: 'a caption', audience: 'public', tags: null,
  image_url: 'http://localhost:8420/icon-192.png', photos: null, video_url: null,
  thumb_url: null, poll: null, created_at: now, updated_at: now, hashtags: [],
  status, publish_at: publish_at || null,
});

async function boot(page, posts) {
  await installSupabaseMocks(page, {
    userId: ME, email: 'smoke@test.local', profile: PROF,
    tables: { profiles: [PROF], posts, follows: [] },
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

test('the public grid shows only published posts, and a Drafts button counts the rest', async ({ page }) => {
  await boot(page, [post('p1', 'published'), post('p2', 'draft'), post('p3', 'scheduled', soon)]);
  await page.evaluate((id) => window.openProfile(id), ME);

  // RLS lets an author read their own drafts - that is what makes the list
  // work - but the grid is only what is live.
  await expect(page.locator('#sProfile .gcell')).toHaveCount(1, { timeout: 10000 });
  const btn = page.locator('#sProfile .pbtns button', { hasText: 'Drafts' });
  await expect(btn).toContainText('2');
});

test('no drafts means no Drafts button', async ({ page }) => {
  await boot(page, [post('p1', 'published')]);
  await page.evaluate((id) => window.openProfile(id), ME);
  await expect(page.locator('#sProfile .gcell')).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator('#sProfile .pbtns button', { hasText: 'Drafts' })).toHaveCount(0);
});

test('the list separates a draft from a scheduled post', async ({ page }) => {
  await boot(page, [post('p2', 'draft'), post('p3', 'scheduled', soon)]);
  await page.evaluate(() => window.openDrafts());

  await expect(page.locator('#listBody .drow')).toHaveCount(2, { timeout: 10000 });
  await expect(page.locator('#listBody .drow').nth(0).locator('.snip')).toHaveText('Draft');
  await expect(page.locator('#listBody .drow').nth(1).locator('.snip')).toContainText('Goes out');
});

test('Post now flips the row to published', async ({ page }) => {
  await boot(page, [post('p2', 'draft')]);
  const patches = [];
  page.on('request', (r) => {
    if (r.url().includes('/rest/v1/posts') && r.method() === 'PATCH') patches.push(r.postData());
  });

  await page.evaluate(() => window.openDrafts());
  await expect(page.locator('#listBody .drow')).toHaveCount(1, { timeout: 10000 });
  await page.locator('#listBody button', { hasText: 'Post now' }).click();

  await expect.poll(() => patches.length).toBeGreaterThan(0);
  const body = JSON.parse(patches[0]);
  expect(body.status).toBe('published');
  expect(body.publish_at).toBeNull();
});

test('scheduling refuses a time in the past', async ({ page }) => {
  await boot(page, []);
  await page.evaluate(() => window.openScheduleSheet(() => { window.__picked = true; }));

  const past = new Date(Date.now() - 3600000);
  const pad = (n) => String(n).padStart(2, '0');
  await page.fill('#schedWhen', `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.getMinutes())}`);
  await page.locator('#schedGo').click();

  await expect(page.locator('#toast')).toContainText('at least a minute from now');
  expect(await page.evaluate(() => window.__picked)).toBeUndefined();
});

test('scheduling accepts a future time and hands back an ISO string', async ({ page }) => {
  await boot(page, []);
  await page.evaluate(() => { window.__when = null; window.openScheduleSheet((w) => { window.__when = w; }); });
  await page.locator('#schedGo').click();     // default is an hour out

  const when = await page.evaluate(() => window.__when);
  expect(when).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(new Date(when).getTime()).toBeGreaterThan(Date.now());
});
