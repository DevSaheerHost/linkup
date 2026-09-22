// Saved collections: the flat saves list becomes a graveyard past one
// screenful. "All" is everything you saved, not a collection row.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const P1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const P2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const now = new Date().toISOString();

const PROF = { id: ME, username: 'smoketest', name: 'Smoke', bio: '', avatar_url: null, is_verified: false, is_private: false, is_moderator: false, last_seen: now };
const post = (id) => ({ id, author_id: ME, caption: 'c', audience: 'public', tags: null, image_url: 'http://localhost:8420/icon-192.png', photos: null, video_url: null, thumb_url: null, poll: null, created_at: now, updated_at: now, hashtags: [] });
const C = (id, name) => ({ id, owner_id: ME, name, created_at: now });

async function boot(page, tables) {
  await installSupabaseMocks(page, {
    userId: ME, email: 'smoke@test.local', profile: PROF,
    tables: { profiles: [PROF], posts: [post(P1), post(P2)], follows: [], ...tables },
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

test('saved shows an All tab plus one per collection, and a New button', async ({ page }) => {
  await boot(page, { saves: [{ post_id: P1 }], collections: [C('c1', 'Recipes'), C('c2', 'Code')] });
  await page.evaluate(() => window.openSaved());

  await expect(page.locator('#savedBody .ctab')).toHaveCount(4, { timeout: 10000 });   // All + 2 + New
  await expect(page.locator('#savedBody .ctab').nth(0)).toHaveText('All');
  await expect(page.locator('#savedBody .ctab.on')).toHaveText('All');   // All is the default
  await expect(page.locator('#savedBody .cnew')).toHaveCount(1);
});

test('with no collections it still works, just All and New', async ({ page }) => {
  await boot(page, { saves: [{ post_id: P1 }], collections: [] });
  await page.evaluate(() => window.openSaved());
  await expect(page.locator('#savedBody .ctab')).toHaveCount(2, { timeout: 10000 });
  await expect(page.locator('#savedBody .gcell')).toHaveCount(1);
});

test('an empty collection says so rather than looking like nothing is saved', async ({ page }) => {
  await boot(page, { saves: [{ post_id: P1 }], collections: [C('c1', 'Recipes')], collection_items: [] });
  await page.evaluate(() => window.openSaved('c1'));

  await expect(page.locator('#savedBody .empty')).toHaveText('Nothing in this collection yet', { timeout: 10000 });
  await expect(page.locator('#savedBody .ctab.on')).toHaveText('Recipes');
});

test('filing a post writes a collection item, and the picker offers to remove it after', async ({ page }) => {
  await boot(page, { saves: [{ post_id: P1 }], collections: [C('c1', 'Recipes')], collection_items: [] });
  const writes = [];
  page.on('request', (r) => {
    if (r.url().includes('/rest/v1/collection_items') && r.method() === 'POST') writes.push(r.postData());
  });

  await page.evaluate(() => window.openSaved());
  await expect(page.locator('#savedBody .savedfile')).toHaveCount(1, { timeout: 10000 });
  await page.locator('#savedBody .savedfile').click();

  await expect(page.locator('#actMenu')).toContainText('Add to Recipes');
  await page.locator('#actMenu button', { hasText: 'Add to Recipes' }).click();

  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(JSON.parse(writes[0]).post_id).toBe(P1);
});

test('a post already in a collection is offered removal, not a second add', async ({ page }) => {
  await boot(page, {
    saves: [{ post_id: P1 }], collections: [C('c1', 'Recipes')],
    collection_items: [{ collection_id: 'c1', post_id: P1, added_at: now }],
  });
  await page.evaluate(() => window.openSaved());
  await expect(page.locator('#savedBody .savedfile')).toHaveCount(1, { timeout: 10000 });
  await page.locator('#savedBody .savedfile').click();
  await expect(page.locator('#actMenu')).toContainText('Remove from Recipes');
});
