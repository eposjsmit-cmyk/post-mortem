import { Chess } from '../../vendor/chess.js';
import { VERDICT_INFO, fmtScore, lineText, uciToSan, verdictFor, winFor } from '../analysis.js';
import { arrow, badgeShape, createBoard, evalBar } from '../board.js';
import { positionFacts } from '../claude.js';
import { claudePanel } from '../claudePanel.js';
import { db, emit, getSettings } from '../db.js';
import { evaluate, getEngine } from '../engine.js';
import { gameFromPgn } from '../pgn.js';
import { clear, h, toast } from '../ui.js';

export const LEVELS = [
  { n: 1, elo: '≈400', skill: 0, depth: 1, random: 0.35 },
  { n: 2, elo: '≈700', skill: 1, depth: 2, random: 0.2 },
  { n: 3, elo: '≈1000', skill: 4, depth: 4, random: 0.1 },
  { n: 4, elo: '≈1300', skill: 7, depth: 6, random: 0.05 },
  { n: 5, elo: '≈1700', skill: 11, depth: 8, random: 0 },
  { n: 6, elo: '≈2100', skill: 15, depth: 12, random: 0 },
  { n: 7, elo: '2500+', skill: 20, depth: 16, random: 0 },
];

const ANALYSIS_DEPTH = 12;

