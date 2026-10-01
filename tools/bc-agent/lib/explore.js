// Explorer: chats like a curious user. Starts from seed prompts, then keeps
// following suggestion chips / CTA buttons it has not tried yet (or, with a
// model configured, lets an LLM persona write the next message). Records which
// widgets ("workflows") each path reached.

export const DEFAULT_SEEDS = [
  'I want to touch up and enhance my photos',
  'Generate an image of a mountain lake at sunset',
  'Show me Firefly community creations',
  'Compare Photoshop vs Lightroom',
  'I would like to book a demo of Adobe Experience Manager for my company',
  'How much does Adobe Experience Platform cost?',
  'How do I improve my brand visibility?',
  'I need help with a billing problem on my Adobe account',
];

// Buttons that navigate away or are not conversation moves.
const SKIP = /thumbs|^sources$|learn more|create now|sign in|^send|expand|close|^\d+$/i;

// Moves that would hand the visitor to a real sales advisor. Synthetic runs
// must never take up advisor capacity, so these are dropped unless
// BC_LIVE_ADVISOR=1.
export const LIVE_ADVISOR_RE = /talk (to|with) (a |an )?(sales|human|person|agent|advisor|someone|rep)|speak (to|with)|connect (me )?(to|with)|live (chat|agent|advisor)|advisor|sales (rep|team|agent)|\bhuman\b|real person/i;

export const liveAdvisorAllowed = (env = process.env) => env.BC_LIVE_ADVISOR === '1';

export function nextMoves(reply, tried, { allowAdvisor = liveAdvisorAllowed() } = {}) {
  const moves = [];
  (reply.suggestions || []).forEach((t) => moves.push({ click: t, label: t }));
  (reply.buttons || []).filter((b) => !SKIP.test(b)).forEach((t) => moves.push({ click: t, label: t }));
  const fresh = moves.filter((m) => !tried.has(m.label.toLowerCase())
    && (allowAdvisor || !LIVE_ADVISOR_RE.test(m.label)));
  // Workflow-changing CTAs first (meeting / sales), then sales-ish questions, then the rest.
  const score = (m) => (/schedule|meeting|book|demo/i.test(m.label) ? 0
    : /sales|advisor|agent|talk to/i.test(m.label) ? 1 : 2);
  return fresh.sort((a, b) => score(a) - score(b));
}

export function personaConfig(env = process.env) {
  const apiKey = env.BC_AGENT_API_KEY || env.AI_JUDGE_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: env.BC_AGENT_BASE_URL || env.AI_JUDGE_BASE_URL || 'https://api.openai.com/v1',
    model: env.BC_AGENT_MODEL || env.AI_JUDGE_MODEL || 'gpt-4o-mini',
  };
}

const PERSONA_PROMPT = `You are role-playing a realistic business visitor on Adobe's website, chatting with the "Brand Concierge" AI assistant. Your job is to exercise as many different assistant workflows as possible (product recommendations, image generation, galleries, product comparisons, pricing, citations, booking a meeting), like a curious human would. Never type real personal data. Never ask to talk to sales, a human, a live agent or an advisor, and never click buttons that would connect you to one: real advisors would be kept waiting.

Given the conversation so far and the buttons currently offered, choose ONE next move. Output ONLY JSON:
{"action": "say", "text": "<your next message>"} or {"action": "click", "text": "<exact button label>"} or {"action": "stop"}`;

export async function personaMove(cfg, transcript, reply) {
  const convo = transcript.map((t) => `${t.role === 'user' ? 'Visitor' : 'Assistant'}: ${t.text.slice(0, 600)}`).join('\n');
  const allowAdvisor = liveAdvisorAllowed();
  const offered = [...(reply.suggestions || []), ...(reply.buttons || []).filter((b) => !SKIP.test(b))]
    .filter((b) => allowAdvisor || !LIVE_ADVISOR_RE.test(b));
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.8,
      max_tokens: 200,
      messages: [
        { role: 'system', content: PERSONA_PROMPT },
        { role: 'user', content: `Conversation:\n${convo}\n\nButtons offered: ${JSON.stringify(offered)}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`persona model error ${res.status}`);
  const json = await res.json();
  const raw = json.choices?.[0]?.message?.content || '';
  const m = raw.match(/\{[\s\S]*\}/);
  const move = m ? JSON.parse(m[0]) : { action: 'stop' };
  if (!allowAdvisor && move.text && LIVE_ADVISOR_RE.test(move.text)) return null;
  if (move.action === 'click' && !offered.includes(move.text)) return { say: move.text, label: move.text };
  if (move.action === 'click') return { click: move.text, label: move.text };
  if (move.action === 'say' && move.text) return { say: move.text, label: move.text };
  return null;
}

// A path is retried once when it errored or captured no turns (e.g. the page
// or chat entry point timed out under parallel load).
export function needsRetry(path) {
  return !!path.error || !(path.turns || []).length;
}

// Keep the retry only when it captured turns and did at least as well as the
// original; otherwise keep the original and record why the retry did not help.
export function mergeRetry(original, retry) {
  const origTurns = (original.turns || []).length;
  const retryTurns = (retry.turns || []).length;
  if (retryTurns && (!retry.error || retryTurns >= origTurns)) {
    return { ...retry, retried: true, firstError: original.error || null };
  }
  return {
    ...original,
    retried: true,
    retryError: retry.error || null,
    errorShot: retry.errorShot || original.errorShot || null,
  };
}
