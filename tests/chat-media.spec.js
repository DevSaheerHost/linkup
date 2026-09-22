// DM photos and voice notes moved out of a public bucket. The rendered
// bubble must carry a signed URL, never a guessable public one, and media
// stored before the move (which held a full public URL) must still resolve.
const { test, expect } = require('@playwright/test');
const { installSupabaseMocks, PROJECT_URL } = require('./mock-supabase');

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const THEM = 'aaaaaaaa-0000-4000-8000-000000000002';
const CONV = [ME, THEM].sort().join('_');
const now = new Date().toISOString();

const P = (id, username) => ({ id, username, name: username, bio: '', avatar_url: null, is_verified: false, last_seen: now });
const NEW_PATH = `${CONV}/new-photo.jpg`;
const LEGACY_URL = `${PROJECT_URL}/storage/v1/object/public/chat/${CONV}/old-photo.jpg`;

async function openChatWith(page, messages) {
  await installSupabaseMocks(page, {
    userId: ME, email: 'smoke@test.local', profile: P(ME, 'smoketest'),
    tables: { profiles: [P(ME, 'smoketest'), P(THEM, 'bestie')], messages },
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  await page.evaluate((them) => window.openChat(them), THEM);
}

test('chat photos render through a signed URL, not a public one', async ({ page }) => {
  await openChatWith(page, [{
    id: 'm1', sender_id: THEM, receiver_id: ME, conversation: CONV, group_id: null,
    text: null, image_url: NEW_PATH, audio_url: null, created_at: now, read: true, reactions: null,
  }]);

  const img = page.locator('#chatBody .bub img');
  await expect(img).toHaveCount(1, { timeout: 10000 });
  await expect(img).toHaveAttribute('src', /\/object\/sign\/chat\/.*token=/, { timeout: 10000 });
  // The whole point: no public URL anywhere in the rendered bubble.
  expect(await page.locator('#chatBody').innerHTML()).not.toContain('/object/public/chat/');
});

test('media stored before the bucket went private still resolves', async ({ page }) => {
  await openChatWith(page, [{
    id: 'm1', sender_id: THEM, receiver_id: ME, conversation: CONV, group_id: null,
    text: null, image_url: LEGACY_URL, audio_url: null, created_at: now, read: true, reactions: null,
  }]);

  // The old full-URL shape is reduced to the object path and signed like
  // any other, so a message that predates the change doesn't lose its photo.
  const img = page.locator('#chatBody .bub img');
  await expect(img).toHaveAttribute('src', /\/object\/sign\/chat\/.*old-photo\.jpg/, { timeout: 10000 });
});

test('a voice note is signed too, not left with a dead src', async ({ page }) => {
  await openChatWith(page, [{
    id: 'm1', sender_id: THEM, receiver_id: ME, conversation: CONV, group_id: null,
    text: null, image_url: null, audio_url: `${CONV}/voice.webm`, created_at: now, read: true, reactions: null,
  }]);

  await expect(page.locator('#chatBody .voice audio')).toHaveAttribute('src', /\/object\/sign\/chat\/.*voice\.webm/, { timeout: 10000 });
});
