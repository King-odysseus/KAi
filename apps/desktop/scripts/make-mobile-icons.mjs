// Renders the phone app's icons from one SVG, so the three sizes cannot drift apart.
// Run with: node apps/desktop/scripts/make-mobile-icons.mjs
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../src/renderer/public/mobile/icons');

/** The mark: the desktop theme's purple, a lavender K, and the amber dot that stands for a running job. */
const mark = (size, pad) => `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  html, body { margin: 0; width: ${size}px; height: ${size}px; background: transparent; }
  .icon { width: ${size}px; height: ${size}px; display: flex; align-items: center; justify-content: center;
          background: linear-gradient(160deg, #2a1e52 0%, #100f22 62%); border-radius: ${size * 0.22}px; }
  .inner { width: ${size - pad * 2}px; height: ${size - pad * 2}px; position: relative; }
  .k { font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; font-weight: 700;
       font-size: ${size * 0.52}px; line-height: 1; letter-spacing: -0.06em;
       color: #b362ff; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -54%); }
  .dot { position: absolute; right: 4%; bottom: 6%; width: ${size * 0.13}px; height: ${size * 0.13}px;
         border-radius: 100px; background: #fad000; }
</style></head><body>
  <div class="icon"><div class="inner"><span class="k">KAI</span><span class="dot"></span></div></div>
</body></html>`;

const sizes = [
  { file: 'icon-192.png', size: 192, pad: 22 },
  { file: 'icon-512.png', size: 512, pad: 58 },
  // Maskable icons are cropped to whatever shape the launcher uses, so the mark sits well inside the safe area.
  { file: 'icon-maskable-512.png', size: 512, pad: 118 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
await mkdir(out, { recursive: true });
for (const { file, size, pad } of sizes) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(mark(size, pad));
  await page.screenshot({ path: join(out, file), omitBackground: true });
  console.log(`wrote ${file} (${size}x${size})`);
}
await browser.close();
