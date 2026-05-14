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
const { chromium, webkit, devices } = require('playwright');
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

const VIEWPORTS = {
  chrome: { engine: chromium, device: 'Desktop Chrome', viewport: { width: 1920, height: 1080 } },
  ipad: { engine: webkit, device: 'iPad Mini', viewport: null },
  iphone: { engine: webkit, device: 'iPhone X', viewport: null },
};

async function captureViewport(viewportName, urls, folderPath, milolibs) {
  const preset = VIEWPORTS[viewportName];
  console.log(`\n▶ Viewport: ${viewportName} (${preset.device})`);
  const browser = await preset.engine.launch();
  const ctxOpts = devices[preset.device] ? { ...devices[preset.device] } : {};
  if (preset.viewport) ctxOpts.viewport = preset.viewport;
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  const results = {};
  for (const [key, url] of Object.entries(urls)) {
    const name = `${key}-${viewportName}`;
    console.log(`  [${name}] ${url}`);
    try {
      const result = await takeTwo(
        page,
        url, null,
        url + milolibs, null,
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

function diffResults(folderPath, allResults) {
  console.log('\n▶ Computing pixel diffs');
  const comparator = getComparator('image/png');
  const diffed = {};

  for (const [key, entries] of Object.entries(allResults)) {
    diffed[key] = entries.map((entry) => {
      if (entry.error || !entry.a || !entry.b) return entry;
      try {
        const a = fs.readFileSync(validatePath(entry.a));
        const b = fs.readFileSync(validatePath(entry.b));
        const diff = comparator(a, b);
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

  const resultsPath = `${folderPath}/results.json`;
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

  const folderPath = `${config.baseDir}/${site}`;
  validatePath(`${folderPath}/.touch`, { forWriting: true });

  const allResults = {};
  for (const vp of viewports) {
    const vpResults = await captureViewport(vp, urls, folderPath, milolibs);
    Object.assign(allResults, vpResults);
  }

  diffResults(folderPath, allResults);

  if (config.s3.accessKeyId && config.s3.secretAccessKey) {
    console.log(`\n▶ Uploading to ${config.s3.endpoint}/${config.s3.bucket}/${folderPath}/`);
    await uploadResultsDir(folderPath);
    console.log('✓ Uploaded');
  } else {
    console.log('\n⚠ Skipping S3 upload (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY not set)');
  }

  const diffCount = Object.values(allResults).flat().filter((e) => e.diff).length;
  console.log(`\n✓ Done.  Captures: ${Object.keys(allResults).length}  ·  With diffs: ${diffCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
