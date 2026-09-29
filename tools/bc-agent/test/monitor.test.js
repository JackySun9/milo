import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECKS, pickIndex, loadPool, planRun, retryIndex, judgeAttempt, summarizeMonitor, monitorErrorSummary, isBacom,
} from '../lib/monitor.js';
import { renderMonitorSummary } from '../lib/monitor-report.js';
import { referencedShots, indexEntry } from '../lib/publish.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const examplePath = join(here, '..', 'monitor', 'pool.example.json');
const example = JSON.parse(readFileSync(examplePath, 'utf8'));
const check = (id) => CHECKS.find((c) => c.id === id);
const reply = (kinds, extra = {}) => ({ text: 'ok', kinds: [...kinds, 'feedback'], links: [], buttons: [], suggestions: [], classes: [], ...extra });
const turn = (r, extra = {}) => ({ label: 'p', reply: r, shot: 'x.png', ...extra });
const attempt = (turns, extra = {}) => ({ entry: { id: 'e1', prompt: 'secret prompt' }, index: 0, turns, ...extra });

test('example pool covers every check', () => {
  CHECKS.forEach((c) => assert.ok(example.checks[c.id]?.length, c.id));
});

test('pickIndex is deterministic and in range', () => {
  assert.equal(pickIndex('run-1', 'genie', 7), pickIndex('run-1', 'genie', 7));
  for (let i = 0; i < 50; i += 1) {
    const n = pickIndex(`r${i}`, 'pricing', 5);
    assert.ok(n >= 0 && n < 5);
  }
  assert.equal(pickIndex('r', 'x', 0), -1);
});

test('loadPool precedence: file > secret (json/base64) > private > example', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-'));
  const file = join(dir, 'p.json');
  writeFileSync(file, JSON.stringify({ checks: { genie: [{ prompt: 'a' }] } }));
  const json = JSON.stringify({ checks: { genie: [{ prompt: 'b' }] } });
  assert.equal(loadPool({ file, env: { BC_MONITOR_POOL: json }, exampleFile: examplePath }).source, 'file');
  assert.equal(loadPool({ env: { BC_MONITOR_POOL: json }, privateFile: file, exampleFile: examplePath }).pool.checks.genie[0].prompt, 'b');
  const b64 = Buffer.from(json).toString('base64');
  assert.equal(loadPool({ env: { BC_MONITOR_POOL: b64 }, exampleFile: examplePath }).source, 'secret');
  assert.equal(loadPool({ env: {}, privateFile: file, exampleFile: examplePath }).source, 'private');
  assert.equal(loadPool({ env: {}, privateFile: join(dir, 'missing.json'), exampleFile: examplePath }).source, 'example');
  assert.throws(() => loadPool({ env: { BC_MONITOR_POOL: '{"checks":{"x":[{}]}}' }, exampleFile: examplePath }));
});

test('planRun skips live chat off BACOM and checks without prompts', () => {
  assert.ok(isBacom('https://business.stage.adobe.com/?milolibs=stage'));
  assert.ok(!isBacom('https://www.adobe.com/'));
  const bacom = planRun({ pool: example, runKey: 'r', url: 'https://business.adobe.com/' });
  assert.ok(!bacom.find((i) => i.checkId === 'live-chat').skip);
  const dotcom = planRun({ pool: example, runKey: 'r', url: 'https://www.adobe.com/' });
  assert.ok(dotcom.find((i) => i.checkId === 'live-chat').skip);
  const partial = planRun({ pool: { checks: { genie: example.checks.genie } }, runKey: 'r', url: 'https://business.adobe.com/', only: ['genie', 'pricing'] });
  assert.deepEqual(partial.map((i) => [i.checkId, !!i.skip]), [['pricing', true], ['genie', false]]);
});

test('retryIndex repeats after error, rotates after review', () => {
  assert.equal(retryIndex({ index: 2, error: 'timeout' }, 5), 2);
  assert.equal(retryIndex({ index: 4 }, 5), 0);
});

