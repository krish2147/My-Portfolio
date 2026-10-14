// Re-captures the project screenshots in shots/ from the live sites listed in
// screenshots.json. A site is only re-captured when its deployed HTML changes
// (each deploy ships new HTML), so the images follow the sites without daily
// noise commits. Fingerprints of the last captured version live in
// shots/state.json.
//
//   node scripts/update-screenshots.mjs           capture changed sites
//   node scripts/update-screenshots.mjs --check   only report whether any changed
//   FORCE=true node scripts/update-screenshots.mjs  capture every site

import { createHash } from 'node:crypto';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const shotsDir = new URL('shots/', root);
const stateFile = new URL('state.json', shotsDir);
const { sites } = JSON.parse(await readFile(new URL('screenshots.json', root), 'utf8'));
const state = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, 'utf8')) : {};
const force = process.env.FORCE === 'true' || process.argv.includes('--force');
const checkOnly = process.argv.includes('--check');

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile:  { viewport: { width: 390, height: 720 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function fingerprint(url) {
  // Cold starts (e.g. Render free tier) can take a minute to wake up.
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return createHash('sha256').update(await res.text()).digest('hex');
}

const pending = [];
for (const site of sites) {
  try {
    const hash = await fingerprint(site.url);
    const missing = !existsSync(new URL(site.file, shotsDir));
    if (force || missing || state[site.file]?.hash !== hash) pending.push({ ...site, hash });
    else console.log(`unchanged  ${site.url}`);
  } catch (err) {
    console.warn(`skipped    ${site.url} (${err.message}); keeping the current image`);
  }
}

if (checkOnly) {
  for (const s of pending) console.log(`changed    ${s.url}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${pending.length > 0}\n`);
  process.exit(0);
}

if (pending.length) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  for (const site of pending) {
    const context = await browser.newContext({ ...DEVICES[site.device ?? 'desktop'], reducedMotion: 'reduce' });
    const page = await context.newPage();
    try {
      const res = await page.goto(site.url, { waitUntil: 'load', timeout: 90_000 });
      if (!res || !res.ok()) throw new Error(`HTTP ${res?.status()}`);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      // Let intro loaders and entrance animations finish.
      await page.waitForTimeout(site.wait ?? 5000);
      const tmp = new URL(`${site.file}.tmp`, shotsDir);
      await page.screenshot({ path: tmp.pathname, type: 'jpeg', quality: 82, animations: 'disabled', caret: 'hide' });
      await rename(tmp, new URL(site.file, shotsDir));
      state[site.file] = { url: site.url, hash: site.hash, captured: new Date().toISOString() };
      console.log(`captured   ${site.url} -> shots/${site.file}`);
    } catch (err) {
      console.warn(`failed     ${site.url} (${err.message}); keeping the current image`);
    } finally {
      await context.close();
    }
  }
  await browser.close();
  await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n');
}
