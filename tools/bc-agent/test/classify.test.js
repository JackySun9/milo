import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply, classifyChat, prodLinksOnStage } from '../lib/classify.js';
import { nextMoves } from '../lib/explore.js';
import { summarizeBusinessStage, renderWorkflowSummary } from '../lib/workflow-summary.js';

test('plain answer is text + feedback', () => {
  assert.deepEqual(classifyReply({ text: 'Hi', classes: ['message-text', 'feedback-button'] }), ['feedback', 'text']);
});

test('meeting form, product card, citations, CTA links are detected', () => {
  const k = classifyReply({
    text: 'x',
    classes: ['bc-inline-form', 'bc-multimodal-image', 'citations-accordion', 'bc-link-button--primary'],
    buttons: ['Schedule meeting'],
  });
  assert.deepEqual(k, ['citations', 'cta-links', 'form', 'meeting-cta', 'product-card']);
});

test('tables, gallery and calendar', () => {
  assert.ok(classifyReply({ tags: ['TABLE'] }).includes('table'));
  assert.ok(classifyReply({ text: 'More in Firefly gallery' }).includes('gallery'));
  assert.ok(classifyReply({ classes: ['bc-calendar-grid'] }).includes('calendar'));
});

test('friendly errors are detected', () => {
  assert.ok(classifyReply({ text: "I'm sorry, I'm having trouble connecting right now." }).includes('error'));
  assert.ok(classifyReply({ text: "I'm sorry, something went wrong." }).includes('error'));
});

test('advisor mode from placeholder, button or banner', () => {
  assert.deepEqual(classifyChat({ placeholder: 'Type a response' }), ['advisor']);
  assert.deepEqual(classifyChat({ buttons: ['End connection'] }), ['advisor']);
  assert.deepEqual(classifyChat({ text: 'You are now connected to Sam' }), ['advisor']);
  assert.deepEqual(classifyChat({ placeholder: 'Ask about solutions', buttons: ['Send message'] }), []);
});

test('prod links on a stage page are flagged; stage/corp links are not', () => {
  const links = [
    { href: 'https://www.adobe.com/products/firefly.html' },
    { href: 'https://www.stage.adobe.com/products/firefly.html' },
    { href: 'https://firefly-stage.corp.adobe.com/generate' },
    { href: 'https://firefly.adobe.com/gallery' },
  ];
  assert.deepEqual(prodLinksOnStage('https://business.stage.adobe.com/', links).map((l) => l.href),
    ['https://www.adobe.com/products/firefly.html', 'https://firefly.adobe.com/gallery']);
  assert.deepEqual(prodLinksOnStage('https://business.adobe.com/', links), []);
});

test('image generation card and sign-in CTA', () => {
  const k = classifyReply({ classes: ['bc-hero-media-card__media'], buttons: ['Sign in'] });
  assert.deepEqual(k, ['auth-cta', 'image-generation']);
});

test('explorer prefers meeting/sales moves and skips tried or navigational ones', () => {
  const reply = {
    suggestions: ['What factors determine pricing?', 'Can I talk to a sales agent?'],
    buttons: ['Thumbs up for x', 'Learn more', 'Sources', 'Schedule meeting', 'Sign in'],
  };
  const tried = new Set(['what factors determine pricing?']);
  assert.deepEqual(nextMoves(reply, tried).map((m) => m.label), ['Schedule meeting', 'Can I talk to a sales agent?']);
});

test('business-stage workflow accepts current product behavior', () => {
  const coverage = Object.fromEntries([
    'product-card', 'citations', 'table', 'meeting-cta', 'form', 'gallery', 'auth-cta', 'feedback',
  ].map((kind) => [kind, [{ path: kind }]]));
  const report = { url: 'https://business.stage.adobe.com/?milolibs=stage', startedAt: '2026-01-01', explore: { coverage, paths: [] } };
  const summary = summarizeBusinessStage(report);
  assert.equal(summary.status, 'pass');
  assert.equal(summary.passed, summary.total);
  assert.match(renderWorkflowSummary(summary, report), /operating normally/);
});

test('business-stage workflow flags missing coverage for review', () => {
  const report = { explore: { coverage: { feedback: [{ path: 'x' }] }, paths: [{ seed: 'x', error: 'timeout' }] } };
  const summary = summarizeBusinessStage(report);
  assert.equal(summary.status, 'review');
  assert.equal(summary.pathErrors.length, 1);
  assert.equal(summary.checks.find((check) => check.id === 'sales').pass, false);
});
