// End-to-end check in the system Chrome with a fake microphone, against a
// throwaway server using the mock speech and T3 providers (no keys, no real
// threads). Saves phone-sized screenshots to $SHOTS (default test-results/e2e).
// Uses your installed Chrome; set CHROME_CHANNEL=chromium after `npx playwright install chromium` if you have none.
//   npm run build && npm run e2e
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { chromium } from 'playwright-core';
const shots = process.env.SHOTS ?? new URL('../test-results/e2e', import.meta.url).pathname;
mkdirSync(shots, { recursive: true });

const server = spawn(process.execPath, ['server/server.mjs'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: '0', AUTH: 'off', SPEECH_PROVIDER: 'mock', T3_PROVIDER: 'mock' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const base = await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => {
    const m = String(d).match(/listening on (http:\/\/[\d.:]+)/);
    if (m) resolve(m[1]);
  });
  server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
});

const browser = await chromium.launch({
  channel: process.env.CHROME_CHANNEL ?? 'chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
let step = 'start';
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await context.grantPermissions(['microphone', 'clipboard-read', 'clipboard-write'], { origin: base });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(base);

  step = 'pick a thread';
  await page.getByRole('button', { name: /pick a thread/ }).click();
  await page.getByText('Tidy up the settings page').waitFor();
  await page.waitForTimeout(400); // let the sheet finish sliding in
  await page.screenshot({ path: join(shots, '1-picker.png') });
  await page.getByRole('button', { name: /Tidy up the settings page/ }).click();
  await page.getByRole('button', { name: /To Tidy up the settings page/ }).waitFor();

  step = 'record';
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('button', { name: 'Stop recording' }).waitFor();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: join(shots, '2-recording.png') });
  await page.getByRole('button', { name: 'Stop recording' }).click();

  step = 'transcript appears, cleaned up';
  const box = page.getByRole('textbox', { name: 'Message' });
  await page.waitForFunction(() => document.querySelector('textarea')?.value.startsWith('So this is a mock transcript'));
  await page.getByRole('button', { name: 'Original' }).waitFor();
  await page.screenshot({ path: join(shots, '3-transcript.png') });

  step = 'record again appends';
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await page.waitForFunction(() => (document.querySelector('textarea')?.value.match(/mock transcript/g) ?? []).length === 2);

  step = 'edit, then copy';
  await box.fill('Edited by hand: please check the dashboard.');
  await page.getByRole('button', { name: 'Copy' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Edited by hand: please check the dashboard.');

  step = 'send';
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Sent to Tidy up the settings page').waitFor();
  assert.equal(await box.inputValue(), '');
  await page.screenshot({ path: join(shots, '4-sent.png') });
  const { sent } = await (await fetch(`${base}/api/_mock/sent`)).json();
  assert.equal(sent.length, 1);
  assert.deepEqual({ threadId: sent[0].threadId, text: sent[0].text, mode: sent[0].mode }, { threadId: 'mock-thread-2', text: 'Edited by hand: please check the dashboard.', mode: 'auto' });

  step = 'thread survives a reload, draft too';
  await box.fill('A draft');
  await page.reload();
  await page.getByRole('button', { name: /To Tidy up the settings page/ }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message' }).inputValue(), 'A draft');

  step = 'history';
  await page.getByRole('button', { name: 'Recent messages' }).click();
  await page.getByText('Sent to Tidy up the settings page').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, '5-history.png') });

  assert.deepEqual(errors, []);
  console.log(`e2e ok (${base}); screenshots in ${shots}`);
} catch (err) {
  console.error(`e2e failed at "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
