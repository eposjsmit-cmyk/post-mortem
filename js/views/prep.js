import { fetchGames, fetchStats } from '../chesscom.js';
import { claudePanel } from '../claudePanel.js';
import { db, getKv, setKv } from '../db.js';
import { explorer, lineItem } from '../explorer.js';
import { buildTree, likelyLine, lineLists, minGamesFor, pathText } from '../openings.js';
import { TERMINATION_LABELS, myResult } from '../pgn.js';
import { barList } from '../charts.js';
import { TIME_CLASS_LABEL, TIME_CLASSES, clear, emptyState, h, progressBar, toast, wdlBar } from '../ui.js';

const MONTHS = 3;

export async function render(view, { params }) {
  let recent = await getKv('recentOpponents', []);
  const input = h('input.input', { name: 'opp', placeholder: 'Opponent’s chess.com username', autocomplete: 'off', autocapitalize: 'none', spellcheck: false, 'aria-label': 'Opponent username' });
  const recentHost = h('div.chips');
  const out = h('div.stack', { style: { gap: '14px' } });
  let exp = null;

  view.append(
    h('div.page-head', h('h1', 'Opponent prep'), h('p.muted', 'Scout someone before you play them.')),
    h(
      'section.card',
      h('form.row', { onsubmit: (e) => {
        e.preventDefault();
        scout(input.value.trim());
      } }, input, h('button.btn.primary', { type: 'submit' }, 'Scout')),
      recentHost,
    ),
    out,
  );

  function renderRecent() {
    clear(recentHost).append(...recent.map((r) => h('button.chip', { type: 'button', onclick: () => scout(r.name) }, r.name)));
  }
  renderRecent();

  async function scout(name) {
    if (!name) return;
    input.value = name;
    exp?.destroy();
    exp = null;
    const bar = h('div', progressBar(0, 'Loading their games'));
    clear(out).append(h('section.card', h('p', `Fetching ${name}’s games from the last ${MONTHS} months…`), bar));
    let games;
    let ratings;
    try {
      [games, ratings] = await Promise.all([
        fetchGames(name, MONTHS, { onProgress: (p) => clear(bar).append(progressBar(p, 'Loading their games')) }),
        fetchStats(name).catch(() => ({})),
      ]);
    } catch (e) {
      clear(out).append(h('section.card', emptyState('Could not scout that player', e.message)));
      return;
    }
    recent = [{ name, at: Date.now() }, ...recent.filter((r) => r.name.toLowerCase() !== name.toLowerCase())].slice(0, 6);
    await setKv('recentOpponents', recent);
    renderRecent();
    const mine = (await db.all('games')).filter((g) => g.myColor && myResult(g));
    show(name, games, ratings, mine);
  }

  function show(name, games, ratings, mine) {
    clear(out);
    const theirs = games.filter((g) => g.myColor && myResult(g)); // myColor here = the opponent's side
    if (!theirs.length) {
      out.append(h('section.card', emptyState(`No standard games found for ${name}`, `Nothing in the last ${MONTHS} months.`)));
      return;
    }
    const lower = name.toLowerCase();
    const tally = (list) => {
      const t = { w: 0, d: 0, l: 0 };
      list.forEach((g) => (t[{ win: 'w', draw: 'd', loss: 'l' }[myResult(g)]] += 1));
      return t;
    };
    const overall = tally(theirs);
    const asWhite = tally(theirs.filter((g) => g.myColor === 'w'));
    const asBlack = tally(theirs.filter((g) => g.myColor === 'b'));
    const avgMoves = Math.round(theirs.reduce((s, g) => s + Math.ceil(g.moves.length / 2), 0) / theirs.length);
    const lossEnds = {};
    theirs.filter((g) => myResult(g) === 'loss').forEach((g) => (lossEnds[g.termination] = (lossEnds[g.termination] ?? 0) + 1));
    const h2h = mine.filter((g) => (g.myColor === 'w' ? g.black : g.white).toLowerCase() === lower);
    const h2hTally = tally(h2h);

    const recordRow = (label, t) => h('div.hbar-row', h('span.hbar-label', label), wdlBar(t), h('span.hbar-value', `${t.w}/${t.d}/${t.l}`));
    out.append(
      h(
        'div.tiles',
        ...TIME_CLASSES.filter((tc) => ratings?.[tc]?.rating).map((tc) => h('div.tile', h('span.tile-label', TIME_CLASS_LABEL[tc]), h('span.tile-value', String(ratings[tc].rating)), h('span.tile-sub', `best ${ratings[tc].best ?? '–'}`))),
        h('div.tile', h('span.tile-label', 'Games scouted'), h('span.tile-value', String(theirs.length)), h('span.tile-sub', `last ${MONTHS} months`)),
        h('div.tile', h('span.tile-label', 'Average length'), h('span.tile-value', String(avgMoves)), h('span.tile-sub', 'moves')),
      ),
      h(
        'div.grid',
        h('section.card', h('h2', `${name}’s record`), h('p.muted.small', 'Won / drawn / lost'), recordRow('Overall', overall), recordRow('As White', asWhite), recordRow('As Black', asBlack), h2h.length ? [h('p.muted.small', 'Your head-to-head record against them:'), recordRow('You vs them', h2hTally)] : h('p.muted.small', 'You have not played them in your saved games.')),
        h(
          'section.card',
          h('h2', 'How their losses end'),
          Object.keys(lossEnds).length
            ? barList(Object.entries(lossEnds).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: TERMINATION_LABELS[k] ?? k, value: v, color: 'var(--loss)' })))
            : h('p.muted', 'No losses in these games.'),
        ),
      ),
    );

    const prepHost = h('div.stack', { style: { gap: '14px' } });
    let myColour = params.colour === 'b' ? 'b' : 'w';
    const colourChips = h('div.chips');
    out.append(h('section.card', h('h2', 'Your colour against them'), colourChips), prepHost);

    const renderPrep = () => {
      clear(colourChips).append(
        h(`button.chip${myColour === 'w' ? '.active' : ''}`, { type: 'button', onclick: () => ((myColour = 'w'), renderPrep()) }, 'I’m White'),
        h(`button.chip${myColour === 'b' ? '.active' : ''}`, { type: 'button', onclick: () => ((myColour = 'b'), renderPrep()) }, 'I’m Black'),
      );
      exp?.destroy();
      const theirColour = myColour === 'w' ? 'b' : 'w';
      const theirTree = buildTree(theirs.filter((g) => g.myColor === theirColour).map((g) => ({ moves: g.moves, outcome: myResult(g) })));
      const myTree = buildTree(mine.filter((g) => g.myColor === myColour).map((g) => ({ moves: g.moves, outcome: myResult(g) })));
      const likely = likelyLine(myTree, theirTree, myColour, 12);
      const { needsPractice: aim, scoringWell: avoid } = lineLists(theirTree, { minGames: minGamesFor(theirTree.count) });
      const practise = (path) => {
        location.hash = `#/play?moves=${encodeURIComponent(path.join(' '))}&colour=${myColour}`;
      };
      exp = explorer({ tree: theirTree, orientation: myColour === 'w' ? 'white' : 'black', ownerLabel: name, onPractise: practise });
      const showLine = (path) => {
        exp.setPath(path);
        exp.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };

      clear(prepHost).append(
        h(
          'section.card',
          h('h2', 'Most likely opening'),
          likely.length
            ? [
                h('p', h('strong', pathText(likely))),
                h('p.muted.small', 'Your usual moves combined with their usual replies.'),
                h('div.row.wrap', h('button.btn', { type: 'button', onclick: () => showLine(likely) }, 'Show on board'), h('button.btn.primary', { type: 'button', onclick: () => practise(likely) }, 'Practise it vs Stockfish')),
              ]
            : h('p.muted', `Not enough games with ${name} as ${theirColour === 'w' ? 'White' : 'Black'} to predict.`),
        ),
        h(
          'div.grid',
          h('section.card', h('h2', 'Lines to aim for'), h('p.muted.small', `${name} scores 42% or less here.`), aim.length ? h('ul.list', aim.map((l) => lineItem({ ...l, score: l.score }, { onShow: () => showLine(l.path), onPractise: () => practise(l.path) }))) : h('p.muted', 'No weak spots with enough games.')),
          h('section.card', h('h2', 'Lines to avoid'), h('p.muted.small', `${name} scores 58% or more here.`), avoid.length ? h('ul.list', avoid.map((l) => lineItem(l, { onShow: () => showLine(l.path) }))) : h('p.muted', 'No strong lines with enough games.')),
        ),
        h('h2', `${name}’s openings as ${theirColour === 'w' ? 'White' : 'Black'}`),
        exp.el,
        h(
          'section.card',
          h('h2', 'Scouting report'),
          claudePanel({
            label: 'Write a scouting report',
            question: `Write a scouting report on ${name} for my next game as ${myColour === 'w' ? 'White' : 'Black'}, in three parts with these headings: "What to expect", "How to play them", "Watch out for".`,
            facts: async () =>
              [
                `Opponent: ${name}. Ratings: ${TIME_CLASSES.filter((tc) => ratings?.[tc]?.rating).map((tc) => `${tc} ${ratings[tc].rating}`).join(', ') || 'unknown'}.`,
                `Games scouted: ${theirs.length} (last ${MONTHS} months). Record W/D/L overall ${overall.w}/${overall.d}/${overall.l}; as White ${asWhite.w}/${asWhite.d}/${asWhite.l}; as Black ${asBlack.w}/${asBlack.d}/${asBlack.l}.`,
                `Average game length: ${avgMoves} moves. How their losses end: ${Object.entries(lossEnds).map(([k, v]) => `${TERMINATION_LABELS[k] ?? k} ${v}`).join(', ') || 'none'}.`,
                `Time controls they play: ${[...new Set(theirs.map((g) => g.timeClass))].join(', ')}.`,
                h2h.length ? `Head-to-head from my saved games (my W/D/L): ${h2hTally.w}/${h2hTally.d}/${h2hTally.l}.` : 'We have not played before (in my saved games).',
                `I will play ${myColour === 'w' ? 'White' : 'Black'}.`,
                `Most likely opening (my usual moves + their usual replies): ${likely.length ? pathText(likely) : 'not enough data'}.`,
                `Their most common replies at the first moves: ${topMoves(theirTree)}.`,
                `Lines where they score badly (aim for): ${aim.map((l) => `${pathText(l.path)} (${l.node.count} games, ${Math.round(l.score * 100)}%)`).join('; ') || 'none with enough games'}.`,
                `Lines where they score well (avoid): ${avoid.map((l) => `${pathText(l.path)} (${l.node.count} games, ${Math.round(l.score * 100)}%)`).join('; ') || 'none with enough games'}.`,
                'Note: these are game statistics, not engine evaluations.',
              ].join('\n'),
            extra: 'Base the report only on the statistics given. Use the three headings requested, with two to four bullet points each.',
          }).el,
        ),
      );
    };
    renderPrep();
    toast(`Scouted ${theirs.length} games.`);
  }

  if (params.name) scout(params.name);
  return () => exp?.destroy();
}

function topMoves(tree) {
  const out = [];
  let node = tree;
  for (let ply = 0; ply < 4 && node; ply++) {
    const kids = [...node.children.entries()].sort((a, b) => b[1].count - a[1].count);
    if (!kids.length) break;
    out.push(kids.slice(0, 3).map(([san, n]) => `${san} (${n.count})`).join(', '));
    node = kids[0][1];
  }
  return out.join(' → ');
}
