import { MISTAKE_TYPES } from '../analysis.js';
import { SERIES, barList, resultBars, timeLineChart } from '../charts.js';
import { claudePanel } from '../claudePanel.js';
import { db, getKv, getSettings, on, saveSettings } from '../db.js';
import { autoSync } from '../main.js';
import { buildTree, lineLists, minGamesFor, pathText } from '../openings.js';
import { TERMINATION_LABELS } from '../pgn.js';
import { puzzleCounts } from '../puzzles.js';
import { enqueue } from '../reviewer.js';
import { accuracyByStage, averageAccuracy, endings, myMistakes, ratingSeries, resultsBy, timeLossShare } from '../stats.js';
import { myResult } from '../pgn.js';
import { TIME_CLASSES, TIME_CLASS_LABEL, capital, clear, emptyState, h, toast } from '../ui.js';

const FAST_SECONDS = 5;

export async function render(view) {
  const settings = await getSettings();
  if (!settings.username && (await db.count('games')) === 0) return welcome(view);

  const host = h('div.stack', { style: { gap: '14px' } });
  view.append(host);
  const draw = async () => {
    const [games, reviews, puzzles, stats] = await Promise.all([db.all('games'), db.all('reviews'), db.all('puzzles'), getKv('stats')]);
    clear(host);
    build(host, { games, reviews, puzzles, ratings: stats?.ratings ?? {}, settings });
  };
  await draw();
  let pending = 0;
  const redraw = () => {
    clearTimeout(pending);
    pending = setTimeout(draw, 400);
  };
  const offs = [on('games', redraw), on('reviews', redraw), on('puzzles', redraw), on('sync', (d) => d?.state === 'done' && redraw())];
  return () => offs.forEach((o) => o());
}

function welcome(view) {
  const input = h('input.input', { placeholder: 'Your chess.com username', autocomplete: 'off', autocapitalize: 'none', spellcheck: false, 'aria-label': 'chess.com username' });
  const msg = h('p.muted.small');
  view.append(
    h(
      'section.card',
      h('h1', 'Welcome to Post-Mortem'),
      h('p', 'Learn from your own games. Post-Mortem fetches your chess.com games, checks every move with Stockfish on this device, and turns your mistakes into puzzles.'),
      h(
        'form.stack',
        { onsubmit: async (e) => {
          e.preventDefault();
          const name = input.value.trim();
          if (!name) return;
          msg.textContent = 'Fetching your games…';
          await saveSettings({ username: name });
          const r = await autoSync({ force: true });
          if (!r) {
            msg.textContent = 'That did not work. Check the username and try again.';
            await saveSettings({ username: '' });
            return;
          }
          location.reload();
        } },
        h('label.field', 'chess.com username', input),
        h('div.row.wrap', h('button.btn.primary', { type: 'submit' }, 'Get started'), h('a.btn', { href: '#/games' }, 'Import a PGN instead')),
        msg,
      ),
      h('p.muted.small', 'No password needed: it only reads your public games. Everything stays in this browser.'),
    ),
  );
}

