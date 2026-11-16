import { MISTAKE_TYPES, lineText, uciToSan, winFor } from '../analysis.js';
import { arrow, createBoard } from '../board.js';
import { positionFacts } from '../claude.js';
import { claudePanel } from '../claudePanel.js';
import { db, emit, on } from '../db.js';
import { evaluate, getEngine } from '../engine.js';
import { ALT_TOLERANCE, dueQueue, puzzleCounts, schedule } from '../puzzles.js';
import { clear, emptyState, fmtDate, h, timeAgo, toast } from '../ui.js';

export async function render(view, { params }) {
  let type = params.type && MISTAKE_TYPES[params.type] ? params.type : null;
  let anyway = params.anyway === '1';
  let puzzles = [];
  let queue = [];
  let current = null;
  let attempt = null; // { hint, wrong, revealed, solved, recorded }
  let board = null;

  const countsHost = h('div.tiles');
  const chipsHost = h('div.chips');
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
    clear(countsHost).append(
      tile('Due now', c.due),
      tile('Done today', c.doneToday),
      tile('Learned', c.learned, 'right 4 times in a row'),
      tile('All puzzles', c.total),
    );
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

  function next() {
    board?.destroy();
    board = null;
    current = queue.shift() ?? null;
    attempt = { hint: false, wrong: false, revealed: false, solved: false, recorded: false };
    renderPuzzle();
  }

  function renderPuzzle() {
    clear(mainHost);
    if (!current) {
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
      return;
    }
    const p = current;
    const side = p.color === 'w' ? 'White' : 'Black';
    const status = h('p.puzzle-status', `Find the best move for ${side}.`);
    const boardHost = h('div.board-col');
    const after = h('div.stack');
    const hintBtn = h('button.btn', { type: 'button', onclick: hint }, 'Hint');
    const showBtn = h('button.btn', { type: 'button', onclick: reveal }, 'Show answer');
    const skipBtn = h('button.btn', { type: 'button', onclick: skip }, 'Skip');
    const nextBtn = h('button.btn.primary', { type: 'button', hidden: true, onclick: next }, 'Next puzzle');

    mainHost.append(
      h(
        'div.split',
        h('div.stack', h('div.board-area', boardHost)),
        h(
          'div.side',
          h(
            'section.card',
            h('div.row.between', h('strong', MISTAKE_TYPES[p.type] ?? 'Puzzle'), h('span.muted.small', p.lastSeen ? `Last tried ${timeAgo(p.lastSeen)}` : 'New')),
            status,
            h('p.muted.small', `In the game you played ${lineText(p.fen, [p.played])} and your winning chances dropped ${Math.round(p.drop)}%.`),
            h('div.row.wrap', hintBtn, showBtn, skipBtn, nextBtn),
            h('a.small', { href: `#/review/${encodeURIComponent(p.gameId)}?ply=${p.ply}&autoreview=0` }, 'See it in the game →'),
          ),
          after,
          h('p.muted.small', `${queue.length} more ${anyway ? 'to practise' : 'due'} after this one.`),
        ),
      ),
    );

    board = createBoard(boardHost, { fen: p.fen, orientation: p.color === 'w' ? 'white' : 'black', interactive: true, movableColor: p.color === 'w' ? 'white' : 'black', onMove: tryMove });

    async function tryMove(uci, chess) {
      if (attempt.solved || attempt.revealed) return;
      if (uci === p.solution) return solved(false);
      board.setInteractive(false);
      status.className = 'puzzle-status';
      status.textContent = 'Checking your move…';
      const fenAfter = chess.fen();
      const r = await evaluate(getEngine('live'), fenAfter, 14);
      const winAfter = winFor(r.score, p.color);
      const drop = p.winBefore - winAfter;
      if (drop <= ALT_TOLERANCE) return solved(true, uci, drop);
      attempt.wrong = true;
      await record('wrong');
      status.className = 'puzzle-status bad';
      status.textContent = `Not quite. That keeps only ${Math.round(winAfter)}% winning chances (a drop of ${Math.round(drop)}%). Try again.`;
      setTimeout(() => {
        if (attempt.solved || attempt.revealed) return;
        board.setPosition(p.fen);
        board.setInteractive(true, p.color === 'w' ? 'white' : 'black');
      }, 900);
    }

    async function solved(alternative, uci, drop) {
      attempt.solved = true;
      board.setInteractive(false);
      const result = attempt.wrong ? 'wrong' : attempt.hint ? 'hint' : 'right';
      await record(result);
      status.className = 'puzzle-status good';
      status.textContent = alternative
        ? `Good move! It's not the engine's first choice (${p.solutionSan}), but it's just as strong${drop > 0.5 ? ` (only ${drop.toFixed(1)}% less)` : ''}.`
        : result === 'right'
          ? 'Correct, first time! This puzzle moves further back.'
          : 'Correct. You will see this one again soon.';
      if (alternative) board.setShapes([arrow(p.solution, 'blue'), arrow(uci, 'green')]);
      finish();
    }

    function hint() {
      attempt.hint = true;
      board.setShapes([{ orig: p.solution.slice(0, 2), brush: 'green' }]);
      status.className = 'puzzle-status';
      status.textContent = 'The circled piece is the one to move.';
    }

    async function reveal() {
      if (attempt.solved) return;
      attempt.revealed = true;
      await record('revealed');
      board.setPosition(p.fen);
      board.setInteractive(false);
      board.playUci(p.solution);
      board.setShapes([arrow(p.solution, 'green')]);
      status.className = 'puzzle-status';
      status.textContent = `The answer is ${p.solutionSan}. You'll get this one again in 10 minutes.`;
      finish();
    }

    function skip() {
      next();
    }

    function finish() {
      hintBtn.hidden = true;
      showBtn.hidden = true;
      skipBtn.hidden = true;
      nextBtn.hidden = false;
      const line = uciToSan(p.fen, p.pv, 8);
      clear(after).append(
        h('section.card', h('h3', 'The engine’s line'), h('p', lineText(p.fen, line.length ? line : [p.solutionSan]))),
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
                `Engine's best move: ${p.solutionSan}. Engine line: ${lineText(p.fen, line.length ? line : [p.solutionSan])}.`,
                `Mistake type (tagged by the app): ${MISTAKE_TYPES[p.type]}.`,
              ].join('\n'),
            chips: ['What should I look for to spot this in a game?', 'What happens after my game move?'],
            compact: true,
          }).el,
        ),
      );
    }
  }

  /** Records the first outcome of this showing (later tries don't change the schedule). */
  async function record(result) {
    if (attempt.recorded) return;
    attempt.recorded = true;
    const updated = schedule(current, result);
    await db.put('puzzles', updated);
    current = updated;
    puzzles = puzzles.map((x) => (x.id === updated.id ? updated : x));
    renderCounts();
    renderChips();
    emit('puzzles', { updated: updated.id });
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
    board?.destroy();
  };
}
