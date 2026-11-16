import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../vendor/chess.js';
import { buildReview, classifyMistake, fmtScore, moveAccuracy, scoreCp, verdictFor, winChance, winFor } from '../js/analysis.js';
import { chessComId, gameFromPgn, myResult, openingFromEcoUrl, parseManyPgn, parseMovetext, splitPgn, timeClassOf, timeSpent } from '../js/pgn.js';
import { buildTree, likelyLine, lineLists, nodeAt, pathText, scoreOf } from '../js/openings.js';
import { DAY, RETRY_MS, dueQueue, puzzleCounts, puzzlesFromReview, schedule } from '../js/puzzles.js';

const near = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('win chance formula', () => {
  near(winChance(0), 50);
  near(winChance(100), 59.1, 0.1);
  near(winChance(-300), 25, 0.2);
  assert.ok(winChance(10000) > 99.99);
  near(winFor({ cp: 100 }, 'b'), 100 - winChance(100));
  assert.ok(scoreCp({ mate: 3 }) > 9000 && scoreCp({ mate: -1 }) < -9000);
});

test('verdict thresholds', () => {
  assert.equal(verdictFor({ forced: true, drop: 50 }), 'forced');
  assert.equal(verdictFor({ isBest: true, drop: 3 }), 'best');
  assert.equal(verdictFor({ drop: 0.4 }), 'best');
  assert.equal(verdictFor({ drop: 1.9 }), 'excellent');
  assert.equal(verdictFor({ drop: 4.9 }), 'good');
  assert.equal(verdictFor({ drop: 9.9 }), 'inaccuracy');
  assert.equal(verdictFor({ drop: 19.9 }), 'mistake');
  assert.equal(verdictFor({ drop: 20 }), 'blunder');
});

test('move accuracy formula and clamping', () => {
  near(moveAccuracy(0), 100, 0.01);
  near(moveAccuracy(10), 103.1668 * Math.exp(-0.4354) - 3.1669, 0.001);
  assert.equal(moveAccuracy(200), 0);
  assert.equal(fmtScore({ cp: 135 }), '+1.4');
  assert.equal(fmtScore({ mate: -2 }), '−M2');
});

const SAMPLE = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.11.10"]
[White "JokerAm1"]
[Black "Rival99"]
[Result "0-1"]
[ECO "C50"]
[ECOUrl "https://www.chess.com/openings/Italian-Game-Two-Knights-Defense-4.d3"]
[WhiteElo "551"]
[BlackElo "560"]
[TimeControl "600+5"]
[Termination "Rival99 won by checkmate"]
[UTCDate "2026.11.10"]
[UTCTime "18:00:00"]
[Link "https://www.chess.com/game/live/123456789"]

1. e4 {[%clk 0:10:03]} 1... e5 {[%clk 0:10:02]} 2. Bc4 {[%clk 0:09:58.5]} 2... Nc6 {[%clk 0:10:00]} 3. Qh5?! {[%clk 0:09:50]} (3. Nf3 Nf6) 3... g6 $2 {[%clk 0:09:59]} 4. Qf3 {[%clk 0:09:40]} 4... Nf6 5. g4 Nd4 6. Qd3 d5 7. exd5 Bxg4 0-1

[Event "Live Chess"]
[Variant "Chess960"]
[White "A"]
[Black "B"]
[Result "1-0"]
[SetUp "1"]
[FEN "bqnrkbrn/pppppppp/8/8/8/8/PPPPPPPP/BQNRKBRN w KQkq - 0 1"]

