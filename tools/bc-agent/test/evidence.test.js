import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeBusinessStage, errorSummary, renderWorkflowSummary } from '../lib/workflow-summary.js';

const turn = (label, kinds, shot) => ({ label, shot, reply: { kinds } });
const report = {
  url: 'https://business.stage.adobe.com/?milolibs=stage',
  startedAt: '2026-01-01T00:00:00Z',
  explore: {
    coverage: {
      'product-card': [{}], citations: [{}], feedback: [{}], 'meeting-cta': [{}], form: [{}],
      gallery: [{}], 'auth-cta': [{}],
    },
    paths: [
      { seed: 'I want to touch up and enhance my photos', turns: [turn('photos', ['feedback', 'product-card'], 'X0-01.png')] },
      { seed: 'Generate an image of a mountain lake at sunset', turns: [
        turn('gen', ['feedback', 'text'], 'X1-01.png'),
        turn('[click] more', ['auth-cta', 'gallery'], 'X1-02.png'),
      ] },
      { seed: 'Compare Photoshop vs Lightroom', turns: [turn('compare', ['text'], 'X3-01.png'), turn('[click] x', ['text'], 'X3-02.png')] },
      { seed: 'I want to talk to sales about AEM', turns: [
        turn('sales', ['meeting-cta'], 'X4-01.png'),
        turn('[click] Schedule meeting', ['form'], 'X4-02.png'),
      ] },
      { seed: 'How much does Adobe Experience Platform cost?', turns: [turn('cost', ['citations'], 'X5-01.png')] },
      { seed: 'broken', error: 'timeout', turns: [turn('broken', ['citations'], null)] },
    ],
  },
};
const byId = (summary) => Object.fromEntries(summary.checks.map((c) => [c.id, c]));

test('each check gets one representative observed screenshot', () => {
  const c = byId(summarizeBusinessStage(report));
  assert.equal(c.recommendation.screenshot, 'X0-01.png');
  assert.equal(c.citations.screenshot, 'X5-01.png');
  assert.equal(c.feedback.screenshot, 'X0-01.png');
  assert.equal(c.recommendation.evidence, 'observed');
});

test('preferred widget wins: form over meeting CTA, gallery+sign-in pair', () => {
  const c = byId(summarizeBusinessStage(report));
  assert.equal(c.sales.screenshot, 'X4-02.png');
  assert.equal(c.generation.screenshot, 'X1-02.png');
  assert.equal(c.generation.status, 'pass');
});

test('unobserved check falls back to the last shot of its seed path', () => {
  const c = byId(summarizeBusinessStage(report));
  assert.equal(c.comparison.pass, false);
  assert.equal(c.comparison.status, 'review');
  assert.equal(c.comparison.evidence, 'fallback');
  assert.equal(c.comparison.screenshot, 'X3-02.png');
});

test('turns without a screenshot are never chosen', () => {
  const summary = summarizeBusinessStage({ explore: { coverage: {}, paths: [{ seed: 'x', turns: [turn('x', ['table'], null)] }] } });
  const c = byId(summary);
  assert.equal(c.comparison.screenshot, null);
  assert.equal(c.comparison.evidence, 'none');
});

test('summary carries url/startedAt and links screenshots in markdown', () => {
  const summary = summarizeBusinessStage(report);
  assert.equal(summary.url, report.url);
  assert.equal(summary.status, 'review');
  assert.match(renderWorkflowSummary(summary, report), /\(\[screenshot\]\(X4-02\.png\)\)/);
});

test('error summary marks every check as error', () => {
  const summary = errorSummary({ url: 'https://x.test/', startedAt: null, error: 'boom' });
  assert.equal(summary.status, 'error');
  assert.ok(summary.checks.every((c) => c.status === 'error' && c.screenshot === null));
  assert.match(summary.conclusion, /boom/);
});
