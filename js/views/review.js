import { Chess } from '../../vendor/chess.js';
import { MISTAKE_TYPES, VERDICT_INFO, fmtScore, lineText, uciToSan, whiteWin } from '../analysis.js';
import { VERDICT_COLOURS, arrow, badgeShape, createBoard, evalBar } from '../board.js';
import { advantageGraph } from '../charts.js';
import { QUICK_QUESTIONS, moveFacts, positionFacts } from '../claude.js';
import { claudePanel } from '../claudePanel.js';
import { db, emit, getSettings, on, saveSettings } from '../db.js';
import { getEngine } from '../engine.js';
import { TERMINATION_LABELS, myResult, parseTimeControl } from '../pgn.js';
import { puzzlesFromReview } from '../puzzles.js';
import { positionsOf, queueState, reviewNow } from '../reviewer.js';
import { TIME_CLASS_LABEL, clear, emptyState, fmtClock, fmtDate, fmtSeconds, h, progressBar, toast } from '../ui.js';

const LIVE_DEPTH = 18;

export async function render(view, { arg, params }) {
  let game = await db.get('games', arg);
  if (!game) {
    view.append(emptyState('Game not found', 'It may have been deleted.', h('a.btn', { href: '#/games' }, 'Back to games')));
    return;
  }
  let review = await db.get('reviews', game.id);
  const settings = await getSettings();
  const positions = positionsOf(game);
  const n = game.moves.length;
  let idx = params.ply != null ? Math.max(0, Math.min(n, Number(params.ply))) : n;
  let variation = null; // { fens: [fen...], moves: [{ san, uci }] } when exploring my own line
  let showEngineArrow = settings.showEngineArrow;
  let liveJob = null;
  let liveResult = null;

  const me = game.myColor;
  const orientation = (settings.boardFlipped ? me !== 'b' : me === 'b') ? 'black' : 'white';

  // ---------- Layout ----------
  const topPlayer = h('div.player');
  const bottomPlayer = h('div.player');
  const bar = evalBar();
  const boardCol = h('div.board-col');
  const area = h('div.board-area', bar.el, boardCol);
  const banner = h('div');
  const liveHost = h('section.card');
  const graphHost = h('div');
  const movesHost = h('div.moves.desktop-only', { role: 'list' });
  const stripHost = h('div.move-strip.phone-only', { role: 'list', 'aria-label': 'Moves' });
  const reportHost = h('section.card');
  const varHost = h('div');
  const whyHost = h('div');

  const btn = (label, title, fn, cls = '') => h(`button.btn${cls}`, { type: 'button', title, 'aria-label': title, onclick: fn }, label);
  const nav = h(
    'div.nav-buttons.dock',
    btn('⏮', 'Start', () => goTo(0)),
    btn('◀', 'Previous move', () => step(-1)),
    btn('▶', 'Next move', () => step(1), '.next'),
    btn('⏭', 'End', () => goTo(n)),
    btn('⇅', 'Flip board', () => {
      board.flip();
      saveSettings({ boardFlipped: !settings.boardFlipped });
      settings.boardFlipped = !settings.boardFlipped;
      bar.setFlipped(board.orientation() === 'black');
      renderPlayers();
    }),
  );
  const arrowToggle = h('label.check.small', h('input', { type: 'checkbox', checked: showEngineArrow, onchange: (e) => {
    showEngineArrow = e.target.checked;
    saveSettings({ showEngineArrow });
    refreshShapes();
  } }), 'Show the engine’s best move now (blue arrow)');

  const res = myResult(game);
  view.append(
    h(
      'div.page-head',
      h('div.stack', { style: { gap: '2px' } }, h('h1', `${game.white} vs ${game.black}`), h('p.muted.small', [TIME_CLASS_LABEL[game.timeClass] ?? game.timeClass, fmtDate(game.date), game.opening, res ? { win: 'You won', loss: 'You lost', draw: 'Draw' }[res] : game.result].filter(Boolean).join(' · '))),
      h('a.btn', { href: '#/games' }, '← Games'),
    ),
    h(
      'div.split',
      h('div.stack', topPlayer, area, bottomPlayer, nav, varHost, banner, stripHost, whyHost, arrowToggle),
      h('div.side', liveHost, h('section.card', h('h2', 'Advantage'), graphHost, movesHost), reportHost),
    ),
  );

  const board = createBoard(boardCol, { fen: positions[idx].fen, orientation, interactive: true, onMove: onUserMove });
  bar.setFlipped(orientation === 'black');

  // ---------- Helpers ----------
  const plyAt = (i) => review?.plies[i] ?? null; // the move from position i to i+1
  const currentFen = () => (variation ? variation.fens[variation.fens.length - 1] : positions[idx].fen);

  function scoreAtIdx() {
    if (!review) return null;
    if (idx === 0) return review.plies[0]?.scoreBefore ?? null;
    return review.plies[idx - 1]?.scoreAfter ?? review.finalScore;
  }

  function clocksAt(i) {
    const tc = parseTimeControl(game.timeControl);
    const c = game.clocks ?? [];
    if (!c.length || !tc) return { w: null, b: null };
    const last = (side) => {
      for (let k = i - 1; k >= 0; k--) if ((k % 2 === 0) === (side === 'w') && c[k] != null) return c[k];
      return tc.base;
    };
    return { w: last('w'), b: last('b') };
  }

  function renderPlayers() {
    const clocks = clocksAt(idx);
    const turn = positions[idx].mover;
    const row = (side) => {
      const name = side === 'w' ? game.white : game.black;
      const elo = side === 'w' ? game.whiteElo : game.blackElo;
      const acc = review?.summary[side]?.accuracy;
      return [
        h(`span.dot-colour.${side}`),
        h('span.name', `${name}${elo ? ` (${elo})` : ''}${side === me ? ' · you' : ''}`),
        acc != null ? h('span.pill', { title: 'Accuracy' }, `${Math.round(acc)}%`) : null,
        clocks[side] != null ? h(`span.clock${!variation && turn === side && idx < n ? '.active' : ''}`, fmtClock(clocks[side])) : null,
      ];
    };
    const bottomSide = board.orientation() === 'white' ? 'w' : 'b';
    clear(bottomPlayer).append(...row(bottomSide));
    clear(topPlayer).append(...row(bottomSide === 'w' ? 'b' : 'w'));
  }

  function refreshShapes() {
    const shapes = [];
    if (!variation && idx > 0) {
      const p = plyAt(idx - 1);
      if (p) {
        shapes.push(badgeShape(p.uci.slice(2, 4), p.verdict));
        if (!['best', 'forced', 'excellent'].includes(p.verdict)) shapes.push(arrow(p.best, 'green'));
      }
    }
    if (showEngineArrow) {
      const best = liveResult?.best ?? (!variation ? plyAt(idx)?.best : null);
      if (best) shapes.push(arrow(best, 'blue'));
    }
    board.setShapes(shapes);
  }

  function renderBanner() {
    clear(banner);
    clear(whyHost);
    if (variation) return;
    if (idx === 0) {
      banner.append(h('div.move-banner', h('strong', 'Start of the game'), h('span.muted', 'Use ▶ or the arrow keys to step through the moves.')));
      return;
    }
    const p = plyAt(idx - 1);
    const san = game.moves[idx - 1];
    const moveNo = Math.ceil(idx / 2);
    const label = `${moveNo}${idx % 2 === 1 ? '.' : '...'} ${san}`;
    if (!p) {
      banner.append(h('div.move-banner', h('strong', label), h('span.muted', 'Not reviewed yet.')));
      return;
    }
    const info = VERDICT_INFO[p.verdict];
    const who = p.mover === me ? 'your' : me ? 'their' : p.mover === 'w' ? "White's" : "Black's";
    const lines = [];
    if (p.verdict === 'forced') lines.push('The only legal move.');
    else if (p.verdict === 'best') lines.push(p.uci === p.best ? 'The engine’s top move.' : `As good as the engine’s move (${p.bestSan}).`);
    else lines.push(`Best was ${p.bestSan} · ${who} winning chances dropped ${p.drop.toFixed(1)}%`);
    banner.append(
      h(
        `div.move-banner.v-${p.verdict}`,
        h('div.row.between', h('span.verdict', h('span.verdict-sym', info.symbol), `${label} · ${info.label}`), h('span.muted.small', `${fmtScore(p.scoreAfter)}`)),
        h('span', lines.join(' ')),
        h('span.muted.small', [p.timeSpent != null ? `Time spent: ${fmtSeconds(p.timeSpent)}` : null, p.type ? `Type: ${MISTAKE_TYPES[p.type]}` : null, `Winning chance ${Math.round(p.winBefore)}% → ${Math.round(p.winAfter)}%`].filter(Boolean).join(' · ')),
      ),
    );
    const bad = ['inaccuracy', 'mistake', 'blunder'].includes(p.verdict);
    const panel = claudePanel({
      label: bad ? 'Why was this a mistake?' : 'Explain this move',
      question: bad
        ? `Why was ${label} a ${info.label.toLowerCase()}, and why is ${p.bestSan} better? Explain it so I can spot it next time.`
        : `Explain the idea behind ${label} in this position.`,
      facts: async () => moveFacts(p),
      chips: QUICK_QUESTIONS,
      compact: true,
    });
    whyHost.append(h('section.card', panel.el));
  }

  function renderMoves() {
    clear(movesHost);
    for (let i = 0; i < n; i += 2) {
      movesHost.append(h('span.num', `${i / 2 + 1}.`));
      for (const k of [i, i + 1]) {
        if (k >= n) {
          movesHost.append(h('span'));
          continue;
        }
        const p = plyAt(k);
        const sym = p && !['best', 'excellent', 'good', 'forced'].includes(p.verdict) ? VERDICT_INFO[p.verdict].symbol : '';
        movesHost.append(
          h(
            `button${!variation && idx === k + 1 ? '.current' : ''}${p ? `.v-${p.verdict}` : ''}`,
            { type: 'button', role: 'listitem', onclick: () => goTo(k + 1), 'aria-label': `${game.moves[k]}${p ? `, ${VERDICT_INFO[p.verdict].label}` : ''}` },
            game.moves[k],
            sym ? h('span.msym', sym) : null,
          ),
        );
      }
    }
    // Keep the current move visible by scrolling the move list only, never the page
    // (scrollIntoView would drag the whole page down to the list on a phone).
    const cur = movesHost.querySelector('.current');
    if (cur) {
      const top = cur.offsetTop;
      const bottom = top + cur.offsetHeight;
      if (top < movesHost.scrollTop || bottom > movesHost.scrollTop + movesHost.clientHeight) {
        movesHost.scrollTop = Math.max(0, top - movesHost.clientHeight / 2);
      }
    }

    // Phone strip: one row of moves that scrolls sideways.
    clear(stripHost);
    for (let k = 0; k < n; k++) {
      if (k % 2 === 0) stripHost.append(h('span.num', `${k / 2 + 1}.`));
      const p = plyAt(k);
      const sym = p && !['best', 'excellent', 'good', 'forced'].includes(p.verdict) ? VERDICT_INFO[p.verdict].symbol : '';
      stripHost.append(
        h(
          `button${!variation && idx === k + 1 ? '.current' : ''}${p ? `.v-${p.verdict}` : ''}`,
          { type: 'button', role: 'listitem', onclick: () => goTo(k + 1), 'aria-label': `${game.moves[k]}${p ? `, ${VERDICT_INFO[p.verdict].label}` : ''}` },
          game.moves[k],
          sym ? h('span.msym', sym) : null,
        ),
      );
    }
    const sc = stripHost.querySelector('.current');
    if (sc) stripHost.scrollLeft = Math.max(0, sc.offsetLeft - stripHost.clientWidth / 2 + sc.offsetWidth / 2);
    else if (idx === 0) stripHost.scrollLeft = 0;
  }

  let graph = null;
  function renderGraph() {
    clear(graphHost);
    if (!review) return;
    const pts = [{ win: whiteWin(review.plies[0]?.scoreBefore ?? { cp: 0 }) }];
    review.plies.forEach((p) => pts.push({ win: whiteWin(p.scoreAfter), verdict: p.verdict, label: `${Math.ceil((p.i + 1) / 2)}${p.mover === 'w' ? '.' : '...'} ${p.san}: ${VERDICT_INFO[p.verdict].label}` }));
    graph = advantageGraph(pts, { onPick: goTo, colours: VERDICT_COLOURS });
    graphHost.append(graph.el);
    graph.setCursor(idx);
  }

  function renderReport() {
    clear(reportHost);
    if (!review) {
      const q = queueState();
      const inQueue = q.running?.id === game.id || q.queue.some((g) => g.id === game.id);
      const start = h('button.btn.primary', { type: 'button', onclick: runReview }, 'Review this game');
      reportHost.append(
        h('h2', 'Game report'),
        h('p.muted', 'Stockfish will check every move on your device. It takes about half a minute.'),
        inQueue ? h('p', 'In the review queue…') : start,
        h('div#review-progress'),
      );
      return;
    }
    const s = review.summary;
    const cell = (v) => h('span.num', String(v));
    const rows = ['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder', 'forced'];
    reportHost.append(
      h('h2', 'Game report'),
      h(
        'div.report',
        h('span'),
        h('span.head', { style: { textAlign: 'center' } }, game.white),
        h('span.head', { style: { textAlign: 'center' } }, game.black),
        h('span', 'Accuracy'),
        h('span.num.acc', s.w.accuracy != null ? `${Math.round(s.w.accuracy)}` : '–'),
        h('span.num.acc', s.b.accuracy != null ? `${Math.round(s.b.accuracy)}` : '–'),
        ...rows.flatMap((v) => [h(`span.verdict.v-${v}`, h('span.verdict-sym', VERDICT_INFO[v].symbol), VERDICT_INFO[v].label), cell(s.w.counts[v]), cell(s.b.counts[v])]),
      ),
    );
    const big = review.plies.filter((p) => p.verdict === 'blunder' || p.verdict === 'mistake').sort((a, b) => b.drop - a.drop).slice(0, 8).sort((a, b) => a.i - b.i);
    if (big.length) {
      reportHost.append(
        h('h3', 'Jump to the big moments'),
        h('div.chips', big.map((p) => h(`button.chip.v-${p.verdict}`, { type: 'button', onclick: () => goTo(p.i + 1), title: `${VERDICT_INFO[p.verdict].label}, −${p.drop.toFixed(0)}%` }, h('span.verdict-sym', VERDICT_INFO[p.verdict].symbol), ` ${Math.ceil((p.i + 1) / 2)}${p.mover === 'w' ? '.' : '...'} ${p.san}${p.mover === me ? ' (you)' : ''}`))),
      );
    }
    const summary = claudePanel({
      label: 'Summarise this game',
      question: 'Give me a short summary of this game: how it went, the turning points, and the two or three things I should work on.',
      facts: async () => gameFacts(),
      chips: ['What was my biggest mistake and why?', 'What did I do well?', 'What should I practise because of this game?'],
    });
    reportHost.append(h('h3', 'Claude coach'), summary.el);
    reportHost.append(
      h(
        'dl.kv',
        h('dt', 'Opening'),
        h('dd', game.opening || game.eco || '–'),
        h('dt', 'Time control'),
        h('dd', game.timeControl || '–'),
        h('dt', 'Ended by'),
        h('dd', TERMINATION_LABELS[game.termination] ?? game.terminationText ?? '–'),
        game.url ? h('dt', 'Link') : null,
        game.url ? h('dd', h('a', { href: game.url, target: '_blank', rel: 'noopener' }, 'Open on chess.com')) : null,
      ),
    );
    if (!me) {
      reportHost.append(
        h('p.muted.small', 'Which side were you? This turns your mistakes into puzzles.'),
        h('div.row', h('button.btn', { type: 'button', onclick: () => setSide('w') }, 'I was White'), h('button.btn', { type: 'button', onclick: () => setSide('b') }, 'I was Black')),
      );
    }
  }

  async function setSide(c) {
    game = { ...game, myColor: c };
    await db.put('games', game);
    const fresh = puzzlesFromReview(game, review);
    if (fresh.length) {
      await db.putMany('puzzles', fresh);
      emit('puzzles', { added: fresh.length });
    }
    toast(`Saved. ${fresh.length} puzzle${fresh.length === 1 ? '' : 's'} added.`);
    location.reload();
  }

  function gameFacts() {
    const s = review.summary;
    const lines = [
      `Game: ${game.white} (${game.whiteElo ?? '?'}) vs ${game.black} (${game.blackElo ?? '?'}), ${TIME_CLASS_LABEL[game.timeClass] ?? game.timeClass} ${game.timeControl}, result ${game.result}, ended by ${TERMINATION_LABELS[game.termination] ?? game.termination}.`,
      me ? `I played ${me === 'w' ? 'White' : 'Black'}.` : '',
      `Opening: ${game.opening || game.eco || 'unknown'}.`,
      `Moves: ${lineText(positions[0].fen, game.moves)}`,
      `Accuracy: White ${s.w.accuracy ?? '–'}%, Black ${s.b.accuracy ?? '–'}%.`,
      `Verdict counts (White / Black): ${Object.keys(s.w.counts).map((k) => `${k} ${s.w.counts[k]}/${s.b.counts[k]}`).join(', ')}.`,
      'Key moments (engine facts):',
      ...review.plies
        .filter((p) => ['inaccuracy', 'mistake', 'blunder'].includes(p.verdict))
        .map((p) => `- ${lineText(p.fenBefore, [p.san])} by ${p.mover === 'w' ? 'White' : 'Black'}: ${p.verdict}, best was ${p.bestSan} (line ${lineText(p.fenBefore, uciToSan(p.fenBefore, p.pv, 5))}), winning chance ${Math.round(p.winBefore)}% → ${Math.round(p.winAfter)}%${p.type ? `, type: ${MISTAKE_TYPES[p.type]}` : ''}${p.timeSpent != null ? `, ${p.timeSpent}s spent` : ''}.`),
    ];
    return lines.filter(Boolean).join('\n');
  }

  async function runReview() {
    const host = reportHost.querySelector('#review-progress');
    reportHost.querySelector('button')?.setAttribute('disabled', '');
    if (host) clear(host).append(h('p.muted.small', 'Waiting for the engine…'));
    const off = on('review-queue', (st) => {
      if (!host) return;
      if (st.running?.id !== game.id) {
        clear(host).append(h('p.muted.small', 'Finishing the game the engine is busy with, then this one is next…'));
        return;
      }
      clear(host).append(progressBar(st.progress, 'Review progress'), h('p.muted.small', `Checking move ${Math.round(st.progress * (n + 1))} of ${n + 1}…`));
    });
    const r = await reviewNow(game);
    off();
    if (r && !review) {
      review = r;
      game = (await db.get('games', game.id)) ?? game;
      toast('Review finished.');
      update();
      renderReport();
      renderGraph();
    }
  }

  // ---------- Live engine ----------
  function startLive() {
    liveJob?.cancel();
    liveResult = null;
    const fen = currentFen();
    const c = new Chess(fen);
    clear(liveHost).append(h('div.card-head', h('h2', 'Engine'), h('span.muted.small', `Stockfish · depth ${LIVE_DEPTH}`)));
    const linesEl = h('div.lines', h('p.muted.small', c.isGameOver() ? 'Game over.' : 'Thinking…'));
    liveHost.append(linesEl);
    if (c.isGameOver()) return;
    const job = getEngine('live').analyse(fen, {
      depth: LIVE_DEPTH,
      multipv: Math.min(3, c.moves().length),
      priority: true,
      onInfo: (r) => {
        if (job !== liveJob) return;
        liveResult = r;
        clear(linesEl);
        for (const l of r.lines) {
          const sans = uciToSan(fen, l.pv, 10);
          linesEl.append(h('div.line', h('span.score', fmtScore(l.score)), h('span.pv', lineText(fen, sans))));
        }
        linesEl.append(h('p.muted.small', `Depth ${r.depth}`));
        if (variation || !review) bar.update(r.lines[0]?.score, fmtScore(r.lines[0]?.score));
        refreshShapes();
      },
    });
    liveJob = job;
  }

  // ---------- Navigation ----------
  function update() {
    const fen = currentFen();
    const lastMove = variation ? variation.moves.at(-1)?.uci : idx > 0 ? positions[idx - 1].uci : null;
    board.setPosition(fen, { lastMove: lastMove ? [lastMove.slice(0, 2), lastMove.slice(2, 4)] : undefined });
    const score = variation ? null : scoreAtIdx();
    if (score) bar.update(score, fmtScore(score));
    else if (!variation) bar.update(null, '');
    renderPlayers();
    renderBanner();
    renderMoves();
    renderVariation();
    graph?.setCursor(idx);
    refreshShapes();
    startLive();
  }

  function goTo(i) {
    variation = null;
    idx = Math.max(0, Math.min(n, i));
    update();
  }
  function step(d) {
    if (variation) {
      if (d < 0) {
        variation.fens.pop();
        variation.moves.pop();
        if (!variation.moves.length) variation = null;
        update();
      }
      return;
    }
    goTo(idx + d);
  }

  function onUserMove(uci, chess, m) {
    if (!variation && idx < n && positions[idx].uci === uci) {
      idx++;
      update();
      return;
    }
    if (!variation) variation = { base: idx, fens: [positions[idx].fen], moves: [] };
    variation.fens.push(chess.fen());
    variation.moves.push({ san: m.san, uci });
    update();
  }

  function renderVariation() {
    clear(varHost);
    if (!variation) return;
    const baseFen = variation.fens[0];
    varHost.append(
      h(
        'div.move-banner',
        h('strong', 'Trying your own line'),
        h('span', lineText(baseFen, variation.moves.map((m) => m.san))),
        h('span.muted.small', 'The engine below is checking this position. Drag pieces to keep going.'),
        h('div.row.wrap', h('button.btn.primary', { type: 'button', onclick: () => goTo(variation.base) }, 'Back to the game'), h('button.btn', { type: 'button', onclick: () => step(-1) }, 'Undo')),
      ),
    );
    const panel = claudePanel({
      label: 'Ask about this line',
      question: 'I tried this line instead of the game move. Is it a good idea? What does the engine’s answer show?',
      facts: async () => {
        const r = liveResult;
        const top = r?.lines?.map((l) => `${fmtScore(l.score)}: ${lineText(currentFen(), uciToSan(currentFen(), l.pv, 8))}`).join('\n') ?? 'not ready yet';
        return `Starting position:\n${positionFacts(baseFen)}\nMy line: ${lineText(baseFen, variation.moves.map((m) => m.san))}\nPosition now:\n${positionFacts(currentFen())}\nEngine lines now (White's view, depth ${r?.depth ?? '?'}):\n${top}`;
      },
      chips: QUICK_QUESTIONS.slice(0, 3),
      compact: true,
    });
    varHost.append(h('section.card', panel.el));
  }

  const onKey = (e) => {
    if (e.target.closest('input, textarea, select, dialog')) return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'Home') goTo(0);
    else if (e.key === 'End') goTo(n);
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  update();
  renderGraph();
  renderReport();
  // Opening an unreviewed game moves it to the front of the review queue.
  if (!review && settings.autoReview && params.autoreview !== '0') runReview();

  // If the background queue finishes this game while the screen is open, show it.
  const offReviews = on('reviews', async ({ gameId }) => {
    if (gameId !== game.id || review) return;
    review = await db.get('reviews', game.id);
    game = (await db.get('games', game.id)) ?? game;
    update();
    renderReport();
    renderGraph();
  });

  return () => {
    offReviews();
    document.removeEventListener('keydown', onKey);
    // Clear liveJob first so the engine's final update for it is ignored.
    const job = liveJob;
    liveJob = null;
    job?.cancel();
    board.destroy();
  };
}
