// #hashtags and @mentions. The ranking system runs on hashtags, but they
// rendered as inert text. The client's tag rule must match the database's
// extract_hashtags() exactly, or a tag that links would open an empty page.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const A = 'aaaaaaaa-0000-4000-8000-000000000002';
const now = new Date().toISOString();
const P = (id, u) => ({ id, username: u, name: u, bio: '', avatar_url: null, is_verified: false, is_private: false, is_moderator: false, last_seen: now });
const post = (id, caption, hashtags) => ({
  id, author_id: A, caption, audience: 'public', tags: null, image_url: 'http://localhost:8420/icon-192.png',
  photos: null, video_url: null, thumb_url: null, poll: null, created_at: now, updated_at: now,
  hashtags, keywords: [], status: 'published', publish_at: null, score: 1,
});

async function boot(page, tables = {}) {
  await installSupabaseMocks(page, {
    userId: ME, email: 's@t.l', profile: P(ME, 'smoketest'),
    tables: { profiles: [P(ME, 'smoketest'), P(A, 'signal_guest')], follows: [], stories: [], likes: [], ...tables },
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

// The same string run through the fixed extract_hashtags() in Postgres
// returned exactly this (before distinct/ordering). If the two rules ever
// drift, this is the test that says so.
const SAMPLE = 'Code #Developer #c++ #js_dev #ലിങ്ക് #हिंदी #தமிழ் #café x#mid #42 ##double #fun🔥 #end. #a,b #ok! (#paren) “#quoted” #it’s #ലിങ്ക്।';
const POSTGRES_SAYS = ['developer', 'c', 'js_dev', 'ലിങ്ക്', 'हिंदी', 'தமிழ்', 'café', '42', 'double', 'fun🔥', 'end', 'a', 'ok', 'paren', 'quoted', 'it', 'ലിങ്ക്'];

test('the client finds exactly the tags the database stores', async ({ page }) => {
  await boot(page);
  const tags = await page.evaluate((s) => {
    const d = document.createElement('div');
    d.innerHTML = window.richText(s);
    return [...d.querySelectorAll('.htag')].map((e) => e.dataset.tag);
  }, SAMPLE);
  expect(tags).toEqual(POSTGRES_SAYS);
});

test('Indic tags stay whole instead of being cut at the first vowel sign', async ({ page }) => {
  await boot(page);
  const tag = await page.evaluate(() => {
    const d = document.createElement('div');
    d.innerHTML = window.richText('Building #ലിങ്ക്അപ്പ് today');
    return d.querySelector('.htag').dataset.tag;
  });
  expect(tag).toBe('ലിങ്ക്അപ്പ്');
});

test('mentions link, emails do not', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const d = document.createElement('div');
    d.innerHTML = window.richText('thanks @Lukman and @signal_guest — mail me at me@example.com');
    return [...d.querySelectorAll('.mtag')].map((e) => e.dataset.user);
  });
  expect(r).toEqual(['lukman', 'signal_guest']);
});

test('captions stay escaped: markup in a caption is text, not HTML', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    window.__xss = undefined;
    const d = document.createElement('div');
    d.innerHTML = window.richText(`<img src=x onerror="window.__xss=1"> #tag" onmouseover="x it's &#39;`);
    return { imgs: d.querySelectorAll('img').length, tag: d.querySelector('.htag').dataset.tag, text: d.textContent, xss: window.__xss };
  });
  expect(r.imgs).toBe(0);
  expect(r.tag).toBe('tag');                 // the quote ends the tag; it never reaches the attribute
  expect(r.text).toContain('<img src=x');    // shown literally
  expect(r.text).toContain('&#39;');         // an escaped entity is not mistaken for #39
  expect(r.xss).toBeUndefined();
});

test('tapping a tag in a feed caption opens the tag page with its count', async ({ page }) => {
  const P1 = 'bbbbbbbb-0000-4000-8000-000000000001';
  const P2 = 'bbbbbbbb-0000-4000-8000-000000000002';
  await boot(page, {
    'rpc/get_feed_for_you': [post(P1, 'Code meet hardware #developer #linux', ['developer', 'linux'])],
    posts: [post(P1, 'a #developer', ['developer']), post(P2, 'b #developer', ['developer'])],
  });
  const queries = [];
  page.on('request', (r) => { if (r.url().includes('/rest/v1/posts') && r.url().includes('hashtags')) queries.push(decodeURIComponent(r.url())); });

  const tag = page.locator(`#post_${P1} .cap .htag`, { hasText: '#developer' });
  await expect(tag).toBeVisible({ timeout: 10000 });
  await tag.click();

  await expect(page.locator('#searchResults .tagname')).toHaveText('#developer', { timeout: 10000 });
  await expect(page.locator('#searchResults .tagcount')).toHaveText('2 posts');
  await expect(page.locator('#searchInput')).toHaveValue('#developer');
  // An array-contains lookup on the indexed column, not a caption substring.
  expect(queries.some((q) => q.includes('hashtags=cs.{developer}'))).toBe(true);
});

test('tapping a mention opens that profile', async ({ page }) => {
  await boot(page);
  const lookups = [];
  page.on('request', (r) => { if (r.url().includes('/rest/v1/profiles') && r.url().includes('username=eq.')) lookups.push(r.url()); });
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'probe';
    d.style.cssText = 'position:fixed;top:0;left:0;z-index:9999;background:#000;padding:10px';
    d.innerHTML = window.richText('hi @signal_guest');
    document.body.appendChild(d);
  });
  await page.locator('#probe .mtag').click();
  await expect.poll(() => lookups.length).toBeGreaterThan(0);
  expect(lookups[0]).toContain('username=eq.signal_guest');
});

test('typing #tag in search is a tag lookup, not a caption search', async ({ page }) => {
  await boot(page, { posts: [] });
  await page.evaluate(() => window.show('Search'));
  await page.fill('#searchInput', '#nothing_here');
  await expect(page.locator('#searchResults .tagname')).toHaveText('#nothing_here', { timeout: 10000 });
  await expect(page.locator('#searchResults .empty')).toHaveText('No posts with this tag yet');
});
