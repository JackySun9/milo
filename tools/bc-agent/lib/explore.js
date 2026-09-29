// Explorer: chats like a curious user. Starts from seed prompts, then keeps
// following suggestion chips / CTA buttons it has not tried yet (or, with a
// model configured, lets an LLM persona write the next message). Records which
// widgets ("workflows") each path reached.

export const DEFAULT_SEEDS = [
  'I want to touch up and enhance my photos',
  'Generate an image of a mountain lake at sunset',
  'Show me Firefly community creations',
  'Compare Photoshop vs Lightroom',
  'I want to talk to sales about Adobe Experience Manager',
  'How much does Adobe Experience Platform cost?',
  'How do I improve my brand visibility?',
  'I need help with a billing problem on my Adobe account',
];

// Buttons that navigate away or are not conversation moves.
const SKIP = /thumbs|^sources$|learn more|create now|sign in|^send|expand|close|^\d+$/i;

export function nextMoves(reply, tried) {
  const moves = [];
  (reply.suggestions || []).forEach((t) => moves.push({ click: t, label: t }));
  (reply.buttons || []).filter((b) => !SKIP.test(b)).forEach((t) => moves.push({ click: t, label: t }));
  const fresh = moves.filter((m) => !tried.has(m.label.toLowerCase()));
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

const PERSONA_PROMPT = `You are role-playing a realistic business visitor on Adobe's website, chatting with the "Brand Concierge" AI assistant. Your job is to exercise as many different assistant workflows as possible (product recommendations, image generation, galleries, product comparisons, pricing, citations, talking to sales / advisor handoff, booking a meeting), like a curious human would. Never type real personal data.

Given the conversation so far and the buttons currently offered, choose ONE next move. Output ONLY JSON:
{"action": "say", "text": "<your next message>"} or {"action": "click", "text": "<exact button label>"} or {"action": "stop"}`;

export async function personaMove(cfg, transcript, reply) {
  const convo = transcript.map((t) => `${t.role === 'user' ? 'Visitor' : 'Assistant'}: ${t.text.slice(0, 600)}`).join('\n');
  const offered = [...(reply.suggestions || []), ...(reply.buttons || []).filter((b) => !SKIP.test(b))];
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
  if (move.action === 'click' && !offered.includes(move.text)) return { say: move.text, label: move.text };
  if (move.action === 'click') return { click: move.text, label: move.text };
  if (move.action === 'say' && move.text) return { say: move.text, label: move.text };
  return null;
}
