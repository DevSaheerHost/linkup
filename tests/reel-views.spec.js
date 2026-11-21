// View totals on the reels in your own profile grid. Exact only for the
// author (postviews RLS), so they appear on your own profile and nowhere else.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002';
const now = new Date().toISOString();
const IMG = 'http://localhost:8420/icon-192.png';
const P = (id, u) => ({ id, username: u, name: u, bio: '', avatar_url: null, is_verified: false, is_private: false, is_moderator: false, last_seen: now });
const base = { audience: 'public', tags: null, photos: null, poll: null, created_at: now, updated_at: now, hashtags: [], keywords: [], status: 'published', publish_at: null, caption: '' };
const reel = (id, author) => ({ ...base, id, author_id: author, image_url: null, thumb_url: IMG, video_url: 'http://localhost:8420/x.mp4' });
const photo = (id, author) => ({ ...base, id, author_id: author, image_url: IMG, thumb_url: null, video_url: null });
const poll = (id, author) => ({ ...base, id, author_id: author, image_url: null, thumb_url: null, video_url: null, poll: { q: 'Make a Solar system', opts: ['a', 'b'] } });

const R1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const R2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const R3 = 'bbbbbbbb-0000-4000-8000-000000000003';
const PH = 'bbbbbbbb-0000-4000-8000-000000000004';
const PL = 'bbbbbbbb-0000-4000-8000-000000000005';

// Counts per post, served for HEAD requests filtered by post_id.
async function serveViewCounts(page, counts) {
  await page.route('**/rest/v1/postviews*', (route) => {
    const req = route.request();
    const pid = (new URL(req.url()).searchParams.get('post_id') || '').replace('eq.', '');
    const n = counts[pid] ?? 0;
    if (req.method() === 'HEAD') {
      return route.fulfill({ status: 200, headers: { 'Content-Range': `*/${n}`, 'Access-Control-Expose-Headers': 'Content-Range' }, body: '' });
    }
    return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
  });
}

async function boot(page, posts) {
  await installSupabaseMocks(page, {
    userId: ME, email: 's@t.l', profile: P(ME, 'saheer_babu'),
    tables: { profiles: [P(ME, 'saheer_babu'), P(OTHER, 'someone')], posts, follows: [], stories: [], highlights: [] },
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

test('each reel on my profile shows its total views, compacted', async ({ page }) => {
  await boot(page, [reel(R1, ME), photo(PH, ME), reel(R2, ME), poll(PL, ME), reel(R3, ME)]);
  await serveViewCounts(page, { [R1]: 7, [R2]: 1530, [R3]: 0 });
  await page.evaluate((id) => window.openProfile(id), ME);

  await expect(page.locator(`#sProfile .gcell[data-pid="${R1}"] .gviews`)).toHaveText('7', { timeout: 10000 });
  await expect(page.locator(`#sProfile .gcell[data-pid="${R2}"] .gviews`)).toHaveText('1.5K');
  // A reel nobody has watched yet still says so.
  await expect(page.locator(`#sProfile .gcell[data-pid="${R3}"] .gviews`)).toHaveText('0');
  // The exact figure is there for anyone who wants it.
  await expect(page.locator(`#sProfile .gcell[data-pid="${R2}"] .gviews`)).toHaveAttribute('title', '1530 views');
});

test('photos and polls get no view badge - only reels', async ({ page }) => {
  await boot(page, [reel(R1, ME), photo(PH, ME), poll(PL, ME)]);
  await serveViewCounts(page, { [R1]: 3, [PH]: 99, [PL]: 99 });
  await page.evaluate((id) => window.openProfile(id), ME);

  await expect(page.locator(`#sProfile .gcell[data-pid="${R1}"] .gviews`)).toHaveText('3', { timeout: 10000 });
  await expect(page.locator(`#sProfile .gcell[data-pid="${PH}"] .gviews`)).toHaveCount(0);
  await expect(page.locator(`#sProfile .gpoll .gviews`)).toHaveCount(0);
});

test("someone else's profile shows no counts, because they would be wrong", async ({ page }) => {
  await boot(page, [reel(R1, OTHER)]);
  await serveViewCounts(page, { [R1]: 42 });
  const counted = [];
  page.on('request', (r) => { if (r.url().includes('/rest/v1/postviews') && r.method() === 'HEAD') counted.push(r.url()); });

  await page.evaluate((id) => window.openProfile(id), OTHER);
  await expect(page.locator(`#sProfile .gcell[data-pid="${R1}"]`)).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(400);
  // RLS would only let a visitor see their own view row - 0 or 1. Not asked
  // at all, so no misleading number is ever shown.
  await expect(page.locator('#sProfile .gviews')).toHaveCount(0);
  expect(counted).toHaveLength(0);
});

test('a count that fails to load shows nothing rather than a false 0', async ({ page }) => {
  await boot(page, [reel(R1, ME)]);
  await page.route('**/rest/v1/postviews*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' }));
  await page.evaluate((id) => window.openProfile(id), ME);
  await expect(page.locator(`#sProfile .gcell[data-pid="${R1}"]`)).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(400);
  await expect(page.locator('#sProfile .gviews')).toHaveCount(0);
});
