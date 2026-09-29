#!/usr/bin/env node
/* global process */
// Brand Concierge monitor: one short conversation per agent/route, judged on
// routing and rendered widgets. See lib/monitor.js and README.md.
//
//   node monitor.mjs --url https://business.stage.adobe.com/?milolibs=stage
//   node monitor.mjs --pool ~/private/bc-pool.json --only pricing,genie --headed
//
// Prompts are never printed to stdout (CI logs of a public repo are public);
// they are only written to report.json / report.html / workflow-summary.json.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BcChat } from './lib/chat.js';
import {
  loadPool, planRun, retryIndex, judgeAttempt, summarizeMonitor, monitorErrorSummary, CHECKS,
} from './lib/monitor.js';
import { renderMonitorReport, renderMonitorSummary } from './lib/monitor-report.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const { values: a } = parseArgs({
  options: {
    url: { type: 'string' },
    out: { type: 'string' },
    pool: { type: 'string' },
    only: { type: 'string' },
    'run-key': { type: 'string' },
    parallel: { type: 'string', default: '2' },
    timeout: { type: 'string', default: '120' },
    headed: { type: 'boolean', default: false },
  },
});

const url = a.url || process.env.BC_WORKFLOW_URL || 'https://business.stage.adobe.com/?milolibs=stage';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(a.out || process.env.BC_WORKFLOW_OUT || join(here, 'reports', `monitor-${stamp}`));
const runKey = a['run-key'] || process.env.BC_RUN_ID || new Date().toISOString().slice(0, 10);
const replyTimeout = Number(a.timeout) * 1000;
const startedAt = new Date().toISOString();
mkdirSync(outDir, { recursive: true });

function writeOutputs(report, summary) {
  const full = {
    ...summary,
    runId: process.env.BC_RUN_ID || null,
    runUrl: process.env.BC_RUN_URL || null,
    finishedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, 'report.html'), renderMonitorReport(report, full));
  writeFileSync(join(outDir, 'workflow-summary.json'), JSON.stringify(full, null, 2));
  writeFileSync(join(outDir, 'workflow-summary.md'), renderMonitorSummary(full));
  return full;
}

const shotName = (checkId, attemptNo, turnNo, suffix = '') => `${checkId}-a${attemptNo}-${String(turnNo).padStart(2, '0')}${suffix}.png`;

async function firstUrl(promises) {
  return new Promise((done) => {
    let pending = promises.length;
    promises.forEach((p) => p.then((v) => {
      if (v) done(v);
      else if (--pending === 0) done(null);
    }, () => { if (--pending === 0) done(null); }));
  });
}

