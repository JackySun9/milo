const reached = (coverage, ...kinds) => kinds.some((kind) => coverage[kind]?.length);

// Each standard check names the reply kinds that prove it (in order of
// preference) and the seed prompt most likely to reach it, used as a
// fallback screenshot when the check was not observed.
const CHECKS = [
  {
    id: 'recommendation',
    name: 'Product recommendation',
    pass: (c) => reached(c, 'product-card', 'cta-links'),
    evidence: [['product-card'], ['cta-links']],
    seed: /touch up|photos/i,
    expected: 'Firefly recommendations and product links are valid current behavior.',
  },
  {
    id: 'citations',
    name: 'Sources and citations',
    pass: (c) => reached(c, 'citations'),
    evidence: [['citations']],
    seed: /cost|brand visibility/i,
    expected: 'Factual replies can render cited sources.',
  },
  {
    id: 'comparison',
    name: 'Product comparison',
    pass: (c) => reached(c, 'table'),
    evidence: [['table']],
    seed: /compare/i,
    expected: 'Photoshop vs Lightroom renders a comparison table.',
  },
  {
    id: 'sales',
    name: 'Sales and meeting flow',
    pass: (c) => reached(c, 'meeting-cta') && reached(c, 'form'),
    evidence: [['form'], ['meeting-cta']],
    seed: /sales/i,
    expected: 'Sales intent may go directly to Schedule meeting and the contact form; live advisor mode is not required.',
  },
  {
    id: 'generation',
    name: 'Image generation / quota gate',
    pass: (c) => reached(c, 'image-generation') || (reached(c, 'gallery') && reached(c, 'auth-cta')),
    evidence: [['image-generation'], ['gallery', 'auth-cta'], ['gallery']],
    seed: /generate an image/i,
    expected: 'Generation may render an image, or show Firefly Gallery + Sign in after the two free generations are used.',
  },
  {
    id: 'feedback',
    name: 'Response feedback',
    pass: (c) => reached(c, 'feedback'),
    evidence: [['feedback']],
    seed: /./,
    expected: 'Assistant replies expose feedback controls.',
  },
];

function allTurns(report) {
  return (report.explore?.paths || []).flatMap((path) => (path.turns || [])
    .map((turn) => ({ ...turn, seed: path.seed })));
}

// Pick one representative screenshot for a check: the first turn whose reply
// shows the preferred widget set; otherwise the last captured turn of the
// seed path most likely to reach it, or that path's error-state screenshot.
export function selectEvidence(report, check) {
  const turns = allTurns(report).filter((turn) => turn.shot);
  for (const kinds of check.evidence) {
    const hit = turns.find((turn) => kinds.every((k) => turn.reply?.kinds?.includes(k)));
    if (hit) return { screenshot: hit.shot, evidence: 'observed', turn: hit.label, seed: hit.seed };
  }
  const fromSeed = turns.filter((turn) => check.seed.test(turn.seed || ''));
  const fallback = fromSeed[fromSeed.length - 1];
  if (fallback) return { screenshot: fallback.shot, evidence: 'fallback', turn: fallback.label, seed: fallback.seed };
  // The seed path never produced a turn: show the page state it failed in.
  const failed = (report.explore?.paths || []).find((path) => path.errorShot && check.seed.test(path.seed || ''));
  if (failed) return { screenshot: failed.errorShot, evidence: 'error-state', turn: null, seed: failed.seed };
  return { screenshot: null, evidence: 'none', turn: null, seed: null };
}

export function summarizeBusinessStage(report) {
  const coverage = report.explore?.coverage || {};
  const checks = CHECKS.map((def) => {
    const pass = def.pass(coverage);
    return {
      id: def.id,
      name: def.name,
      pass,
      status: pass ? 'pass' : 'review',
      expected: def.expected,
      ...selectEvidence(report, def),
    };
  });
  const pathErrors = (report.explore?.paths || [])
    .filter((path) => path.error)
    .map((path) => ({ seed: path.seed, error: path.error }));
  const passed = checks.filter((check) => check.pass).length;
  return {
    status: passed === checks.length ? 'pass' : 'review',
    conclusion: passed === checks.length
      ? 'Brand Concierge core chat and business workflows are operating normally; no clear defect was found.'
      : 'One or more expected workflows were not observed; review the transcript before treating this as a product defect.',
    url: report.url,
    startedAt: report.startedAt,
    passed,
    total: checks.length,
    checks,
    pathErrors,
  };
}

// Used when the run crashed before report.json was written, so consumers
// still get a status document instead of a missing file.
export function errorSummary({ url, startedAt, error }) {
  return {
    status: 'error',
    conclusion: `The workflow did not produce a report: ${error}`,
    url,
    startedAt,
    passed: 0,
    total: CHECKS.length,
    checks: CHECKS.map((def) => ({
      id: def.id,
      name: def.name,
      pass: false,
      status: 'error',
      expected: def.expected,
      screenshot: null,
      evidence: 'none',
      turn: null,
      seed: null,
    })),
    pathErrors: [],
  };
}

export function renderWorkflowSummary(summary, report = {}) {
  const mark = (check) => check.status.toUpperCase();
  const shot = (check) => (check.screenshot ? ` ([screenshot](${check.screenshot}))` : '');
  return `# Brand Concierge — business stage workflow

**URL:** ${summary.url || report.url}
**Started:** ${summary.startedAt || report.startedAt}
**Result:** ${summary.status.toUpperCase()} (${summary.passed}/${summary.total})

## Conclusion

${summary.conclusion}

## Checks

${summary.checks.map((check) => `- **${mark(check)} — ${check.name}:** ${check.expected}${shot(check)}`).join('\n')}

${summary.pathErrors.length ? `## Transient path errors

${summary.pathErrors.map((item) => `- \`${item.seed}\`: ${item.error}`).join('\n')}

Path errors are reported separately and should be retried before filing a product bug.
` : ''}`;
}
