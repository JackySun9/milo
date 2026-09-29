// Thin Playwright driver for the Brand Concierge chat UI.
import { classifyReply, classifyChat } from './classify.js';

const REPLY = '.concierge-message';
const ENTRY_INPUTS = '.bc-input-field textarea, .bc-floating-input textarea, textarea[id^="bc-input-field"]';
const FLOATING_BUTTONS = '.bc-floating-button button, .bc-floating-button, .bc-gnav-button button, .bc-gnav-button';

export class BcChat {
  constructor(page, { replyTimeout = 90000, log = () => {} } = {}) {
    this.page = page;
    this.replyTimeout = replyTimeout;
    this.log = log;
    this.calls = [];
    page.on('response', (res) => {
      const u = res.url();
      if (/\/brand-concierge\/conversations/.test(u)) {
        this.calls.push({ status: res.status(), url: u.split('?')[0], at: Date.now() });
      }
    });
  }

  async open(url) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector(`${ENTRY_INPUTS}, ${FLOATING_BUTTONS}, .chat-input`, { timeout: 30000 });
    await this.page.waitForTimeout(1500);
  }

  replyCount() {
    return this.page.locator(REPLY).count();
  }

  async modalOpen() {
    return this.page.locator('.chat-input').first().isVisible().catch(() => false);
  }

  async ask(text) {
    const before = await this.replyCount();
    if (await this.modalOpen()) {
      await this.page.locator('.chat-input').first().fill(text);
      await this.page.locator('.submit-button').first().click();
    } else {
      const entry = this.page.locator(ENTRY_INPUTS).filter({ visible: true }).first();
      if (await entry.count()) {
        await entry.fill(text);
        await entry.press('Enter');
      } else {
        await this.page.locator(FLOATING_BUTTONS).filter({ visible: true }).first().click();
        await this.page.locator('.chat-input').first().waitFor({ timeout: 15000 });
        await this.page.locator('.chat-input').first().fill(text);
        await this.page.locator('.submit-button').first().click();
      }
    }
    return this.waitForReply(before);
  }

  // Click a button (by visible text / aria-label regex) in the latest reply or
  // its suggestion chips, then wait for the reply it triggers (if any).
  async click(name, { expectReply = true } = {}) {
    const re = name instanceof RegExp ? name : new RegExp(name, 'i');
    const before = await this.replyCount();
    const scopes = ['.prompt-suggestions-container', `${REPLY}:last-of-type`, '.chat-interface', '.dialog-modal', 'body'];
    for (const scope of scopes) {
      const btn = this.page.locator(`${scope} button, ${scope} a`).filter({ hasText: re }).filter({ visible: true }).last();
      if (await btn.count()) {
        await btn.click();
        return expectReply ? this.waitForReply(before) : { ms: 0 };
      }
    }
    throw new Error(`No visible button matching ${re}`);
  }

  async waitForReply(before) {
    const t0 = Date.now();
    await this.page.waitForFunction(
      ([sel, n]) => document.querySelectorAll(sel).length > n,
      [REPLY, before],
      { timeout: this.replyTimeout },
    );
    // Replies stream in; wait until the last one stops changing and is finalised.
    let last = '';
    let stableSince = Date.now();
    while (Date.now() - t0 < this.replyTimeout) {
      const { text, done } = await this.page.evaluate((sel) => {
        const m = [...document.querySelectorAll(sel)].pop();
        return {
          text: m ? m.innerText : '',
          done: !!(m && m.querySelector('.bc-response-footer, .bc-inline-form, [class*=calendar]')),
        };
      }, REPLY);
      if (text !== last) { last = text; stableSince = Date.now(); }
      if (done && Date.now() - stableSince > 2500) break;
      // Image generation can leave this placeholder unchanged for well over
      // 12 seconds while the backend job is still running.
      if (!done && Date.now() - stableSince > 12000 && !/generating response/i.test(text)) break;
      await this.page.waitForTimeout(500);
    }
    // Suggestion chips render a few seconds after the reply itself.
    await this.page.waitForFunction((sel) => {
      const m = [...document.querySelectorAll(sel)].pop();
      for (let s = m && m.nextElementSibling; s; s = s.nextElementSibling) {
        if (s.classList.contains('prompt-suggestions-container')) return true;
      }
      return !!(m && m.querySelector('.bc-inline-form'));
    }, REPLY, { timeout: 5000 }).catch(() => {});
    await this.page.waitForTimeout(800);
    return { ms: Date.now() - t0 };
  }

  async snapshotReply() {
    const snap = await this.page.evaluate((sel) => {
      const m = [...document.querySelectorAll(sel)].pop();
      if (!m) return null;
      const classes = new Set();
      const tags = new Set();
      m.querySelectorAll('*').forEach((e) => {
        tags.add(e.tagName);
        if (typeof e.className === 'string') e.className.split(/\s+/).forEach((c) => c && classes.add(c));
      });
      const visible = (e) => !!(e.offsetParent || e.getClientRects().length);
      const sugg = [...document.querySelectorAll('.prompt-suggestions-container')].pop();
      // Action widgets (e.g. "Schedule meeting") render as siblings after the message.
      const trailing = [];
      for (let s = m.nextElementSibling; s && !s.classList.contains('chat-message'); s = s.nextElementSibling) {
        if (!s.classList.contains('prompt-suggestions-container')) trailing.push(s);
      }
      trailing.forEach((s) => [s, ...s.querySelectorAll('*')].forEach((e) => {
        if (typeof e.className === 'string') e.className.split(/\s+/).forEach((c) => c && classes.add(c));
      }));
      const buttons = [m, ...trailing].flatMap((root) => [...root.querySelectorAll('button')]);
      return {
        text: m.innerText.replace(/^Brand Concierge says\s*/, '').trim(),
        classes: [...classes],
        tags: [...tags],
        links: [...m.querySelectorAll('a[href]')].map((a) => ({ text: a.innerText.trim(), href: a.href })),
        buttons: buttons.filter(visible)
          .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter(Boolean),
        suggestions: sugg && visible(sugg)
          ? [...sugg.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean) : [],
      };
    }, REPLY);
    if (!snap) return null;
    return { ...snap, kinds: classifyReply(snap) };
  }

  async chatState() {
    const s = await this.page.evaluate(() => {
      const input = document.querySelector('.chat-input');
      const root = document.querySelector('.chat-interface') || document.body;
      return {
        placeholder: input ? input.placeholder : '',
        buttons: [...root.querySelectorAll('button')].filter((b) => b.offsetParent)
          .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter(Boolean),
        text: root.innerText.slice(-2000),
      };
    });
    return { ...s, kinds: classifyChat(s) };
  }

  async screenshot(path) {
    const modal = this.page.locator('.dialog-modal').filter({ visible: true }).first();
    if (await modal.count()) await modal.screenshot({ path }).catch(() => this.page.screenshot({ path }));
    else await this.page.screenshot({ path });
    return path;
  }
}
