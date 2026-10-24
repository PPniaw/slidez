import { expect, test } from '@playwright/test';
import { openSlide } from './helpers.ts';

test.describe('published decks', () => {
  test('the toolbar shows the live address next to the publish button', async ({ page }) => {
    await page.route('**/__publish/list', (route) =>
      route.fulfill({
        json: {
          decks: {
            alpha: {
              url: 'https://alpha-deck.vercel.app',
              publishedAt: '2026-10-24T00:00:00Z',
              live: false,
            },
          },
        },
      }),
    );
    await openSlide(page, 'alpha');
    const chip = page.locator('[data-publish-chip] a');
    await expect(chip).toHaveText('alpha-deck.vercel.app');
    await expect(chip).toHaveAttribute('href', 'https://alpha-deck.vercel.app');
    await expect(chip).toHaveAttribute('target', '_blank');
  });

  test('an unpublished deck shows no address', async ({ page }) => {
    await page.route('**/__publish/list', (route) => route.fulfill({ json: { decks: {} } }));
    await openSlide(page, 'alpha');
    await expect(page.locator('[data-publish-ui]')).toBeVisible();
    await expect(page.locator('[data-publish-chip]')).toHaveCount(0);
  });
});

test.describe('presenter view with live interaction', () => {
  test('questions sit in their own column beside the speaker notes', async ({ page }) => {
    const room = { server: 'http://127.0.0.1:9', roomId: 'room1' };
    await page.route('**/__publish/live?*', (route) => route.fulfill({ json: room }));
    await page.route('**/__publish/live-admin?*', (route) =>
      route.fulfill({ json: { ...room, adminKey: 'k' } }),
    );
    await page.goto('/s/alpha/presenter');
    await expect(page.getByText('Alpha speaker note')).toBeVisible({ timeout: 30_000 });
    const panel = page.locator('[data-live-panel]');
    await expect(panel).toBeVisible();
    await expect(
      page.locator('[data-presenter-live]').getByText('Live interaction', { exact: true }),
    ).toBeVisible();
    // Embedded: no close button, and notes stay on screen at the same time.
    await expect(panel.getByRole('button', { name: 'Close' })).toHaveCount(0);
    await expect(page.getByText('Alpha speaker note')).toBeVisible();
  });

  test('the live column collapses and counts what arrives meanwhile', async ({ page }) => {
    const room = { server: 'http://127.0.0.1:9', roomId: 'room2' };
    await page.route('**/__publish/live?*', (route) => route.fulfill({ json: room }));
    await page.route('**/__publish/live-admin?*', (route) =>
      route.fulfill({ json: { ...room, adminKey: 'k' } }),
    );
    const question = (id: number, text: string) => ({
      id,
      text,
      name: null,
      votes: 0,
      answered: false,
      approved: false,
      hidden: false,
      createdAt: Date.now(),
    });
    const state = (questions: unknown[], comments: unknown[]) => ({
      t: 'state',
      role: 'admin',
      title: 'Alpha',
      settings: { qaOpen: true, feedbackOpen: true, anonymity: 'anonymous', moderation: 'post' },
      online: 1,
      joined: 1,
      cap: 30,
      spotlight: null,
      rating: { avg: null, count: 0, dist: [0, 0, 0, 0, 0] },
      reactions: {},
      questions,
      comments,
    });
    let push: (msg: unknown) => void = () => {};
    await page.routeWebSocket(/\/ws\/room2\?role=admin$/, (ws) => {
      push = (msg) => ws.send(JSON.stringify(msg));
      ws.onMessage(() => push(state([question(1, 'First question')], [])));
    });

    await page.goto('/s/alpha/presenter');
    const column = page.locator('[data-presenter-live]');
    await expect(column.getByText('First question')).toBeVisible({ timeout: 30_000 });

    await column.getByRole('button', { name: 'Collapse live interaction' }).click();
    await expect(page.locator('[data-live-panel]')).toBeHidden();
    await expect(page.locator('[data-live-unread]')).toHaveCount(0);

    push(
      state(
        [question(1, 'First question'), question(2, 'Second question')],
        [{ id: 1, text: 'Nice talk', createdAt: Date.now() }],
      ),
    );
    await expect(page.locator('[data-live-unread]')).toHaveText('2');

    await column.getByRole('button', { name: 'Expand live interaction' }).click();
    await expect(column.getByText('Second question')).toBeVisible();
    await column.getByRole('button', { name: 'Collapse live interaction' }).click();
    await expect(page.locator('[data-live-unread]')).toHaveCount(0);
    // Still collapsed after a reload.
    await page.reload();
    await expect(page.locator('[data-presenter-live][data-collapsed]')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('without live interaction the presenter keeps two columns', async ({ page }) => {
    await page.route('**/__publish/live?*', (route) => route.fulfill({ json: {} }));
    await page.goto('/s/alpha/presenter');
    await expect(page.getByText('Alpha speaker note')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-live-panel]')).toHaveCount(0);
  });
});
