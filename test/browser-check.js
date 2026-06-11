// Headless browser smoke test:
//  Pass 1 — load the demo page, let it boot (download data + init), synthesize
//           with both voices via the real JS/Web Audio path.
//  Pass 2 — reload with the SAME browser profile and confirm the voice data is
//           served from the IndexedDB cache (no re-download).
const os = require('os');
const path = require('path');
const fs = require('fs');
const puppeteer = require('/Users/biou/Projects/a11yStatementCrawler/node_modules/puppeteer');

const URL = process.env.URL || 'http://localhost:8080/index.html';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rhv-profile-'));

async function run(pass) {
  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir: profile,
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  const page = await browser.newPage();
  let downloaded = false, cached = false;
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('Downloading')) downloaded = true;
    if (t.includes('served from cache')) cached = true;
    console.log(`  [pass${pass}]`, t);
  });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction('window.RHVoiceTTS && RHVoiceTTS.isReady()', { timeout: 120000 });

  const results = {};
  for (const voice of ['mia', 'mil']) {
    results[voice] = await page.evaluate(
      (v) => RHVoiceTTS.speak('Moien, dëst ass en Test.', v), voice);
    if (!results[voice] || results[voice].samples <= 0)
      throw new Error(`no audio produced for ${voice}`);
  }
  await browser.close();
  return { downloaded, cached, results };
}

(async () => {
  const p1 = await run(1);
  console.log('Pass 1:', JSON.stringify(p1.results), '(downloaded:', p1.downloaded + ')');
  if (!p1.downloaded) throw new Error('pass 1 should have downloaded data');

  const p2 = await run(2);
  console.log('Pass 2: cached:', p2.cached, 'downloaded-again:', p2.downloaded);
  if (p2.downloaded) throw new Error('pass 2 re-downloaded data (cache failed)');
  if (!p2.cached) throw new Error('pass 2 did not report cache hit');

  fs.rmSync(profile, { recursive: true, force: true });
  console.log('BROWSER OK — synthesis works in both passes; data cached in IndexedDB.');
})().catch((e) => { console.error('BROWSER FAIL:', e.message); process.exit(1); });