test('judges match probe-shaped replies', () => {
  const ok = (id, turns, extra) => judgeAttempt(check(id), attempt(turns, extra)).pass;
  assert.ok(ok('paa-product', [turn(reply(['citations', 'product-card']))]));
  assert.ok(!ok('paa-compare', [turn(reply(['text']))]));
  assert.ok(ok('paa-compare', [turn(reply(['table']))]));
  assert.ok(ok('pricing', [turn(reply(['cta-links'], { links: [{ href: 'https://www.adobe.com/creativecloud/plans.html' }] }))]));
  assert.ok(ok('pricing', [turn(reply(['text'], { text: 'Photoshop is US$22.99/mo' }))]));
  const card = [turn(reply(['product-card']))];
  const expectUrl = 'https://www.adobe.com/acrobat/online/pdf-editor.html';
  assert.ok(ok('acrobat-cta', card, { entry: { prompt: 'p', expectUrl }, navigatedTo: `${expectUrl}?adobe_brand_concierge_source=bc-adobe-product-card` }));
  assert.ok(!ok('acrobat-cta', card, { entry: { prompt: 'p', expectUrl }, navigatedTo: 'https://www.adobe.com/acrobat/online/compress-pdf.html' }));
  assert.ok(!ok('acrobat-cta', card, { entry: { prompt: 'p', expectUrl } }));
  assert.ok(ok('genie', [turn(reply(['citations'], { links: [{ href: 'https://helpx.adobe.com/photoshop/remove.html' }] }))]));
  assert.ok(ok('firefly-generate', [turn(reply(['auth-cta', 'gallery']))]));
  assert.ok(ok('firefly-boards', [turn(reply(['cta-links'], { links: [{ href: 'https://firefly.adobe.com/boards/x' }] }))]));
  assert.ok(ok('firefly-edit', [turn(reply(['cta-links'], { links: [{ href: 'https://firefly-stage.corp.adobe.com/generate/image?view=edit' }] }))]));
  assert.ok(!ok('bam-explicit', [turn(reply(['meeting-cta']))]));
  assert.ok(ok('bam-explicit', [turn(reply(['meeting-cta'])), turn(reply(['form']))]));
  assert.ok(ok('bam-implicit', [turn(reply(['text'], { buttons: ['Schedule meeting'] }))]));
  const q = reply(['text'], { text: 'Which Adobe product or area would you like to discuss with sales?' });
  assert.ok(ok('bam-clarify', [turn(q), turn(reply(['meeting-cta']))]));
  assert.ok(!ok('bam-clarify', [turn(reply(['meeting-cta']))]));
  assert.ok(ok('live-chat', [turn(null, { chat: { kinds: ['advisor'] } })]));
  assert.ok(!ok('live-chat', [turn(reply(['text']), { chat: { kinds: [] } })]));
  assert.ok(ok('support-deflect', [turn(reply(['cta-links'], { links: [{ href: 'https://experienceleague.adobe.com/en/support' }] }))]));
  assert.ok(!ok('support-deflect', [turn(reply(['text'], { text: 'support' }), { chat: { kinds: ['advisor'] } })]));
  assert.ok(ok('out-of-scope', [turn(reply(['text'], { text: "That's outside my scope" }))]));
  assert.ok(!ok('out-of-scope', [turn(reply(['product-card']))]));
  assert.equal(judgeAttempt(check('genie'), { entry: {}, turns: [], error: 'timeout' }).status, 'error');
  assert.equal(judgeAttempt(check('genie'), attempt([turn(reply(['error']))])).status, 'review');
});

test('summarizeMonitor: flaky pass, review, error, skip, feedback', () => {
  const pass = turn(reply(['table']), { shot: 'cmp-a2-01.png' });
  const report = {
    url: 'https://www.adobe.com/',
    startedAt: 't',
    monitor: {
      poolSource: 'secret',
      items: [
        { checkId: 'paa-compare', index: 0, attempts: [attempt([turn(reply(['text']))]), attempt([pass])] },
        { checkId: 'genie', index: 0, attempts: [attempt([turn(reply(['text']), { shot: 'g.png' })]), attempt([turn(reply(['text']))])] },
        { checkId: 'pricing', index: 0, attempts: [{ entry: { prompt: 'p' }, turns: [], error: 'timeout', errorShot: 'pricing-a1-00-error-state.png' }] },
        { checkId: 'live-chat', skip: 'Not expected on this site' },
      ],
    },
  };
  const s = summarizeMonitor(report);
  const by = Object.fromEntries(s.checks.map((c) => [c.id, c]));
  assert.equal(by['paa-compare'].status, 'pass');
  assert.equal(by['paa-compare'].flaky, true);
  assert.equal(by['paa-compare'].screenshot, 'cmp-a2-01.png');
  assert.equal(by.genie.status, 'review');
  assert.equal(by.pricing.status, 'error');
  assert.equal(by.pricing.evidence, 'error-state');
  assert.equal(by['live-chat'].status, 'skip');
  assert.equal(by.feedback.status, 'pass');
  assert.equal(s.total, 4);
  assert.equal(s.passed, 2);
  assert.equal(s.skipped, 1);
  assert.equal(s.status, 'review');
  assert.deepEqual(s.pathErrors, [{ seed: 'pricing', error: 'timeout' }]);
  const shots = referencedShots(report, s);
  ['cmp-a2-01.png', 'g.png', 'pricing-a1-00-error-state.png'].forEach((f) => assert.ok(shots.includes(f), f));
  assert.equal(indexEntry({ runId: 'r', summary: s, prefix: 'p' }).suite, 'monitor');
});

test('public markdown summary never contains prompt or reply text', () => {
  const report = {
    url: 'u',
    startedAt: 't',
    monitor: { poolSource: 'secret', items: [{ checkId: 'genie', index: 0, attempts: [attempt([turn(reply(['text'], { text: 'secret reply' }))])] }] },
  };
  const md = renderMonitorSummary(summarizeMonitor(report));
  assert.ok(!md.includes('secret prompt'));
  assert.ok(!md.includes('secret reply'));
  const err = monitorErrorSummary({ url: 'u', startedAt: null, error: 'boom' });
  assert.equal(err.total, CHECKS.length + 1);
  assert.ok(renderMonitorSummary(err).includes('ERROR'));
});
