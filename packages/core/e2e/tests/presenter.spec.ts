import { expect, test } from '@playwright/test';
import {
  deleteSlide,
  duplicateSlide,
  enterPlayMode,
  openSlide,
  readSlideSource,
} from './helpers.ts';

test.describe('presenter view', () => {
  test('standalone presenter shows notes and the not-linked badge', async ({ page }) => {
    await page.goto('/s/alpha/presenter');
    await expect(page.getByText('Presenter')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Not linked')).toBeVisible();
    await expect(page.getByText('Alpha speaker note')).toBeVisible();
  });

  test('presenter popup links to the player and drives it', async ({ page, context }) => {
    await openSlide(page, 'alpha');
    await enterPlayMode(page);

    const popupPromise = context.waitForEvent('page');
    await page.keyboard.press('p');
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(popup.url()).toContain('/s/alpha/presenter');

    await expect(popup.getByText('01 / 03')).toBeVisible({ timeout: 30_000 });
    await expect(popup.getByText('Not linked')).toBeHidden();
    await expect(popup.getByText('Alpha speaker note')).toBeVisible();

    await popup.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page).toHaveURL(/[?&]p=2/);
    await expect(popup.getByText('02 / 03')).toBeVisible();
    await expect(popup.getByText('No speaker notes for this slide.')).toBeVisible();

    await popup.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/[?&]p=3/);
    await expect(popup.getByText('03 / 03')).toBeVisible();
    await expect(popup.getByText('Last slide')).toBeVisible();
    await expect(popup.getByText('End of deck')).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();

    await popup.getByRole('button', { name: 'Prev', exact: true }).click();
    await expect(page).toHaveURL(/[?&]p=2/);

    const jump = popup.locator('input[type="number"]');
    await jump.fill('1');
    await jump.press('Enter');
    await expect(page).toHaveURL(/[?&]p=1/);
    await expect(popup.getByText('01 / 03')).toBeVisible();
  });

  test('blackout round-trips between presenter and player', async ({ page, context }) => {
    await openSlide(page, 'alpha');
    await enterPlayMode(page);

    const popupPromise = context.waitForEvent('page');
    await page.keyboard.press('p');
    const popup = await popupPromise;
    await expect(popup.getByText('01 / 03')).toBeVisible({ timeout: 30_000 });

    const blackButton = popup.getByRole('button', { name: 'Black', exact: true });
    await blackButton.click();
    await expect(blackButton).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('div.absolute.inset-0.bg-black')).toBeVisible();

    await blackButton.click();
    await expect(blackButton).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('div.absolute.inset-0.bg-black')).toBeHidden();

    const whiteButton = popup.getByRole('button', { name: 'White', exact: true });
    await whiteButton.click();
    await expect(whiteButton).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('div.absolute.inset-0.bg-white')).toBeVisible();

    await whiteButton.click();
    await expect(whiteButton).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('div.absolute.inset-0.bg-white')).toBeHidden();
  });

  test('notes are written and edited right in the presenter', async ({
    page,
    context,
    request,
  }) => {
    await duplicateSlide(request, 'alpha', 'presenter-notes');
    try {
      await openSlide(page, 'presenter-notes');
      await enterPlayMode(page);
      const popupPromise = context.waitForEvent('page');
      await page.keyboard.press('p');
      const popup = await popupPromise;
      await expect(popup.getByText('01 / 03')).toBeVisible({ timeout: 30_000 });

      // The slide without notes: the empty state points at the Edit button.
      await popup.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(popup.getByText('02 / 03')).toBeVisible();
      await expect(popup.getByText('Press Edit to write what to say here.')).toBeVisible();

      await popup.locator('[data-notes-edit]').click();
      const editor = popup.locator('[data-notes-editor]');
      await expect(editor).toBeFocused();
      await editor.fill('Mention the **pilot** results');
      // Arrow keys move the caret instead of turning the slide.
      await editor.press('ArrowLeft');
      await expect(popup.getByText('02 / 03')).toBeVisible();
      await popup.locator('[data-notes-edit]').click();

      await expect(popup.locator('strong', { hasText: 'pilot' })).toBeVisible();
      await expect
        .poll(() => readSlideSource('presenter-notes'))
        .toContain('Mention the **pilot** results');
    } finally {
      await deleteSlide(request, 'presenter-notes');
    }
  });
});
