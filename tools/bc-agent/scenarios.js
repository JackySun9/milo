// Brand Concierge test-plan scenarios (wiki "BC — Test Plan", manual section).
// AI replies are non-deterministic, so checks assert on *which widget/workflow*
// rendered rather than exact wording. Each check is pass | fail | warn.
import { prodLinksOnStage } from './lib/classify.js';

const isStage = (url) => /stage/.test(new URL(url).host);

async function linkStatus(page, href) {
  try {
    const res = await page.request.get(href, { maxRedirects: 5, timeout: 20000 });
    return res.status();
  } catch (e) {
    return `ERR ${e.message.slice(0, 60)}`;
  }
}

export const MANUAL_ONLY = [
  { id: 'M5b', title: 'Sign-in / SUSI Light — successful login', reason: 'needs a real Adobe login (logged-out modal checks are automated in M5)' },
  { id: 'M6', title: 'Navigation persistence (floating entry point)', reason: 'needs a page with bc-floating-button and cross-page navigation; covered partly by milo brand-concierge.test.js' },
  { id: 'M9', title: 'Mobile keyboard white area', reason: 'needs a real on-screen keyboard' },
  { id: 'M11', title: 'Modal height on orientation change', reason: 'needs a real device rotation' },
];

export const SCENARIOS = [
  {
    id: 'M1',
    title: 'Product recommendation flow',
    async run({ turn, check, page }) {
      const r = await turn('I want to touch up and enhance my photos');
      check('Reply mentions a photo product (Photoshop / Lightroom)', /photoshop|lightroom/i.test(r.text),
        `Recommended: ${r.links.map((l) => l.text).filter(Boolean).slice(0, 3).join(', ') || r.text.slice(0, 120)}`);
      check('Sources section present', r.kinds.includes('citations'), '', 'warn');
      check('Thumbs up / down visible', r.kinds.includes('feedback'));
      const cards = r.links.filter((l) => l.text && !/^\d+$/.test(l.text)).slice(0, 3);
      for (const l of cards) {
        const s = await linkStatus(page, l.href);
        check(`Product link works: ${l.text.slice(0, 40)}`, typeof s === 'number' && s < 400, `${s} ${l.href}`);
      }
    },
  },
  {
    id: 'M2',
    title: 'Firefly gallery widget',
    async run({ turn, check, url }) {
      const r = await turn('Show me Firefly community creations');
      check('Firefly gallery widget renders', r.kinds.includes('gallery'), `Got widgets: ${r.kinds.join(', ')}`);
      if (isStage(url)) {
        const bad = prodLinksOnStage(url, r.links);
        check('Stage links stay on stage (firefly-stage / *.stage)', !bad.length,
          bad.map((l) => l.href).slice(0, 3).join(' '), 'warn');
      }
    },
  },
  {
    id: 'M3',
    title: 'Advisor connection (sales handoff)',
    async run({ turn, check, chat }) {
      await turn('I want to talk to sales about Firefly Services');
      await turn('I want to know more about pricing');
      let s = await chat.chatState();
      if (!s.kinds.includes('advisor')) {
        const last = await chat.snapshotReply();
        const ask = last.suggestions.find((t) => /talk to (a )?sales|advisor|agent/i.test(t));
        if (ask) await turn({ click: ask });
        await chat.page.waitForTimeout(10000);
        s = await chat.chatState();
      }
      const advisor = s.kinds.includes('advisor');
      const r = await chat.snapshotReply();
      check('Chat transitions to advisor mode', advisor,
        advisor ? '' : `Stayed in AI mode; offered: ${[...r.buttons, ...r.suggestions].filter((b) => !/thumbs/i.test(b)).slice(0, 4).join(' | ')}`);
      if (!advisor) return;
      check('Input placeholder is "Type a response"', /type a response/i.test(s.placeholder), s.placeholder);
      check('"End connection" button visible', s.buttons.some((b) => /end connection/i.test(b)));
      await chat.click(/end connection/i, { expectReply: false });
      await chat.page.waitForTimeout(3000);
      const after = await chat.chatState();
      check('End connection returns to AI mode', !after.kinds.includes('advisor'), after.placeholder);
    },
  },
  {
    id: 'M4',
    title: 'Meeting booking & calendar',
    async run({ turn, check, chat, opts, shot }) {
      let r = await turn('I would like to book a meeting for a product demo');
      // Behave like a person: answer clarifying questions / click the meeting CTA.
      for (let i = 0; i < 3 && !r.kinds.includes('form'); i += 1) {
        if (r.kinds.includes('meeting-cta')) r = await turn({ click: /schedule (a )?meeting/i });
        else if (/\?\s*$/.test(r.text.trim())) r = await turn('Adobe Experience Manager Sites, for our marketing team');
        else r = await turn('Yes, please schedule a meeting');
      }
      check('Meeting form renders', r.kinds.includes('form'), `Got widgets: ${r.kinds.join(', ')}`);
      if (!r.kinds.includes('form')) return;
      check('Subtitle asks for details', /to connect you with the right person/i.test(r.text), r.text.slice(0, 120));
      const layout = await chat.page.evaluate(() => {
        const form = [...document.querySelectorAll('.bc-inline-form')].pop();
        const rows = [...form.querySelectorAll('.bc-inline-form__field-row')].map((row) => ({
          n: row.children.length,
          kinds: [...row.querySelectorAll('input, select')].map((i) => (i.tagName === 'SELECT' ? 'select' : i.type)),
        }));
        const submit = [...form.querySelectorAll('.bc-inline-form__buttons button')].map((b) => b.innerText.trim());
        return { rows, submit };
      });
      const textRows = layout.rows.filter((row) => row.kinds.every((k) => ['text', 'email', 'tel', 'number'].includes(k)));
      const singleRows = layout.rows.filter((row) => row.kinds.some((k) => ['select', 'checkbox'].includes(k)));
      check('Text/email/phone fields are 2 per row', textRows.length > 0 && textRows.slice(0, -1).every((row) => row.n === 2),
        JSON.stringify(textRows.map((row) => row.n)), 'warn');
      check('Dropdowns / checkboxes are 1 per row', singleRows.every((row) => row.n === 1),
        JSON.stringify(singleRows.map((row) => row.n)), 'warn');
      check('Submit label is "Schedule a meeting"', layout.submit.some((t) => /^schedule a meeting$/i.test(t)),
        layout.submit.join(' | '));
      if (!opts.submitForms) {
        check('Calendar step', true, 'Skipped: form not submitted (pass --submit-forms on stage to continue)', 'warn');
        return;
      }
      await chat.page.evaluate(() => {
        const form = [...document.querySelectorAll('.bc-inline-form')].pop();
        const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        form.querySelectorAll('input').forEach((i) => {
          if (i.type === 'checkbox') { if (!i.checked) i.click(); return; }
          const label = (i.closest('.bc-form-input')?.innerText || i.name || '').toLowerCase();
          if (/email/.test(label) || i.type === 'email') set(i, 'nala.bc.test@example.com');
          else if (/phone/.test(label) || i.type === 'tel') set(i, '4155550100');
          else if (/first/.test(label)) set(i, 'Nala');
          else if (/last/.test(label)) set(i, 'Test');
          else set(i, 'Nala QA');
        });
        form.querySelectorAll('select').forEach((s) => { if (s.options.length > 1) set(s, s.options[1].value); });
      });
      await shot('form-filled');
      r = await turn({ click: /^schedule a meeting$/i });
      check('Calendar widget appears after submit', r.kinds.includes('calendar'), `Got widgets: ${r.kinds.join(', ')}`);
      check('Calendar subtitle', /please select a meeting date and time/i.test(r.text), r.text.slice(0, 120), 'warn');
    },
  },
  {
    id: 'M5',
    title: 'Sign-in / SUSI Light (logged out)',
    async run({ turn, check, chat, url, shot }) {
      const susiHosts = new Set();
      chat.page.on('request', (req) => {
        const h = new URL(req.url()).host;
        if (/auth-light\.identity/.test(h)) susiHosts.add(h);
      });
      const r = await turn('Generate an image of a mountain lake at sunset');
      const genOk = r.kinds.includes('image-generation') || (r.kinds.includes('gallery') && r.kinds.includes('auth-cta'));
      check('Image generation reply (image, or gallery once free quota is used)', genOk, `Got widgets: ${r.kinds.join(', ')}`);
      check('Auth CTA ("Sign in") offered', r.kinds.includes('auth-cta'), r.buttons.join(' | '));
      if (!r.kinds.includes('auth-cta')) return;
      const before = await chat.replyCount();
      await chat.click(/^sign in/i, { expectReply: false });
      const title = chat.page.locator('.bc-susi-modal-title');
      const opened = await title.waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
      check('SUSI modal opens', opened);
      if (!opened) return;
      check('Modal title "Sign in or create an account"', /sign in or create an account/i.test(await title.innerText()));
      await chat.page.waitForTimeout(4000);
      await chat.page.screenshot({ path: shot.path('susi') });
      const inSusi = async (re) => {
        for (const f of chat.page.frames().filter((fr) => /auth-light/.test(fr.url()))) {
          if (await f.getByText(re).first().isVisible().catch(() => false)) return true;
        }
        return chat.page.getByText(re).first().isVisible().catch(() => false);
      };
      const found = [];
      for (const p of ['Google', 'Microsoft', 'Facebook', 'Apple', 'email']) {
        if (await inSusi(new RegExp(`continue with ${p}`, 'i'))) found.push(p);
      }
      check('Sign-in options match plan (Google / Facebook / Apple / Email)',
        ['Google', 'Facebook', 'Apple', 'email'].every((p) => found.includes(p)), `Found: ${found.join(', ') || 'none'}`, 'warn');
      if (isStage(url)) {
        const hosts = [...susiHosts];
        check('SUSI loads from identity-stage', hosts.includes('auth-light.identity-stage.adobe.com'), hosts.join(', '));
        check('No prod identity host on stage', !hosts.includes('auth-light.identity.adobe.com'), hosts.join(', '), 'warn');
      }
      // Use the modal's close button: Escape also closes the whole chat.
      await chat.page.locator('.bc-susi-modal .dialog-close').first().click();
      await chat.page.waitForTimeout(1500);
      check('Cancel closes the SUSI modal', !(await title.isVisible().catch(() => false)));
      check('Chat still open with history after cancel',
        (await chat.modalOpen()) && (await chat.replyCount()) >= before);
    },
  },
  {
    id: 'M7',
    title: 'Comparison tables',
    async run({ turn, check, chat }) {
      const r = await turn('Compare Photoshop vs Lightroom');
      check('Comparison table renders', r.kinds.includes('table'), `Got widgets: ${r.kinds.join(', ')}`);
      check('Reply covers both products', /photoshop/i.test(r.text) && /lightroom/i.test(r.text), r.text.slice(0, 120));
      if (r.kinds.includes('table')) {
        const overflow = await chat.page.evaluate(() => {
          const t = [...document.querySelectorAll('.concierge-message table')].pop();
          const box = t.closest('.message-content') || t.parentElement;
          return { table: t.scrollWidth, box: box.clientWidth, scroll: getComputedStyle(t.parentElement).overflowX };
        });
        check('Table fits or scrolls', overflow.table <= overflow.box || /auto|scroll/.test(overflow.scroll), JSON.stringify(overflow), 'warn');
      }
    },
  },
  {
    id: 'M8',
    title: 'Citations / sources',
    async run({ turn, check, chat, page }) {
      const r = await turn('What is Adobe Experience Manager Sites?');
      check('Sources section present', r.kinds.includes('citations'), `Got widgets: ${r.kinds.join(', ')}`);
      check('Inline citation numbers', r.classes.includes('citation-number'), '', 'warn');
      if (!r.kinds.includes('citations')) return;
      await chat.click(/^sources$/i, { expectReply: false });
      const links = await chat.page.evaluate(() => {
        const m = [...document.querySelectorAll('.concierge-message')].pop();
        return [...m.querySelectorAll('.citations-link')].map((a) => ({ href: a.href, target: a.target }));
      });
      check('Sources list has links', links.length > 0, `${links.length} link(s)`);
      check('Citation links open in a new tab', links.every((l) => l.target === '_blank'), links.map((l) => l.target || '(none)').join(','), 'warn');
      for (const l of links.slice(0, 5)) {
        const s = await linkStatus(page, l.href);
        check(`Citation link works: ${new URL(l.href).pathname.slice(0, 50)}`, typeof s === 'number' && s < 400, `${s} ${l.href}`);
      }
    },
  },
  {
    id: 'M10',
    title: 'Chat input max-width 800px',
    viewport: { width: 1920, height: 1080 },
    async run({ turn, check, chat }) {
      await turn('Hi');
      const m = await chat.page.evaluate(() => {
        const ic = document.querySelector('.input-container');
        const modal = document.querySelector('.dialog-modal');
        if (!ic) return null;
        const a = ic.getBoundingClientRect();
        const b = modal ? modal.getBoundingClientRect() : { left: 0, right: window.innerWidth };
        return { width: Math.round(a.width), leftGap: Math.round(a.left - b.left), rightGap: Math.round(b.right - a.right) };
      });
      check('.input-container found', !!m);
      if (!m) return;
      check('Input width ≤ 800px', m.width <= 800, `${m.width}px`);
      check('Input centered in modal', Math.abs(m.leftGap - m.rightGap) <= 4, JSON.stringify(m), 'warn');
    },
  },
  {
    id: 'M12',
    title: 'Error / loading states',
    async run({ turn, check, chat }) {
      await chat.page.route('**/brand-concierge/conversations**', (route) => route.abort('failed'));
      const r = await turn('What is Adobe Target?');
      check('Friendly error on failed request', r.kinds.includes('error'), r.text.slice(0, 160));
      await chat.page.unroute('**/brand-concierge/conversations**');
      const again = await turn('What is Adobe Target?');
      check('Retry works without reload', !again.kinds.includes('error') && again.text.length > 40, again.text.slice(0, 120));
    },
  },
  {
    id: 'M13',
    title: 'Feedback submission',
    async run({ turn, check, chat, shot }) {
      await turn('What is Adobe Analytics?');
      const dialogText = () => chat.page.evaluate(() => {
        const d = [...document.querySelectorAll('.bc-dialog')].filter((e) => e.offsetParent).pop();
        return d ? d.innerText : '';
      });
      await chat.page.locator('.feedback-button--thumbsUp').last().click();
      await chat.page.waitForTimeout(1000);
      let t = await dialogText();
      await shot('feedback-up');
      check('Positive dialog title', /your feedback is appreciated/i.test(t), t.slice(0, 80));
      check('Positive dialog asks "What went well?"', /what went well/i.test(t));
      check('Options include "Other" and Notes', /other/i.test(t) && /notes/i.test(t));
      await chat.page.locator('.bc-dialog button').filter({ hasText: /^cancel$/i }).last().click();
      await chat.page.waitForTimeout(800);
      check('Cancel closes the dialog', !(await dialogText()));
      await chat.page.locator('.feedback-button--thumbsDown').last().click();
      await chat.page.waitForTimeout(1000);
      t = await dialogText();
      check('Negative dialog asks "What went wrong?"', /what went wrong/i.test(t), t.slice(0, 120));
      await chat.page.locator('.bc-dialog').filter({ visible: true }).getByText(/^other$/i).last().click().catch(() => {});
      await chat.page.locator('.bc-dialog button').filter({ hasText: /^submit$/i }).last().click();
      const toast = await chat.page.getByText(/thank you for the feedback/i).first()
        .waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
      await shot('feedback-toast');
      check('Toast "Thank you for the feedback." after submit', toast);
    },
  },
];
