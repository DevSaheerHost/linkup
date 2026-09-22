// Invite flow: a shared profile link should tell a stranger who sent them,
// and there should always be a way to send one.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks, PROJECT_REF } = require('./mock-supabase');

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const now = new Date().toISOString();
const P = (id, u) => ({ id, username: u, name: u, bio: '', avatar_url: null, is_verified: false, is_private: false, last_seen: now });

// Logged out: no session in localStorage, so the auth card is what renders.
async function bootLoggedOut(page, hash, preview) {
  await installSupabaseMocks(page, {
    userId: ME, email: 'x@y.z', profile: P(ME, 'smoketest'),
    tables: { 'rpc/invite_preview': preview },
  });
  await page.addInitScript((ref) => localStorage.removeItem(`sb-${ref}-auth-token`), PROJECT_REF);
  await page.goto('/' + hash);
}

test('a profile link says who invited you', async ({ page }) => {
  await bootLoggedOut(page, '#u=saheer_babu', [{ username: 'saheer_babu', name: 'Saheer', avatar_url: null, is_verified: false }]);

  await expect(page.locator('#invitedBy')).toContainText('@saheer_babu', { timeout: 10000 });
  await expect(page.locator('#invitedBy')).toContainText('invited you to LinkUp');
  await expect(page.locator('#authSub')).toHaveText('Create an account to follow them');
});

test('a plain visit shows the ordinary login card', async ({ page }) => {
  await bootLoggedOut(page, '', []);
  await expect(page.locator('#auth')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#invitedBy')).toBeEmpty();
  await expect(page.locator('#authSub')).toHaveText('Sign in to continue');
});

test('an unknown username falls back to the plain card, not a broken one', async ({ page }) => {
  await bootLoggedOut(page, '#u=ghost', []);
  await expect(page.locator('#auth')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#invitedBy')).toBeEmpty();
  await expect(page.locator('#authSub')).toHaveText('Sign in to continue');
});

test('the invite card closes the rail, and is the whole rail when nobody is left', async ({ page }) => {
  await installSupabaseMocks(page, {
    userId: ME, email: 'x@y.z', profile: P(ME, 'smoketest'),
    tables: { profiles: [P(ME, 'smoketest')], 'rpc/suggest_people': [], follows: [], posts: [], stories: [] },
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => window.renderSuggestRail());

  // Running out of people to suggest is the normal case on a small instance;
  // an empty rail would be a dead end.
  await expect(page.locator('#suggestRail .sginvite')).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator('#suggestRail .sghead')).toHaveText('Grow your feed');
});

test('the shared link carries the username the invite card reads back', async ({ page }) => {
  await installSupabaseMocks(page, {
    userId: ME, email: 'x@y.z', profile: P(ME, 'smoketest'),
    tables: { profiles: [P(ME, 'smoketest')], 'rpc/suggest_people': [], follows: [], posts: [], stories: [] },
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });

  const link = await page.evaluate(() => window.myProfileLink());
  expect(link).toContain('#u=smoketest');
  expect(new URL(link).hash.match(/[#&]u=([^&]+)/)[1]).toBe('smoketest');
});
