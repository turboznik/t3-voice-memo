// Renders the app icons from the SVGs with your installed Chrome (playwright-core).
//   node icons/render.mjs
// apple-touch-icon is opaque and full-bleed: iOS rounds the corners itself and
// draws transparent areas black.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright-core';
const here = new URL('.', import.meta.url).pathname;
const pub = join(here, '../public');
const full = readFileSync(join(here, 'icon-full.svg'), 'utf8');
const rounded = readFileSync(join(pub, 'favicon.svg'), 'utf8');

const outputs = [
  ['apple-touch-icon.png', full, 180],
  ['icon-192.png', full, 192],
  ['icon-512.png', full, 512],
  ['favicon-32.png', rounded, 32],
];

const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome', headless: true });
try {
  for (const [name, svg, size] of outputs) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: join(pub, name), omitBackground: true });
    await page.close();
    console.log(name, size);
  }
} finally {
  await browser.close();
}
