// Publishes one bc-agent run to the Screenshot Diff S3 bucket so nala-auto
// can render it. Key contract (relative to the bucket root):
//
//   screenshots/bc-agent/runs/<runId>/workflow-summary.json
//   screenshots/bc-agent/runs/<runId>/workflow-summary.md
//   screenshots/bc-agent/runs/<runId>/report.html
//   screenshots/bc-agent/runs/<runId>/report.json
//   screenshots/bc-agent/runs/<runId>/<shot>.png      (every PNG the report/summary references)
//   screenshots/bc-agent/runs/index.json               (newest first, capped)
//   screenshots/bc-agent/latest.json                   (newest run entry)
//
// Pointers are written last so they never reference a half-uploaded run.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const S3_ROOT = 'screenshots/bc-agent';
export const INDEX_KEY = `${S3_ROOT}/runs/index.json`;
export const LATEST_KEY = `${S3_ROOT}/latest.json`;
export const INDEX_LIMIT = 50;
export const REPORT_FILES = ['report.html', 'report.json', 'workflow-summary.md', 'workflow-summary.json'];

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHOT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.png$/;

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  json: 'application/json',
  md: 'text/markdown; charset=utf-8',
  png: 'image/png',
};

export function s3Config(env = process.env) {
  const endpoint = env.S3_ENDPOINT || 'https://s3-sj3.corp.adobe.com';
  const bucket = env.S3_BUCKET || 'milo';
  return {
    region: env.S3_REGION || 'us-west-1',
    endpoint,
    bucket,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    publicReadUrl: env.S3_PUBLIC_READ_URL || `${endpoint}/${bucket}`,
  };
}

export function sanitizeRunId(runId) {
  const value = String(runId ?? '').trim();
  if (!RUN_ID_RE.test(value) || value.includes('..')) {
    throw new Error(`Invalid run_id '${value}' (letters, digits, dot, dash, underscore; max 64 chars)`);
  }
  return value;
}

export function runPrefix(runId) {
  return `${S3_ROOT}/runs/${sanitizeRunId(runId)}`;
}

export function isSafeShotName(name) {
  return typeof name === 'string' && SHOT_RE.test(name) && !name.includes('..');
}

export function contentType(name) {
  return CONTENT_TYPES[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
}

// Every screenshot file name referenced by the report or summary.
export function referencedShots(report = {}, summary = {}) {
  const names = new Set();
  const addTurns = (turns) => (turns || []).forEach((turn) => turn.shot && names.add(turn.shot));
  (report.scenarios || []).forEach((sc) => {
    addTurns(sc.turns);
    (sc.extraShots || []).forEach((shot) => shot && names.add(shot));
  });
  (report.explore?.paths || []).forEach((path) => {
    addTurns(path.turns);
    if (path.errorShot) names.add(path.errorShot);
  });
  (summary.checks || []).forEach((check) => check.screenshot && names.add(check.screenshot));
  return [...names];
}

// Resolve a file name inside dir, refusing anything that escapes it
// (including through symlinks). Returns null for unsafe or missing files.
export function safeLocalPath(dir, name) {
  const root = realpathSync(dir);
  const candidate = resolve(root, name);
  if (!candidate.startsWith(root + sep)) return null;
  if (!existsSync(candidate)) return null;
  const real = realpathSync(candidate);
  return real.startsWith(root + sep) ? real : null;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// Decide what to upload. Pure except for reading dir; no network.
export function planUpload(dir, runId) {
  const prefix = runPrefix(runId);
  const report = readJson(join(dir, 'report.json')) || {};
  const summary = readJson(join(dir, 'workflow-summary.json'));
  const uploads = [];
  const skipped = [];
  const add = (name) => {
    const local = safeLocalPath(dir, name);
    if (!local) { skipped.push(name); return; }
    uploads.push({ local, key: `${prefix}/${name}`, contentType: contentType(name) });
  };
  referencedShots(report, summary || {}).forEach((name) => {
    if (isSafeShotName(name)) add(name);
    else skipped.push(name);
  });
  // Summary last among run files: its presence marks the run complete.
  REPORT_FILES.forEach(add);
  return { prefix, summary, uploads, skipped };
}

export function indexEntry({ runId, summary, prefix, publishedAt, runUrl }) {
  return {
    runId,
    status: summary?.status || 'error',
    passed: summary?.passed ?? 0,
    total: summary?.total ?? 0,
    url: summary?.url || null,
    startedAt: summary?.startedAt || null,
    publishedAt,
    runUrl: runUrl || null,
    prefix,
    summary: `${prefix}/workflow-summary.json`,
    report: `${prefix}/report.html`,
  };
}

export function updateIndex(existing, entry, limit = INDEX_LIMIT) {
  const list = Array.isArray(existing) ? existing.filter((e) => e && e.runId !== entry.runId) : [];
  return [entry, ...list].slice(0, limit);
}

export function makeS3Client(cfg) {
  if (!cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error('Missing S3 credentials. Set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.');
  }
  return import('@aws-sdk/client-s3').then(({ S3Client, PutObjectCommand, GetObjectCommand }) => {
    const client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: true,
    });
    return {
      put: ({ key, body, contentType: type, cacheControl }) => client.send(new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: body,
        ContentType: type,
        CacheControl: cacheControl,
        ACL: 'public-read',
      })),
      getJson: async (key) => {
        const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return JSON.parse(await res.Body.transformToString());
      },
    };
  });
}

// store: { put({key, body, contentType, cacheControl}), getJson(key) }
export async function publishRun({ dir, runId, store, runUrl, now = () => new Date(), log = console.log }) {
  const { prefix, summary, uploads, skipped } = planUpload(dir, runId);
  skipped.forEach((name) => log(`  ⚠ skipped ${name} (missing or unsafe)`));
  const failed = [];
  for (const item of uploads) {
    try {
      await store.put({ key: item.key, body: readFileSync(item.local), contentType: item.contentType });
    } catch (e) {
      failed.push(item.key);
      log(`  ✗ ${item.key}: ${e.message}`);
    }
  }
  log(`  ✓ uploaded ${uploads.length - failed.length}/${uploads.length} files to ${prefix}/`);
  const hasSummary = uploads.some((u) => u.key.endsWith('/workflow-summary.json') && !failed.includes(u.key));
  if (!hasSummary) {
    throw new Error(`workflow-summary.json was not published for ${runId}; pointers left unchanged`);
  }

  const entry = indexEntry({ runId: sanitizeRunId(runId), summary, prefix, publishedAt: now().toISOString(), runUrl });
  let existing = [];
  try { existing = await store.getJson(INDEX_KEY); } catch (e) { log(`  ⚠ no readable run index (${e.message}); starting a new one`); }
  const index = updateIndex(existing, entry);
  const json = (value) => Buffer.from(JSON.stringify(value, null, 2));
  await store.put({ key: INDEX_KEY, body: json(index), contentType: CONTENT_TYPES.json, cacheControl: 'no-cache' });
  await store.put({ key: LATEST_KEY, body: json(entry), contentType: CONTENT_TYPES.json, cacheControl: 'no-cache' });
  if (failed.length) throw new Error(`${failed.length} file(s) failed to upload`);
  return { entry, uploaded: uploads.length, skipped };
}
