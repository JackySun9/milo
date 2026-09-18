#!/usr/bin/env node
/**
 * SOT visual regression on REAL iOS Simulators (via `simctl`).
 *
 * Sibling of sot.run.js, but drives real Mobile Safari on an iOS Simulator
 * instead of Playwright/Chromium. Produces the SAME results format
 * (`{ "<key>-ios<ver>-<device>": [{ a, b, diff? }] }`) and reuses milo's pixel
 * comparator + S3 uploader, so iOS shows up next to chrome/ipad/iphone in
 * /imagediff/<site> with zero changes to the viewer.
 *
 * Perf: boots ONE simulator per job and reuses it for every capture (a fresh
 * boot per screenshot was ~2x too slow for full sites). Safari is terminated
 * between captures for a clean page load; cookies persist in the reused sim,
 * which is fine for milolibs A/B diffs (comparator tolerance absorbs minor
 * personalization noise).
 *
 * Required env: SITE
 * Optional: MILO_LIBS (?milolibs=stage), IOS_VERSION (e.g. 18.3; default newest),
 *   IOS_DEVICE (default 'iPhone 15'), IOS_SETTLE (secs after openurl, default 8),
 *   IOS_MAX_URLS (0 = all; N for quick tests),
 *   S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (both to upload).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
// eslint-disable-next-line import/no-extraneous-dependencies
const { getComparator } = require('playwright-core/lib/utils');
const { uploadResultsDir } = require('../../../tools/screenshot-diff/lib/upload-s3.js');
const { validatePath } = require('../../../tools/screenshot-diff/lib/utils.js');
const { loadSiteData } = require('../../../tools/screenshot-diff/lib/load-data.js');
const config = require('../../../tools/screenshot-diff/lib/config.js');

const COMPARE_OPTS = { threshold: 0.2, maxDiffPixelRatio: 0.01 };
const SAFARI = 'com.apple.mobilesafari';
const simctl = (args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' });
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const slug = (s) => s.replace(/[^A-Za-z0-9]+/g, ''); // "iPad Pro 11-inch (M4)" -> "iPadPro11inchM4"

function resolveRuntime(version) {
  const lines = simctl(['list', 'runtimes'])
    .split('\n')
    .filter((l) => /iOS/.test(l) && /com\.apple/.test(l));
  const line = (version && lines.find((l) => l.includes(`iOS ${version}`))) || lines[lines.length - 1];
  const m = line && line.match(/com\.apple\.CoreSimulator\.SimRuntime\.iOS[-\w]*/);
  if (!m) throw new Error(`no iOS runtime for "${version || 'latest'}" (xcodebuild -downloadPlatform iOS)`);
  return m[0];
}

function appendQuery(url, qs) {
  if (!qs) return url;
  const stripped = qs.startsWith('?') ? qs.slice(1) : qs;
  if (!stripped) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${stripped}`;
}

function bootSim(device, runtime) {
  const udid = simctl(['create', `nala-ios-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, device, runtime]).trim();
  simctl(['boot', udid]);
  try { simctl(['bootstatus', udid]); } catch (e) { /* may exit nonzero once booted */ }
  return udid;
}

// Capture one URL on the reused sim. Fresh Safari launch each time.
async function captureUrl(udid, url, outPath, settle) {
  try { simctl(['terminate', udid, SAFARI]); } catch (e) { /* not running */ }
  simctl(['openurl', udid, url]);
  await sleep(settle);
  simctl(['io', udid, 'screenshot', outPath]);
}

async function main() {
  const site = process.env.SITE;
  if (!site) { console.error('SITE env var is required (e.g. SITE=bacom)'); process.exit(1); }
  const milolibs = process.env.MILO_LIBS || '?milolibs=stage';
  const device = process.env.IOS_DEVICE || 'iPhone 15';
  const version = process.env.IOS_VERSION || '';
  const settle = Number(process.env.IOS_SETTLE || 8);
  const runtime = resolveRuntime(version);
  const vp = `ios${version}-${slug(device)}`; // e.g. ios18.3-iPhone15
  const resultsFile = `results-${vp}.json`;

  const raw = await loadSiteData(site, { dir: __dirname });
  const allEntries = Object.entries(raw).filter(([k]) => !k.startsWith('__'));
  const maxUrls = Number(process.env.IOS_MAX_URLS || 0); // 0 = all; set N for quick tests
  const entries = maxUrls > 0 ? allEntries.slice(0, maxUrls) : allEntries;
  const folderPath = `${config.baseDir}/${site}`;
  validatePath(`${folderPath}/.touch`, { forWriting: true });

  console.log(`▶ ${device} · iOS ${version || '(latest)'} · ${runtime}`);
  console.log(`▶ Site: ${site} · URLs: ${entries.length} · MILO_LIBS: ${milolibs}`);

  const comparator = getComparator('image/png');
  const results = {};
  const udid = bootSim(device, runtime);
  console.log(`▶ Booted ${udid} (reused for all captures)`);

  try {
    for (const [key, value] of entries) {
      const urlA = typeof value === 'string' ? value : value.a;
      const urlB = typeof value === 'string' ? appendQuery(value, milolibs) : value.b;
      const name = `${key}-${vp}`;
      const aPath = `${folderPath}/${name}-a.png`;
      const bPath = `${folderPath}/${name}-b.png`;
      console.log(`  [${name}] ${urlA}  vs  ${urlB}`);
      try {
        await captureUrl(udid, urlA, aPath, settle);
        await captureUrl(udid, urlB, bPath, settle);
        const entry = { order: 1, a: aPath, b: bPath, urls: `${urlA} | ${urlB}` };
        const diff = comparator(
          fs.readFileSync(validatePath(aPath)),
          fs.readFileSync(validatePath(bPath)),
          COMPARE_OPTS,
        );
        if (diff) {
          const diffPath = bPath.replace('.png', '-diff.png');
          fs.writeFileSync(validatePath(diffPath, { forWriting: true }), diff.diff);
          entry.diff = diffPath;
        }
        results[name] = [entry];
      } catch (err) {
        console.warn(`  ⚠ ${name} failed: ${err.message}`);
        results[name] = [{ error: err.message }];
      }
    }
  } finally {
    try { simctl(['shutdown', udid]); } catch (e) { /* noop */ }
    try { simctl(['delete', udid]); } catch (e) { /* noop */ }
  }

  const resultsPath = `${folderPath}/${resultsFile}`;
  fs.writeFileSync(validatePath(resultsPath, { forWriting: true }), JSON.stringify(results, null, 2));
  console.log(`  Wrote ${resultsPath}`);

  if (config.s3.accessKeyId && config.s3.secretAccessKey) {
    console.log(`▶ Uploading images + ${resultsFile} to ${config.s3.endpoint}/${config.s3.bucket}/${folderPath}/`);
    await uploadResultsDir(folderPath, { resultsFile, type: `-${vp}` });
    console.log('✓ Uploaded shard');
  } else {
    console.log('⚠ Skipping S3 upload (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY not set)');
  }

  const diffCount = Object.values(results).flat().filter((e) => e.diff).length;
  console.log(`✓ Done. Captures: ${Object.keys(results).length} · With diffs: ${diffCount}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
