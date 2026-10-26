import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  page.errors = errors;
});
test.afterEach(async ({ page }) => expect(page.errors).toEqual([]));

test('loads the ideal scenario', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#s-coherence')).toHaveText('100.0');
  await expect(page.locator('[data-node]')).toHaveCount(16);
});

test('tabs follow the WAI-ARIA pattern with arrow keys', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tab-formation').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tab-focus')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tab-focus')).toBeFocused();
  await expect(page.locator('#tab-formation')).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('End');
  await expect(page.locator('#tab-req')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tab-formation')).toHaveAttribute('aria-selected', 'true');
});

test('focus map renders from the worker with an auto span that resolves the beam', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tab-focus').click();
  await expect(page.locator('#visual image')).toHaveCount(1);
  await expect(page.locator('#view-note')).toContainText('주빔과 격자 로브를 표본화한 보기');
  await expect(page.locator('#f-mapScale')).toHaveValue('Auto');
  await page.locator('#zoomFocus').click();
  await expect(page.locator('#f-mapScale')).toHaveValue('Manual');
  await expect(page.locator('#view-note')).toContainText('표본 부족');
});

test('inspector buttons stay clickable during playback', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-preset="drift"]').click();
  await page.locator('#f-timeS').fill('0');
  await page.locator('#f-timeS').blur();
  await page.locator('#play').click();
  await expect(page.locator('#play')).toHaveAttribute('aria-pressed', 'true');
  const button = await page.locator('#r-goto').elementHandle();
  await page.waitForTimeout(300);
  expect(await button.evaluate(b => b.isConnected)).toBe(true);
  await page.locator('#r-goto').click();
  await expect(page.locator('#tab-focus')).toHaveAttribute('aria-selected', 'true');
});

test('node selection keeps keyboard focus', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-node="3"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-node="3"]')).toBeFocused();
  await page.locator('[data-node="5"]').click();
  await expect(page.locator('[data-node="5"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#node-info')).toContainText('위성 06');
});

test('settings round-trip through the URL hash', async ({ page }) => {
  await page.goto('/#nodes=4&formation=Ring&tab=req');
  await expect(page.locator('#f-nodes')).toHaveValue('4');
  await expect(page.locator('#f-formation')).toHaveValue('Ring');
  await expect(page.locator('#tab-req')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.req-intro .q95')).not.toHaveText('계산 중…');
  await page.locator('#f-rfPhaseRmsDeg').fill('12');
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('rfPhaseRmsDeg=12');
});

test('requirement view shows the Monte Carlo outage and the current budget', async ({ page }) => {
  await page.goto('/#rfPhaseRmsDeg=20&tab=req');
  await expect(page.locator('.req-note').first()).toContainText('95% 확률로');
  await expect(page.locator('.budget')).toContainText('20.00°');
});

test('mobile layout has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const tab of ['formation', 'focus', 'sync', 'req']) {
    await page.goto(`/#tab=${tab}`);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  }
});
