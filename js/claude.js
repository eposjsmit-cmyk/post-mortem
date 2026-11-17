// The single place the app talks to Claude. Every feature builds a "request" (instructions + facts +
// question) and either copies it as one prompt for a Claude chat, or streams the answer with the API key.
import { Chess } from '../vendor/chess.js';
import { fmtScore, lineText, uciToSan, winFor } from './analysis.js';
import { getSettings, getKv } from './db.js';

export const MODEL = 'claude-opus-5-5';

const PIECE_NAMES = { k: 'King', q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight', p: 'Pawn' };

/** "White: King g1, Queen d1, Pawns a2 b2 …" for both sides. */
export function pieceList(fen) {
  const board = new Chess(fen).board();
  const sides = { w: {}, b: {} };
  for (const row of board) {
    for (const sq of row) {
      if (!sq) continue;
      (sides[sq.color][sq.type] ??= []).push(sq.square);
    }
  }
  const order = ['k', 'q', 'r', 'b', 'n', 'p'];
  const side = (c) =>
    order
      .filter((t) => sides[c][t])
      .map((t) => `${PIECE_NAMES[t]}${sides[c][t].length > 1 ? 's' : ''} ${sides[c][t].sort().join(' ')}`)
      .join(', ');
  return `White: ${side('w')}\nBlack: ${side('b')}`;
}

/** FEN, piece list and side to move, ready to paste into a prompt. */
export function positionFacts(fen) {
  const turn = fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  return `FEN: ${fen}\n${pieceList(fen)}\n${turn} to move.`;
}

const pct = (n) => `${Math.round(n)}%`;
const colourName = (c) => (c === 'w' ? 'White' : 'Black');

/** Engine facts for one reviewed move. */
export function moveFacts(ply) {
  const best = ply.pv?.length ? lineText(ply.fenBefore, uciToSan(ply.fenBefore, ply.pv, 8)) : ply.bestSan;
  return [
    `Position before the move:\n${positionFacts(ply.fenBefore)}`,
    `Move played: ${lineText(ply.fenBefore, [ply.san])} by ${colourName(ply.mover)} (verdict: ${ply.verdict}).`,
    `Engine evaluation before the move: ${fmtScore(ply.scoreBefore)} (White's view); ${colourName(ply.mover)}'s winning chance ${pct(ply.winBefore)}.`,
    `After the move: ${fmtScore(ply.scoreAfter)}; ${colourName(ply.mover)}'s winning chance ${pct(ply.winAfter)} (dropped ${ply.drop.toFixed(1)}%).`,
    `Engine's best move: ${ply.bestSan ?? 'unknown'}. Engine line: ${best || 'not available'}.`,
    ply.timeSpent != null ? `Time spent on the move: ${ply.timeSpent} seconds.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function playerLevel() {
  const stats = await getKv('stats');
  const r = stats?.ratings?.rapid?.rating;
  return r ? `a club player whose chess.com rapid rating is about ${r}` : 'a beginner-to-club player';
}

/** The shared instructions every request starts with. */
export async function systemPrompt(extra = '') {
  return [
    `You are a friendly, patient chess coach for ${await playerLevel()}.`,
    'Write in South African English with British spelling, in plain, friendly words.',
    'Use only the engine facts given below for evaluations, best moves and lines. Do not invent engine evaluations or lines, and if the facts do not settle something, say so honestly.',
    'The first time you use a chess term (for example fork, pin, tempo, outpost), explain it briefly in brackets.',
    'Keep it short and practical: about 150-250 words unless the question needs more. Use short paragraphs or a few bullet points.',
    'End with a final line that starts with "Takeaway:" followed by one lesson to remember.',
    extra,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * A request: { title, system, facts, question, history? }.
 * history is a list of { role: 'user' | 'assistant', text } for follow-up questions.
 */
export async function makeRequest({ title, facts, question, extra = '', history = [] }) {
  return { title, system: await systemPrompt(extra), facts, question, history };
}

/** Everything as one block of text for pasting into a Claude chat. */
export function promptText(req) {
  const parts = [req.system, '', '--- Engine facts ---', req.facts, ''];
  for (const h of req.history) parts.push(`${h.role === 'user' ? 'Me' : 'Coach'}: ${h.text}`, '');
  parts.push(`Question: ${req.question}`);
  return parts.join('\n');
}

export async function copyPrompt(req) {
  const text = promptText(req);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older browsers / no permission: fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  return text;
}

export async function hasApiKey() {
  return !!(await getSettings()).apiKey;
}

let sdkPromise = null;
const loadSdk = () => (sdkPromise ??= import('../vendor/anthropic-sdk.js'));

/** Where to create a key. */
export const KEYS_URL = 'https://console.anthropic.com/settings/keys';

/**
 * Checks a key without generating an answer (it only looks up the model, which is free).
 * Resolves { ok: true } or { ok: false, message }.
 */
export async function checkKey(apiKey) {
  const key = apiKey.trim();
  if (!key) return { ok: false, message: 'Paste your key first.' };
  if (!key.startsWith('sk-ant-')) return { ok: false, message: 'That does not look like an Anthropic key. It should start with "sk-ant-".' };
  const { default: Anthropic } = await loadSdk();
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 1 });
  try {
    await client.models.retrieve(MODEL);
    return { ok: true };
  } catch (e) {
    if (e instanceof Anthropic.NotFoundError) return { ok: false, message: `The key works, but this account can't use ${MODEL} yet.` };
    return { ok: false, message: friendlyError(e, Anthropic) };
  }
}

/**
 * Streams Claude's answer. onText receives each new piece of text.
 * Returns the full answer text. Throws an Error with a friendly message on failure.
 */
export async function askClaude(req, { onText, onStatus, signal } = {}) {
  const { apiKey } = await getSettings();
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings first, or use "Copy for Claude".');
  const { default: Anthropic } = await loadSdk();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const messages = [];
  const first = `Engine facts:\n${req.facts}`;
  if (req.history.length) {
    messages.push({ role: 'user', content: `${first}\n\nQuestion: ${req.history[0].text}` });
    for (const h of req.history.slice(1)) messages.push({ role: h.role, content: h.text });
    messages.push({ role: 'user', content: req.question });
  } else {
    messages.push({ role: 'user', content: `${first}\n\nQuestion: ${req.question}` });
  }

  onStatus?.('thinking');
  let text = '';
  try {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 16000,
        // If Claude declines for safety reasons, the API retries on a fallback model in the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: req.system,
        messages,
      },
      { signal },
    );
    stream.on('text', (delta) => {
      if (!text) onStatus?.('writing');
      text += delta;
      onText?.(delta, text);
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') throw new Error('Claude declined to answer this one.');
    onStatus?.('done');
    return text;
  } catch (e) {
    onStatus?.('error');
    if (signal?.aborted) throw new Error('Stopped.');
    throw new Error(friendlyError(e, Anthropic));
  }
}

function friendlyError(e, Anthropic) {
  if (e instanceof Anthropic.AuthenticationError) return 'That key was not accepted. Check you copied all of it, or make a new one.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use this model.';
  if (e instanceof Anthropic.RateLimitError) return 'Too many requests right now. Wait a moment and try again.';
  if (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message)) return 'Your Anthropic account is out of credit. Add some under Billing at console.anthropic.com, then try again.';
  if (e instanceof Anthropic.BadRequestError) return `Claude could not take this request: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach Claude. Check your internet connection.';
  if (e instanceof Anthropic.APIError) return `Claude had a problem (${e.status ?? 'error'}). Try again shortly.`;
  return e?.message || 'Something went wrong talking to Claude.';
}

/** Quick follow-up question chips for a position. */
export const QUICK_QUESTIONS = [
  'What is the main idea in this position?',
  'What was my opponent threatening?',
  'Why is the engine move better than mine?',
  'What should I look for in positions like this?',
  'How do I avoid this kind of mistake?',
];

/** Win chance in plain words. */
export const chanceText = (score, color) => pct(winFor(score, color));
