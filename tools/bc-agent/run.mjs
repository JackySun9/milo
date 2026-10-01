#!/usr/bin/env node
// Brand Concierge agent: runs test-plan scenarios and/or explores the chat.
//
//   node run.mjs --url https://business.stage.adobe.com/                # all scenarios
//   node run.mjs --url ... --only M1,M3 --headed
//   node run.mjs --url ... --explore --no-scenarios --depth 4
//   node run.mjs --url ... --explore --persona                         # LLM persona (needs BC_AGENT_API_KEY)
//   node run.mjs --url ... --only M4 --submit-forms                    # stage only, BC_SUBMIT_FORMS=1
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BcChat } from './lib/chat.js';
import { SCENARIOS, MANUAL_ONLY } from './scenarios.js';
import {
  DEFAULT_SEEDS, nextMoves, liveAdvisorAllowed, personaConfig, personaMove, needsRetry, mergeRetry,
} from './lib/explore.js';
import { renderReport } from './lib/report.js';

const { values: a } = parseArgs({
  options: {
    url: { type: 'string', default: 'https://business.stage.adobe.com/' },
    only: { type: 'string' },
    explore: { type: 'boolean', default: false },
    'no-scenarios': { type: 'boolean', default: false },
    seeds: { type: 'string' },
    depth: { type: 'string', default: '3' },
    persona: { type: 'boolean', default: false },
    'submit-forms': { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    parallel: { type: 'string', default: '3' },
    out: { type: 'string' },
    timeout: { type: 'string', default: '90' },
    repeat: { type: 'string', default: '1' },
  },
});

const url = a.url;
const host = new URL(url).host;
if (a['submit-forms'] && !/stage|localhost|aem\.(page|live)/.test(host)) {
  console.error(`Refusing --submit-forms on ${host}: it would create real leads. Use a stage URL.`);
  process.exit(2);
}
// Stage is not isolated: its live chat reached real advisors (ICX, 9/29), so
// stage leads may reach sales too. Require an explicit opt-in.
if (a['submit-forms'] && process.env.BC_SUBMIT_FORMS !== '1') {
  console.error('Refusing --submit-forms: stage leads may reach real sales. Set BC_SUBMIT_FORMS=1 only with the sales ops team\'s agreement.');
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(a.out || join('reports', `${host}-${stamp}`));
mkdirSync(outDir, { recursive: true });
const opts = { submitForms: a['submit-forms'], replyTimeout: Number(a.timeout) * 1000 };
const t0 = Date.now();
let apiCalls = 0;

const browser = await chromium.launch({ headless: !a.headed });

// errorShot: file name for a full-page screenshot of the state the page was
// in when fn (or opening the chat) threw; attached to the error as e.shot.
async function withChat(viewport, fn, { errorShot } = {}) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const chat = new BcChat(page, { replyTimeout: opts.replyTimeout });
  try {
    await chat.open(url);
    return await fn(chat, page);
  } catch (e) {
    if (errorShot) {
      await page.screenshot({ path: join(outDir, errorShot), fullPage: false, timeout: 15000 })
        .then(() => { e.shot = errorShot; })
        .catch(() => {});
    }
    throw e;
  } finally {
    apiCalls += chat.calls.length;
    await ctx.close();
  }
}

// Shared per-conversation helpers: `turn` sends a message or clicks, records
// transcript + screenshot; returns the classified latest reply.
function recorder(prefix, chat, turns) {
  let n = 0;
  const fileFor = (label) => {
    n += 1;
    return `${prefix}-${String(n).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 30)}.png`;
  };
  const shot = async (label) => {
    const file = fileFor(label);
    await chat.screenshot(join(outDir, file));
    return file;
  };
  const turn = async (input) => {
    const label = typeof input === 'string' ? input : `[click] ${input.click}`;
    const entry = { label };
    turns.push(entry);
    try {
      const { ms } = typeof input === 'string' ? await chat.ask(input) : await chat.click(input.click);
      entry.ms = ms;
      entry.reply = await chat.snapshotReply();
    } catch (e) {
      entry.error = e.message.split('\n')[0];
      entry.reply = await chat.snapshotReply().catch(() => null);
    }
    entry.shot = await shot(label).catch(() => null);
    // Safety net: if the AI routed to a live advisor on its own, end the
    // connection at once so no human is kept waiting on a synthetic visitor.
    if (!liveAdvisorAllowed()) {
      const state = await chat.chatState().catch(() => null);
      if (state?.kinds?.includes('advisor')) {
        entry.endedAdvisor = await chat.click(/end connection/i, { expectReply: false }).then(() => true).catch(() => false);
      }
    }
    if (!entry.reply) throw new Error(entry.error || 'no reply');
    return entry.reply;
  };
  return { turn, shot, fileFor };
}

async function pool(items, size, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }));
  return results;
}

async function runScenario(sc) {
  const res = { id: sc.id, title: sc.title, checks: [], turns: [], extraShots: [] };
  const s0 = Date.now();
  console.log(`▶ ${sc.id} ${sc.title}`);
  try {
    await withChat(sc.viewport, async (chat, page) => {
      const { turn, shot, fileFor } = recorder(sc.id.replace('#', '-r'), chat, res.turns);
      const check = (name, ok, detail = '', level = 'fail') => {
        res.checks.push({ name, status: ok ? 'pass' : level, detail: String(detail ?? '') });
      };
      const extraShot = async (label) => { res.extraShots.push(await shot(label)); };
      // Full-page screenshots (e.g. overlays outside the chat modal).
      extraShot.path = (label) => { const f = fileFor(label); res.extraShots.push(f); return join(outDir, f); };
      await sc.run({ turn, check, chat, page, url, opts, shot: extraShot });
    });
  } catch (e) {
    res.error = e.message.split('\n')[0];
  }
  res.ms = Date.now() - s0;
  const st = res.checks.map((c) => c.status);
  res.status = res.error ? 'error' : st.includes('fail') ? 'fail' : st.includes('warn') ? 'warn' : 'pass';
  console.log(`  ${res.status.toUpperCase()} ${sc.id} (${res.checks.filter((c) => c.status === 'pass').length}/${res.checks.length} checks)${res.error ? ` — ${res.error}` : ''}`);
  return res;
}

