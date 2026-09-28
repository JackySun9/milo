/**
 * Pure-helper tests for versioned run publishing / retention.
 * Run with: npm run test:screenshot-diff
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SCREENSHOT_BASE_DIR = process.env.SCREENSHOT_BASE_DIR || 'screenshots';

const {
  DEFAULT_KEEP,
  sanitizeRunId,
  buildRunPrefix,
  buildRunIndexKey,
  isEphemeralSite,
  rewriteResultsPaths,
  buildRunIndex,
  pruneRunIndex,
  selectRunsForDeletion,
  parseRunKeys,
  stageRunCopy,
} = require('../lib/publish-run.js');

describe('run id + prefix construction', () => {
  test('accepts ordinary GitHub run ids', () => {
    assert.equal(sanitizeRunId(' 1234567890 '), '1234567890');
    assert.equal(sanitizeRunId('2026-09-28_run.1'), '2026-09-28_run.1');
  });

  test('rejects empty and path-escaping run ids', () => {
    assert.throws(() => sanitizeRunId(''), /run_id is required/);
    assert.throws(() => sanitizeRunId('../../etc'), /Invalid run_id/);
    assert.throws(() => sanitizeRunId('a/b'), /Invalid run_id/);
    assert.throws(() => sanitizeRunId('x'.repeat(65)), /Invalid run_id/);
  });

  test('builds the documented S3 key contract', () => {
    assert.equal(buildRunPrefix('bacom', '123'), 'screenshots/bacom/runs/123');
    assert.equal(buildRunIndexKey('bacom'), 'screenshots/bacom/runs/index.json');
    assert.throws(() => buildRunPrefix('a/b', '1'), /Invalid site/);
  });

  test('flags ephemeral quick-/figma- sites for the 24h lifecycle rule', () => {
    assert.equal(isEphemeralSite('figma-marquee'), true);
    assert.equal(isEphemeralSite('quick-abc'), true);
    assert.equal(isEphemeralSite('bacom'), false);
  });
});

describe('selectRunsForDeletion', () => {
  const runs = ['r5', 'r4', 'r3', 'r2', 'r1'];

  test('keeps the newest 3 by default', () => {
    assert.equal(DEFAULT_KEEP, 3);
    assert.deepEqual(selectRunsForDeletion(runs), ['r2', 'r1']);
  });

  test('deletes nothing when at or under the limit', () => {
    assert.deepEqual(selectRunsForDeletion(['r2', 'r1'], { keep: 3 }), []);
    assert.deepEqual(selectRunsForDeletion([], { keep: 3 }), []);
  });

  test('never deletes a .keep-marked run', () => {
    assert.deepEqual(selectRunsForDeletion(runs, { keep: 3, protectedRuns: ['r1'] }), ['r2']);
  });

  test('de-duplicates ids and honours an explicit keep count', () => {
    assert.deepEqual(selectRunsForDeletion(['r3', 'r3', 'r2', 'r1'], { keep: 1 }), ['r2', 'r1']);
  });
});

describe('parseRunKeys', () => {
  test('derives run ids and keep markers, ignoring the index', () => {
    const keys = [
      'screenshots/bacom/runs/index.json',
      'screenshots/bacom/runs/111/results.json',
      'screenshots/bacom/runs/111/x-a.png',
      'screenshots/bacom/runs/222/.keep',
      'screenshots/bacom/results.json',
      'screenshots/other/runs/999/results.json',
    ];
    const out = parseRunKeys(keys, 'bacom');
    assert.deepEqual(out.runs.sort(), ['111', '222']);
    assert.deepEqual(out.protectedRuns, ['222']);
  });
});

describe('buildRunIndex', () => {
  test('prepends newest and replaces a re-published run id', () => {
    const existing = [{ runId: 'b' }, { runId: 'a' }];
    const out = buildRunIndex(existing, { runId: 'b', timestamp: 't', results: 'k' });
    assert.deepEqual(out.map((e) => e.runId), ['b', 'a']);
    assert.equal(out[0].results, 'k');
  });

  test('tolerates a missing/invalid previous index', () => {
    assert.deepEqual(buildRunIndex(null, { runId: 'a' }).map((e) => e.runId), ['a']);
  });
});

describe('pruneRunIndex', () => {
  test('drops deleted runs so the viewer never lists missing results', () => {
    const index = [{ runId: 'd' }, { runId: 'c' }, { runId: 'b' }, { runId: 'a' }];
    assert.deepEqual(pruneRunIndex(index, ['b', 'a']).map((e) => e.runId), ['d', 'c']);
  });

  test('tolerates a missing index', () => {
    assert.deepEqual(pruneRunIndex(null, ['a']), []);
  });
});

describe('rewriteResultsPaths', () => {
  test('repoints image paths at the versioned prefix', () => {
    const results = {
      'page-chrome': [{
        order: 1, a: 'screenshots/s/page-a.png', b: 'screenshots/s/page-b.png', diff: 'screenshots/s/page-diff.png', urls: 'x | y',
      }],
      single: { a: 'screenshots/s/one-a.png', urls: 'z' },
    };
    const out = rewriteResultsPaths(results, 'screenshots/s', 'screenshots/s/runs/9');
    assert.equal(out['page-chrome'][0].a, 'screenshots/s/runs/9/page-a.png');
    assert.equal(out['page-chrome'][0].diff, 'screenshots/s/runs/9/page-diff.png');
    assert.equal(out['page-chrome'][0].urls, 'x | y');
    assert.equal(out.single.a, 'screenshots/s/runs/9/one-a.png');
  });

  test('leaves foreign paths untouched', () => {
    const out = rewriteResultsPaths({ k: { a: 'other/x.png' } }, 'screenshots/s', 'screenshots/s/runs/9');
    assert.equal(out.k.a, 'other/x.png');
  });
});

describe('stageRunCopy (filesystem integration)', () => {
  test('copies images and writes a self-contained results.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdiff-'));
    const prevBase = process.env.SCREENSHOT_BASE_DIR;
    const prevCwd = process.cwd();
    try {
      // config.baseDir is read at require-time, so stage inside `screenshots/`.
      process.chdir(tmp);
      const dir = 'screenshots/demo';
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/x-a.png`, 'A');
      fs.writeFileSync(`${dir}/x-b.png`, 'B');
      fs.writeFileSync(`${dir}/results.json`, JSON.stringify({
        x: [{ order: 1, a: `${dir}/x-a.png`, b: `${dir}/x-b.png`, urls: 'u' }],
      }));

      const { runDir, resultsPath } = stageRunCopy(dir, '4242');
      assert.equal(runDir, 'screenshots/demo/runs/4242');
      const copied = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
      assert.equal(copied.x[0].a, 'screenshots/demo/runs/4242/x-a.png');
      assert.equal(fs.readFileSync(copied.x[0].a, 'utf-8'), 'A');
      assert.equal(fs.readFileSync(copied.x[0].b, 'utf-8'), 'B');
    } finally {
      process.chdir(prevCwd);
      process.env.SCREENSHOT_BASE_DIR = prevBase;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
