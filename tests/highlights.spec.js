// Story highlights: the one thing that makes a profile worth revisiting
// once the stories themselves have expired.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002';
const now = new Date().toISOString();
const old = new Date(Date.now() - 5 * 86400000).toISOString();   // long expired

const P = (id, u) => ({ id, username: u, name: u, bio: '', avatar_url: null, is_verified: false, is_private: false, is_moderator: false, last_seen: now });
const STORY = (id, author, when) => ({ id, author_id: author, image_url: `http://localhost:8420/icon-192.png`, caption: '', tags: null, created_at: when });
const HL = (id, owner, title) => ({ id, owner_id: owner, title, cover_url: 'http://localhost:8420/icon-192.png', created_at: now });

async function boot(page, tables) {
  await installSupabaseMocks(page, {
    userId: ME, email: 'smoke@test.local', profile: P(ME, 'smoketest'),
    tables: { profiles: [P(ME, 'smoketest'), P(OTHER, 'someone')], posts: [], follows: [], ...tables },
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

test('my profile shows my highlights plus a New button', async ({ page }) => {
  await boot(page, { highlights: [HL('h1', ME, 'Trip'), HL('h2', ME, 'Food')] });
  await page.evaluate((id) => window.openProfile(id), ME);

  await expect(page.locator('#sProfile .hlcell')).toHaveCount(3, { timeout: 10000 });   // 2 + New
  await expect(page.locator('#sProfile .hlcell .nm').nth(0)).toHaveText('Trip');
  await expect(page.locator('#sProfile .hladd')).toHaveCount(1);
});

test("someone else's profile shows their highlights and no New button", async ({ page }) => {
  await boot(page, { highlights: [HL('h1', OTHER, 'Their trip')] });
  await page.evaluate((id) => window.openProfile(id), OTHER);

  await expect(page.locator('#sProfile .hlcell')).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator('#sProfile .hladd')).toHaveCount(0);
});

test('a profile with no highlights shows nothing to a visitor', async ({ page }) => {
  await boot(page, { highlights: [] });
  await page.evaluate((id) => window.openProfile(id), OTHER);
  await expect(page.locator('#sProfile .pbtns')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#sProfile .hlrow')).toHaveCount(0);
});

test('the composer offers expired stories, and needs a name and a pick', async ({ page }) => {
  await boot(page, { highlights: [], stories: [STORY('s1', ME, old), STORY('s2', ME, old)] });
  await page.evaluate(() => window.openHighlightCompose());

  // Expired stories are exactly what a highlight is for, so all of them show.
  await expect(page.locator('#listBody .hlopt')).toHaveCount(2, { timeout: 10000 });

  await page.locator('#hlSave').click();
  await expect(page.locator('#toast')).toHaveText('Give it a name');

  await page.fill('#hlTitle', 'Trip');
  await page.locator('#hlSave').click();
  await expect(page.locator('#toast')).toHaveText('Pick at least one story');
});

test('creating writes the highlight and its items, cover taken from the first pick', async ({ page }) => {
  await boot(page, { highlights: [], stories: [STORY('s1', ME, old), STORY('s2', ME, old)] });
  const writes = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/(highlights|highlight_items)/);
    if (m && r.method() === 'POST') writes.push({ table: m[1], body: r.postData() });
  });

  await page.evaluate(() => window.openHighlightCompose());
  await expect(page.locator('#listBody .hlopt')).toHaveCount(2, { timeout: 10000 });
  await page.fill('#hlTitle', 'Trip');
  await page.locator('.hlopt').nth(0).click();
  await page.locator('.hlopt').nth(1).click();
  await page.locator('#hlSave').click();

  await expect.poll(() => writes.length).toBeGreaterThan(1);
  const h = JSON.parse(writes[0].body);
  expect(writes[0].table).toBe('highlights');
  expect(h.title).toBe('Trip');
  expect(h.cover_url).toContain('icon-192.png');

  const items = JSON.parse(writes[1].body);
  expect(writes[1].table).toBe('highlight_items');
  expect(items).toHaveLength(2);
  expect(items.map((i) => i.position)).toEqual([0, 1]);   // order preserved
});
