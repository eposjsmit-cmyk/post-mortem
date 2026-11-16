// Numbers for Home: ratings, results, how games end, accuracy by stage and mistake patterns.
import { myResult } from './pgn.js';

/** Rating after each game, per time control, from the user's own rating field. */
export function ratingSeries(games) {
  const out = {};
  for (const g of [...games].sort((a, b) => a.date - b.date)) {
    if (!g.myColor || g.source !== 'chess.com' || g.rated === false) continue;
    const r = g.myColor === 'w' ? g.whiteElo : g.blackElo;
    if (!r) continue;
    (out[g.timeClass] ??= []).push({ x: g.date, y: r });
  }
  return out;
}

const tally = () => ({ w: 0, d: 0, l: 0 });
const add = (t, res) => {
  if (res === 'win') t.w++;
  else if (res === 'draw') t.d++;
  else if (res === 'loss') t.l++;
};

export function resultsBy(games) {
  const byColour = { w: tally(), b: tally() };
  const byClass = {};
  for (const g of games) {
    const res = myResult(g);
    if (!res) continue;
    add(byColour[g.myColor], res);
    add((byClass[g.timeClass] ??= tally()), res);
  }
  return { byColour, byClass };
}

/** How wins and losses end: { wins: { checkmate: 3, … }, losses: {…} } */
export function endings(games) {
  const wins = {};
  const losses = {};
  for (const g of games) {
    const res = myResult(g);
    if (res === 'win') wins[g.termination] = (wins[g.termination] ?? 0) + 1;
    if (res === 'loss') losses[g.termination] = (losses[g.termination] ?? 0) + 1;
  }
  return { wins, losses };
}

/** Average accuracy of the user's moves by stage, from reviews. */
export function accuracyByStage(games, reviews) {
  const byId = new Map(games.map((g) => [g.id, g]));
  const sums = { opening: [0, 0], middlegame: [0, 0], endgame: [0, 0] };
  for (const r of reviews) {
    const g = byId.get(r.gameId);
    if (!g?.myColor) continue;
    for (const p of r.plies) {
      if (p.mover !== g.myColor || p.accuracy == null) continue;
      sums[p.stage][0] += p.accuracy;
      sums[p.stage][1]++;
    }
  }
  return Object.fromEntries(Object.entries(sums).map(([k, [s, n]]) => [k, n ? s / n : null]));
}

/** The user's mistakes and blunders across reviews (with game info). */
export function myMistakes(games, reviews) {
  const byId = new Map(games.map((g) => [g.id, g]));
  const out = [];
  for (const r of reviews) {
    const g = byId.get(r.gameId);
    if (!g?.myColor) continue;
    for (const p of r.plies) if (p.mover === g.myColor && (p.verdict === 'mistake' || p.verdict === 'blunder')) out.push({ ...p, game: g });
  }
  return out;
}

export function averageAccuracy(games) {
  const accs = games.map((g) => (g.myColor && g.accuracy ? g.accuracy[g.myColor]?.accuracy : null)).filter((a) => a != null);
  return accs.length ? accs.reduce((s, a) => s + a, 0) / accs.length : null;
}

/** Share of the user's losses that were on time. */
export function timeLossShare(games) {
  const losses = games.filter((g) => myResult(g) === 'loss');
  if (!losses.length) return { share: 0, count: 0, losses: 0 };
  const count = losses.filter((g) => g.termination === 'timeout').length;
  return { share: count / losses.length, count, losses: losses.length };
}
