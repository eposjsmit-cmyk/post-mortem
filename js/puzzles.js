// Puzzles from the user's own mistakes, with spaced repetition.

export const DAY = 24 * 60 * 60 * 1000;
export const INTERVAL_DAYS = [1, 3, 7, 21];
export const RETRY_MS = 10 * 60 * 1000;
export const LEARNED_BOX = 4;
/** A different move counts as solved if it is within this many percent of the engine's move. */
export const ALT_TOLERANCE = 4;
/** Positions where the user was already losing badly (win chance below this) are skipped. */
export const MIN_WIN_BEFORE = 15;

/** Puzzles for one reviewed game: every mistake or blunder by the user. */
export function puzzlesFromReview(game, review, now = Date.now()) {
  if (!game.myColor) return [];
  return review.plies
    .filter((p) => p.mover === game.myColor && (p.verdict === 'mistake' || p.verdict === 'blunder') && p.best && p.winBefore >= MIN_WIN_BEFORE)
    .map((p) => ({
      id: `${game.id}#${p.i}`,
      gameId: game.id,
      ply: p.i,
      fen: p.fenBefore,
      solution: p.best,
      solutionSan: p.bestSan,
      pv: p.pv,
      played: p.san,
      verdict: p.verdict,
      drop: p.drop,
      type: p.type ?? 'wrong-plan',
      color: game.myColor,
      winBefore: p.winBefore,
      createdAt: now,
      box: 0,
      due: now,
      attempts: 0,
      lastSeen: null,
      lastResult: null,
      history: [],
    }));
}

/**
 * Updates a puzzle after an attempt.
 * result: 'right' (first time, no help) | 'hint' (solved with a hint) | 'wrong' | 'revealed'.
 */
export function schedule(puzzle, result, now = Date.now()) {
  const p = { ...puzzle, attempts: puzzle.attempts + 1, lastSeen: now, lastResult: result, history: [...(puzzle.history ?? []), { at: now, result }] };
  if (result === 'right') {
    p.box = Math.min(LEARNED_BOX, puzzle.box + 1);
    p.due = now + INTERVAL_DAYS[p.box - 1] * DAY;
  } else if (result === 'hint') {
    // Solved, but with help: same gap as now, no step forward.
    p.due = now + (puzzle.box > 0 ? INTERVAL_DAYS[puzzle.box - 1] : 1) * DAY;
  } else {
    p.box = 0;
    p.due = now + RETRY_MS;
  }
  return p;
}

const startOfDay = (now) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Counts for the Puzzles screen. */
export function puzzleCounts(puzzles, now = Date.now()) {
  const today = startOfDay(now);
  return {
    due: puzzles.filter((p) => p.due <= now).length,
    doneToday: puzzles.filter((p) => (p.history ?? []).some((h) => h.at >= today)).length,
    learned: puzzles.filter((p) => p.box >= LEARNED_BOX).length,
    total: puzzles.length,
  };
}

/** Next due puzzles, oldest due first, optionally only one mistake type. */
export function dueQueue(puzzles, { type = null, now = Date.now(), anyway = false } = {}) {
  return puzzles
    .filter((p) => (!type || p.type === type) && (anyway || p.due <= now))
    .sort((a, b) => (anyway ? (a.lastSeen ?? 0) - (b.lastSeen ?? 0) || a.box - b.box : a.due - b.due));
}
