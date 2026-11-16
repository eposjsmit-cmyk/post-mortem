// Pure chess-analysis maths: win chance, move verdicts, accuracy and mistake types.
// No DOM and no engine here, so it can be tested in Node.
import { Chess } from '../vendor/chess.js';

export const VERDICTS = ['forced', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'];

export const VERDICT_INFO = {
  forced: { label: 'Forced', symbol: '□', short: 'Only move' },
  best: { label: 'Best', symbol: '★', short: 'Best' },
  excellent: { label: 'Excellent', symbol: '!', short: 'Excellent' },
  good: { label: 'Good', symbol: '✓', short: 'Good' },
  inaccuracy: { label: 'Inaccuracy', symbol: '?!', short: 'Inaccuracy' },
  mistake: { label: 'Mistake', symbol: '?', short: 'Mistake' },
  blunder: { label: 'Blunder', symbol: '??', short: 'Blunder' },
};

export const MISTAKE_TYPES = {
  'walked-into-mate': 'Walked into checkmate',
  'missed-mate': 'Missed a checkmate',
  'hanging-piece': 'Left a piece hanging',
  'missed-free-piece': 'Missed a free piece',
  'missed-tactic': 'Missed a tactic',
  'opening-slip': 'Opening slip',
  'endgame-slip': 'Endgame slip',
  'wrong-plan': 'Wrong plan',
};

const MATE_CP = 10000;

/** Win chance (0-100) for the side the centipawn score favours. */
export function winChance(cp) {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/**
 * An engine score from White's point of view: { cp } or { mate } (positive = White mates).
 * Mates become a very large centipawn value, slightly smaller the further away the mate is.
 */
export function scoreCp(score) {
  if (!score) return 0;
  if (score.mate != null) {
    if (score.mate === 0) return 0;
    return Math.sign(score.mate) * (MATE_CP - Math.min(Math.abs(score.mate), 99) * 10);
  }
  return Math.max(-MATE_CP, Math.min(MATE_CP, score.cp ?? 0));
}

/** White's win chance for a White-POV score. */
export const whiteWin = (score) => winChance(scoreCp(score));

/** Win chance for `color` ('w' | 'b') from a White-POV score. */
export const winFor = (score, color) => (color === 'w' ? whiteWin(score) : 100 - whiteWin(score));

/** Move accuracy (0-100) from the drop in winning chance. */
export function moveAccuracy(drop) {
  const a = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, a));
}

/** Verdict for one move. */
export function verdictFor({ forced, isBest, drop }) {
  if (forced) return 'forced';
  if (isBest || drop < 0.5) return 'best';
  if (drop < 2) return 'excellent';
  if (drop < 5) return 'good';
  if (drop < 10) return 'inaccuracy';
  if (drop < 20) return 'mistake';
  return 'blunder';
}

/** Readable score: "+1.4", "−0.3", "M3", "−M2". */
export function fmtScore(score) {
  if (!score) return '–';
  if (score.terminal === 'checkmate') return score.cp > 0 ? '1-0' : '0-1';
  if (score.mate != null) return `${score.mate < 0 ? '−' : ''}M${Math.abs(score.mate)}`;
  const v = (score.cp ?? 0) / 100;
  if (Math.abs(v) < 0.05) return '0.0';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
}

// ---------- Material helpers ----------

const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Material balance (White minus Black) from a FEN. */
export function materialBalance(fen) {
  let s = 0;
  for (const ch of fen.split(' ')[0]) {
    const v = VALUES[ch.toLowerCase()];
    if (v == null) continue;
    s += ch === ch.toUpperCase() ? v : -v;
  }
  return s;
}

/** Number of knights, bishops, rooks and queens left on the board (both sides). */
export function pieceCount(fen) {
  let n = 0;
  for (const ch of fen.split(' ')[0]) if ('nbrqNBRQ'.includes(ch)) n++;
  return n;
}

/** Plays UCI moves from a FEN; returns the FENs reached (stops at the first illegal move). */
export function playLine(fen, ucis, max = 99) {
  const c = new Chess(fen);
  const fens = [];
  for (const u of ucis.slice(0, max)) {
    try {
      c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    } catch {
      break;
    }
    fens.push(c.fen());
  }
  return fens;
}

/** Converts UCI moves to SAN from a FEN (stops at the first illegal move). */
export function uciToSan(fen, ucis, max = 99) {
  const c = new Chess(fen);
  const out = [];
  for (const u of ucis.slice(0, max)) {
    try {
      out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
    } catch {
      break;
    }
  }
  return out;
}

/** "12. Nf3 Nc6 13. Bb5" style text for a SAN line starting at `fen`. */
export function lineText(fen, sans) {
  const parts = fen.split(' ');
  let move = Number(parts[5]) || 1;
  let white = parts[1] === 'w';
  const out = [];
  sans.forEach((san, i) => {
    if (white) out.push(`${move}. ${san}`);
    else out.push(i === 0 ? `${move}... ${san}` : san);
    if (!white) move++;
    white = !white;
  });
  return out.join(' ');
}

/** Best material swing (for `color`) reached along a line within `plies`. */
function materialGain(fen, pv, color, plies) {
  const start = materialBalance(fen);
  const sign = color === 'w' ? 1 : -1;
  const fens = playLine(fen, pv, plies);
  let best = 0;
  fens.forEach((f, i) => {
    // Count gains that hold after the opponent has replied (odd index), or where the line ends.
    if (i % 2 === 1 || i === fens.length - 1) best = Math.max(best, (materialBalance(f) - start) * sign);
  });
  return best;
}