async function explorePath(seed, idx, tried, cfg, attempt = 1) {
  const path = { seed, turns: [], persona: !!cfg, attempt };
  const prefix = attempt > 1 ? `X${idx}-retry` : `X${idx}`;
  console.log(`🔎 explore${attempt > 1 ? ' (retry)' : ''}: ${seed}`);
  try {
    await withChat(null, async (chat) => {
      const { turn } = recorder(prefix, chat, path.turns);
      let reply = await turn(seed);
      const transcript = [{ role: 'user', text: seed }, { role: 'bot', text: reply.text }];
      for (let d = 1; d < Number(a.depth); d += 1) {
        if (reply.kinds.includes('form') && !opts.submitForms) break;
        let move;
        if (cfg) move = await personaMove(cfg, transcript, reply).catch((e) => { console.warn(`  persona: ${e.message}`); return null; });
        else move = nextMoves(reply, tried)[0];
        if (!move) break;
        tried.add(move.label.toLowerCase());
        reply = await turn(move.say ?? { click: move.click });
        transcript.push({ role: 'user', text: move.label }, { role: 'bot', text: reply.text });
      }
    }, { errorShot: `${prefix}-error-state.png` });
  } catch (e) {
    path.error = e.message.split('\n')[0];
    if (e.shot) path.errorShot = e.shot;
  }
  return path;
}

const report = { url, startedAt: new Date(t0).toISOString(), scenarios: [], manual: [] };

if (!a['no-scenarios']) {
  const only = a.only ? a.only.split(',').map((s) => s.trim().toUpperCase()) : null;
  const liveOk = liveAdvisorAllowed();
  const selected = SCENARIOS.filter((s) => !only || only.includes(s.id));
  const picked = selected.filter((s) => liveOk || !s.liveAdvisor);
  const liveSkipped = selected.filter((s) => !liveOk && s.liveAdvisor)
    .map((s) => ({ id: s.id, title: s.title, reason: 'reaches a real sales advisor; run with BC_LIVE_ADVISOR=1 only with the advisor team\'s agreement' }));
  const repeat = Math.max(1, Number(a.repeat) || 1);
  // AI routing is non-deterministic: --repeat N runs each scenario N times.
  const runs = picked.flatMap((s) => Array.from({ length: repeat }, (_, i) => (
    repeat > 1 ? { ...s, id: `${s.id}#${i + 1}`, baseId: s.id } : { ...s, baseId: s.id })));
  report.scenarios = await pool(runs, Number(a.parallel), runScenario);
  if (repeat > 1) {
    report.passRates = picked.map((s) => {
      const mine = report.scenarios.filter((r) => r.id.startsWith(`${s.id}#`));
      return { id: s.id, title: s.title, pass: mine.filter((r) => r.status === 'pass' || r.status === 'warn').length, runs: mine.length };
    });
  }
  report.manual = [...liveSkipped, ...MANUAL_ONLY.filter((m) => !only || only.includes(m.id))];
}

if (a.explore) {
  const cfg = a.persona ? personaConfig() : null;
  if (a.persona && !cfg) console.warn('⚠ --persona needs BC_AGENT_API_KEY (or AI_JUDGE_API_KEY); falling back to suggestion-following.');
  const seeds = a.seeds ? a.seeds.split('|').map((s) => s.trim()).filter(Boolean) : DEFAULT_SEEDS;
  const tried = new Set();
  const paths = await pool(seeds.map((s, i) => [s, i]), Number(a.parallel), ([s, i]) => explorePath(s, i, tried, cfg));
  // Failures under parallel load are often transient: retry each failed path
  // once, sequentially, with the same seed.
  for (let i = 0; i < paths.length; i += 1) {
    if (needsRetry(paths[i])) {
      console.log(`↻ retrying: ${paths[i].seed} (${paths[i].error || 'no turns'})`);
      paths[i] = mergeRetry(paths[i], await explorePath(paths[i].seed, i, tried, cfg, 2));
    }
  }
  const coverage = {};
  paths.forEach((p) => p.turns.forEach((t, ti) => (t.reply?.kinds || []).forEach((k) => {
    (coverage[k] ||= []).push({ path: `${p.seed} → ${p.turns.slice(1, ti + 1).map((x) => x.label).join(' → ')}`.replace(/ → $/, '') });
  })));
  report.explore = { paths, coverage };
}

await browser.close();
report.ms = Date.now() - t0;
report.apiCalls = apiCalls;
report.totals = report.scenarios.reduce((acc, s) => ({ ...acc, [s.status]: (acc[s.status] || 0) + 1 }), {});
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
writeFileSync(join(outDir, 'report.html'), renderReport(report));
console.log(`\nReport: ${join(outDir, 'report.html')}`);
if (report.explore) console.log(`Workflows reached: ${Object.keys(report.explore.coverage).sort().join(', ')}`);
process.exitCode = report.scenarios.some((s) => s.status === 'fail' || s.status === 'error') ? 1 : 0;
