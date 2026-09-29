import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsRetry, mergeRetry } from '../lib/explore.js';
import { summarizeBusinessStage } from '../lib/workflow-summary.js';
import { referencedShots } from '../lib/publish.js';

const turn = (label, kinds, shot) => ({ label, shot, reply: { kinds } });
const SALES = 'I want to talk to sales about Adobe Experience Manager';

test('paths with an error or no turns need a retry', () => {
  assert.equal(needsRetry({ turns: [] }), true);
  assert.equal(needsRetry({ turns: [turn('a', [], 'a.png')], error: 'timeout' }), true);
  assert.equal(needsRetry({ turns: [turn('a', [], 'a.png')] }), false);
});

test('a retry that captured turns replaces the failed path', () => {
  const merged = mergeRetry(
    { seed: SALES, turns: [], error: 'Timeout 30000ms', errorShot: 'X4-error-state.png' },
    { seed: SALES, turns: [turn('sales', ['form'], 'X4-retry-01.png')], attempt: 2 },
  );
  assert.equal(merged.turns[0].shot, 'X4-retry-01.png');
  assert.equal(merged.error, undefined);
  assert.equal(merged.errorShot, undefined);
  assert.equal(merged.firstError, 'Timeout 30000ms');
  assert.equal(merged.retried, true);
});

test('a retry that fails again keeps the original and its error-state shot', () => {
  const merged = mergeRetry(
    { seed: SALES, turns: [], error: 'first', errorShot: 'X4-error-state.png' },
    { seed: SALES, turns: [], error: 'second', errorShot: 'X4-retry-error-state.png' },
  );
  assert.equal(merged.error, 'first');
  assert.equal(merged.retryError, 'second');
  assert.equal(merged.errorShot, 'X4-retry-error-state.png');
});

test('a worse partial retry does not replace a longer original', () => {
  const original = { seed: 's', turns: [turn('a', [], 'a.png'), turn('b', [], 'b.png')], error: 'late timeout' };
  const merged = mergeRetry(original, { seed: 's', turns: [turn('c', [], 'c.png')], error: 'again' });
  assert.deepEqual(merged.turns.map((t) => t.shot), ['a.png', 'b.png']);
});

test('a check whose seed path never produced a turn uses its error-state screenshot', () => {
  const report = {
    explore: {
      coverage: { feedback: [{}] },
      paths: [
        { seed: 'I want to touch up and enhance my photos', turns: [turn('p', ['feedback'], 'X0-01.png')] },
        { seed: SALES, turns: [], error: 'timeout', errorShot: 'X4-retry-error-state.png' },
      ],
    },
  };
  const sales = summarizeBusinessStage(report).checks.find((c) => c.id === 'sales');
  assert.equal(sales.status, 'review');
  assert.equal(sales.screenshot, 'X4-retry-error-state.png');
  assert.equal(sales.evidence, 'error-state');
  assert.equal(sales.seed, SALES);
  assert.ok(referencedShots(report).includes('X4-retry-error-state.png'));
});

test('error-state evidence is never borrowed from an unrelated seed', () => {
  const report = {
    explore: { coverage: {}, paths: [{ seed: 'Compare Photoshop vs Lightroom', turns: [], errorShot: 'X3-error-state.png' }] },
  };
  const sales = summarizeBusinessStage(report).checks.find((c) => c.id === 'sales');
  assert.equal(sales.screenshot, null);
  assert.equal(sales.evidence, 'none');
});
