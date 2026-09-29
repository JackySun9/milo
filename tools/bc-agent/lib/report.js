// Writes a self-contained report.html next to report.json and screenshots.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const badge = (s) => `<span class="b ${s}">${s.toUpperCase()}</span>`;

function transcriptHtml(turns) {
  return turns.map((t) => `
    <div class="turn">
      <div class="user">🧑 ${esc(t.label)}</div>
      ${t.error ? `<div class="err">${esc(t.error)}</div>` : ''}
      ${t.reply ? `<div class="bot">🤖 ${esc(t.reply.text.slice(0, 700))}</div>
      <div class="kinds">${t.reply.kinds.map((k) => `<code>${esc(k)}</code>`).join(' ')} · ${t.ms ? `${(t.ms / 1000).toFixed(1)}s` : ''}</div>` : ''}
      ${t.shot ? `<a href="${esc(t.shot)}" target="_blank"><img src="${esc(t.shot)}" loading="lazy"></a>` : ''}
    </div>`).join('');
}

export function renderReport(r) {
  const scen = (r.scenarios || []).map((s) => `
    <details ${s.status !== 'pass' ? 'open' : ''}>
      <summary>${badge(s.status)} <b>${esc(s.id)}</b> ${esc(s.title)} <small>${(s.ms / 1000).toFixed(0)}s</small></summary>
      <table>${s.checks.map((c) => `<tr><td>${badge(c.status)}</td><td>${esc(c.name)}</td><td class="d">${esc(c.detail)}</td></tr>`).join('')}</table>
      ${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}
      ${transcriptHtml(s.turns)}
      ${(s.extraShots || []).map((p) => `<a href="${esc(p)}" target="_blank"><img src="${esc(p)}" loading="lazy"></a>`).join('')}
    </details>`).join('');

  const manual = (r.manual || []).map((m) => `<li><b>${esc(m.id)}</b> ${esc(m.title)} — <i>${esc(m.reason)}</i></li>`).join('');

  const exp = r.explore ? `
    <h2>Explorer — workflows reached</h2>
    <table>${Object.entries(r.explore.coverage).sort().map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${v.length}×</td><td class="d">${esc(v[0].path)}</td></tr>`).join('')}</table>
    ${r.explore.paths.map((p) => `<details><summary><b>${esc(p.seed)}</b> <small>${p.turns.length} turn(s)${p.persona ? ' · persona' : ''}</small></summary>${transcriptHtml(p.turns)}</details>`).join('')}` : '';

  const t = r.totals || {};
  const rates = r.passRates ? `<h2>Pass rate (--repeat)</h2><table>${r.passRates.map((p) => `<tr><td><b>${esc(p.id)}</b></td><td>${esc(p.title)}</td><td>${p.pass}/${p.runs}</td></tr>`).join('')}</table>` : '';
  return `<!doctype html><meta charset="utf-8"><title>BC agent — ${esc(r.url)}</title>
<style>
body{font:14px system-ui;margin:24px;max-width:1200px;color:#222}
.b{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;color:#fff}
.pass{background:#2d9d78}.fail{background:#d7373f}.warn{background:#e68619}.error{background:#6e2cc4}
details{border:1px solid #ddd;border-radius:8px;margin:8px 0;padding:8px 12px}summary{cursor:pointer}
table{border-collapse:collapse;margin:8px 0}td{padding:3px 8px;border-bottom:1px solid #eee;vertical-align:top}
.d{color:#555;font-size:12px;word-break:break-all}
.turn{border-left:3px solid #eee;padding:4px 10px;margin:10px 0}.user{font-weight:600}
.bot{white-space:pre-wrap;color:#333;margin:4px 0}.kinds code{background:#eef;padding:0 4px;border-radius:3px}
.err{color:#d7373f;white-space:pre-wrap}img{max-width:420px;border:1px solid #ddd;border-radius:6px;margin:6px 6px 0 0}
</style>
<h1>Brand Concierge agent run</h1>
<p><b>${esc(r.url)}</b> · ${esc(r.startedAt)} · ${(r.ms / 1000).toFixed(0)}s · conversation API calls: ${r.apiCalls}</p>
<p>${badge('pass')} ${t.pass || 0} ${badge('warn')} ${t.warn || 0} ${badge('fail')} ${t.fail || 0} ${badge('error')} ${t.error || 0}</p>
${rates}
${scen ? `<h2>Test-plan scenarios</h2>${scen}` : ''}
${manual ? `<h3>Manual only</h3><ul>${manual}</ul>` : ''}
${exp}`;
}