function build(host, { games, reviews, puzzles, ratings, settings }) {
  const mineGames = games.filter((g) => g.myColor);
  const counts = puzzleCounts(puzzles);
  const avgAcc = averageAccuracy(mineGames);
  const mistakes = myMistakes(games, reviews);
  const unreviewed = games.filter((g) => !g.reviewed);

  // ---------- Tiles ----------
  const tile = (label, value, sub) => h('div.tile', h('span.tile-label', label), h('span.tile-value', value), sub ? h('span.tile-sub', sub) : null);
  host.append(
    h('div.page-head', h('h1', settings.username ? `Hi ${settings.username}` : 'Home'), h('a.btn', { href: '#/games' }, 'Your games')),
    h(
      'div.tiles',
      ...TIME_CLASSES.filter((tc) => ratings[tc]?.rating).map((tc) => tile(TIME_CLASS_LABEL[tc], String(ratings[tc].rating), ratings[tc].best ? `best ${ratings[tc].best}` : null)),
      tile('Games', String(games.length), `${games.length - unreviewed.length} reviewed`),
      tile('Average accuracy', avgAcc != null ? `${Math.round(avgAcc)}%` : '–', 'in reviewed games'),
    ),
  );

  // ---------- Work on this next ----------
  const todo = [];
  const item = (icon, title, text, action) => h('div.todo', h('span.todo-icon', { 'aria-hidden': 'true' }, icon), h('div.todo-main', h('strong', title), text ? h('span.muted.small', text) : null, action ? h('div.row.wrap', action) : null));
  if (counts.due) todo.push(item('🧩', `${counts.due} puzzle${counts.due === 1 ? '' : 's'} due`, 'Moments from your own games, coming back at the right time.', h('a.btn.primary.small', { href: '#/puzzles' }, 'Solve them')));

  const typeCounts = {};
  mistakes.forEach((m) => (typeCounts[m.type] = (typeCounts[m.type] ?? 0) + 1));
  const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
  if (topType) todo.push(item('🎯', `Most common mistake: ${MISTAKE_TYPES[topType[0]]}`, `${topType[1]} of your ${mistakes.length} mistakes and blunders.`, h('a.btn.small', { href: `#/puzzles?type=${topType[0]}&anyway=1` }, 'Train')));

  const worst = worstLine(mineGames);
  if (worst) todo.push(item('📖', `Opening to fix: ${pathText(worst.path)}`, `As ${worst.colour === 'w' ? 'White' : 'Black'} you score ${Math.round(worst.score * 100)}% over ${worst.node.count} games.`, [h('a.btn.small', { href: `#/openings?colour=${worst.colour}&path=${encodeURIComponent(worst.path.join(' '))}` }, 'Look at it'), h('a.btn.small', { href: `#/play?moves=${encodeURIComponent(worst.path.join(' '))}&colour=${worst.colour}` }, 'Practise it')]));

  const timed = mistakes.filter((m) => m.timeSpent != null);
  const fast = timed.filter((m) => m.timeSpent < FAST_SECONDS);
  if (timed.length >= 5 && fast.length / timed.length >= 0.4) {
    todo.push(item('⏱️', `${Math.round((fast.length / timed.length) * 100)}% of your mistakes took under ${FAST_SECONDS} seconds`, 'Slow down on the moves that matter: before you move, ask "what does my opponent want to do?"'));
  }
  const tl = timeLossShare(mineGames.filter((g) => g.timeClass !== 'daily'));
  if (tl.losses >= 4 && tl.share >= 0.25) todo.push(item('⌛', `${Math.round(tl.share * 100)}% of your losses are on time`, `${tl.count} of ${tl.losses} losses. Try to keep a few minutes in hand for the endgame, or play a slightly longer time control.`));

  if (unreviewed.length) todo.push(item('🔍', `${unreviewed.length} game${unreviewed.length === 1 ? '' : 's'} not reviewed yet`, 'Reviews run on this device and turn your mistakes into puzzles.', h('button.btn.small', { type: 'button', onclick: () => {
    const n = enqueue(unreviewed);
    toast(n ? `Reviewing ${n} game${n === 1 ? '' : 's'}. Progress is on the Games tab.` : 'Already in the queue.');
  } }, 'Review all')));

  host.append(h('section.card', h('h2', 'Work on this next'), todo.length ? todo : h('p.muted', 'All caught up. Play a game, or practise anyway on the Puzzles tab.')));

  if (!games.length) {
    host.append(h('section.card', emptyState('No games yet', 'Sync from chess.com or import a PGN to see your charts.', h('a.btn.primary', { href: '#/games' }, 'Go to Games'))));
    return;
  }

  // ---------- Charts ----------
  const charts = h('div.grid');
  host.append(charts);
  const series = ratingSeries(games);
  const lines = TIME_CLASSES.map((tc, i) => ({ label: TIME_CLASS_LABEL[tc], color: SERIES[i], points: series[tc] ?? [] })).filter((s) => s.points.length > 1);
  if (lines.length) charts.append(h('section.card', h('h2', 'Rating over time'), timeLineChart(lines, { yLabel: 'Rating' })));

  const res = resultsBy(mineGames);
  charts.append(
    h(
      'section.card',
      h('h2', 'Results'),
      resultBars([
        { label: 'As White', ...res.byColour.w },
        { label: 'As Black', ...res.byColour.b },
        ...Object.entries(res.byClass).map(([tc, t]) => ({ label: TIME_CLASS_LABEL[tc] ?? capital(tc), ...t })),
      ]),
    ),
  );

  const ends = endings(mineGames);
  const endRows = (obj, color) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({ label: TERMINATION_LABELS[k] ?? k, value: v, color }));
  charts.append(
    h(
      'section.card',
      h('h2', 'How your games end'),
      h('h3.small.muted', 'Your wins'),
      Object.keys(ends.wins).length ? barList(endRows(ends.wins, 'var(--win)')) : h('p.muted.small', 'No wins yet.'),
      h('h3.small.muted', 'Your losses'),
      Object.keys(ends.losses).length ? barList(endRows(ends.losses, 'var(--loss)')) : h('p.muted.small', 'No losses yet.'),
    ),
  );

  const stage = accuracyByStage(games, reviews);
  if (Object.values(stage).some((v) => v != null)) {
    charts.append(
      h(
        'section.card',
        h('h2', 'Accuracy by stage of the game'),
        barList(
          [
            { label: 'Opening (moves 1–10)', value: stage.opening ?? 0, display: stage.opening != null ? `${Math.round(stage.opening)}%` : '–' },
            { label: 'Middlegame', value: stage.middlegame ?? 0, display: stage.middlegame != null ? `${Math.round(stage.middlegame)}%` : '–' },
            { label: 'Endgame', value: stage.endgame ?? 0, display: stage.endgame != null ? `${Math.round(stage.endgame)}%` : '–' },
          ],
          { max: 100 },
        ),
      ),
    );
  }

  if (mistakes.length) {
    charts.append(
      h(
        'section.card',
        h('h2', 'Your mistakes by type'),
        h('p.muted.small', 'Tap a type to train it.'),
        barList(
          Object.entries(typeCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([t, v]) => ({ label: MISTAKE_TYPES[t], value: v, onClick: () => (location.hash = `#/puzzles?type=${t}&anyway=1`), title: `Train: ${MISTAKE_TYPES[t]}` })),
        ),
      ),
    );
  }

  // ---------- Claude training plan ----------
  host.append(
    h(
      'section.card',
      h('h2', 'Your training plan'),
      h('p.muted.small', 'Claude looks at your numbers and suggests what to work on this week.'),
      claudePanel({
        label: 'Make me a training plan',
        question: 'Based on these numbers, give me a simple training plan for the next week: three priorities, what to do for each, and how I will know it is working.',
        facts: async () => planFacts({ games: mineGames, ratings, mistakes, typeCounts, stage, counts, worst, tl, fast, timed, ends }),
        extra: 'This is about the player’s statistics rather than one position, so use only the numbers given.',
        chips: ['Make it fit 20 minutes a day', 'Which opening should I learn next?', 'How do I stop blundering pieces?'],
      }).el,
    ),
  );
}

