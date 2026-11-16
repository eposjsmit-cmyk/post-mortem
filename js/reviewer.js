// Game review pipeline and the background "review queue".
import { Chess } from '../vendor/chess.js';
import { buildReview } from './analysis.js';
import { db, emit } from './db.js';
import { evaluate, getEngine } from './engine.js';
import { timeSpent } from './pgn.js';
import { puzzlesFromReview } from './puzzles.js';

export const REVIEW_DEPTH = 12;

/** Every position of a game with the facts the review needs. */
export function positionsOf(game) {
  const c = new Chess();
  const out = [];
  for (const san of game.moves) {
    const fen = c.fen();
    const legal = c.moves().length;
    const mover = c.turn();
    const moveNumber = c.moveNumber();
    const m = c.move(san);
    out.push({ fen, legal, san: m.san, uci: m.from + m.to + (m.promotion ?? ''), mover, moveNumber });
  }
  out.push({ fen: c.fen(), legal: c.moves().length, mover: c.turn(), moveNumber: c.moveNumber() });
  return out;
}

/** Analyses a game with Stockfish and saves the review and any new puzzles. */
export async function reviewGame(game, { engine = getEngine('bg'), onProgress, isCancelled } = {}) {
  const positions = positionsOf(game);
  const evals = [];
  for (let i = 0; i < positions.length; i++) {
    if (isCancelled?.()) return null;
    evals.push(await evaluate(engine, positions[i].fen, REVIEW_DEPTH));
    onProgress?.((i + 1) / positions.length);
  }
  const spent = timeSpent(game.clocks ?? [], game.timeControl, game.moves.length);
  const review = { gameId: game.id, createdAt: Date.now(), depth: REVIEW_DEPTH, ...buildReview(positions, evals, spent) };
  await db.put('reviews', review);
  await db.put('games', { ...game, reviewed: true, accuracy: review.summary });

  // New puzzles keep the progress of any that already exist for this game.
  const existing = new Set((await db.all('puzzles')).filter((p) => p.gameId === game.id).map((p) => p.id));
  const fresh = puzzlesFromReview(game, review).filter((p) => !existing.has(p.id));
  if (fresh.length) await db.putMany('puzzles', fresh);
  emit('reviews', { gameId: game.id });
  if (fresh.length) emit('puzzles', { added: fresh.length });
  return review;
}

// ---------- Review queue ----------

const state = { queue: [], running: null, progress: 0, done: 0, total: 0, stopped: false };
export const queueState = () => ({ ...state, queue: [...state.queue] });

/** Adds games (newest first) to the queue and starts working through them. */
export function enqueue(games) {
  const known = new Set([...state.queue.map((g) => g.id), state.running?.id]);
  const add = games.filter((g) => !g.reviewed && !known.has(g.id));
  if (add.length === 0) return 0;
  state.queue.push(...add);
  state.total += add.length;
  state.stopped = false;
  emit('review-queue', queueState());
  run();
  return add.length;
}

const waiters = new Map();

/** Reviews one game next (ahead of the queue). Resolves when it's done. */
export function reviewNow(game) {
  if (state.running?.id === game.id) return waitFor(game.id);
  state.queue = state.queue.filter((g) => g.id !== game.id);
  state.queue.unshift({ ...game, reviewed: false });
  if (!state.running) state.done = 0;
  state.total = state.done + state.queue.length + (state.running ? 1 : 0);
  state.stopped = false;
  const p = waitFor(game.id);
  emit('review-queue', queueState());
  run();
  return p;
}

function waitFor(id) {
  return new Promise((resolve) => {
    const list = waiters.get(id) ?? [];
    list.push(resolve);
    waiters.set(id, list);
  });
}

export function stopQueue() {
  for (const g of state.queue) {
    (waiters.get(g.id) ?? []).forEach((resolve) => resolve(null));
    waiters.delete(g.id);
  }
  state.stopped = true;
  state.queue = [];
  state.total = state.done + (state.running ? 1 : 0);
  emit('review-queue', queueState());
}

let running = false;
async function run() {
  if (running) return;
  running = true;
  try {
    while (state.queue.length && !state.stopped) {
      const game = state.queue.shift();
      state.running = game;
      state.progress = 0;
      emit('review-queue', queueState());
      let review = null;
      try {
        review = await reviewGame(game, {
          onProgress: (p) => {
            state.progress = p;
            emit('review-queue', queueState());
          },
          isCancelled: () => state.stopped,
        });
      } catch (e) {
        console.error('Review failed for', game.id, e);
      }
      (waiters.get(game.id) ?? []).forEach((resolve) => resolve(review));
      waiters.delete(game.id);
      state.done++;
      state.running = null;
    }
  } finally {
    running = false;
    state.running = null;
    if (!state.queue.length) {
      state.done = 0;
      state.total = 0;
    }
    emit('review-queue', queueState());
  }
}
