// HTML report (published to internal S3 only) and Markdown summary (printed in
// public CI logs, so it must never contain prompt or reply text).
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const badge = (s) => `<span class="b ${esc(s)}">${esc(String(s).toUpperCase())}</span>`;

function turnsHtml(turns = []) {
  return turns.map((t) => `
    <div class="turn">
      <div class="user">🧑 ${esc(t.label)}</div>
      ${t.error ? `<div class="err">${esc(t.error)}</div>` : ''}
      ${t.reply ? `<div class="bot">🤖 ${esc((t.reply.text || '').slice(0, 700))}</div>
      <div class="kinds">${(t.reply.kinds || []).map((k) => `<code>${esc(k)}</code>`).join(' ')}${t.ms ? ` · ${(t.ms / 1000).toFixed(1)}s` : ''}</div>` : ''}
      ${(t.chat?.kinds || []).includes('advisor') ? '<div class="kinds"><code>advisor</code> live advisor mode</div>' : ''}
      ${t.shot ? `<a href="${esc(t.shot)}" target="_blank"><img src="${esc(t.shot)}" loading="lazy" alt=""></a>` : ''}
    </div>`).join('');
}

export function renderMonitorReport(report, summary) {
  const items = new Map((report.monitor?.items || []).map((i) => [i.checkId, i]));
  const groups = [...new Set(summary.checks.map((c) => c.group))];
  const body = groups.map((g) => `<h2>${esc(g)}</h2>${summary.checks.filter((c) => c.group === g).map((c) => {
    const attempts = items.get(c.id)?.attempts || [];
    return `<details ${c.status !== 'pass' && c.status !== 'skip' ? 'open' : ''}>
      <summary>${badge(c.status)} <b>${esc(c.name)}</b>${c.flaky ? ' <span class="b flaky">FLAKY</span>' : ''} <small>${esc(c.observed)}</small></summary>
      <p class="d">${esc(c.expected)}</p>
      ${attempts.map((a, n) => `<div class="attempt"><b>Attempt ${n + 1}</b> <small>${esc(a.entry?.id || '')} ${esc(a.entry?.source || '')}</small>
        ${a.navigatedTo ? `<div class="d">Opened: ${esc(a.navigatedTo)}${a.entry?.expectUrl ? ` (expected ${esc(a.entry.expectUrl)})` : ''}</div>` : ''}
        ${a.error ? `<div class="err">${esc(a.error)}</div>` : ''}
        ${turnsHtml(a.turns)}
        ${a.errorShot ? `<a href="${esc(a.errorShot)}" target="_blank"><img src="${esc(a.errorShot)}" loading="lazy" alt="Page state when the attempt failed"></a>` : ''}
      </div>`).join('')}
      ${!attempts.length && c.screenshot ? `<a href="${esc(c.screenshot)}" target="_blank"><img src="${esc(c.screenshot)}" loading="lazy" alt=""></a>` : ''}
    </details>`;
  }).join('')}`).join('');
  return `<!doctype html><meta charset="utf-8"><title>BC monitor — ${esc(summary.url)}</title>
<style>
body{font:14px system-ui;margin:24px;max-width:1200px;color:#222}
.b{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;color:#fff}
.pass{background:#2d9d78}.review{background:#e68619}.error{background:#6e2cc4}.skip{background:#8a8a8a}.flaky{background:#b58a00}
details{border:1px solid #ddd;border-radius:8px;margin:8px 0;padding:8px 12px}summary{cursor:pointer}
.d{color:#555;font-size:12px;word-break:break-all}.attempt{border-top:1px dashed #ddd;margin-top:8px;padding-top:8px}
.turn{border-left:3px solid #eee;padding:4px 10px;margin:10px 0}.user{font-weight:600}
.bot{white-space:pre-wrap;color:#333;margin:4px 0}.kinds code{background:#eef;padding:0 4px;border-radius:3px}
.err{color:#d7373f;white-space:pre-wrap}img{max-width:420px;border:1px solid #ddd;border-radius:6px;margin:6px 6px 0 0}
</style>
<h1>Brand Concierge monitor</h1>
<p><b>${esc(summary.url)}</b> · ${esc(summary.startedAt)} · pool: ${esc(summary.poolSource)}</p>
<p>${badge(summary.status)} ${summary.passed}/${summary.total} passed${summary.skipped ? ` · ${summary.skipped} skipped` : ''}</p>
<p>${esc(summary.conclusion)}</p>
${body}`;
}

export function renderMonitorSummary(summary) {
  const groups = [...new Set(summary.checks.map((c) => c.group))];
  return `# Brand Concierge — monitor

**URL:** ${summary.url}
**Started:** ${summary.startedAt}
**Result:** ${summary.status.toUpperCase()} (${summary.passed}/${summary.total}${summary.skipped ? `, ${summary.skipped} skipped` : ''})
**Prompt pool:** ${summary.poolSource || 'unknown'}

${summary.conclusion}

${groups.map((g) => `## ${g}

${summary.checks.filter((c) => c.group === g).map((c) => `- **${c.status.toUpperCase()} — ${c.name}**${c.flaky ? ' (flaky)' : ''}: ${c.expected}`).join('\n')}
`).join('\n')}
Prompts, replies and screenshots are in the internal report only.
`;
}
