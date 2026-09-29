const reached = (coverage, ...kinds) => kinds.some((kind) => coverage[kind]?.length);

export function summarizeBusinessStage(report) {
  const coverage = report.explore?.coverage || {};
  const checks = [
    {
      id: 'recommendation',
      name: 'Product recommendation',
      pass: reached(coverage, 'product-card', 'cta-links'),
      expected: 'Firefly recommendations and product links are valid current behavior.',
    },
    {
      id: 'citations',
      name: 'Sources and citations',
      pass: reached(coverage, 'citations'),
      expected: 'Factual replies can render cited sources.',
    },
    {
      id: 'comparison',
      name: 'Product comparison',
      pass: reached(coverage, 'table'),
      expected: 'Photoshop vs Lightroom renders a comparison table.',
    },
    {
      id: 'sales',
      name: 'Sales and meeting flow',
      pass: reached(coverage, 'meeting-cta') && reached(coverage, 'form'),
      expected: 'Sales intent may go directly to Schedule meeting and the contact form; live advisor mode is not required.',
    },
    {
      id: 'generation',
      name: 'Image generation / quota gate',
      pass: reached(coverage, 'image-generation')
        || (reached(coverage, 'gallery') && reached(coverage, 'auth-cta')),
      expected: 'Generation may render an image, or show Firefly Gallery + Sign in after the two free generations are used.',
    },
    {
      id: 'feedback',
      name: 'Response feedback',
      pass: reached(coverage, 'feedback'),
      expected: 'Assistant replies expose feedback controls.',
    },
  ];
  const pathErrors = (report.explore?.paths || [])
    .filter((path) => path.error)
    .map((path) => ({ seed: path.seed, error: path.error }));
  const passed = checks.filter((check) => check.pass).length;
  return {
    status: passed === checks.length ? 'pass' : 'review',
    conclusion: passed === checks.length
      ? 'Brand Concierge core chat and business workflows are operating normally; no clear defect was found.'
      : 'One or more expected workflows were not observed; review the transcript before treating this as a product defect.',
    passed,
    total: checks.length,
    checks,
    pathErrors,
  };
}

export function renderWorkflowSummary(summary, report) {
  const mark = (pass) => (pass ? 'PASS' : 'REVIEW');
  return `# Brand Concierge — business stage workflow

**URL:** ${report.url}
**Started:** ${report.startedAt}
**Result:** ${summary.status.toUpperCase()} (${summary.passed}/${summary.total})

## Conclusion

${summary.conclusion}

## Checks

${summary.checks.map((check) => `- **${mark(check.pass)} — ${check.name}:** ${check.expected}`).join('\n')}

${summary.pathErrors.length ? `## Transient path errors

${summary.pathErrors.map((item) => `- \`${item.seed}\`: ${item.error}`).join('\n')}

Path errors are reported separately and should be retried before filing a product bug.
` : ''}`;
}
