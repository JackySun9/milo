/* eslint-disable no-console */
/**
 * Versioned result publishing + retention for screenshot-diff.
 *
 * Problem: every run overwrote `screenshots/<site>/results.json`, so a dataset
 * only ever had its newest run. This module publishes an immutable copy of each
 * run under a run-id prefix while leaving the existing "latest" keys untouched,
 * so current nala-auto URLs keep working.
 *
 * S3 key contract
 * ───────────────
 *   latest (unchanged):
 *     screenshots/<site>/results.json
 *     screenshots/<site>/timestamp.json
 *     screenshots/<site>/<name>-a.png | -b.png | -diff.png
 *
 *   immutable per-run copy:
 *     screenshots/<site>/runs/<runId>/results.json
 *     screenshots/<site>/runs/<runId>/timestamp.json
 *     screenshots/<site>/runs/<runId>/<name>-a.png | -b.png | -diff.png
 *
 *   run index (newest first), for the UI's history picker:
 *     screenshots/<site>/runs/index.json
 *     → [{ runId, timestamp, results: '<runs/<runId>/results.json key>' }, ...]
 *
 *   retention escape hatch (any object at this key pins the run forever):
 *     screenshots/<site>/runs/<runId>/.keep
 *
 * Retention: CI/CD artifacts are short-lived. After a successful publish, all
 * but the newest `keep` runs (default 3) are deleted, skipping `.keep`-marked
 * runs. Cleanup failures are logged and swallowed — a retention problem must
 * never fail a screenshot run.
 *
 * Wall-clock expiry is expected to come from an S3 lifecycle rule on the bucket
 * (see tools/screenshot-diff/README.md): 7 days for ordinary dataset sites,
 * 1 day for the ephemeral `quick-*` / `figma-*` sites. This module only enforces
 * the per-site "newest N" window.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config.js');
const { validatePath } = require('./utils.js');

// Lazily loaded so the pure helpers below (and their unit tests) don't need the
// AWS SDK installed.
function s3Uploads() {
  // eslint-disable-next-line global-require
  return require('./upload-s3.js');
}

const DEFAULT_KEEP = Number(process.env.SCREENSHOT_KEEP_RUNS || 3);
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Validate a caller-supplied run id (nala-auto passes the GitHub run id).
 * Rejects anything that could escape the prefix or break key parsing.
 * @param {string} runId
 * @returns {string}
 */
function sanitizeRunId(runId) {
  const value = String(runId == null ? '' : runId).trim();
  if (!value) throw new Error('run_id is required for versioned publishing');
  if (!RUN_ID_RE.test(value)) {
    throw new Error(`Invalid run_id '${value}' (allowed: letters, digits, dot, dash, underscore; max 64 chars)`);
  }
  return value;
}

/**
 * Immutable prefix for one run, relative to the bucket root.
 * @param {string} site
 * @param {string} runId
 * @returns {string} e.g. screenshots/bacom/runs/12345
 */
function buildRunsRoot(site) {
  const cleanSite = String(site || '').trim();
  if (!cleanSite || cleanSite.includes('/') || cleanSite.includes('..')) {
    throw new Error(`Invalid site '${site}' for run prefix`);
  }
  return `${config.baseDir}/${cleanSite}/runs`;
}

function buildRunPrefix(site, runId) {
  return `${buildRunsRoot(site)}/${sanitizeRunId(runId)}`;
}

/** Key of the per-site run index. */
function buildRunIndexKey(site) {
  return `${buildRunsRoot(site)}/index.json`;
}

/**
 * Ephemeral sites are ad-hoc Quick runs and Figma comparisons — they are never
 * a tracked dataset, so lifecycle expiry for them is 1 day instead of 7.
 * @param {string} site
 * @returns {boolean}
 */
function isEphemeralSite(site) {
  return /^(quick|figma)[-_]/i.test(String(site || '').trim());
}

/** Key of a run's retention `.keep` marker. */
function buildKeepMarkerKey(site, runId) {
  return `${buildRunPrefix(site, runId)}/.keep`;
}

/**
 * Rewrite the image paths inside a results object from one directory to another.
 * Entries may be arrays (sot/figma runners) or plain objects (compare.mjs).
 * @param {object} results
 * @param {string} fromDir
 * @param {string} toDir
 * @returns {object} new results object
 */
function rewriteResultsPaths(results, fromDir, toDir) {
  const swap = (value) => {
    if (typeof value !== 'string' || !value) return value;
    const base = path.basename(value);
    return value.startsWith(`${fromDir}/`) ? `${toDir}/${base}` : value;
  };
  const mapEntry = (entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const next = { ...entry };
    ['a', 'b', 'diff'].forEach((k) => {
      if (next[k]) next[k] = swap(next[k]);
    });
    return next;
  };
  return Object.fromEntries(Object.entries(results || {}).map(([key, value]) => [
    key,
    Array.isArray(value) ? value.map(mapEntry) : mapEntry(value),
  ]));
}

