#!/usr/bin/env node
/**
 * SOT visual regression runner.
 *
 * Reads `sot.<SITE>.yml` from this directory (e.g. sot.bacom.yml, sot.cc.yml).
 * For each URL: captures the URL twice — unmodified and with MILO_LIBS appended
 * (default `?milolibs=stage`) — across the requested viewports, computes
 * pixel diffs, writes results.json, and (if S3 creds are present) uploads to
 * internal S3 under screenshots/<site>/.
 *
 * Required env vars:
 *   SITE                    — e.g. bacom (selects sot.<site>.yml)
 *
 * Optional env vars:
 *   MILO_LIBS               — default '?milolibs=stage'
 *   VIEWPORTS               — comma-separated; default 'chrome'
 *                             (chrome | ipad | iphone)
 *   S3_ACCESS_KEY_ID
 *   S3_SECRET_ACCESS_KEY    — set both to upload; otherwise skipped
 *
 * Invocation:
 *   SITE=bacom VIEWPORTS=chrome,ipad,iphone node nala/features/visual/sot.run.js
 *
 * Dependencies are isolated in tools/screenshot-diff/ — that's where the
 * lib and node_modules live. This script imports via relative paths.
 */

// eslint-disable-next-line import/no-extraneous-dependencies
const { chromium, devices } = require('playwright');
// eslint-disable-next-line import/no-extraneous-dependencies
const { getComparator } = require('playwright-core/lib/utils');
// eslint-disable-next-line import/no-extraneous-dependencies
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const { takeTwo } = require('../../../tools/screenshot-diff/lib/take.js');
const { validatePath } = require('../../../tools/screenshot-diff/lib/utils.js');
const { uploadResultsDir } = require('../../../tools/screenshot-diff/lib/upload-s3.js');
const config = require('../../../tools/screenshot-diff/lib/config.js');

// All viewports run on Chromium. We still apply Playwright's iPad / iPhone
// `devices` preset (UA, viewport, isMobile, hasTouch, devicePixelRatio) so
// the page sees a mobile/tablet client and serves the right responsive
// layout — we just don't pay the WebKit engine's startup + per-capture
// overhead. BACOM team has run regression this way for 1+ year without
// missing real Safari-only bugs in practice.
const VIEWPORTS = {
  chrome: { engine: chromium, device: 'Desktop Chrome', viewport: { width: 1920, height: 1080 } },
  ipad: { engine: chromium, device: 'iPad Mini', viewport: null },
  iphone: { engine: chromium, device: 'iPhone X', viewport: null },
};

// Pixel comparator tolerance — matches nala/configs/visual.config.js
// (toHaveScreenshot.maxDiffPixelRatio: 0.2). Without these the comparator
// flags any single-pixel anti-aliasing variance as a diff, drowning real
// layout changes in noise.
const COMPARE_OPTS = {
  threshold: 0.2,           // per-pixel color tolerance (0 = strict, 1 = anything goes)
  maxDiffPixelRatio: 0.01,  // page-level: less than 1% pixels differ → not a diff
};

/**
 * Wait until the page is "settled" before taking the screenshot.
 *
 * Three phases:
 *   1. FEDS footer visible — top-to-bottom layout rendered.
 *   2. Slow scroll bottom→top — triggers Intersection-Observer-based
 *      lazy loads (customer story cards, data feeds, hero images that
 *      hydrate on scroll-into-view).
 *   3. networkidle — any AJAX kicked off by step 2 has settled.
 *
 * Without step 2 the screenshot captures loading spinners where
 * lazy-loaded sections should be.
 */
async function waitForPageReady(page) {
  // 1. Wait for FEDS footer
  await page.locator('.feds-footer-privacyLink').first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => {});

  // 2. Scroll dance to wake up Intersection Observers
  await page.evaluate(async () => {
    const step = 600;
    const delay = 100;
    let y = 0;
    const max = document.body.scrollHeight;
    while (y < max) {
      window.scrollTo(0, y);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
      y += step;
    }
    window.scrollTo(0, 0);
  });

  // 3. Wait for any lazy-fetch network activity to settle
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

