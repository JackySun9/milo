#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Figma ↔ web element visual comparison runner (MVP).
 *
 * Compares ONE Figma node against ONE DOM element on ONE web page at ONE
 * viewport, then writes the same `results.json` shape the SOT runner produces
 * and uploads it through the existing S3 pipeline, so
 * http://nala-auto.corp.adobe.com/imagediff/<site> works unchanged.
 *
 * Required env vars:
 *   SITE        — output folder / imagediff slug, e.g. figma-marquee
 *   FIGMA_URL   — Figma share URL containing a node-id, e.g.
 *                 https://www.figma.com/design/<key>/Name?node-id=12-34
 *   SELECTOR    — CSS selector of the web element to capture (must match once)
 *   URLS        — exactly one web URL (no `a | b` pairs)
 *   FIGMA_TOKEN — read-only Figma personal access token
 *
 * Optional env vars:
 *   VIEWPORTS          — exactly one of chrome | ipad | iphone (default chrome)
 *   FIGMA_EXPORT_SCALE — Figma export scale, default 2
 *   WAIT_STRATEGY      — 'footer' (default) or 'scroll'
 *   S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY — set both to upload
 *
 * Invocation:
 *   SITE=figma-demo FIGMA_URL=... SELECTOR='.marquee' URLS=https://... \
 *     VIEWPORTS=chrome node nala/features/visual/figma.run.js
 */

// eslint-disable-next-line import/no-extraneous-dependencies
const { chromium, devices } = require('playwright');
// eslint-disable-next-line import/no-extraneous-dependencies
const { getComparator } = require('playwright-core/lib/utils');
const fs = require('fs');
const { validatePath } = require('../../../tools/screenshot-diff/lib/utils.js');
const { uploadResultsDir } = require('../../../tools/screenshot-diff/lib/upload-s3.js');
const { keyForUrl } = require('../../../tools/screenshot-diff/lib/load-data.js');
const config = require('../../../tools/screenshot-diff/lib/config.js');
const { publishRun } = require('../../../tools/screenshot-diff/lib/publish-run.js');
const {
  parseFigmaUrl,
  pickSingleUrl,
  pickSingleViewport,
  requireSelector,
  requireFigmaToken,
  readPngSize,
  exportFigmaNodePng,
  buildResultEntry,
} = require('../../../tools/screenshot-diff/lib/figma.js');

const VIEWPORTS = {
  chrome: { device: 'Desktop Chrome', viewport: { width: 1920, height: 1080 } },
  ipad: { device: 'iPad Mini', viewport: null },
  iphone: { device: 'iPhone X', viewport: null },
};

// Design vs implementation always differs more than build-to-build pixels, so
// the tolerance is looser than the SOT runner's — this diff is a review aid.
const COMPARE_OPTS = { threshold: 0.3, maxDiffPixelRatio: 0.01 };