/**
 * Prepend the new run to the index, de-duplicating a re-published run id.
 * @param {Array} existing - previous index contents (newest first)
 * @param {{runId: string, timestamp: string, results: string}} entry
 * @returns {Array} new index, newest first
 */
function buildRunIndex(existing, entry) {
  const list = Array.isArray(existing) ? existing.filter((e) => e && e.runId !== entry.runId) : [];
  return [entry, ...list];
}

/**
 * Drop deleted runs from the index so viewers never list a run whose files are gone.
 * @param {Array} index - run index, newest first
 * @param {string[]} deleted - run ids that were removed
 * @returns {Array}
 */
function pruneRunIndex(index, deleted) {
  const gone = new Set(deleted);
  return (Array.isArray(index) ? index : []).filter((e) => e && !gone.has(e.runId));
}

/**
 * Pure retention selection: which run ids should be deleted.
 *
 * `runs` is ordered newest-first. Unknown runs discovered on S3 but absent from
 * the index are treated as oldest (appended) so orphans get cleaned up too.
 * `.keep`-marked runs are never deleted and never consume a retention slot's
 * protection from the others — they are simply excluded from deletion.
 *
 * @param {string[]} runs - run ids, newest first
 * @param {{keep?: number, protectedRuns?: string[]}} [opts]
 * @returns {string[]} run ids to delete
 */
function selectRunsForDeletion(runs, opts = {}) {
  const keep = Number.isInteger(opts.keep) && opts.keep >= 0 ? opts.keep : DEFAULT_KEEP;
  const protectedRuns = new Set(opts.protectedRuns || []);
  const seen = new Set();
  const ordered = (runs || []).filter((id) => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return ordered.slice(keep).filter((id) => !protectedRuns.has(id));
}

/**
 * Derive run ids and `.keep` markers from a flat list of S3 keys under
 * `screenshots/<site>/runs/`.
 * @param {string[]} keys
 * @param {string} site
 * @returns {{runs: string[], protectedRuns: string[]}}
 */
function parseRunKeys(keys, site) {
  const prefix = `${config.baseDir}/${site}/runs/`;
  const runs = new Set();
  const protectedRuns = new Set();
  (keys || []).forEach((key) => {
    if (typeof key !== 'string' || !key.startsWith(prefix)) return;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return; // index.json and stray files at the runs/ root
    const runId = rest.slice(0, slash);
    runs.add(runId);
    if (rest.slice(slash + 1) === '.keep') protectedRuns.add(runId);
  });
  return { runs: [...runs], protectedRuns: [...protectedRuns] };
}

/**
 * Copy a completed results directory into `<dir>/runs/<runId>/`, rewriting the
 * image paths so the copy is self-contained.
 * @param {string} dir - e.g. screenshots/bacom
 * @param {string} runId
 * @param {string} [resultsFile='results.json']
 * @returns {{runDir: string, resultsPath: string}}
 */
function stageRunCopy(dir, runId, resultsFile = 'results.json') {
  const runDir = `${dir}/runs/${sanitizeRunId(runId)}`;
  const sourceResults = JSON.parse(fs.readFileSync(validatePath(`${dir}/${resultsFile}`), 'utf-8'));
  validatePath(`${runDir}/.touch`, { forWriting: true }); // creates runDir

  Object.values(sourceResults).forEach((value) => {
    const entries = Array.isArray(value) ? value : [value];
    entries.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      ['a', 'b', 'diff'].forEach((k) => {
        const src = entry[k];
        if (!src) return;
        const dest = `${runDir}/${path.basename(src)}`;
        try {
          fs.copyFileSync(validatePath(src), validatePath(dest, { forWriting: true }));
        } catch (err) {
          console.warn(`⚠ Could not stage ${src} for run ${runId}: ${err.message}`);
        }
      });
    });
  });

  const rewritten = rewriteResultsPaths(sourceResults, dir, runDir);
  const resultsPath = `${runDir}/results.json`;
  fs.writeFileSync(
    validatePath(resultsPath, { forWriting: true }),
    JSON.stringify(rewritten, null, 2),
  );
  return { runDir, resultsPath };
}

// Read the existing run index through the public read path (same origin the UI
// uses). A missing/unreadable index is treated as empty — never fatal.
async function readRunIndex(site, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const url = `${config.publicReadUrl}/${buildRunIndexKey(site)}`;
  try {
    const res = await doFetch(url);
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body) ? body : [];
  } catch (err) {
    console.warn(`⚠ Could not read run index (${err.message}) — starting a new one`);
    return [];
  }
}

