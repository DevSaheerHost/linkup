// Light theme. Everything in the stylesheet already reads from tokens, so
// the switch only swaps the palette - these cover the parts that aren't
// just CSS: resolution, persistence, following the OS, and no flash.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks, PROJECT_REF } = require('./mock-supabase');

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const now = new Date().toISOString();
const P = { id: ME, username: 'smoketest', name: 'S', bio: '', avatar_url: null, is_verified: false, is_private: false, is_moderator: false, last_seen: now };

async function boot(page, { stored, colorScheme } = {}) {
  if (colorScheme) await page.emulateMedia({ colorScheme });
  await installSupabaseMocks(page, {
    userId: ME, email: 'smoke@test.local', profile: P,
    tables: { profiles: [P], posts: [], follows: [], stories: [] },
  });
  if (stored !== undefined) {
    await page.addInitScript((v) => localStorage.setItem('linkup_theme', v), stored);
  }
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

const theme = (page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));

test('a stored light preference is applied', async ({ page }) => {
  await boot(page, { stored: 'light', colorScheme: 'dark' });
  expect(await theme(page)).toBe('light');
  // The browser paints its own chrome from this; leaving it on the dark
  // accent would put a purple bar above a white app.
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#ffffff');
});

test('a stored dark preference wins over a light OS', async ({ page }) => {
  await boot(page, { stored: 'dark', colorScheme: 'light' });
  expect(await theme(page)).toBe('dark');
});

test('with no preference, the OS decides', async ({ page }) => {
  await boot(page, { colorScheme: 'light' });
  expect(await theme(page)).toBe('light');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  expect(await theme(page)).toBe('dark');
});

test('on Auto, the app follows the OS changing while it is open', async ({ page }) => {
  await boot(page, { stored: 'system', colorScheme: 'dark' });
  expect(await theme(page)).toBe('dark');

  // Following the system means following it as it changes - at sunset, say -
  // not only at launch.
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => theme(page)).toBe('light');
});

test('an explicit choice does not follow the OS', async ({ page }) => {
  await boot(page, { stored: 'dark', colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(200);
  expect(await theme(page)).toBe('dark');
});

test('the picker sets, persists and highlights the choice', async ({ page }) => {
  await boot(page, { colorScheme: 'dark' });
  // loadProfile() is async and replaces #sProfile when it resolves, so let
  // it finish before opening the form into the same element.
  await page.evaluate(async (id) => { await window.loadProfile(id); window.openEdit(); }, ME);
  await expect(page.locator('#sProfile .themebtn')).toHaveCount(3, { timeout: 10000 });

  await page.locator('.themebtn', { hasText: 'Light' }).click();
  expect(await theme(page)).toBe('light');
  expect(await page.evaluate(() => localStorage.getItem('linkup_theme'))).toBe('light');
  await expect(page.locator('.themebtn.on')).toHaveText(/Light/);
});

test('the theme is applied before first paint, so there is no flash of dark', async ({ page }) => {
  await boot(page, { stored: 'light', colorScheme: 'dark' });
  // app.js loads at the end of <body>; if it were the thing applying the
  // theme, every launch would show a frame of dark first. The inline
  // <head> script is what makes this true.
  const applied = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    const headEnd = html.indexOf('</head>');
    const inHead = html.slice(0, headEnd);
    return { set: document.documentElement.getAttribute('data-theme'), headHasScript: inHead.includes('linkup_theme') };
  });
  expect(applied.set).toBe('light');
  expect(applied.headHasScript).toBe(true);
});

test('light theme actually paints a light background', async ({ page }) => {
  await boot(page, { stored: 'light', colorScheme: 'dark' });
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(255, 255, 255)');

  await page.evaluate(() => window.setTheme('dark'));
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(dark).toBe('rgb(13, 13, 18)');
});
