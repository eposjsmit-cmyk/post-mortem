import { Chess } from '../../vendor/chess.js';
import { MISTAKE_TYPES, VERDICT_INFO, fmtScore, lineText, uciToSan, winFor } from '../analysis.js';
import { arrow, badgeShape, createBoard, evalBar } from '../board.js';
import { positionFacts } from '../claude.js';
import { claudePanel } from '../claudePanel.js';
import { db, emit, on } from '../db.js';
import { evaluate, getEngine } from '../engine.js';
import { ALT_TOLERANCE, dueQueue, puzzleCounts, schedule } from '../puzzles.js';
import { clear, emptyState, fmtDate, h, timeAgo, toast } from '../ui.js';

/** Moves from the game shown before the puzzle position, so you can see how it came about. */
const CONTEXT_PLIES = 6;
/** The most moves you have to find in one puzzle. */
const MAX_STEPS = 3;
const CHECK_DEPTH = 14;
const LIVE_DEPTH = 18;

/** A short vibration on phones that support it (Android); silently does nothing elsewhere. */
const buzz = (pattern) => {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Not allowed here.
  }
};

const sanToUci = (fen, san) => {
  try {
    const m = new Chess(fen).move(san);
    return m.from + m.to + (m.promotion ?? '');
  } catch {
    return null;
  }
};

