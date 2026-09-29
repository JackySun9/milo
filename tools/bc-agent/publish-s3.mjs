#!/usr/bin/env node
// Publish a bc-agent run directory to S3 (see lib/publish.js for the key contract).
//
//   node publish-s3.mjs --dir reports/run --run-id 12345 [--url <tested url>] [--run-url <gh run url>]
//
// Credentials: S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (same as screenshot-diff).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { makeS3Client, publishRun, s3Config } from './lib/publish.js';
import { errorSummary, renderWorkflowSummary } from './lib/workflow-summary.js';

const { values: a } = parseArgs({
  options: {
    dir: { type: 'string' },
    'run-id': { type: 'string' },
    url: { type: 'string' },
    'run-url': { type: 'string' },
  },
});

try {
  if (!a.dir || !a['run-id']) throw new Error('Usage: node publish-s3.mjs --dir <dir> --run-id <id>');
  const dir = resolve(a.dir);
  mkdirSync(dir, { recursive: true });
  // The agent may have crashed before summarising; publish an error status
  // so nala-auto does not show a stale or missing run.
  if (!existsSync(join(dir, 'workflow-summary.json'))) {
    const summary = errorSummary({ url: a.url || null, startedAt: null, error: 'no workflow summary was written' });
    writeFileSync(join(dir, 'workflow-summary.json'), JSON.stringify(summary, null, 2));
    writeFileSync(join(dir, 'workflow-summary.md'), renderWorkflowSummary(summary));
  }
  const cfg = s3Config();
  const store = await makeS3Client(cfg);
  const { entry } = await publishRun({ dir, runId: a['run-id'], store, runUrl: a['run-url'] });
  console.log(`Published ${entry.status.toUpperCase()} run ${entry.runId}`);
  console.log(`Summary: ${cfg.publicReadUrl}/${entry.summary}`);
  console.log(`Report:  ${cfg.publicReadUrl}/${entry.report}`);
} catch (e) {
  console.error(`Publish failed: ${e.message}`);
  process.exitCode = 1;
}