async function waitForPageReady(page, strategy) {
  await page.locator('.feds-footer-privacyLink').first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => {});
  if (strategy !== 'scroll') return;
  await page.evaluate(async () => {
    const step = 600;
    let y = 0;
    const max = document.body.scrollHeight;
    while (y < max) {
      window.scrollTo(0, y);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
      y += step;
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

/**
 * Capture exactly one element. Fails explicitly when the selector matches zero
 * or more than one node, so a bad selector never silently compares the wrong box.
 */
async function captureElement(page, url, selector, waitStrategy, outPath) {
  console.log(`▶ Web: ${url}`);
  await page.goto(url, { waitUntil: 'load' });
  await waitForPageReady(page, waitStrategy);

  const locator = page.locator(selector);
  const count = await locator.count();
  if (count === 0) throw new Error(`Selector '${selector}' matched no element on ${url}`);
  if (count > 1) throw new Error(`Selector '${selector}' matched ${count} elements on ${url} — it must match exactly one`);

  await locator.first().scrollIntoViewIfNeeded();
  await locator.first().waitFor({ state: 'visible', timeout: 15_000 });
  const box = await locator.first().boundingBox();
  if (!box || box.width < 1 || box.height < 1) {
    throw new Error(`Selector '${selector}' resolved to a zero-sized element on ${url}`);
  }
  await locator.first().screenshot({ path: validatePath(outPath, { forWriting: true }) });
  return outPath;
}

/**
 * Normalize the Figma export so it has the exact pixel dimensions of the web
 * capture — the pixel comparator refuses images of differing size.
 *
 * The export is scaled to the capture's width (aspect preserved) and laid on a
 * white canvas of the capture's height, top-aligned. Height differences then
 * show up as diff pixels instead of hard-failing the run.
 */
async function normalizePng(browser, pngBuffer, { width, height }, outPath) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    const dataUri = `data:image/png;base64,${pngBuffer.toString('base64')}`;
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">
      <img src="${dataUri}" style="display:block;width:${width}px;height:auto">
    </body></html>`);
    await page.waitForFunction(() => {
      const img = document.querySelector('img');
      return !!img && img.complete && img.naturalWidth > 0;
    }, null, { timeout: 15_000 });
    await page.screenshot({
      path: validatePath(outPath, { forWriting: true }),
      clip: {
        x: 0, y: 0, width, height,
      },
    });
  } finally {
    await context.close();
  }
  return outPath;
}

async function main() {
  const site = process.env.SITE;
  if (!site) throw new Error('SITE env var is required (e.g. SITE=figma-demo)');

  const { fileKey, nodeId } = parseFigmaUrl(process.env.FIGMA_URL);
  const selector = requireSelector(process.env.SELECTOR);
  const webUrl = pickSingleUrl(process.env.URLS);
  const viewportName = pickSingleViewport(
    process.env.VIEWPORTS || 'chrome',
    Object.keys(VIEWPORTS),
  );
  const token = requireFigmaToken();
  const scale = Number(process.env.FIGMA_EXPORT_SCALE || 2);
  const waitStrategy = process.env.WAIT_STRATEGY || 'footer';

  const folderPath = `${config.baseDir}/${site}`;
  validatePath(`${folderPath}/.touch`, { forWriting: true });
  const name = `${keyForUrl(webUrl)}-figma-${viewportName}`;
  const baselinePath = `${folderPath}/${name}-a.png`;
  const candidatePath = `${folderPath}/${name}-b.png`;

  console.log(`▶ Site: ${site}  ·  Viewport: ${viewportName}  ·  Selector: ${selector}`);
  console.log(`▶ Figma: file ${fileKey} node ${nodeId} @${scale}x`);

  const figmaPng = await exportFigmaNodePng({
    fileKey, nodeId, token, scale,
  });
  console.log(`✓ Exported Figma node (${figmaPng.length} bytes)`);

  const preset = VIEWPORTS[viewportName];
  const browser = await chromium.launch();
  let entry;
  try {
    const ctxOpts = devices[preset.device] ? { ...devices[preset.device] } : {};
    if (preset.viewport) ctxOpts.viewport = preset.viewport;
    ctxOpts.reducedMotion = 'reduce';
    const context = await browser.newContext(ctxOpts);
    const page = await context.newPage();
    await captureElement(page, webUrl, selector, waitStrategy, candidatePath);
    await context.close();

    const size = readPngSize(fs.readFileSync(validatePath(candidatePath)));
    console.log(`✓ Captured web element (${size.width}x${size.height})`);
    await normalizePng(browser, figmaPng, size, baselinePath);

    const a = fs.readFileSync(validatePath(baselinePath));
    const b = fs.readFileSync(validatePath(candidatePath));
    const diff = getComparator('image/png')(a, b, COMPARE_OPTS);
    let diffPath;
    if (diff && diff.diff) {
      diffPath = `${folderPath}/${name}-diff.png`;
      fs.writeFileSync(validatePath(diffPath, { forWriting: true }), diff.diff);
    } else if (diff && diff.errorMessage) {
      throw new Error(`Comparison failed: ${diff.errorMessage}`);
    }
    entry = buildResultEntry({
      baselinePath, candidatePath, figmaUrl: process.env.FIGMA_URL, webUrl, diffPath,
    });
  } finally {
    await browser.close();
  }

  const results = { [name]: [entry] };
  const resultsPath = `${folderPath}/results.json`;
  fs.writeFileSync(
    validatePath(resultsPath, { forWriting: true }),
    JSON.stringify(results, null, 2),
  );
  console.log(`  Wrote ${resultsPath}`);

  if (config.s3.accessKeyId && config.s3.secretAccessKey) {
    await uploadResultsDir(folderPath, { resultsFile: 'results.json', type: '' });
    console.log(`✓ Uploaded — http://nala-auto.corp.adobe.com/imagediff/${site}`);
    if (process.env.RUN_ID) {
      // Versioned copy is additive; never let it fail an otherwise-green run.
      await publishRun({ dir: folderPath, site, runId: process.env.RUN_ID })
        .catch((err) => console.warn(`::warning::Versioned publish failed: ${err.message}`));
    }
  } else {
    console.log('⚠ Skipping S3 upload (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY not set)');
  }

  console.log(entry.diff ? '\n✓ Done. Differences found.' : '\n✓ Done. No differences above tolerance.');
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});