export async function render(view, { params }) {
  const startMoves = params.moves ? params.moves.split(/[ ,]+/).filter(Boolean) : [];
  let colourChoice = params.colour === 'b' ? 'b' : params.colour === 'w' ? 'w' : 'w';
  let level = Number(localStorage.getItem('pm-level')) || 3;
  let game = null;

  const setupHost = h('section.card');
  const playHost = h('div');
  view.append(h('div.page-head', h('h1', 'Play vs Stockfish'), h('p.muted', 'Every move you make gets checked, so you learn as you play.')), setupHost, playHost);

  function renderSetup() {
    const chip = (active, label, fn, title) => h(`button.chip${active ? '.active' : ''}`, { type: 'button', 'aria-pressed': active, onclick: fn, title }, label);
    let start = null;
    if (startMoves.length) {
      try {
        const c = new Chess();
        startMoves.forEach((m) => c.move(m));
        start = lineText(new Chess().fen(), startMoves);
      } catch {
        start = null;
      }
    }
    clear(setupHost).append(
      h('h2', 'New game'),
      start ? h('p', 'Starting from: ', h('strong', start)) : null,
      h('span.label.small.muted', 'Level'),
      h('div.chips', LEVELS.map((l) => chip(level === l.n, `${l.n} · ${l.elo}`, () => {
        level = l.n;
        localStorage.setItem('pm-level', String(level));
        renderSetup();
      }))),
      h('span.label.small.muted', 'You play'),
      h('div.chips', chip(colourChoice === 'w', 'White', () => ((colourChoice = 'w'), renderSetup())), chip(colourChoice === 'b', 'Black', () => ((colourChoice = 'b'), renderSetup())), chip(colourChoice === 'r', 'Random', () => ((colourChoice = 'r'), renderSetup()))),
      h('div.row.wrap', h('button.btn.primary', { type: 'button', onclick: startGame }, game ? 'Start a new game' : 'Start game')),
    );
  }

  function startGame() {
    game?.destroy();
    const me = colourChoice === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : colourChoice;
    game = newGame(playHost, { me, level: LEVELS[level - 1], startMoves });
    setupHost.hidden = true;
  }

  renderSetup();
  if (params.moves || params.start === '1') startGame();
  return () => game?.destroy();

  function newGame(host, { me, level: lvl, startMoves: pre }) {
    clear(host);
    const chess = new Chess();
    for (const m of pre) {
      try {
        chess.move(m);
      } catch {
        break;
      }
    }
    const preCount = chess.history().length;
    const myMoves = new Map(); // ply index -> { verdict, best, drop, ... }
    let evalBefore = null; // analysis of the position before my move
    let evalJob = null;
    let over = false;
    let destroyed = false;
    let hintUsed = 0;

    const bar = evalBar();
    const boardCol = h('div.board-col');
    const status = h('p.puzzle-status');
    const feedback = h('div.stack');
    const movesEl = h('p.small');
    const hintBtn = h('button.btn', { type: 'button', onclick: hint }, 'Hint');
    const takeBtn = h('button.btn', { type: 'button', onclick: takeBack }, 'Take back');
    const resignBtn = h('button.btn.danger', { type: 'button', onclick: resign }, 'Resign');
    const reviewBtn = h('button.btn.primary', { type: 'button', hidden: true, onclick: saveAndReview }, 'Review this game');
    const newBtn = h('button.btn', { type: 'button', onclick: () => {
      setupHost.hidden = false;
      setupHost.scrollIntoView({ behavior: 'smooth' });
    } }, 'New game');

    host.append(
      h(
        'div.split',
        h('div.stack', h('div.player', h(`span.dot-colour.${me === 'w' ? 'b' : 'w'}`), h('span.name', `Stockfish level ${lvl.n} (${lvl.elo})`)), h('div.board-area', bar.el, boardCol), h('div.player', h(`span.dot-colour.${me}`), h('span.name', 'You'))),
        h('div.side', h('section.card', status, h('div.row.wrap.dock', hintBtn, takeBtn, resignBtn, reviewBtn, newBtn)), feedback, h('section.card', h('h3', 'Moves'), movesEl)),
      ),
    );

    const board = createBoard(boardCol, { fen: chess.fen(), orientation: me === 'w' ? 'white' : 'black', interactive: true, movableColor: me === 'w' ? 'white' : 'black', onMove: onMyMove });
    bar.setFlipped(me === 'b');

    const analyser = getEngine('live');
    const player = getEngine('play');
    player.newGame();

    function setStatus(text, cls = '') {
      status.className = `puzzle-status ${cls}`;
      status.textContent = text;
    }

    function renderMoves() {
      const hist = chess.history();
      const parts = [];
      hist.forEach((san, i) => {
        if (i % 2 === 0) parts.push(h('span.muted', ` ${i / 2 + 1}.`));
        const v = myMoves.get(i);
        parts.push(` ${san}`, v && !['best', 'excellent', 'good', 'forced'].includes(v.verdict) ? h(`span.msym.v-${v.verdict}`, { style: { color: 'var(--v)', fontWeight: 800 } }, VERDICT_INFO[v.verdict].symbol) : null);
      });
      clear(movesEl).append(...(parts.length ? parts.filter(Boolean) : ['No moves yet.']));
    }

    /** Analyse the position before my move, in the background. */
    function analyseMyTurn() {
      evalJob?.cancel();
      evalBefore = null;
      const fen = chess.fen();
      const job = analyser.analyse(fen, { depth: ANALYSIS_DEPTH, priority: true });
      evalJob = job;
      job.promise.then((r) => {
        if (job !== evalJob || r.cancelled || destroyed) return;
        evalBefore = { fen, score: r.lines[0]?.score ?? { cp: 0 }, best: r.best, pv: r.lines[0]?.pv ?? [] };
        bar.update(evalBefore.score, fmtScore(evalBefore.score));
      });
    }

    async function onMyMove(uci, _boardChess, m) {
      if (over) return;
      // The board keeps its own copy of the game; keep ours in step.
      chess.move(m.san);
      const index = chess.history().length - 1;
      board.setInteractive(false);
      renderMoves();
      // The verdict is worked out alongside the engine's reply.
      finishFeedback(index, uci, m);
      if (checkOver()) return;
      setStatus('Stockfish is thinking…');
      await botMove();
    }

    async function finishFeedback(index, uci, m) {
      const fenBefore = new Chess();
      const hist = chess.history();
      for (const san of hist.slice(0, index)) fenBefore.move(san);
      const before = evalBefore?.fen === fenBefore.fen() ? evalBefore : await evaluate(analyser, fenBefore.fen(), ANALYSIS_DEPTH);
      const afterFen = (() => {
        const c = new Chess(fenBefore.fen());
        c.move(m.san);
        return c.fen();
      })();
      const after = await evaluate(analyser, afterFen, ANALYSIS_DEPTH);
      if (destroyed) return;
      const winBefore = winFor(before.score, me);
      const winAfter = winFor(after.score, me);
      const drop = Math.max(0, winBefore - winAfter);
      const legal = new Chess(fenBefore.fen()).moves().length;
      const verdict = verdictFor({ forced: legal === 1, isBest: before.best === uci, drop });
      const bestSan = before.best ? uciToSan(fenBefore.fen(), [before.best])[0] : null;
      const info = { verdict, best: before.best, bestSan, drop, winBefore, winAfter, san: m.san, fenBefore: fenBefore.fen(), pv: before.pv, scoreBefore: before.score, scoreAfter: after.score };
      myMoves.set(index, info);
      renderMoves();
      showFeedback(info, m.to);
    }

    function showFeedback(info, toSquare) {
      const v = VERDICT_INFO[info.verdict];
      const bad = ['inaccuracy', 'mistake', 'blunder'].includes(info.verdict);
      board.setShapes([badgeShape(toSquare, info.verdict), bad ? arrow(info.best, 'green') : null]);
      clear(feedback).append(
        h(
          `section.card.move-banner.v-${info.verdict}`,
          h('span.verdict', h('span.verdict-sym', v.symbol), `${info.san} · ${v.label}`),
          info.verdict === 'best' || info.verdict === 'forced'
            ? h('span', info.verdict === 'forced' ? 'The only legal move.' : 'Spot on.')
            : h('span', `Best was ${info.bestSan} · your winning chances dropped ${info.drop.toFixed(1)}%`),
          h('span.muted.small', `Winning chance ${Math.round(info.winBefore)}% → ${Math.round(info.winAfter)}%`),
        ),
        bad
          ? h(
              'section.card',
              claudePanel({
                label: 'Why?',
                question: `Why was ${info.san} a ${v.label.toLowerCase()} and why is ${info.bestSan} better?`,
                facts: async () =>
                  [
                    `Practice game against Stockfish. I am ${me === 'w' ? 'White' : 'Black'}.`,
                    `Position before my move:\n${positionFacts(info.fenBefore)}`,
                    `I played ${lineText(info.fenBefore, [info.san])} (verdict: ${info.verdict}).`,
                    `Evaluation before: ${fmtScore(info.scoreBefore)} (White's view), after: ${fmtScore(info.scoreAfter)}. My winning chance ${Math.round(info.winBefore)}% → ${Math.round(info.winAfter)}%.`,
                    `Engine's best move: ${info.bestSan}. Engine line: ${lineText(info.fenBefore, uciToSan(info.fenBefore, info.pv, 8))}.`,
                  ].join('\n'),
                compact: true,
              }).el,
            )
          : null,
      );
    }

    async function botMove() {
      if (over || destroyed) return;
      const fen = chess.fen();
      const legal = chess.moves({ verbose: true });
      let uci;
      if (lvl.random && Math.random() < lvl.random) {
        const m = legal[Math.floor(Math.random() * legal.length)];
        uci = m.from + m.to + (m.promotion ?? '');
        await new Promise((r) => setTimeout(r, 350));
      } else {
        const t0 = performance.now();
        const r = await player.analyse(fen, { depth: lvl.depth, skill: lvl.skill }).promise;
        uci = r.best;
        const wait = 350 - (performance.now() - t0);
        if (wait > 0) await new Promise((res) => setTimeout(res, wait));
      }
      if (destroyed || over || chess.fen() !== fen || !uci) return;
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      board.playUci(m.from + m.to + (m.promotion ?? ''));
      renderMoves();
      if (checkOver()) return;
      board.setInteractive(true, me === 'w' ? 'white' : 'black');
      setStatus('Your move.');
      analyseMyTurn();
    }

    function checkOver() {
      if (!chess.isGameOver()) return false;
      over = true;
      board.setInteractive(false);
      let text;
      if (chess.isCheckmate()) text = chess.turn() === me ? 'Checkmate. Stockfish wins this one.' : 'Checkmate! You win.';
      else if (chess.isStalemate()) text = 'Stalemate: a draw.';
      else if (chess.isThreefoldRepetition()) text = 'Draw by repetition.';
      else if (chess.isInsufficientMaterial()) text = 'Draw: not enough pieces left to checkmate.';
      else if (chess.isDrawByFiftyMoves()) text = 'Draw by the 50-move rule.';
      else text = 'Draw.';
      endGame(text, chess.isCheckmate() ? (chess.turn() === 'w' ? '0-1' : '1-0') : '1/2-1/2');
      return true;
    }

    let result = '*';
    function endGame(text, res) {
      result = res;
      over = true;
      evalJob?.cancel();
      setStatus(text, res === '1/2-1/2' ? '' : (res === '1-0') === (me === 'w') ? 'good' : 'bad');
      hintBtn.hidden = true;
      takeBtn.hidden = true;
      resignBtn.hidden = true;
      reviewBtn.hidden = chess.history().length - preCount < 2;
    }

    function hint() {
      if (over) return;
      hintUsed++;
      if (evalBefore?.best) board.setShapes([arrow(evalBefore.best, 'blue')]);
      else {
        setStatus('Working out a hint…');
        evaluate(analyser, chess.fen(), ANALYSIS_DEPTH).then((r) => {
          board.setShapes([arrow(r.best, 'blue')]);
          setStatus('Your move.');
        });
      }
    }

    function takeBack() {
      if (over) return;
      player.cancelAll();
      // Undo back to my previous turn: my move plus the engine's reply.
      const myTurnNow = chess.turn() === me;
      const undo = myTurnNow ? 2 : 1;
      for (let i = 0; i < undo && chess.history().length > preCount; i++) {
        myMoves.delete(chess.history().length - 1);
        chess.undo();
      }
      board.setPosition(chess.fen());
      clear(feedback);
      renderMoves();
      if (chess.turn() === me) {
        board.setInteractive(true, me === 'w' ? 'white' : 'black');
        setStatus('Your move.');
        analyseMyTurn();
      } else botMove();
    }

    function resign() {
      if (over) return;
      endGame('You resigned. Review the game to see where it turned.', me === 'w' ? '0-1' : '1-0');
    }

    async function saveAndReview() {
      const { username } = await getSettings();
      const c = new Chess();
      const now = new Date();
      const pad = (x) => String(x).padStart(2, '0');
      c.setHeader('Event', `Post-Mortem practice vs Stockfish level ${lvl.n}`);
      c.setHeader('Site', 'Post-Mortem');
      c.setHeader('Date', `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`);
      c.setHeader('White', me === 'w' ? username || 'You' : `Stockfish level ${lvl.n}`);
      c.setHeader('Black', me === 'b' ? username || 'You' : `Stockfish level ${lvl.n}`);
      c.setHeader('Result', result);
      c.setHeader('Termination', status.textContent);
      for (const san of chess.history()) c.move(san);
      const g = gameFromPgn(c.pgn(), { myColor: me, source: 'play', extra: { timeClass: 'practice', timeControl: '', date: Date.now() } });
      g.id = `play:${Date.now()}`;
      await db.put('games', g);
      emit('games', { added: 1 });
      toast('Saved to your games. Reviewing now…');
      location.hash = `#/review/${encodeURIComponent(g.id)}`;
    }

    renderMoves();
    if (chess.turn() === me) {
      setStatus(pre.length ? 'Your move. Play on from this opening.' : 'Your move.');
      analyseMyTurn();
    } else {
      board.setInteractive(false);
      setStatus('Stockfish is thinking…');
      botMove();
    }

    return {
      destroy() {
        destroyed = true;
        evalJob?.cancel();
        player.cancelAll();
        board.destroy();
      },
    };
  }
}
