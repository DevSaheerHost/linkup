// Thin smoke suite against the real app.js/index.html, with the Supabase
// backend faked out (see mock-supabase.js) so nothing here touches the
// live project. Scoped to the exact regressions found by hand this
// session: the back button not closing an open overlay, and a menu
// rendering invisibly behind another overlay due to z-index.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');

const USER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const PROFILE = {
  id: USER_ID, username: 'smoketest', name: 'Smoke Test', bio: '', avatar_url: null,
  is_verified: false, last_seen: new Date().toISOString(),
};
const POST = {
  id: 'bbbbbbbb-0000-4000-8000-000000000001',
  author_id: USER_ID, caption: 'Hello from a smoke test', audience: 'public', tags: null,
  image_url: null, photos: null, video_url: null, thumb_url: null, poll: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  hashtags: [], keywords: [],
  author: { id: USER_ID, username: 'smoketest', name: 'Smoke Test', avatar_url: null, is_verified: false },
};

async function bootLoggedIn(page) {
  await installSupabaseMocks(page, { userId: USER_ID, email: 'smoke@test.local', profile: PROFILE, tables: { posts: [POST] } });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#sFeed')).toHaveClass(/on/);
}

test('boots to the Feed screen for a logged-in session', async ({ page }) => {
  await bootLoggedIn(page);
  await expect(page.locator('#auth')).toBeHidden();
});

test('back button closes an open post view on the first press', async ({ page }) => {
  await bootLoggedIn(page);

  await page.evaluate((pid) => window.openPostView(pid), POST.id);
  await expect(page.locator('#postView')).toHaveClass(/on/);

  // Guards against topLayerClose()/the popstate wiring breaking outright
  // (the reported symptom: back doing nothing to an open post, second
  // back exiting the app). Note: this single-tab, single-overlay harness
  // doesn't reproduce the narrower rearm()-omission case itself - the
  // boot-time history entry alone is enough for one overlay opened fresh
  // - so it won't catch a future overlay-opener that skips rearm(); it
  // only catches the back button failing to close an open overlay at all.
  await page.goBack();
  await expect(page.locator('#postView')).not.toHaveClass(/on/, { timeout: 5000 });
});

test('own-post menu is visually on top of the post view, not hidden behind it', async ({ page }) => {
  await bootLoggedIn(page);

  await page.evaluate((pid) => window.openPostView(pid), POST.id);
  await expect(page.locator('#postView')).toHaveClass(/on/);

  await page.locator('#postView .pmore').click();
  await expect(page.locator('#postMenuWrap')).toHaveClass(/on/);

  const [menuZ, overlayZ] = await page.evaluate(() => [
    parseInt(getComputedStyle(document.getElementById('postMenuWrap')).zIndex, 10),
    parseInt(getComputedStyle(document.getElementById('postView')).zIndex, 10),
  ]);
  expect(menuZ).toBeGreaterThan(overlayZ);

  // Also confirm it's actually hit-testable at its own position, not just
  // higher in a stacking-context sense - this is what "no action when I
  // tap it" looked like in practice.
  const cancelBox = await page.locator('#postMenuWrap button', { hasText: 'Cancel' }).boundingBox();
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('#postMenuWrap') !== null : false;
  }, { x: cancelBox.x + cancelBox.width / 2, y: cancelBox.y + cancelBox.height / 2 });
  expect(hit).toBe(true);
});