async function captureViewport(viewportName, urls, folderPath, milolibs) {
  const preset = VIEWPORTS[viewportName];
  console.log(`\n▶ Viewport: ${viewportName} (${preset.device})`);
  const browser = await preset.engine.launch();
  const ctxOpts = devices[preset.device] ? { ...devices[preset.device] } : {};
  if (preset.viewport) ctxOpts.viewport = preset.viewport;
  // Honor prefers-reduced-motion so CSS animations / transitions don't
  // make the pixel diff race the carousel frame.
  ctxOpts.reducedMotion = 'reduce';
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  const results = {};
  for (const [key, value] of Object.entries(urls)) {
    // Two yaml formats:
    //   1. `key: 'https://url'`           → milolibs mode (A = url, B = url + MILO_LIBS)
    //   2. `key: { a: 'https://...', b: 'https://...' }` → explicit pair mode
    //      (e.g. graybox: aem.reviews preview vs business-graybox publish)
    const urlA = typeof value === 'string' ? value : value.a;
    const urlB = typeof value === 'string' ? value + milolibs : value.b;
    const name = `${key}-${viewportName}`;
    console.log(`  [${name}] ${urlA}  vs  ${urlB}`);
    try {
      const result = await takeTwo(
        page,
        urlA, () => waitForPageReady(page),
        urlB, () => waitForPageReady(page),
        folderPath, name,
        { fullPage: true },
      );
      results[name] = [result];
    } catch (err) {
      console.warn(`  ⚠ ${name} failed: ${err.message}`);
      results[name] = [{ error: err.message }];
    }
  }
  await browser.close();
  return results;
}

function diffResults(folderPath, allResults, resultsFile) {
  console.log('\n▶ Computing pixel diffs');
  const comparator = getComparator('image/png');
  const diffed = {};

  for (const [key, entries] of Object.entries(allResults)) {
    diffed[key] = entries.map((entry) => {
      if (entry.error || !entry.a || !entry.b) return entry;
      try {
        const a = fs.readFileSync(validatePath(entry.a));
        const b = fs.readFileSync(validatePath(entry.b));
        const diff = comparator(a, b, COMPARE_OPTS);
        if (diff) {
          const diffName = entry.b.replace('.png', '-diff.png');
          fs.writeFileSync(validatePath(diffName, { forWriting: true }), diff.diff);
          return { ...entry, diff: diffName };
        }
        return entry;
      } catch (err) {
        console.warn(`  ⚠ diff failed for ${key}: ${err.message}`);
        return entry;
      }
    });
  }

  const resultsPath = `${folderPath}/${resultsFile}`;
  fs.writeFileSync(
    validatePath(resultsPath, { forWriting: true }),
    JSON.stringify(diffed, null, 2),
  );
  console.log(`  Wrote ${resultsPath}`);
  return diffed;
}

async function main() {
  const site = process.env.SITE;
  if (!site) {
    console.error('SITE env var is required (e.g. SITE=bacom)');
    process.exit(1);
  }

  const milolibs = process.env.MILO_LIBS || '?milolibs=stage';
  const viewports = (process.env.VIEWPORTS || 'chrome').split(',').filter(Boolean);
  const invalid = viewports.filter((v) => !VIEWPORTS[v]);
  if (invalid.length) {
    console.error(`Unknown viewport(s): ${invalid.join(', ')}. Valid: ${Object.keys(VIEWPORTS).join(', ')}`);
    process.exit(1);
  }

  const dataPath = path.join(__dirname, `sot.${site}.yml`);
  if (!fs.existsSync(dataPath)) {
    console.error(`No data file at ${dataPath}. Add it first.`);
    process.exit(1);
  }
  const urls = yaml.load(fs.readFileSync(dataPath, 'utf8'));
  console.log(`▶ Site: ${site}  ·  URLs: ${Object.keys(urls).length}  ·  Viewports: ${viewports.join(',')}`);
  console.log(`▶ MILO_LIBS: ${milolibs}`);

  // SHARD_NAME enables parallel-matrix mode: each matrix job writes its
  // own results-<shard>.json so they don't overwrite each other on S3.
  // A fan-in merge job later consolidates them into results.json.
  const shard = process.env.SHARD_NAME;
  const resultsFile = shard ? `results-${shard}.json` : 'results.json';
  const timestampType = shard ? `-${shard}` : '';

  const folderPath = `${config.baseDir}/${site}`;
  validatePath(`${folderPath}/.touch`, { forWriting: true });

  const allResults = {};
  for (const vp of viewports) {
    const vpResults = await captureViewport(vp, urls, folderPath, milolibs);
    Object.assign(allResults, vpResults);
  }

  const diffed = diffResults(folderPath, allResults, resultsFile);

  if (config.s3.accessKeyId && config.s3.secretAccessKey) {
    console.log(`\n▶ Uploading to ${config.s3.endpoint}/${config.s3.bucket}/${folderPath}/`);
    await uploadResultsDir(folderPath, { resultsFile, type: timestampType });
    console.log('✓ Uploaded');
  } else {
    console.log('\n⚠ Skipping S3 upload (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY not set)');
  }

  const diffCount = Object.values(diffed).flat().filter((e) => e.diff).length;
  console.log(`\n✓ Done.  Captures: ${Object.keys(diffed).length}  ·  With diffs: ${diffCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
