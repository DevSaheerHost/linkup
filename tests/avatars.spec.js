// Profile photos in the in-app UI: the notification list shows the actor's
// photo, falls back to the letter default when there isn't one (or when the
// photo won't load), and never lets a profile field break out of the
// attribute it's rendered into.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const WITH_PHOTO = 'aaaaaaaa-0000-4000-8000-000000000002';
const NO_PHOTO = 'aaaaaaaa-0000-4000-8000-000000000003';
const BROKEN = 'aaaaaaaa-0000-4000-8000-000000000004';

// Served by the test's own static server, so it really loads.
const PHOTO = 'http://localhost:8420/icon-192.png';
// Same origin, nothing there - the OS/browser fails the request.
const GONE = 'http://localhost:8420/deleted-avatar.jpg';

const now = new Date().toISOString();
const profile = (id, username, avatar_url) =>
  ({ id, username, name: username, bio: '', avatar_url, is_verified: false, last_seen: now });
const notif = (id, actor_id, type) =>
  ({ id, user_id: ME, actor_id, type, post_id: null, read: true, created_at: now, text: null });

async function boot(page, profiles, notifications) {
  await installSupabaseMocks(page, {
    userId: ME, email: 'smoke@test.local', profile: profiles[0],
    tables: { profiles, notifications },
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => window.openNotif());
}

test('notification rows show the actor photo, or the letter default without one', async ({ page }) => {
  await boot(page, [
    profile(ME, 'smoketest', null),
    profile(WITH_PHOTO, 'saheer_babu', PHOTO),
    profile(NO_PHOTO, 'lukman', null),
  ], [notif('n1', WITH_PHOTO, 'follow'), notif('n2', NO_PHOTO, 'follow')]);

  await expect(page.locator('#notifBody .row')).toHaveCount(2, { timeout: 10000 });

  const photo = page.locator('#notifBody .row').nth(0).locator('img.av');
  await expect(photo).toHaveAttribute('src', PHOTO);
  // Actually decoded, not just an <img> tag pointing at nothing.
  expect(await photo.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);

  const fallback = page.locator('#notifBody .row').nth(1).locator('.av.ph');
  await expect(fallback).toHaveText('L');          // lukman -> L
});

test('a photo that fails to load falls back to the default, not a broken image', async ({ page }) => {
  await boot(page, [profile(ME, 'smoketest', null), profile(BROKEN, 'signal_guest', GONE)],
    [notif('n1', BROKEN, 'follow')]);

  // The <img> is replaced in place once the load fails, so the row keeps a
  // real avatar instead of showing the browser's broken-image glyph.
  await expect(page.locator('#notifBody .row .av.ph')).toHaveText('S', { timeout: 10000 });
  await expect(page.locator('#notifBody img.av')).toHaveCount(0);
});

test('a quote in avatar_url cannot break out of the src attribute', async ({ page }) => {
  // avatar_url is plain text the owner can set to anything via the API, so
  // an unescaped one would be stored XSS in every viewer's feed.
  const EVIL = 'https://example.com/a.jpg" onerror="window.__pwned=1';
  await boot(page, [profile(ME, 'smoketest', null), profile(BROKEN, 'evil', EVIL)],
    [notif('n1', BROKEN, 'follow')]);

  await expect(page.locator('#notifBody .row')).toHaveCount(1, { timeout: 10000 });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});
