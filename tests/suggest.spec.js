// Suggested people: the cold-start fix. The ranking is proven against the
// real database; this covers the rail that surfaces it.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const A = 'aaaaaaaa-0000-4000-8000-000000000002';
const B = 'aaaaaaaa-0000-4000-8000-000000000003';
const now = new Date().toISOString();

const P = (id, u, priv) => ({ id, username: u, name: u, bio: '', avatar_url: null, is_verified: false, is_private: !!priv, last_seen: now });
const S = (id, u, reason, priv) => ({ id, username: u, name: u, avatar_url: null, is_verified: false, is_private: !!priv, reason, score: 5 });

async function boot(page, suggestions) {
  await installSupabaseMocks(page, {
    userId: ME, email: 'smoke@test.local', profile: P(ME, 'smoketest'),
    tables: {
      profiles: [P(ME, 'smoketest'), P(A, 'follows_me'), P(B, 'locked', true)],
      'rpc/suggest_people': suggestions,
      follows: [], posts: [], stories: [], suggestion_dismissals: [],
    },
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

test('the rail shows each suggestion with the reason it was made', async ({ page }) => {
  await boot(page, [S(A, 'follows_me', 'Follows you'), S(B, 'locked', 'Popular on LinkUp', true)]);
  await page.evaluate(() => window.renderSuggestRail());

  await expect(page.locator('#suggestRail .sgcard')).toHaveCount(2, { timeout: 10000 });
  await expect(page.locator('#suggestRail .sghead')).toHaveText('Suggested for you');
  await expect(page.locator('#suggestRail .sgcard').nth(0).locator('.sgwhy')).toHaveText('Follows you');
  // A private suggestion has to ask, not follow.
  await expect(page.locator('#suggestRail .sgcard').nth(0).locator('.sgfollow')).toHaveText('Follow');
  await expect(page.locator('#suggestRail .sgcard').nth(1).locator('.sgfollow')).toHaveText('Request');
});

test('the rail stays out of Following, which is a feed you chose', async ({ page }) => {
  await boot(page, [S(A, 'follows_me', 'Follows you')]);
  await page.evaluate(() => window.setFeedMode('following'));
  await expect(page.locator('#suggestRail .sgcard')).toHaveCount(0);

  await page.evaluate(() => window.setFeedMode('all'));
  await expect(page.locator('#suggestRail .sgcard')).toHaveCount(1, { timeout: 10000 });
});

test('dismissing records it so the person stops coming back', async ({ page }) => {
  await boot(page, [S(A, 'follows_me', 'Follows you')]);
  const writes = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rest/v1/suggestion_dismissals')) writes.push(r.postData());
  });
  await page.evaluate(() => window.renderSuggestRail());
  await expect(page.locator('#suggestRail .sgcard')).toHaveCount(1, { timeout: 10000 });
  await page.locator('#suggestRail .sgx').click();

  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(JSON.parse(writes[0]).dismissed_id).toBe(A);
});

test('nothing to suggest renders nothing at all, not an empty heading', async ({ page }) => {
  await boot(page, []);
  await page.evaluate(() => window.renderSuggestRail());
  await expect(page.locator('#suggestRail')).toBeEmpty();
});