export async function render(view, { params }) {
  let type = params.type && MISTAKE_TYPES[params.type] ? params.type : null;
  let anyway = params.anyway === '1';
  let puzzles = [];
  let queue = [];
  let current = null;
  let session = null;

  const countsHost = h('div.tiles.compact');
  const chipsHost = h('div.chips.scroll');
  const mainHost = h('div');
  view.append(h('div.page-head', h('h1', 'Puzzles'), h('p.muted', 'Every puzzle is a moment from your own games where you went wrong.')), countsHost, chipsHost, mainHost);

  async function load(keepCurrent = false) {
    puzzles = await db.all('puzzles');
    renderCounts();
    renderChips();
    queue = dueQueue(puzzles, { type, anyway }).filter((x) => !keepCurrent || x.id !== current?.id);
    if (params.id && !keepCurrent) {
      const p = puzzles.find((x) => x.id === params.id);
      if (p) queue = [p, ...queue.filter((x) => x.id !== p.id)];
      params.id = null;
    }
    if (!keepCurrent) next();
  }

  function renderCounts() {
    const c = puzzleCounts(puzzles);
    clear(countsHost).append(tile('Due now', c.due), tile('Done today', c.doneToday), tile('Learned', c.learned, 'right 4 times in a row'), tile('All', c.total));
  }

  const tile = (label, value, sub) => h('div.tile', h('span.tile-label', label), h('span.tile-value', String(value)), sub ? h('span.tile-sub', sub) : null);

  function renderChips() {
    clear(chipsHost);
    const now = Date.now();
    const byType = {};
    for (const p of puzzles) {
      const t = (byType[p.type] ??= { due: 0, total: 0 });
      t.total++;
      if (p.due <= now) t.due++;
    }
    const chip = (t, label, count) =>
      h(`button.chip${type === t ? '.active' : ''}`, { type: 'button', 'aria-pressed': type === t, onclick: () => {
        type = t;
        load();
      } }, label, h('span.count', String(count)));
    chipsHost.append(chip(null, 'All types', anyway ? puzzles.length : puzzles.filter((p) => p.due <= now).length));
    for (const [t, label] of Object.entries(MISTAKE_TYPES)) {
      if (!byType[t]) continue;
      chipsHost.append(chip(t, label, anyway ? byType[t].total : byType[t].due));
    }
    chipsHost.append(
      h(`button.chip${anyway ? '.active' : ''}`, { type: 'button', 'aria-pressed': anyway, title: 'Include puzzles that are not due yet', onclick: () => {
        anyway = !anyway;
        load();
      } }, 'Practise anyway'),
    );
  }

  async function next() {
    session?.destroy();
    session = null;
    current = queue.shift() ?? null;
    clear(mainHost);
    if (!current) return renderEmpty();
    const game = await db.get('games', current.gameId);
    session = puzzleSession(mainHost, current, game);
    requestAnimationFrame(fitBoard);
  }

  /** Scrolls so the whole board sits between the message and the pinned buttons (phones). */
  function fitBoard() {
    const area = mainHost.querySelector('.board-area');
    const msg = mainHost.querySelector('.puzzle-status');
    if (!area || !msg) return;
    const dock = mainHost.querySelector('.dock');
    const dockTop = dock && getComputedStyle(dock).position === 'fixed' ? dock.getBoundingClientRect().top : innerHeight;
    const b = area.getBoundingClientRect();
    const top = msg.getBoundingClientRect().top;
    let by = 0;
    if (b.bottom > dockTop - 6) by = Math.min(b.bottom - dockTop + 10, top - 8);
    else if (top < 0) by = top - 8;
    if (Math.abs(by) > 2) window.scrollBy({ top: by, behavior: 'smooth' });
  }

  function renderEmpty() {
    const upcoming = puzzles.filter((p) => !type || p.type === type).sort((a, b) => a.due - b.due)[0];
    mainHost.append(
      h(
        'section.card',
        puzzles.length
          ? emptyState(
              'Nothing due right now',
              upcoming ? `Next puzzle is due ${upcoming.due > Date.now() ? `on ${fmtDate(upcoming.due)}` : 'now'}. Spaced repetition works best a little at a time.` : null,
              h('button.btn.primary', { type: 'button', onclick: () => {
                anyway = true;
                load();
              } }, 'Practise anyway'),
            )
          : emptyState('No puzzles yet', 'Review some games and every mistake or blunder you made becomes a puzzle here.', h('a.btn.primary', { href: '#/games' }, 'Go to Games')),
      ),
    );
  }

  /** Records the first outcome of this showing (later tries don't change the schedule). */
  async function record(p, result) {
    const updated = schedule(p, result);
    await db.put('puzzles', updated);
    if (current?.id === updated.id) current = updated;
    puzzles = puzzles.map((x) => (x.id === updated.id ? updated : x));
    renderCounts();
    renderChips();
    emit('puzzles', { updated: updated.id });
  }

  /**
   * One puzzle on screen. Two phases:
   *  'solve' – find the move(s); you can still step back through the game moves that led here.
   *  'done'  – free analysis: step through, move any piece, see the engine's best lines.
   */
  function puzzleSession(host, p, game) {
    const side = p.color === 'w' ? 'White' : 'Black';
    const myColour = p.color === 'w' ? 'white' : 'black';
    let destroyed = false;
    let phase = 'solve';
    let practice = false; // "Try again" rounds don't change the schedule
    let recorded = false;
    let attempt = { hint: 0, wrong: false };
    let busy = false;
    let showEngine = true;
    let liveJob = null;
    let liveResult = null;
    const stepWin = new Map(); // node index -> my winning chance there (for judging other good moves)

    // ---------- The line of positions ----------
    // nodes[i] = { fen, san, uci, kind } where san/uci is the move that led to this position.
    // kind: 'ctx' (game moves before the puzzle) | 'start' | 'sol' (solution) | 'reply' | 'alt' | 'game' | 'explore'
    const context = [];
    if (game?.moves?.length) {
      const c = new Chess();
      const from = Math.max(0, p.ply - CONTEXT_PLIES);
      const moves = game.moves.slice(0, p.ply);
      moves.forEach((san, i) => {
        if (i === from) context.push({ fen: c.fen(), san: null, uci: null, kind: 'ctx' });
        const m = c.move(san);
        if (i >= from) context.push({ fen: c.fen(), san: m.san, uci: m.from + m.to + (m.promotion ?? ''), kind: 'ctx' });
      });
      if (!context.length || context.at(-1).fen.split(' ').slice(0, 4).join(' ') !== p.fen.split(' ').slice(0, 4).join(' ')) context.length = 0;
    }
    if (!context.length) context.push({ fen: p.fen, san: null, uci: null, kind: 'ctx' });
    context.at(-1).kind = 'start';
    const startIdx = context.length - 1;
    let nodes = context.slice();
    let cursor = startIdx;
    stepWin.set(startIdx, p.winBefore);

    // The engine's solution line: my moves at even offsets, replies at odd ones.
    const line = [p.solution, ...(p.pv?.[0] === p.solution ? p.pv.slice(1) : [])];
    const steps = Math.min(MAX_STEPS, Math.ceil(line.length / 2));
    const stepOf = (i) => (i - startIdx) / 2; // which of my moves is due at node i
    const expectedAt = (i) => line[i - startIdx];

    // ---------- Layout ----------
    const bar = evalBar();
    bar.el.hidden = true;
    const boardCol = h('div.board-col');
    const status = h('p.puzzle-status');
    const strip = h('div.move-strip', { role: 'list', 'aria-label': 'Moves' });
    const enginePanel = h('section.card', { hidden: true });
    const after = h('div.stack');
    const navBtn = (label, title, fn) => h('button.btn.nav-sq', { type: 'button', title, 'aria-label': title, onclick: fn }, label);
    const firstBtn = navBtn('⏮', 'Back to the puzzle start', () => goTo(phase === 'solve' ? 0 : startIdx));
    const prevBtn = navBtn('◀', 'Previous move', () => goTo(cursor - 1));
    const nextBtn = navBtn('▶', 'Next move', () => goTo(cursor + 1));
    const hintBtn = h('button.btn', { type: 'button', onclick: hint }, 'Hint');
    const showBtn = h('button.btn', { type: 'button', onclick: reveal }, 'Answer');
    const skipBtn = h('button.btn', { type: 'button', onclick: () => next() }, 'Skip');
    const againBtn = h('button.btn', { type: 'button', hidden: true, onclick: tryAgain }, 'Try again');
    const nextPuzzleBtn = h('button.btn.primary', { type: 'button', hidden: true, onclick: () => next() }, 'Next ▸');
    const tools = h('div.row.wrap', { hidden: true });

    const opponent = game ? (p.color === 'w' ? game.black : game.white) : null;
    host.append(
      h(
        'div.split',
        h('div.stack', status, h('div.board-area', bar.el, boardCol), h('div.row.dock.puzzle-dock', firstBtn, prevBtn, nextBtn, hintBtn, showBtn, skipBtn, againBtn, nextPuzzleBtn), strip, tools),
        h(
          'div.side',
          h(
            'section.card',
            h('div.row.between', h('strong', MISTAKE_TYPES[p.type] ?? 'Puzzle'), h('span.muted.small', p.lastSeen ? `Last tried ${timeAgo(p.lastSeen)}` : 'New')),
            h('p.muted.small', [opponent ? `From your game vs ${opponent}` : 'From one of your games', game?.date ? fmtDate(game.date) : null, `move ${Math.floor(p.ply / 2) + 1}`].filter(Boolean).join(' · ')),
            h('p.muted.small', `Tap ◀ to see how the position came about. ${steps > 1 ? `This one is ${steps} moves deep.` : ''}`),
            h('a.small', { href: `#/review/${encodeURIComponent(p.gameId)}?ply=${p.ply}&autoreview=0` }, 'See it in the game →'),
          ),
          enginePanel,
          after,
          h('p.muted.small', `${queue.length} more ${anyway ? 'to practise' : 'due'} after this one.`),
        ),
      ),
    );

    const board = createBoard(boardCol, { fen: nodes[cursor].fen, orientation: myColour, interactive: true, movableColor: myColour, onMove: onMove });

    function setStatus(text, cls = '') {
      status.className = `puzzle-status ${cls}`;
      status.textContent = text;
    }

    // ---------- Drawing ----------
    function draw({ animate = false } = {}) {
      if (destroyed) return;
      const n = nodes[cursor];
      if (!animate) board.setPosition(n.fen, { lastMove: n.uci ? [n.uci.slice(0, 2), n.uci.slice(2, 4)] : undefined });
      const tip = cursor === nodes.length - 1;
      const myTurn = n.fen.split(' ')[1] === p.color;
      if (phase === 'solve') board.setInteractive(!busy && tip && myTurn, myColour);
      else board.setInteractive(true, null);
      prevBtn.disabled = cursor === 0;
      nextBtn.disabled = tip;
      firstBtn.disabled = cursor === (phase === 'solve' ? 0 : startIdx);
      if (phase === 'solve' && !busy) {
        if (cursor < startIdx) setStatus(`This is how the position came about. Tap ▶ to get back to the puzzle.`);
        else if (!tip) setStatus('Tap ⏭ or ▶ to get back to where you are solving.');
        else if (status.dataset.keep !== '1') setStatus(cursor === startIdx ? `Find the best move for ${side} (drag or tap a piece).` : `Good! Now find the next move for ${side}.`);
      }
      status.dataset.keep = '';
      renderStrip();
      refreshShapes();
      if (phase === 'done') startLive();
    }

    function refreshShapes() {
      const shapes = [];
      const n = nodes[cursor];
      if (phase === 'done') {
        if (cursor === startIdx) {
          shapes.push(arrow(p.solution, 'green'));
          const played = sanToUci(p.fen, p.played);
          if (played && played !== p.solution) shapes.push(arrow(played, 'red'));
        }
        if (n.kind === 'game') shapes.push(badgeShape(n.uci.slice(2, 4), p.verdict));
        if (showEngine && liveResult?.best && liveResult.fen === n.fen) shapes.push(arrow(liveResult.best, 'blue'));
      }
      board.setShapes(shapes);
    }

    function renderStrip() {
      clear(strip);
      nodes.forEach((n, i) => {
        if (i === 0) {
          strip.append(h(`button${cursor === 0 ? '.current' : ''}.ctx`, { type: 'button', onclick: () => goTo(0), title: 'Start' }, '⏮'));
          return;
        }
        if (i === startIdx + 1) strip.append(h('span.marker', { title: 'The puzzle starts here' }, '🧩'));
        const prev = nodes[i - 1].fen.split(' ');
        const num = prev[1] === 'w' ? `${prev[5]}.` : i === 1 || i === startIdx + 1 ? `${prev[5]}…` : '';
        if (num) strip.append(h('span.num', num));
        const sym = n.kind === 'game' ? VERDICT_INFO[p.verdict].symbol : n.kind === 'sol' || n.kind === 'alt' ? '✓' : '';
        strip.append(
          h(
            `button.${n.kind}${cursor === i ? '.current' : ''}`,
            { type: 'button', role: 'listitem', onclick: () => goTo(i) },
            n.san,
            sym ? h('span.msym', sym) : null,
          ),
        );
      });
      const cur = strip.querySelector('.current');
      if (cur) strip.scrollLeft = Math.max(0, cur.offsetLeft - strip.clientWidth / 2 + cur.offsetWidth / 2);
    }

    function goTo(i) {
      cursor = Math.max(0, Math.min(nodes.length - 1, i));
      draw();
    }

    // ---------- Solving ----------
    function push(node) {
      nodes = nodes.slice(0, cursor + 1);
      nodes.push(node);
      cursor = nodes.length - 1;
    }

    async function onMove(uci, chess, m) {
      if (phase === 'done') return explore(uci, chess, m);
      const at = cursor;
      const expected = expectedAt(at);
      const fenAfter = chess.fen();
      if (uci === expected) return correct({ fen: fenAfter, san: m.san, uci, kind: 'sol' });
      busy = true;
      board.setInteractive(false);
      setStatus('Checking your move…');
      const winBefore = stepWin.get(at) ?? winFor((await evaluate(getEngine('live'), nodes[at].fen, CHECK_DEPTH)).score, p.color);
      const r = await evaluate(getEngine('live'), fenAfter, CHECK_DEPTH);
      if (destroyed) return;
      const winAfter = winFor(r.score, p.color);
      const drop = winBefore - winAfter;
      busy = false;
      if (drop <= ALT_TOLERANCE) {
        const expectedSan = uciToSan(nodes[at].fen, [expected])[0];
        status.dataset.keep = '1';
        setStatus(`Good move! Not the engine's first choice (${expectedSan}), but just as strong.`, 'good');
        push({ fen: fenAfter, san: m.san, uci, kind: 'alt' });
        return finish(true);
      }
      attempt.wrong = true;
      buzz([60, 80, 60]);
      if (!practice && !recorded) {
        recorded = true;
        record(p, 'wrong');
      }
      const reply = r.best ? uciToSan(fenAfter, [r.best])[0] : null;
      board.setShapes([arrow(r.best, 'red')]);
      status.dataset.keep = '1';
      setStatus(
        reply
          ? `Not quite. After ${m.san}, ${p.color === 'w' ? 'Black' : 'White'} answers ${reply} (red arrow) and your winning chance falls to ${Math.round(winAfter)}%. Try again.`
          : `Not quite. That leaves you only ${Math.round(winAfter)}% winning chances. Try again.`,
        'bad',
      );
      busy = true;
      setTimeout(() => {
        if (destroyed || phase !== 'solve') return;
        busy = false;
        status.dataset.keep = '1';
        draw();
      }, 2200);
    }

    function correct(node) {
      buzz(40);
      push(node);
      const done = stepOf(cursor - 1) + 1 >= steps || !line[cursor - startIdx];
      if (done) return finish(false);
      draw();
      // The opponent answers, then it's my turn again.
      busy = true;
      board.setInteractive(false);
      status.dataset.keep = '1';
      setStatus('Correct! Watch the reply…', 'good');
      const replyUci = line[cursor - startIdx];
      setTimeout(() => {
        if (destroyed || phase !== 'solve') return;
        const fenBefore = nodes[cursor].fen;
        const m = new Chess(fenBefore).move({ from: replyUci.slice(0, 2), to: replyUci.slice(2, 4), promotion: replyUci[4] });
        const c = new Chess(fenBefore);
        c.move(m.san);
        board.playUci(replyUci);
        push({ fen: c.fen(), san: m.san, uci: replyUci, kind: 'reply' });
        busy = false;
        const at = cursor;
        // Work out my winning chance here in the background, to judge other good moves fairly.
        evaluate(getEngine('live'), c.fen(), CHECK_DEPTH).then((r) => stepWin.set(at, winFor(r.score, p.color)));
        status.dataset.keep = '';
        draw({ animate: true });
      }, 650);
    }

    function hint() {
      if (phase !== 'solve') return;
      if (cursor !== nodes.length - 1) goTo(nodes.length - 1);
      const expected = expectedAt(cursor);
      if (!expected) return;
      attempt.hint++;
      status.dataset.keep = '1';
      if (attempt.hint === 1) {
        board.setShapes([{ orig: expected.slice(0, 2), brush: 'green' }]);
        setStatus('The circled piece is the one to move. Tap Hint again to see where.');
      } else {
        board.setShapes([arrow(expected, 'green')]);
        setStatus('Play the move shown by the arrow.');
      }
    }

    function reveal() {
      if (phase !== 'solve') return;
      if (!practice && !recorded) {
        recorded = true;
        record(p, 'revealed');
      }
      // Fill in the rest of the solution so you can step through it.
      cursor = nodes.length - 1;
      const firstShown = cursor + 1;
      let fen = nodes[cursor].fen;
      for (let k = cursor - startIdx; k < Math.min(line.length, steps * 2); k++) {
        const c = new Chess(fen);
        let m;
        try {
          m = c.move({ from: line[k].slice(0, 2), to: line[k].slice(2, 4), promotion: line[k][4] });
        } catch {
          break;
        }
        nodes.push({ fen: c.fen(), san: m.san, uci: line[k], kind: k % 2 === 0 ? 'sol' : 'reply' });
        fen = c.fen();
      }
      cursor = Math.min(firstShown, nodes.length - 1);
      status.dataset.keep = '1';
      setStatus(`The answer was ${nodes[cursor].san}. Tap ▶ to see how it goes on.${practice ? '' : ' You will get this one again in 10 minutes.'}`);
      finish(null);
    }

    /** solvedAlt: true = a different good move, false = the engine's line, null = answer shown. */
    function finish(solvedAlt) {
      phase = 'done';
      busy = false;
      if (solvedAlt !== null) {
        const result = attempt.wrong ? 'wrong' : attempt.hint ? 'hint' : 'right';
        if (!practice && !recorded) {
          recorded = true;
          record(p, result);
        }
        if (solvedAlt === false) {
          status.dataset.keep = '1';
          setStatus(practice ? 'Solved again. Nice!' : result === 'right' ? 'Solved, first time! This puzzle moves further back.' : 'Solved. You will see this one again soon.', 'good');
        }
      }
      hintBtn.hidden = true;
      showBtn.hidden = true;
      skipBtn.hidden = true;
      againBtn.hidden = false;
      nextPuzzleBtn.hidden = false;
      bar.el.hidden = false;
      enginePanel.hidden = false;
      renderTools();
      renderAfter();
      draw();
    }

    function tryAgain() {
      stopLive();
      practice = true;
      phase = 'solve';
      attempt = { hint: 0, wrong: false };
      nodes = context.slice();
      cursor = startIdx;
      hintBtn.hidden = false;
      showBtn.hidden = false;
      skipBtn.hidden = false;
      againBtn.hidden = true;
      nextPuzzleBtn.hidden = true;
      bar.el.hidden = true;
      enginePanel.hidden = true;
      tools.hidden = true;
      clear(after);
      status.dataset.keep = '1';
      setStatus(`Practice round (doesn't change your schedule). Find the best move for ${side}.`);
      draw();
    }

    // ---------- Analysis (after solving) ----------
    function explore(uci, chess, m) {
      if (nodes[cursor + 1]?.uci === uci) return goTo(cursor + 1);
      push({ fen: chess.fen(), san: m.san, uci, kind: 'explore' });
      draw({ animate: true });
    }

    function renderTools() {
      tools.hidden = false;
      const playedUci = sanToUci(p.fen, p.played);
      clear(tools).append(
        h('button.btn.small', { type: 'button', onclick: () => {
          const c = new Chess(p.fen);
          c.move(p.played);
          cursor = startIdx;
          push({ fen: c.fen(), san: p.played, uci: playedUci, kind: 'game' });
          draw();
          status.dataset.keep = '1';
          setStatus(`This is what you played in the game. The blue arrow shows how your opponent could punish it.`, 'bad');
        } }, 'Your game move'),
        h('button.btn.small', { type: 'button', onclick: showSolution }, 'The best line'),
        game ? h('button.btn.small', { type: 'button', onclick: playOn }, 'Play on vs computer') : null,
        h('label.check.small', h('input', { type: 'checkbox', checked: showEngine, onchange: (e) => {
          showEngine = e.target.checked;
          enginePanel.hidden = !showEngine;
          bar.el.hidden = !showEngine;
          refreshShapes();
        } }), 'Engine'),
      );
    }

    function showSolution() {
      nodes = context.slice();
      let fen = p.fen;
      for (let k = 0; k < line.length && k < 10; k++) {
        const c = new Chess(fen);
        let m;
        try {
          m = c.move({ from: line[k].slice(0, 2), to: line[k].slice(2, 4), promotion: line[k][4] });
        } catch {
          break;
        }
        nodes.push({ fen: c.fen(), san: m.san, uci: line[k], kind: k % 2 === 0 ? 'sol' : 'reply' });
        fen = c.fen();
      }
      cursor = startIdx;
      status.dataset.keep = '1';
      setStatus('The engine’s best line. Tap ▶ to step through it, or move any piece to try your own ideas.');
      draw();
    }

    function playOn() {
      const moves = [...game.moves.slice(0, p.ply), ...nodes.slice(startIdx + 1, cursor + 1).map((n) => n.san)];
      location.hash = `#/play?moves=${encodeURIComponent(moves.join(' '))}&colour=${p.color}`;
    }

    function stopLive() {
      const job = liveJob;
      liveJob = null;
      job?.cancel();
    }

    function startLive() {
      stopLive();
      liveResult = null;
      const fen = nodes[cursor].fen;
      const c = new Chess(fen);
      const linesEl = h('div.lines', h('p.muted.small', c.isGameOver() ? (c.isCheckmate() ? 'Checkmate.' : 'Game over.') : 'Thinking…'));
      clear(enginePanel).append(h('div.card-head', h('h2', 'What’s best here?'), h('span.muted.small', 'tap a line to play it')), linesEl);
      if (c.isGameOver() || !showEngine) {
        bar.update(c.isCheckmate() ? { cp: c.turn() === 'w' ? -10000 : 10000 } : null, c.isCheckmate() ? '#' : '');
        return;
      }
      const job = getEngine('live').analyse(fen, {
        depth: LIVE_DEPTH,
        multipv: Math.min(3, c.moves().length),
        priority: true,
        onInfo: (r) => {
          if (job !== liveJob || destroyed) return;
          liveResult = { ...r, fen };
          clear(linesEl);
          r.lines.forEach((l) => {
            const sans = uciToSan(fen, l.pv, 8);
            const win = Math.round(winFor(l.score, p.color));
            linesEl.append(
              h(
                'button.line.line-btn',
                { type: 'button', title: 'Play this line', onclick: () => {
                  let f = fen;
                  for (const u of l.pv.slice(0, 1)) {
                    const cc = new Chess(f);
                    const mm = cc.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
                    push({ fen: cc.fen(), san: mm.san, uci: u, kind: 'explore' });
                    f = cc.fen();
                  }
                  draw();
                } },
                h('span.score', fmtScore(l.score)),
                h('span.pv', lineText(fen, sans)),
                h('span.muted.small.win', `${win}%`),
              ),
            );
          });
          linesEl.append(h('p.muted.small', `Depth ${r.depth} · the % is your winning chance`));
          bar.update(r.lines[0]?.score, fmtScore(r.lines[0]?.score));
          refreshShapes();
        },
      });
      liveJob = job;
    }

    function renderAfter() {
      const sol = uciToSan(p.fen, line, 8);
      clear(after).append(
        h(
          'section.card',
          claudePanel({
            label: 'Explain this puzzle',
            question: `Explain why ${p.solutionSan} is the right move here and what was wrong with ${p.played}. What pattern should I remember?`,
            facts: async () =>
              [
                `Puzzle from my own game. I am ${side}.`,
                positionFacts(p.fen),
                `In the game I played ${lineText(p.fen, [p.played])}; my winning chance dropped ${p.drop.toFixed(1)}% (verdict: ${p.verdict}).`,
                `My winning chance before the move: ${Math.round(p.winBefore)}%.`,
                `Engine's best move: ${p.solutionSan}. Engine line: ${lineText(p.fen, sol.length ? sol : [p.solutionSan])}.`,
                `Mistake type (tagged by the app): ${MISTAKE_TYPES[p.type]}.`,
              ].join('\n'),
            chips: ['What should I look for to spot this in a game?', 'What happens after my game move?'],
            compact: true,
          }).el,
        ),
      );
    }

    const onKey = (e) => {
      if (e.target.closest('input, textarea, select, dialog')) return;
      if (e.key === 'ArrowLeft') goTo(cursor - 1);
      else if (e.key === 'ArrowRight') goTo(cursor + 1);
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);

    draw();

    return {
      destroy() {
        destroyed = true;
        document.removeEventListener('keydown', onKey);
        stopLive();
        board.destroy();
      },
    };
  }

  const off = on('puzzles', ({ added } = {}) => {
    if (added) {
      toast(`${added} new puzzle${added === 1 ? '' : 's'} from your latest review.`);
      load(true);
    }
  });
  await load();
  return () => {
    off();
    session?.destroy();
  };
}