1. e4 e5 1-0
`;

test('PGN: splitting, clocks, headers, variants', () => {
  assert.equal(splitPgn(SAMPLE).length, 2);
  const { games, skipped } = parseManyPgn(SAMPLE, { me: 'jokeram1' });
  assert.equal(games.length, 1);
  assert.equal(skipped, 1);
  const g = games[0];
  assert.equal(g.id, 'cc:123456789');
  assert.equal(g.myColor, 'w');
  assert.equal(g.timeClass, 'rapid');
  assert.equal(g.termination, 'checkmate');
  assert.equal(g.opening, 'Italian Game Two Knights Defense');
  assert.deepEqual(g.moves.slice(0, 6), ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'g6']);
  assert.equal(g.moves.length, 14);
  assert.deepEqual(g.clocks.slice(0, 7), [603, 602, 598.5, 600, 590, 599, 580]);
  assert.equal(myResult(g), 'loss');
  // 603: started 600, +5 increment, used 2s. 598.5: 603 - 598.5 + 5 = 9.5
  assert.deepEqual(timeSpent(g.clocks, g.timeControl, 5), [2, 3, 9.5, 7, 13.5]);
});

test('PGN helpers', () => {
  assert.equal(timeClassOf('60'), 'bullet');
  assert.equal(timeClassOf('180+2'), 'blitz');
  assert.equal(timeClassOf('600'), 'rapid');
  assert.equal(timeClassOf('1/86400'), 'daily');
  assert.equal(chessComId('https://www.chess.com/game/daily/987'), '987');
  assert.equal(openingFromEcoUrl('https://www.chess.com/openings/Sicilian-Defense-Open-3...cxd4'), 'Sicilian Defense Open');
  assert.equal(openingFromEcoUrl('https://www.chess.com/openings/Caro-Kann-Defense...3.d3-dxe4-4.dxe4-Qxd1-5.Kxd1'), 'Caro-Kann Defense');
  assert.deepEqual(parseMovetext('1. e4 {hi} (1. d4 d5) e5 2. Nf3 *').sans, ['e4', 'e5', 'Nf3']);
});

function positionsFor(moves) {
  const c = new Chess();
  const out = [];
  for (const san of moves) {
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

test('review: verdicts, accuracy and mistake types', () => {
  // 1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6?? 4. Qxf7#
  const positions = positionsFor(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
  const evals = [
    { score: { cp: 30 }, best: 'e2e4', pv: ['e2e4'] },
    { score: { cp: 30 }, best: 'e7e5', pv: ['e7e5'] },
    { score: { cp: 25 }, best: 'g1f3', pv: ['g1f3'] },
    { score: { cp: -20 }, best: 'b8c6', pv: ['b8c6'] },
    { score: { cp: 0 }, best: 'f1c4', pv: ['f1c4'] },
    { score: { cp: 0 }, best: 'g7g6', pv: ['g7g6', 'h5f3'] },
    { score: { mate: 1 }, best: 'h5f7', pv: ['h5f7'] },
    { score: { cp: 10000, terminal: 'checkmate' }, best: null, pv: [] },
  ];
  const r = buildReview(positions, evals, [2, 3, 4, 5, 6, 1, 2]);
  assert.equal(r.plies.length, 7);
  assert.equal(r.plies[0].verdict, 'best');
  assert.equal(r.plies[2].verdict, 'good'); // Qh5: 25cp -> -20cp ≈ 4.1% drop
  const nf6 = r.plies[5];
  assert.equal(nf6.verdict, 'blunder');
  assert.equal(nf6.type, 'walked-into-mate');
  assert.equal(nf6.bestSan, 'g6');
  assert.equal(r.plies[6].verdict, 'best');
  assert.ok(r.summary.w.accuracy > 90);
  assert.ok(r.summary.b.accuracy < r.summary.w.accuracy);
  assert.equal(r.summary.b.counts.blunder, 1);
});

test('mistake types: hanging piece, free piece', () => {
  // White's knight on e5 can just be taken by the d6 pawn... use a clear position:
  // 1. e4 d5 2. Qg4?? and the c8 bishop simply takes the queen.
  const hang = classifyMistake({
    fenBefore: 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    fenAfter: 'rnbqkbnr/ppp1pppp/8/3p4/4P1Q1/8/PPPP1PPP/RNB1KBNR b KQkq - 1 2',
    mover: 'w',
    moveNumber: 2,
    scoreBefore: { cp: 30 },
    scoreAfter: { cp: -800 },
    bestPv: ['e4d5'],
    replyPv: ['c8g4', 'f1e2'],
  });
  assert.equal(hang, 'hanging-piece');
  // A loose black knight on e5 that White's d4 pawn can take.
  const free = classifyMistake({
    fenBefore: 'r1bqkbnr/pppp1ppp/8/4n3/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 0 4',
    fenAfter: 'r1bqkbnr/pppp1ppp/8/4n3/3P4/7P/PPP2PP1/RNBQKBNR b KQkq - 0 4',
    mover: 'w',
    moveNumber: 14,
    scoreBefore: { cp: 300 },
    scoreAfter: { cp: 0 },
    bestPv: ['d4e5', 'd7d6'],
    replyPv: ['e5c6'],
  });
  assert.equal(free, 'missed-free-piece');
});

test('opening tree, lists and likely line', () => {
  const mk = (moves, outcome) => ({ moves: moves.split(' '), outcome });
  const games = [
    mk('e4 e5 Nf3 Nc6', 'loss'),
    mk('e4 e5 Nf3 Nc6', 'loss'),
    mk('e4 e5 Nf3 d6', 'win'),
    mk('e4 c5 Nf3 d6', 'win'),
    mk('e4 c5 Nf3 Nc6', 'win'),
    mk('d4 d5 c4', 'draw'),
  ];
  const tree = buildTree(games);
  assert.equal(tree.count, 6);
  assert.equal(nodeAt(tree, ['e4']).count, 5);
  near(scoreOf(nodeAt(tree, ['e4', 'e5'])), 1 / 3, 0.001);
  const { needsPractice, scoringWell } = lineLists(tree, { minGames: 2 });
  assert.deepEqual(needsPractice[0].path, ['e4', 'e5', 'Nf3', 'Nc6']);
  assert.ok(scoringWell.some((l) => pathText(l.path) === '1. e4 c5'));
  // Opponent as Black mostly answers 1. e4 with e5 and 2. Nf3 with Nc6.
  const theirs = buildTree([mk('e4 e5 Nf3 Nc6 Bc4', 'win'), mk('e4 e5 Nf3 Nc6 Bb5', 'loss'), mk('d4 Nf6', 'win')]);
  assert.deepEqual(likelyLine(tree, theirs, 'w', 4), ['e4', 'e5', 'Nf3', 'Nc6']);
});

test('puzzles and spaced repetition', () => {
  const game = { id: 'cc:1', myColor: 'b' };
  const review = {
    plies: [
      { i: 5, mover: 'b', verdict: 'blunder', best: 'g7g6', bestSan: 'g6', pv: ['g7g6'], san: 'Nf6', winBefore: 48, drop: 48, fenBefore: 'x', type: 'walked-into-mate' },
      { i: 7, mover: 'b', verdict: 'mistake', best: 'a7a6', bestSan: 'a6', pv: [], san: 'h6', winBefore: 10, drop: 8, fenBefore: 'y' },
      { i: 8, mover: 'w', verdict: 'blunder', best: 'a2a3', bestSan: 'a3', pv: [], san: 'h3', winBefore: 60, drop: 30, fenBefore: 'z' },
    ],
  };
  const now = Date.UTC(2026, 10, 16, 9);
  const ps = puzzlesFromReview(game, review, now);
  assert.equal(ps.length, 1); // opponent's blunder and the already-lost position are skipped
  let p = ps[0];
  assert.equal(p.type, 'walked-into-mate');
  p = schedule(p, 'right', now);
  assert.equal(p.box, 1);
  assert.equal(p.due, now + DAY);
  p = schedule(p, 'right', now);
  p = schedule(p, 'right', now);
  p = schedule(p, 'right', now);
  assert.equal(p.box, 4);
  assert.equal(p.due, now + 21 * DAY);
  p = schedule(p, 'wrong', now);
  assert.equal(p.box, 0);
  assert.equal(p.due, now + RETRY_MS);
  const counts = puzzleCounts([p], now + RETRY_MS);
  assert.equal(counts.due, 1);
  assert.equal(counts.doneToday, 1);
  assert.equal(dueQueue([p], { now }).length, 0);
  assert.equal(dueQueue([p], { now, anyway: true }).length, 1);
});