/**
 * Mistake type for a mistake or blunder.
 * ply: { fenBefore, fenAfter, mover, moveNumber, scoreBefore, scoreAfter (White POV), bestPv (UCI), replyPv (UCI) }
 */
export function classifyMistake(ply) {
  const { fenBefore, fenAfter, mover, moveNumber, scoreBefore, scoreAfter, bestPv = [], replyPv = [] } = ply;
  const sign = mover === 'w' ? 1 : -1;
  if (scoreAfter?.mate != null && Math.sign(scoreAfter.mate) === -sign) return 'walked-into-mate';
  if (scoreBefore?.mate != null && Math.sign(scoreBefore.mate) === sign) return 'missed-mate';

  const opp = mover === 'w' ? 'b' : 'w';
  const reply = replyPv[0];
  if (reply && fenAfter) {
    const target = pieceOn(fenAfter, reply.slice(2, 4));
    if (target && target.color === mover && VALUES[target.type] >= 3 && materialGain(fenAfter, replyPv, opp, 4) >= 2) return 'hanging-piece';
  }
  const best = bestPv[0];
  if (best) {
    const target = pieceOn(fenBefore, best.slice(2, 4));
    if (target && target.color === opp && VALUES[target.type] >= 3 && materialGain(fenBefore, bestPv, mover, 2) >= 2) return 'missed-free-piece';
  }
  if (materialGain(fenBefore, bestPv, mover, 6) >= 2 || (fenAfter && materialGain(fenAfter, replyPv, opp, 6) >= 2)) return 'missed-tactic';
  if (moveNumber <= 10) return 'opening-slip';
  if (pieceCount(fenBefore) <= 6) return 'endgame-slip';
  return 'wrong-plan';
}

function pieceOn(fen, square) {
  const rows = fen.split(' ')[0].split('/');
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]);
  const row = rows[8 - rank];
  if (!row) return null;
  let f = 0;
  for (const ch of row) {
    if (/\d/.test(ch)) f += Number(ch);
    else {
      if (f === file) return { type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? 'w' : 'b' };
      f++;
    }
    if (f > file) return null;
  }
  return null;
}

/** Stage of the game for a ply: opening (first 10 moves), endgame (6 or fewer pieces), else middlegame. */
export function stageOf(moveNumber, fen) {
  if (moveNumber <= 10) return 'opening';
  if (pieceCount(fen) <= 6) return 'endgame';
  return 'middlegame';
}

/** Score for a finished position (checkmate, stalemate, draw) without the engine, White POV. */
export function terminalScore(chess) {
  // The side to move is mated, so the other side has won.
  if (chess.isCheckmate()) return { cp: chess.turn() === 'w' ? -MATE_CP : MATE_CP, terminal: 'checkmate' };
  if (chess.isDraw() || chess.isStalemate()) return { cp: 0, terminal: 'draw' };
  return null;
}

/**
 * Builds a review from per-position engine results.
 * positions: [{ fen, legal, san?, uci?, moveNumber, mover }] for each ply, plus the final position.
 * evals[i]: { score (White POV), best (UCI), pv (UCI[]) } for positions[i].
 */
export function buildReview(positions, evals, clocksUsed = []) {
  const plies = [];
  for (let i = 0; i < positions.length - 1; i++) {
    const p = positions[i];
    const e = evals[i];
    const next = evals[i + 1];
    const before = winFor(e.score, p.mover);
    const after = winFor(next.score, p.mover);
    const drop = Math.max(0, before - after);
    const forced = p.legal === 1;
    const isBest = !!e.best && e.best === p.uci;
    const verdict = verdictFor({ forced, isBest, drop });
    const ply = {
      i,
      san: p.san,
      uci: p.uci,
      mover: p.mover,
      moveNumber: p.moveNumber,
      fenBefore: p.fen,
      fenAfter: positions[i + 1].fen,
      scoreBefore: e.score,
      scoreAfter: next.score,
      best: e.best,
      bestSan: e.best ? uciToSan(p.fen, [e.best])[0] : null,
      pv: (e.pv ?? []).slice(0, 10),
      winBefore: round1(before),
      winAfter: round1(after),
      drop: round1(drop),
      verdict,
      accuracy: forced ? null : round1(moveAccuracy(drop)),
      timeSpent: clocksUsed[i] ?? null,
      stage: stageOf(p.moveNumber, p.fen),
    };
    if (verdict === 'mistake' || verdict === 'blunder') {
      ply.type = classifyMistake({ ...ply, bestPv: ply.pv, replyPv: next.pv ?? [] });
    }
    plies.push(ply);
  }
  return { plies, summary: summarise(plies), finalScore: evals[evals.length - 1]?.score ?? null };
}

const round1 = (n) => Math.round(n * 10) / 10;

/** Accuracy and verdict counts per side. */
export function summarise(plies) {
  const side = (c) => {
    const mine = plies.filter((p) => p.mover === c);
    const scored = mine.filter((p) => p.accuracy != null);
    const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
    mine.forEach((p) => counts[p.verdict]++);
    return { accuracy: scored.length ? round1(scored.reduce((s, p) => s + p.accuracy, 0) / scored.length) : null, counts };
  };
  return { w: side('w'), b: side('b') };
}
