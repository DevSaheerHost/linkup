// Mute is the soft alternative to blocking: their posts and stories stop
// being served, they aren't told, and their profile still works.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const NOISY = 'aaaaaaaa-0000-4000-8000-000000000002';
const QUIET = 'aaaaaaaa-0000-4000-8000-000000000003';
const now = new Date().toISOString();

const P = (id, u) => ({ id, username: u, name: u, bio: '', avatar_url: null, is_verified: false, is_private: false, last_seen: now });
const story = (id, author) => ({ id, author_id: author, image_url: null, caption: '', created_at: now });

async function boot(page, mutes) {
  await installSupabaseMocks(page, {
    userId: ME, email: 'smoke@test.local', profile: P(ME, 'smoketest'),
    tables: {
      profiles: [P(ME, 'smoketest'), P(NOISY, 'noisy'), P(QUIET, 'quiet')],
      stories: [story('s1', NOISY), story('s2', QUIET)],
      mutes, follows: [], posts: [],
    },
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

test('a muted author is dropped from the story tray, an unmuted one is not', async ({ page }) => {
  await boot(page, [{ muted_id: NOISY, mute_posts: true, mute_stories: true }]);
  await page.evaluate(async () => { await window.loadMutes(); await window.loadStories(); });

  const names = await page.locator('#storyTray .scell .nm').allTextContents();
  expect(names).toContain('quiet');
  expect(names).not.toContain('noisy');
});

test('with nothing muted, both authors appear', async ({ page }) => {
  await boot(page, []);
  await page.evaluate(async () => { await window.loadMutes(); await window.loadStories(); });

  const names = await page.locator('#storyTray .scell .nm').allTextContents();
  expect(names).toContain('quiet');
  expect(names).toContain('noisy');
});

test('muting writes a mute row and never touches follows or blocks', async ({ page }) => {
  await boot(page, []);
  const writes = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/(mutes|blocks|follows)/);
    if (m && r.method() !== 'GET') writes.push(m[1]);
  });

  await page.evaluate(async (id) => { await window.loadMutes(); await window.toggleMuteUser(id); }, NOISY);

  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(writes).toContain('mutes');
  // The entire point of mute over block: nothing else changes.
  expect(writes).not.toContain('blocks');
  expect(writes).not.toContain('follows');
});

test('the menu offers Mute, and Unmute once muted', async ({ page }) => {
  await boot(page, [{ muted_id: NOISY, mute_posts: true, mute_stories: true }]);
  await page.evaluate(async () => { await window.loadMutes(); });

  await page.evaluate((id) => window.openUserMenu(id), QUIET);
  await expect(page.locator('#actMenu')).toContainText('Mute user');

  await page.evaluate((id) => window.openUserMenu(id), NOISY);
  await expect(page.locator('#actMenu')).toContainText('Unmute user');
});
