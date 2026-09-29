import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeRunId, runPrefix, isSafeShotName, safeLocalPath, referencedShots, planUpload,
  updateIndex, publishRun, INDEX_KEY, LATEST_KEY, s3Config,
} from '../lib/publish.js';

function fixture({ summary = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bc-publish-'));
  const report = {
    explore: {
      paths: [{ seed: 's', turns: [{ shot: 'X0-01-a.png' }, { shot: '../escape.png' }, { shot: 'missing.png' }] }],
    },
    scenarios: [{ turns: [{ shot: 'M1-01.png' }], extraShots: ['M1-02-susi.png'] }],
  };
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report));
  writeFileSync(join(dir, 'report.html'), '<p>hi</p>');
  ['X0-01-a.png', 'M1-01.png', 'M1-02-susi.png', 'unreferenced.png'].forEach((f) => writeFileSync(join(dir, f), 'png'));
  if (summary) {
    writeFileSync(join(dir, 'workflow-summary.json'), JSON.stringify({
      status: 'pass', passed: 6, total: 6, url: 'https://u.test/', startedAt: 't', checks: [{ screenshot: 'X0-01-a.png' }],
    }));
    writeFileSync(join(dir, 'workflow-summary.md'), '# ok');
  }
  return dir;
}

function memoryStore(initial = {}) {
  const objects = { ...initial };
  const puts = [];
  return {
    objects,
    puts,
    put: async ({ key, body, contentType, cacheControl }) => {
      puts.push({ key, contentType, cacheControl });
      objects[key] = body.toString();
    },
    getJson: async (key) => {
      if (!(key in objects)) throw new Error('NoSuchKey');
      return JSON.parse(objects[key]);
    },
  };
}

test('run ids are validated before building keys', () => {
  assert.equal(runPrefix('12345'), 'screenshots/bc-agent/runs/12345');
  assert.equal(sanitizeRunId(' 1.2_3-a '), '1.2_3-a');
  ['', '../x', 'a/b', 'a..b', '.hidden', 'x'.repeat(65), 'a b'].forEach((bad) => {
    assert.throws(() => sanitizeRunId(bad), /Invalid run_id/);
  });
});

test('only plain PNG basenames are publishable screenshots', () => {
  assert.ok(isSafeShotName('X0-02--click-Schedule-meeting.png'));
  ['../a.png', 'a/b.png', 'a.html', '.png', 'a..png', '/etc/x.png', null].forEach((n) => assert.equal(isSafeShotName(n), false));
});

test('safeLocalPath refuses traversal and symlink escapes', () => {
  const dir = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'bc-outside-'));
  writeFileSync(join(outside, 'secret.png'), 'x');
  symlinkSync(join(outside, 'secret.png'), join(dir, 'link.png'));
  assert.ok(safeLocalPath(dir, 'X0-01-a.png'));
  assert.equal(safeLocalPath(dir, '../escape.png'), null);
  assert.equal(safeLocalPath(dir, 'link.png'), null);
  assert.equal(safeLocalPath(dir, 'missing.png'), null);
  rmSync(dir, { recursive: true });
  rmSync(outside, { recursive: true });
});

test('referenced shots cover scenarios, extra shots, explorer and summary', () => {
  const shots = referencedShots(
    { scenarios: [{ turns: [{ shot: 'a.png' }], extraShots: ['b.png'] }], explore: { paths: [{ turns: [{ shot: 'c.png' }, {}] }] } },
    { checks: [{ screenshot: 'd.png' }, { screenshot: null }] },
  );
  assert.deepEqual(shots.sort(), ['a.png', 'b.png', 'c.png', 'd.png']);
});

test('plan uploads referenced PNGs and reports under the run prefix, summary last', () => {
  const dir = fixture();
  const { uploads, skipped } = planUpload(dir, '42');
  const keys = uploads.map((u) => u.key);
  assert.deepEqual(keys, [
    'screenshots/bc-agent/runs/42/M1-01.png',
    'screenshots/bc-agent/runs/42/M1-02-susi.png',
    'screenshots/bc-agent/runs/42/X0-01-a.png',
    'screenshots/bc-agent/runs/42/report.html',
    'screenshots/bc-agent/runs/42/report.json',
    'screenshots/bc-agent/runs/42/workflow-summary.md',
    'screenshots/bc-agent/runs/42/workflow-summary.json',
  ]);
  assert.deepEqual(skipped.sort(), ['../escape.png', 'missing.png']);
  assert.equal(uploads.find((u) => u.key.endsWith('.html')).contentType, 'text/html; charset=utf-8');
  rmSync(dir, { recursive: true });
});

test('index is newest first, de-duplicated and capped', () => {
  const old = Array.from({ length: 60 }, (_, i) => ({ runId: `r${i}` }));
  const next = updateIndex([{ runId: 'r5' }, ...old], { runId: 'r5', status: 'pass' });
  assert.equal(next[0].status, 'pass');
  assert.equal(next.filter((e) => e.runId === 'r5').length, 1);
  assert.equal(next.length, 50);
  assert.deepEqual(updateIndex('garbage', { runId: 'x' }), [{ runId: 'x' }]);
});

test('publishRun uploads files, then index and latest pointers', async () => {
  const dir = fixture();
  const store = memoryStore({ [INDEX_KEY]: JSON.stringify([{ runId: 'older' }]) });
  const { entry } = await publishRun({
    dir, runId: '42', store, runUrl: 'https://gh/run/42', now: () => new Date('2026-01-01T00:00:00Z'), log: () => {},
  });
  assert.deepEqual(store.puts.slice(-2).map((p) => p.key), [INDEX_KEY, LATEST_KEY]);
  assert.equal(store.puts.at(-1).cacheControl, 'no-cache');
  assert.deepEqual(JSON.parse(store.objects[INDEX_KEY]).map((e) => e.runId), ['42', 'older']);
  assert.deepEqual(JSON.parse(store.objects[LATEST_KEY]), entry);
  assert.equal(entry.summary, 'screenshots/bc-agent/runs/42/workflow-summary.json');
  assert.equal(entry.status, 'pass');
  assert.equal(entry.runUrl, 'https://gh/run/42');
  rmSync(dir, { recursive: true });
});

test('publishRun keeps pointers unchanged when the summary is missing', async () => {
  const dir = fixture({ summary: false });
  const store = memoryStore();
  await assert.rejects(publishRun({ dir, runId: '43', store, log: () => {} }), /workflow-summary\.json was not published/);
  assert.ok(!(LATEST_KEY in store.objects));
  assert.ok('screenshots/bc-agent/runs/43/report.html' in store.objects);
  rmSync(dir, { recursive: true });
});

test('publishRun still writes pointers but fails when some uploads fail', async () => {
  const dir = fixture();
  const store = memoryStore();
  const put = store.put;
  store.put = async (args) => {
    if (args.key.endsWith('M1-01.png')) throw new Error('503');
    return put(args);
  };
  await assert.rejects(publishRun({ dir, runId: '44', store, log: () => {} }), /1 file\(s\) failed/);
  assert.ok(LATEST_KEY in store.objects);
  rmSync(dir, { recursive: true });
});

test('s3 config uses screenshot-diff defaults and never needs inline secrets', () => {
  const cfg = s3Config({});
  assert.equal(cfg.endpoint, 'https://s3-sj3.corp.adobe.com');
  assert.equal(cfg.bucket, 'milo');
  assert.equal(cfg.publicReadUrl, 'https://s3-sj3.corp.adobe.com/milo');
  assert.equal(cfg.accessKeyId, undefined);
});
