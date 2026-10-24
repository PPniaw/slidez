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
    await expect(panel.getByRole('heading', { name: 'Live interaction' })).toBeVisible();
    // Embedded: no close button, and notes stay on screen at the same time.
    await expect(panel.getByRole('button', { name: 'Close' })).toHaveCount(0);
    await expect(page.getByText('Alpha speaker note')).toBeVisible();
  });

  test('without live interaction the presenter keeps two columns', async ({ page }) => {
    await page.route('**/__publish/live?*', (route) => route.fulfill({ json: {} }));
    await page.goto('/s/alpha/presenter');
    await expect(page.getByText('Alpha speaker note')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-live-panel]')).toHaveCount(0);
  });
});
