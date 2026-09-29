#!/usr/bin/env node
/* global process */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { summarizeBusinessStage, renderWorkflowSummary, errorSummary } from './lib/workflow-summary.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const { values: options } = parseArgs({
  options: {
    url: { type: 'string' },
    out: { type: 'string' },
  },
});
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(options.out || process.env.BC_WORKFLOW_OUT
  || join(here, 'reports', `business-stage-workflow-${stamp}`));
const url = options.url || process.env.BC_WORKFLOW_URL
  || 'https://business.stage.adobe.com/?milolibs=stage';
let target;
try {
  target = new URL(url);
} catch {
  console.error(`Invalid URL: ${url}`);
  process.exit(2);
}
if (!/^https?:$/.test(target.protocol)) {
  console.error(`URL must use http or https: ${url}`);
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const startedAt = new Date().toISOString();

function writeSummary(result, report) {
  const summary = {
    ...result,
    runId: process.env.BC_RUN_ID || null,
    runUrl: process.env.BC_RUN_URL || null,
    finishedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, 'workflow-summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, 'workflow-summary.md'), renderWorkflowSummary(summary, report));
}

const args = [
  join(here, 'run.mjs'),
  '--url', target.href,
  '--explore',
  '--no-scenarios',
  '--depth', '4',
  '--parallel', '2',
  '--timeout', '120',
  '--out', outDir,
];

const exitCode = await new Promise((done) => {
  const child = spawn(process.execPath, args, { cwd: here, env: process.env, stdio: 'inherit' });
  child.on('error', (error) => {
    console.error(error);
    done(2);
  });
  child.on('close', (code) => done(code ?? 2));
});

const reportFile = join(outDir, 'report.json');
let report;
try {
  report = JSON.parse(readFileSync(reportFile, 'utf8'));
} catch {
  console.error(`Workflow did not produce ${reportFile}`);
  writeSummary(errorSummary({ url: target.href, startedAt, error: `agent exited with code ${exitCode}` }), {});
  process.exit(exitCode || 2);
}

const summary = summarizeBusinessStage(report);
writeSummary(summary, report);

console.log(`\nWorkflow result: ${summary.status.toUpperCase()} (${summary.passed}/${summary.total})`);
console.log(summary.conclusion);
console.log(`Share: ${join(outDir, 'workflow-summary.md')}`);
console.log(`Details: ${join(outDir, 'report.html')}`);
process.exitCode = exitCode || (summary.status === 'pass' ? 0 : 1);
