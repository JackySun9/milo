#!/usr/bin/env node
/**
 * SOT visual regression on REAL iOS Simulators via Appium (XCUITest) — full page.
 *
 * Drives real Mobile Safari on an iOS Simulator through Appium's WebDriver HTTP
 * API (plain fetch, no webdriverio dep). For each URL captures A (unmodified)
 * vs B (+ MILO_LIBS) as FULL-PAGE screenshots (scroll + stitch), pixel-diffs
 * them, and produces the SAME results format as sot.run.js so iOS shows up next
 * to chrome/ipad/iphone at /imagediff/<site>.
 *
 * One Appium session (one simulator) is reused for the whole job; cookies +
 * storage are cleared between every capture (clean A/B state, like sot.run.js).
 * Stitching uses pngjs (PNG) bundled inside playwright-core — no extra dep.
 *
 * Requires an Appium server on APPIUM_URL (default http://127.0.0.1:4723) with
 * the xcuitest driver, plus full Xcode + the requested iOS runtime, in a
 * logged-in GUI session.
 *
 * Required env: SITE
 * Optional: MILO_LIBS (?milolibs=stage), IOS_VERSION (e.g. 18.3; default newest),
 *   IOS_DEVICE (default 'iPhone 15'), IOS_SETTLE (secs, default 6),
 *   IOS_MAX_URLS (0 = all), APPIUM_URL,
 *   S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (both to upload).
 */
const fs = require('fs');
const { execFileSync } = require('child_process');
// eslint-disable-next-line import/no-extraneous-dependencies
const { getComparator } = require('playwright-core/lib/utils');
// eslint-disable-next-line import/no-extraneous-dependencies
const { PNG } = require('playwright-core/lib/utilsBundle');
const { uploadResultsDir } = require('../../../tools/screenshot-diff/lib/upload-s3.js');
const { validatePath } = require('../../../tools/screenshot-diff/lib/utils.js');
const { loadSiteData } = require('../../../tools/screenshot-diff/lib/load-data.js');
const config = require('../../../tools/screenshot-diff/lib/config.js');