/**
 * Delete every object under the given run prefixes. Best effort.
 * @param {string} site
 * @param {string[]} runIds
 */
async function deleteRuns(site, runIds) {
  if (!runIds.length) return;
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint,
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
    forcePathStyle: true,
  });
  // eslint-disable-next-line no-restricted-syntax
  for (const runId of runIds) {
    const Prefix = `${buildRunPrefix(site, runId)}/`;
    // eslint-disable-next-line no-await-in-loop
    const listed = await client.send(new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix }));
    const objects = (listed.Contents || []).map((o) => ({ Key: o.Key }));
    if (!objects.length) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await client.send(new DeleteObjectsCommand({
      Bucket: config.s3.bucket,
      Delete: { Objects: objects },
    }));
    console.log(`  ✓ removed old run ${runId} (${objects.length} objects)`);
  }
}

/**
 * List every key under `screenshots/<site>/runs/`.
 * @param {string} site
 * @returns {Promise<string[]>}
 */
async function listRunKeys(site) {
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint,
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
    forcePathStyle: true,
  });
  const keys = [];
  let token;
  do {
    // eslint-disable-next-line no-await-in-loop
    const res = await client.send(new ListObjectsV2Command({
      Bucket: config.s3.bucket,
      Prefix: `${config.baseDir}/${site}/runs/`,
      ContinuationToken: token,
    }));
    (res.Contents || []).forEach((o) => keys.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/**
 * Publish an immutable copy of the just-completed run and prune old ones.
 * The "latest" keys must already have been uploaded by the caller.
 *
 * @param {object} args
 * @param {string} args.dir - local results dir, e.g. screenshots/bacom
 * @param {string} args.site
 * @param {string} args.runId
 * @param {number} [args.keep=3]
 * @returns {Promise<{runId: string, prefix: string, resultsKey: string}>}
 */
async function publishRun({
  dir, site, runId, keep = DEFAULT_KEEP,
}) {
  const id = sanitizeRunId(runId);
  const { runDir } = stageRunCopy(dir, id);
  await s3Uploads().uploadResultsDir(runDir, { resultsFile: 'results.json', type: '' });

  const entry = {
    runId: id,
    timestamp: new Date().toISOString(),
    results: `${buildRunPrefix(site, id)}/results.json`,
  };
  const index = buildRunIndex(await readRunIndex(site), entry);
  const indexPath = `${dir}/runs/index.json`;
  const writeIndex = async (list) => {
    fs.writeFileSync(
      validatePath(indexPath, { forWriting: true }),
      JSON.stringify(list, null, 2),
    );
    await s3Uploads().uploadFile({
      fileName: indexPath, s3Path: '.', s3Key: buildRunIndexKey(site), mimeType: 'application/json',
    });
  };
  await writeIndex(index);
  console.log(`✓ Published run ${id} → ${buildRunPrefix(site, id)}/`);

  // Retention is best effort: a failure here must not fail the screenshot run.
  try {
    const { runs, protectedRuns } = parseRunKeys(await listRunKeys(site), site);
    const indexOrder = index.map((e) => e.runId);
    const ordered = [...indexOrder, ...runs.filter((r) => !indexOrder.includes(r))];
    const doomed = selectRunsForDeletion(ordered, { keep, protectedRuns });
    if (doomed.length) {
      console.log(`▶ Retention: keeping newest ${keep}, deleting ${doomed.length}`);
      await deleteRuns(site, doomed);
      await writeIndex(pruneRunIndex(index, doomed));
    }
  } catch (err) {
    console.warn(`⚠ Run cleanup skipped: ${err.message}`);
  }

  return { runId: id, prefix: buildRunPrefix(site, id), resultsKey: entry.results };
}

module.exports = {
  DEFAULT_KEEP,
  buildRunsRoot,
  sanitizeRunId,
  buildRunPrefix,
  buildRunIndexKey,
  buildKeepMarkerKey,
  isEphemeralSite,
  rewriteResultsPaths,
  buildRunIndex,
  pruneRunIndex,
  selectRunsForDeletion,
  parseRunKeys,
  stageRunCopy,
  publishRun,
};

// CLI: `node publish-run.js screenshots/<site> <site> <runId> [keep]`
if (require.main === module) {
  const [dir, site, runId, keep] = process.argv.slice(2);
  if (!dir || !site || !runId) {
    console.error('Usage: node publish-run.js <dir> <site> <runId> [keep]');
    process.exit(1);
  }
  publishRun({
    dir, site, runId, keep: keep ? Number(keep) : DEFAULT_KEEP,
  }).catch((err) => {
    // Versioned publishing must never fail an otherwise-green screenshot run.
    console.warn(`::warning::Versioned publish failed: ${err.message}`);
  });
}