async function runAttempt(browser, { id: checkId, flow, followUp }, entry, attemptNo) {
  const attempt = { entry, turns: [], attempt: attemptNo };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const chat = new BcChat(page, { replyTimeout });
  const turn = async (input, timeout = replyTimeout) => {
    chat.replyTimeout = timeout;
    const entryTurn = { label: typeof input === 'string' ? input : `[click] ${input.click}` };
    attempt.turns.push(entryTurn);
    try {
      const { ms } = typeof input === 'string' ? await chat.ask(input) : await chat.click(input.click);
      entryTurn.ms = ms;
    } catch (e) {
      entryTurn.error = e.message.split('\n')[0];
    }
    entryTurn.reply = await chat.snapshotReply().catch(() => null);
    entryTurn.chat = await chat.chatState().then((s) => ({ kinds: s.kinds, placeholder: s.placeholder })).catch(() => null);
    const file = shotName(checkId, attemptNo, attempt.turns.length);
    entryTurn.shot = await chat.screenshot(join(outDir, file)).then(() => file).catch(() => null);
    if (!entryTurn.reply && !(entryTurn.chat?.kinds || []).includes('advisor')) {
      throw new Error(entryTurn.error || 'no reply');
    }
    return entryTurn;
  };
  const kinds = (t) => t?.reply?.kinds || [];
  const asksBack = (t) => /\?\s*$/.test((t?.reply?.text || '').trim());
  try {
    await chat.open(url);
    // Advisor handoff does not render a new assistant message, so do not wait
    // the full reply timeout for one.
    let t = await turn(entry.prompt, flow === 'live' ? 30000 : replyTimeout);
    if (flow === 'ask' && followUp && asksBack(t)) {
      t = await turn(entry.followUp || followUp);
    } else if (flow === 'meeting' || flow === 'clarify') {
      if (flow === 'clarify' && asksBack(t)) t = await turn(entry.followUp || 'Adobe Experience Platform');
      for (let i = 0; i < 2 && !kinds(t).includes('form'); i += 1) {
        if (kinds(t).includes('meeting-cta')) t = await turn({ click: /schedule (a )?meeting/i }, 30000);
        else if (flow === 'meeting' && asksBack(t)) t = await turn(entry.followUp || 'Yes');
        else break;
      }
    } else if (flow === 'live') {
      let state = await chat.chatState();
      for (let i = 0; i < 5 && !state.kinds.includes('advisor'); i += 1) {
        await page.waitForTimeout(2000);
        state = await chat.chatState();
      }
      t.chat = { kinds: state.kinds, placeholder: state.placeholder };
      // Never leave a human advisor waiting on a synthetic visitor.
      if (state.kinds.includes('advisor')) {
        attempt.endedAdvisor = await chat.click(/end connection/i, { expectReply: false }).then(() => true).catch(() => false);
      }
    } else if (flow === 'cta' && kinds(t).includes('product-card')) {
      const btn = page.locator('.concierge-message').last().locator('.bc-multimodal-image button, .bc-multimodal-image a').first();
      if (await btn.count()) {
        const before = page.url();
        const popup = ctx.waitForEvent('page', { timeout: 15000 }).then(async (p) => {
          await p.waitForURL((u) => !String(u).startsWith('about:'), { timeout: 15000 }).catch(() => {});
          return p.url();
        }).catch(() => null);
        const nav = page.waitForURL((u) => String(u) !== before, { timeout: 15000 }).then(() => page.url()).catch(() => null);
        await btn.click();
        attempt.navigatedTo = await firstUrl([nav, popup]);
      }
    }
  } catch (e) {
    attempt.error = e.message.split('\n')[0];
    const file = shotName(checkId, attemptNo, 0, '-error-state');
    await page.screenshot({ path: join(outDir, file), timeout: 15000 }).then(() => { attempt.errorShot = file; }).catch(() => {});
  } finally {
    await ctx.close().catch(() => {});
  }
  return attempt;
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      await fn(items[idx]);
    }
  }));
}

const report = { suite: 'monitor', url, startedAt, runKey };
let exitCode = 0;
try {
  const { pool: promptPool, source } = loadPool({
    file: a.pool,
    privateFile: join(here, 'monitor', 'pool.json'),
    exampleFile: join(here, 'monitor', 'pool.example.json'),
  });
  if (source === 'example') console.warn('⚠ Using the public example pool; set BC_MONITOR_POOL or --pool for the real monitor prompts.');
  const only = a.only ? a.only.split(',').map((s) => s.trim()) : null;
  const items = planRun({ pool: promptPool, runKey, url, only });
  report.monitor = { poolSource: source, items };
  const browser = await chromium.launch({ headless: !a.headed });
  await pool(items.filter((item) => !item.skip), Number(a.parallel) || 2, async (item) => {
    const check = CHECKS.find((c) => c.id === item.checkId);
    const first = await runAttempt(browser, check, { ...item.entries[item.index], index: item.index }, 1);
    first.index = item.index;
    item.attempts = [first];
    let verdict = judgeAttempt(check, first);
    if (!verdict.pass && item.entries.length) {
      const index = retryIndex(first, item.entries.length);
      const second = await runAttempt(browser, check, { ...item.entries[index], index }, 2);
      second.index = index;
      item.attempts.push(second);
      verdict = judgeAttempt(check, second);
    }
    // Status only: `observed` can quote reply text, and CI logs are public.
    console.log(`${verdict.pass ? '✓' : '✗'} ${check.id} ${verdict.status}${item.attempts.length > 1 ? ' (retried)' : ''}`);
  });
  await browser.close();
  items.forEach((item) => { delete item.entries; });
  const summary = writeOutputs(report, summarizeMonitor(report));
  console.log(`\n${summary.status.toUpperCase()} ${summary.passed}/${summary.total} (pool: ${source})`);
  console.log(`Report: ${join(outDir, 'report.html')}`);
  exitCode = summary.status === 'pass' ? 0 : 1;
} catch (e) {
  console.error(`Monitor failed: ${e.message.split('\n')[0]}`);
  writeOutputs(report, monitorErrorSummary({ url, startedAt, error: e.message, poolSource: report.monitor?.poolSource }));
  exitCode = 2;
}
process.exitCode = exitCode;
