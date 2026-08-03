import { expect, test, type Page } from '@playwright/test';

/**
 * The one end-to-end test.
 *
 * It walks the loop the whole product is built around: a kid signs in on the
 * wall tablet, taps a chore, a parent approves it, and the points and the
 * ticker both move. Every layer is real — SWA routing, the Functions host,
 * Table Storage, the session cookies — which is precisely what the unit and
 * Azurite suites cannot cover, because each of them stubs the layer below.
 *
 * PINs come from `api/scripts/seed.mts`; the test assumes a freshly seeded
 * household.
 */

const MAYA = { id: 'maya', name: 'Maya', pin: '7391' };
const PARENT = { id: 'lee', name: 'Dad', pin: '4816' };

test.describe('chore → approval → points', () => {
  test('a kid completes a chore and a parent approves it', async ({ page }) => {
    // ?kiosk=1 pins the wall-tablet surface. Without it a 1280x800 Chrome with
    // touch resolves to kiosk anyway, but pinning it means the test does not
    // silently change surface if the heuristic is ever tuned.
    await page.goto('/?kiosk=1');

    await expect(page.getByRole('button', { name: `Sign in as ${MAYA.name}` })).toBeVisible();

    await signIn(page, MAYA);

    // The board floats the signed-in member to the top, but scope by name
    // rather than position — ordering is a product decision that may change.
    const mayasChores = page.getByRole('group', { name: new RegExp(`^${MAYA.name}`) });
    await expect(mayasChores).toBeVisible();

    // An open chore that is past its due time renders as `overdue`, not `open`.
    // Both are completable, and on a seeded household either may come first.
    const chore = mayasChores
      .locator('[data-status="open"], [data-status="overdue"]')
      .first();
    await expect(chore).toBeEnabled();
    const choreTitle = (await chore.getAttribute('data-title'))!;

    await chore.click();

    // Pending, and visibly NOT earned. The distinction is the entire reason
    // parent approval exists, so the test asserts the state, not just the tap.
    await expect(
      mayasChores.locator(`[data-status="pending"][data-title="${choreTitle}"]`),
    ).toBeVisible();

    await signOut(page);
    await signIn(page, PARENT);

    // Read the baseline BEFORE opening the queue: the helper navigates to
    // /points when it is not already there, which would otherwise walk the test
    // away from the approve button it is about to click.
    const pointsBefore = await leaderboardPoints(page, MAYA.id);

    await page.goto('/queue?kiosk=1');

    // Scope to the row for THIS chore. A seeded household has backdated
    // history, so "the first Approve button" is not necessarily ours — and
    // approving the wrong row would still make every later assertion pass.
    const queueRow = page
      .locator('div')
      .filter({ hasText: choreTitle })
      .filter({ has: page.getByRole('button', { name: 'Approve' }) })
      .last();
    await expect(queueRow).toBeVisible();

    await queueRow.getByRole('button', { name: 'Approve' }).click();

    // Approved rows leave the queue. Waiting on the row's disappearance rather
    // than a fixed timeout keeps this honest about the async write ordering:
    // the queue row is deleted LAST, after the ledger and the balance.
    await expect(queueRow).toHaveCount(0);

    await page.goto('/points?kiosk=1');
    await expect
      .poll(() => leaderboardPoints(page, MAYA.id), {
        message: 'approved points should land on the leaderboard',
        timeout: 20_000,
      })
      .toBeGreaterThan(pointsBefore);

    // And the family sees it happen. The ticker is the product's whole
    // "something is going on in this house" surface — a silent approval is a
    // functioning backend and a broken feature.
    await expect(page.getByText(choreTitle).last()).toBeVisible();
  });
});

async function signIn(page: Page, who: { name: string; pin: string }): Promise<void> {
  await page.getByRole('button', { name: `Sign in as ${who.name}` }).click();

  const keypad = page.getByRole('dialog', { name: new RegExp(`${who.name}`) });
  await expect(keypad).toBeVisible();

  for (const digit of who.pin) {
    await keypad.getByRole('button', { name: digit, exact: true }).click();
  }

  await expect(keypad).toBeHidden();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: /^Sign in as / }).first()).toBeVisible();
}

/**
 * Read a member's ranked total off the leaderboard.
 *
 * Deliberately reads the rendered number rather than calling the API: the bug
 * this guards against is pending points being folded into the ranked total,
 * which is a rendering decision the API cannot show you.
 */
async function leaderboardPoints(page: Page, memberId: string): Promise<number> {
  if (!page.url().includes('/points')) await page.goto('/points?kiosk=1');

  const row = page.locator(`[data-member="${memberId}"]`);
  if ((await row.count()) === 0) return 0;

  return Number(await row.first().getAttribute('data-points'));
}