function worstLine(games) {
  let worst = null;
  for (const colour of ['w', 'b']) {
    const tree = buildTree(games.filter((g) => g.myColor === colour).map((g) => ({ moves: g.moves, outcome: myResult(g) })));
    const { needsPractice } = lineLists(tree, { minGames: minGamesFor(tree.count) });
    const cand = needsPractice.sort((a, b) => a.score - b.score || b.node.count - a.node.count)[0];
    if (cand && (!worst || cand.score < worst.score || (cand.score === worst.score && cand.node.count > worst.node.count))) worst = { ...cand, colour };
  }
  return worst;
}

function planFacts({ games, ratings, mistakes, typeCounts, stage, counts, worst, tl, fast, timed, ends }) {
  const res = resultsBy(games);
  return [
    `Ratings: ${TIME_CLASSES.filter((tc) => ratings[tc]?.rating).map((tc) => `${tc} ${ratings[tc].rating} (best ${ratings[tc].best ?? '?'})`).join(', ') || 'unknown'}.`,
    `Games saved: ${games.length}. Results as White W/D/L ${res.byColour.w.w}/${res.byColour.w.d}/${res.byColour.w.l}; as Black ${res.byColour.b.w}/${res.byColour.b.d}/${res.byColour.b.l}.`,
    `Mistakes and blunders found by the engine: ${mistakes.length}. By type: ${Object.entries(typeCounts).map(([t, n]) => `${MISTAKE_TYPES[t]} ${n}`).join(', ') || 'none yet'}.`,
    `Average accuracy by stage: opening ${fmt(stage.opening)}, middlegame ${fmt(stage.middlegame)}, endgame ${fmt(stage.endgame)}.`,
    timed.length ? `${fast.length} of ${timed.length} timed mistakes were played in under ${FAST_SECONDS} seconds.` : '',
    `Losses on time: ${tl.count} of ${tl.losses}.`,
    `How losses end: ${Object.entries(ends.losses).map(([k, v]) => `${TERMINATION_LABELS[k] ?? k} ${v}`).join(', ') || 'none'}.`,
    worst ? `Weakest opening line: ${pathText(worst.path)} as ${worst.colour === 'w' ? 'White' : 'Black'}, scoring ${Math.round(worst.score * 100)}% over ${worst.node.count} games.` : '',
    `Puzzles from my mistakes: ${counts.total} total, ${counts.due} due, ${counts.learned} learned.`,
  ]
    .filter(Boolean)
    .join('\n');
}

const fmt = (v) => (v == null ? 'not enough data' : `${Math.round(v)}%`);