const APPIUM = process.env.APPIUM_URL || 'http://127.0.0.1:4723';
const COMPARE_OPTS = { threshold: 0.2, maxDiffPixelRatio: 0.01 };
const slug = (s) => s.replace(/[^A-Za-z0-9]+/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wd = {
  post: async (p, body) => (await fetch(APPIUM + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(),
  get: async (p) => (await fetch(APPIUM + p)).json(),
  del: async (p) => (await fetch(APPIUM + p, { method: 'DELETE' })).json(),
};

// --- simctl: pin the EXACT device + runtime -------------------------------
// We create the simulator ourselves and hand its UDID to Appium instead of
// letting Appium fuzzy-match `deviceName`. That match is unreliable: it silently
// ran "iPhone 15" when "iPhone 16" was requested, and reported "no device" for
// combos it couldn't resolve. Creating the sim ourselves means the device that
// runs is always the one that was asked for — or the job fails with a clear
// reason (e.g. iPhone 16 has no iOS 17.5 build).
const simctl = (args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const lastLine = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';

// "18.3" -> the installed iOS runtime object; version '' picks the newest.
function resolveRuntime(version) {
  const all = JSON.parse(simctl(['list', 'runtimes', '--json'])).runtimes || [];
  const ready = all.filter((r) => r.isAvailable && /iOS/i.test(r.name || r.identifier || ''));
  if (!ready.length) throw new Error('No iOS runtimes installed on this runner');
  if (version) {
    const dashed = `iOS-${version.replace(/\./g, '-')}`;
    const want = ready.find((r) => r.version === version || (r.identifier || '').endsWith(dashed));
    if (!want) throw new Error(`iOS ${version} runtime not installed on this runner (installed: ${ready.map((r) => r.version).join(', ')})`);
    return want;
  }
  ready.sort((a, b) => (a.version < b.version ? 1 : -1));
  return ready[0];
}

// "iPhone 16 Pro Max" -> its device type object (exact name, then case-insensitive).
function resolveDeviceType(device) {
  const all = JSON.parse(simctl(['list', 'devicetypes', '--json'])).devicetypes || [];
  const dt = all.find((d) => d.name === device) || all.find((d) => (d.name || '').toLowerCase() === device.toLowerCase());
  if (!dt) throw new Error(`Device "${device}" is not available on this runner (no matching simulator device type)`);
  return dt;
}

// Create + boot a throwaway sim for exactly this device+runtime; return its UDID.
function createSim(name, deviceType, runtime) {
  let udid;
  try {
    udid = simctl(['create', name, deviceType.identifier, runtime.identifier]).trim();
  } catch (e) {
    // simctl refuses incompatible pairs (e.g. iPhone 16 on iOS 17.5) — surface why.
    throw new Error(`Cannot run "${deviceType.name}" on ${runtime.name}: ${lastLine(e.stderr) || lastLine(e.message) || 'device/runtime not compatible'}`);
  }
  try { simctl(['boot', udid]); } catch (e) { /* may already be booting */ }
  try { simctl(['bootstatus', udid, '-b']); } catch (e) { /* best effort */ }
  return udid;
}

function deleteSim(udid) {
  if (!udid) return;
  try { simctl(['shutdown', udid]); } catch (e) { /* noop */ }
  try { simctl(['delete', udid]); } catch (e) { /* noop */ }
}

// Attach Appium to the exact simulator we created (by UDID — no device matching).
async function newSession(udid) {
  const caps = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:udid': udid,
    browserName: 'Safari',
    'appium:newCommandTimeout': 600,
    'appium:safariInitialUrl': 'about:blank',
    // First run on a fresh runner builds WebDriverAgent (~2-3 min) — the default
    // 60s launch timeout isn't enough. Cached after the first build.
    'appium:wdaLaunchTimeout': 240000,
    'appium:wdaConnectionTimeout': 240000,
  };
  const r = await wd.post('/session', { capabilities: { alwaysMatch: caps, firstMatch: [{}] } });
  const sid = r.value?.sessionId || r.sessionId;
  if (!sid) throw new Error(`session create failed: ${JSON.stringify(r).slice(0, 400)}`);
  return sid;
}
const exec = async (sid, script, args = []) => (await wd.post(`/session/${sid}/execute/sync`, { script, args })).value;
const navigate = (sid, url) => wd.post(`/session/${sid}/url`, { url });
const shotPng = async (sid) => PNG.sync.read(Buffer.from((await wd.get(`/session/${sid}/screenshot`)).value || '', 'base64'));

async function resetState(sid) {
  try { await wd.del(`/session/${sid}/cookie`); } catch (e) { /* noop */ }
  try { await exec(sid, 'try{localStorage.clear();sessionStorage.clear()}catch(e){}'); } catch (e) { /* noop */ }
}

function appendQuery(url, qs) {
  if (!qs) return url;
  const stripped = qs.startsWith('?') ? qs.slice(1) : qs;
  if (!stripped) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${stripped}`;
}

// Navigate, settle, wake lazy content by scrolling, then scroll + stitch full page.
async function captureFullPage(sid, url, outPath, settle) {
  await navigate(sid, url);
  await sleep(settle * 1000);
  const innerH = await exec(sid, 'return window.innerHeight');
  const dpr = await exec(sid, 'return window.devicePixelRatio');

  // Pre-scroll to trigger lazy sections, then back to top.
  let y = 0;
  let maxH = await exec(sid, 'return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)');
  while (y < maxH) { await exec(sid, `window.scrollTo(0, ${y})`); await sleep(120); y += innerH; }
  await exec(sid, 'window.scrollTo(0, 0)');
  await sleep(800);

  const scrollH = await exec(sid, 'return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)');
  const first = await shotPng(sid);
  const fullH = Math.round(scrollH * dpr);
  const canvas = new PNG({ width: first.width, height: fullH });
  PNG.bitblt(first, canvas, 0, 0, first.width, Math.min(first.height, fullH), 0, 0);

  // Hide fixed/sticky elements so a pinned nav/banner doesn't repeat in every
  // stitched section (it stays in the first viewport captured above).
  // visibility:hidden preserves layout, so nothing shifts.
  await exec(sid, "for (const el of document.querySelectorAll('*')) { const p = getComputedStyle(el).position; if (p === 'fixed' || p === 'sticky') el.style.visibility = 'hidden'; }");

  y = innerH;
  while (y < scrollH) {
    await exec(sid, `window.scrollTo(0, ${y})`);
    await sleep(400);
    const actualY = await exec(sid, 'return window.pageYOffset');
    const img = await shotPng(sid);
    const destY = Math.round(actualY * dpr);
    const copyH = Math.min(img.height, fullH - destY);
    if (copyH > 0) PNG.bitblt(img, canvas, 0, 0, img.width, copyH, 0, destY);
    y += innerH;
  }
  fs.writeFileSync(validatePath(outPath, { forWriting: true }), PNG.sync.write(canvas));
}

async function main() {
  const site = process.env.SITE;
  if (!site) { console.error('SITE env var is required (e.g. SITE=bacom)'); process.exit(1); }
  const milolibs = process.env.MILO_LIBS || '?milolibs=stage';
  const device = process.env.IOS_DEVICE || 'iPhone 15';
  const version = process.env.IOS_VERSION || '';
  const settle = Number(process.env.IOS_SETTLE || 6);
  const vp = `ios${version}-${slug(device)}`;
  const resultsFile = `results-${vp}.json`;

  const raw = await loadSiteData(site, { dir: __dirname });
  const allEntries = Object.entries(raw).filter(([k]) => !k.startsWith('__'));
  const maxUrls = Number(process.env.IOS_MAX_URLS || 0);
  const entries = maxUrls > 0 ? allEntries.slice(0, maxUrls) : allEntries;
  const folderPath = `${config.baseDir}/${site}`;
  validatePath(`${folderPath}/.touch`, { forWriting: true });

  console.log(`▶ ${device} · iOS ${version || '(latest)'} · Appium ${APPIUM}`);
  console.log(`▶ Site: ${site} · URLs: ${entries.length} · MILO_LIBS: ${milolibs}`);

  // Resolve + create the EXACT device/runtime up front. If the pair is invalid
  // (e.g. iPhone 16 on iOS 17.5) this throws now, with a clear reason, instead
  // of silently capturing on the wrong device.
  const runtime = resolveRuntime(version);
  const deviceType = resolveDeviceType(device);
  console.log(`▶ Simulator: ${deviceType.name} · ${runtime.name} — creating…`);
  const simName = `nala-${slug(device)}-${slug(version || runtime.version)}-${process.pid}`;
  const udid = createSim(simName, deviceType, runtime);
  console.log(`▶ Simulator ${udid} booted`);

  const comparator = getComparator('image/png');
  const results = {};
  console.log('▶ Creating Safari session (first run builds WebDriverAgent)…');
  const sid = await newSession(udid);
  console.log(`▶ Session ${sid} (reused for all captures)`);

  try {
    for (const [key, value] of entries) {
      const urlA = typeof value === 'string' ? value : value.a;
      const urlB = typeof value === 'string' ? appendQuery(value, milolibs) : value.b;
      const name = `${key}-${vp}`;
      const aPath = `${folderPath}/${name}-a.png`;
      const bPath = `${folderPath}/${name}-b.png`;
      console.log(`  [${name}] ${urlA}  vs  ${urlB}`);
      try {
        await resetState(sid);
        await captureFullPage(sid, urlA, aPath, settle);
        await resetState(sid);
        await captureFullPage(sid, urlB, bPath, settle);
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
    try { await wd.del(`/session/${sid}`); } catch (e) { /* noop */ }
    deleteSim(udid);
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
