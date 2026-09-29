// Maps a DOM snapshot of one Brand Concierge reply to the backend "workflow"
// it most likely came from. Kept pure (no Playwright) so it is unit-testable.
//
// A snapshot is { text, classes: string[], tags: string[], links: [{text, href}],
// buttons: string[], suggestions: string[] } as produced by chat.js#snapshotReply.

export const ERROR_PATTERNS = [
  /having trouble connecting/i,
  /something went wrong/i,
];

const has = (classes, re) => classes.some((c) => re.test(c));

export function classifyReply(snap) {
  const classes = snap.classes || [];
  const tags = snap.tags || [];
  const text = snap.text || '';
  const kinds = new Set();

  if (ERROR_PATTERNS.some((re) => re.test(text))) kinds.add('error');
  if (has(classes, /^bc-inline-form/)) kinds.add('form');
  if (has(classes, /calendar/i)) kinds.add('calendar');
  if (has(classes, /gallery/i) || /more in firefly gallery/i.test(text)) kinds.add('gallery');
  if (tags.includes('TABLE') || has(classes, /comparison|compare-table/i)) kinds.add('table');
  if (has(classes, /^bc-hero-media-card/)) kinds.add('image-generation');
  if (has(classes, /^bc-multimodal-image/)) kinds.add('product-card');
  if (has(classes, /^citations-accordion$/)) kinds.add('citations');
  if (has(classes, /^bc-link-button/)) kinds.add('cta-links');
  if ((snap.buttons || []).some((b) => /schedule (a )?meeting/i.test(b))) kinds.add('meeting-cta');
  if ((snap.buttons || []).some((b) => /^sign in/i.test(b))) kinds.add('auth-cta');
  if ((snap.suggestions || []).length) kinds.add('suggestions');
  if (has(classes, /^feedback-button/)) kinds.add('feedback');
  if (!kinds.size || [...kinds].every((k) => k === 'feedback' || k === 'suggestions')) kinds.add('text');
  return [...kinds].sort();
}

// Chat-level state that is not part of a single reply (advisor handoff).
export function classifyChat(chat) {
  const kinds = new Set();
  if (/type a response/i.test(chat.placeholder || '')) kinds.add('advisor');
  if ((chat.buttons || []).some((b) => /end connection/i.test(b))) kinds.add('advisor');
  if (/you are now connected to/i.test(chat.text || '')) kinds.add('advisor');
  return [...kinds];
}

// Links a stage run should keep on stage; returns the offenders.
export function prodLinksOnStage(pageUrl, links) {
  let host;
  try { host = new URL(pageUrl).host; } catch { return []; }
  if (!/stage/.test(host)) return [];
  return (links || []).filter((l) => {
    try {
      const h = new URL(l.href).host;
      return /(^|\.)adobe\.com$/.test(h) && !/stage|corp\.adobe\.com/.test(h)
        && /^(www\.|business\.|firefly\.)/.test(h);
    } catch { return false; }
  });
}
