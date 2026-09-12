// Covers the engagement features: post reactions, social proof, streaks,
// story urgency. Same approach as smoke.spec.js - real app.js/index.html,
// Supabase faked at the network layer so nothing touches live data.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks } = require('./mock-supabase');

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const FRIEND = 'aaaaaaaa-0000-4000-8000-000000000002';
const AUTHOR = 'aaaaaaaa-0000-4000-8000-000000000003';
const POST_ID = 'bbbbbbbb-0000-4000-8000-000000000001';

const ME_PROFILE = { id: ME, username: 'smoketest', name: 'Smoke Test', bio: '', avatar_url: null, is_verified: false, last_seen: new Date().toISOString() };
const FRIEND_PROFILE = { id: FRIEND, username: 'bestie', name: 'Bestie', bio: '', avatar_url: null, is_verified: false, last_seen: new Date().toISOString() };
const AUTHOR_PROFILE = { id: AUTHOR, username: 'poster', name: 'Poster', bio: '', avatar_url: null, is_verified: false, last_seen: new Date().toISOString() };

const POST = {
  id: POST_ID, author_id: AUTHOR, caption: 'A post worth reacting to', audience: 'public', tags: null,
  image_url: null, photos: null, video_url: null, thumb_url: null, poll: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  hashtags: [], keywords: [], score: 1,
};

// I reacted 'fire'; a friend I follow reacted 'haha'.
const LIKES = [
  { id: 'l1', post_id: POST_ID, user_id: ME, reaction: 'fire', created_at: new Date().toISOString() },
  { id: 'l2', post_id: POST_ID, user_id: FRIEND, reaction: 'haha', created_at: new Date().toISOString() },
];

async function boot(page, extraTables = {}) {
  await installSupabaseMocks(page, {
    userId: ME, email: 'smoke@test.local', profile: ME_PROFILE,
    tables: {
      profiles: [ME_PROFILE, FRIEND_PROFILE, AUTHOR_PROFILE],
      'rpc/get_feed_for_you': [POST],
      posts: [POST],
      likes: LIKES,
      follows: [{ follower_id: ME, following_id: FRIEND }],
      ...extraTables,
    },
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

test('post shows reaction chips with counts, and marks my own reaction', async ({ page }) => {
  await boot(page);
  const chips = page.locator(`#rx_${POST_ID} .rchip`);
  await expect(chips).toHaveCount(2, { timeout: 10000 });
  // Mine is the 'fire' one - it carries the .mine outline.
  await expect(page.locator(`#rx_${POST_ID} .rchip.mine`)).toHaveCount(1);
});

test('like button reflects my non-heart reaction instead of a plain heart', async ({ page }) => {
  await boot(page);
  await expect(page.locator(`#post_${POST_ID} .like`)).toBeVisible({ timeout: 10000 });
  // reactIcon() wraps the glyph in a coloured span; a plain heart does not.
  const hasReactionGlyph = await page.locator(`#post_${POST_ID} .like span`).count();
  expect(hasReactionGlyph).toBeGreaterThan(0);
});

test('long-pressing the like button opens the reaction picker', async ({ page }) => {
  await boot(page);
  const like = page.locator(`#post_${POST_ID} .like`);
  await expect(like).toBeVisible({ timeout: 10000 });

  // Raw mouse events don't auto-scroll the way locator.click() does, and
  // the like button sits below the fold at the default viewport size.
  await like.scrollIntoViewIfNeeded();
  const box = await like.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);          // long-press threshold is 450ms
  await page.mouse.up();

  await expect(page.locator('#postReactWrap')).toHaveClass(/on/);
  await expect(page.locator('#postReactRow .rbtn')).toHaveCount(6);
});

test('DM streak badge shows from 2 days and stays hidden below that', async ({ page }) => {
  await boot(page, { 'rpc/my_dm_streaks': [{ other_id: FRIEND, streak: 5 }, { other_id: AUTHOR, streak: 1 }] });
  const r = await page.evaluate(async ([friend, author]) => {
    await window.loadDmStreaks();
    return { friend: window.streakHtml(friend), author: window.streakHtml(author) };
  }, [FRIEND, AUTHOR]);
  expect(r.friend).toContain('>5<');        // 5-day streak renders the count
  expect(r.author).toBe('');                // a 1-day "streak" is not a streak
});

test('close-friends nudge appears only when you have close friends, and switches audience', async ({ page }) => {
  await boot(page);

  // No close friends yet -> no nudge (it would be a dead end).
  const empty = await page.evaluate(() => { window.renderAudHint(); return document.getElementById('audHint').innerHTML; });
  expect(empty).toBe('');

  // With a close-friends list, the nudge shows and switches the audience.
  // Loaded through the real path - the module-scoped set can't be poked
  // at from window, and going through loadCloseFriends() tests more anyway.
  await page.route('**/rest/v1/closefriends*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'cf1', owner_id: ME, friend_id: FRIEND }]) })
  );
  const after = await page.evaluate(async () => {
    await window.loadCloseFriends();
    window.setAudience('public');
    const shown = document.getElementById('audHint').innerHTML;
    document.querySelector('#audHint b').click();
    return {
      shown,
      closeSelected: document.getElementById('audClose').classList.contains('on'),
      everyoneSelected: document.getElementById('audAll').classList.contains('on'),
      hintAfter: document.getElementById('audHint').innerHTML,
    };
  });
  expect(after.shown).toContain('Close Friends');
  expect(after.closeSelected).toBe(true);
  expect(after.everyoneSelected).toBe(false);
  expect(after.hintAfter).toBe('');      // once switched, stop nagging
});

test('story countdown reports time left and flags the urgent window', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
    return {
      fresh: window.storyTimeLeft(ago(0)),
      threeLeft: window.storyTimeLeft(ago(21)),
      twoLeft: window.storyTimeLeft(ago(22)),
      minutes: window.storyTimeLeft(ago(23.5)),
      expired: window.storyTimeLeft(ago(25)),
    };
  });
  expect(r.fresh.urgent).toBe(false);
  expect(r.threeLeft.urgent).toBe(false);      // exactly 3h is not yet urgent
  expect(r.twoLeft).toEqual({ label: '2h left', urgent: true });
  expect(r.minutes).toEqual({ label: '30m left', urgent: true });
  expect(r.expired).toBeNull();                 // past 24h there's nothing to show
});

test('social proof names a follower who liked the post', async ({ page }) => {
  await boot(page);
  const proof = page.locator(`#post_${POST_ID} .sproof`);
  await expect(proof).toBeVisible({ timeout: 10000 });
  await expect(proof).toContainText('bestie');
});
