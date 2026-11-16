import { db } from '../db.js';
import { explorer, lineItem } from '../explorer.js';
import { buildTree, lineLists, minGamesFor } from '../openings.js';
import { myResult } from '../pgn.js';
import { TIME_CLASS_LABEL, clear, emptyState, h } from '../ui.js';

export async function render(view, { params }) {
  const games = (await db.all('games')).filter((g) => g.myColor && myResult(g));
  let colour = params.colour === 'b' ? 'b' : 'w';
  let timeClass = params.tc ?? 'all';

  view.append(h('div.page-head', h('h1', 'Openings'), h('p.muted', 'How your openings go, from your own games.')));
  if (!games.length) {
    view.append(h('section.card', emptyState('No games yet', 'Sync or import some games first.', h('a.btn.primary', { href: '#/games' }, 'Go to Games'))));
    return;
  }

  const controls = h('div.stack');
  const listsHost = h('div.grid');
  view.append(controls);

  const tree = () =>
    buildTree(
      games
        .filter((g) => g.myColor === colour && (timeClass === 'all' || g.timeClass === timeClass))
        .map((g) => ({ moves: g.moves, outcome: myResult(g) })),
    );
  const practise = (path) => {
    location.hash = `#/play?moves=${encodeURIComponent(path.join(' '))}&colour=${colour}`;
  };

  const exp = explorer({ tree: tree(), orientation: colour === 'w' ? 'white' : 'black', ownerLabel: 'you', onPractise: practise, path: params.path ? params.path.split(' ') : [] });
  view.append(exp.el, listsHost);

  function renderControls() {
    const chip = (active, label, fn) => h(`button.chip${active ? '.active' : ''}`, { type: 'button', 'aria-pressed': active, onclick: fn }, label);
    const classes = ['all', ...new Set(games.map((g) => g.timeClass))];
    clear(controls).append(
      h('div.chips', chip(colour === 'w', 'As White', () => setColour('w')), chip(colour === 'b', 'As Black', () => setColour('b'))),
      h('div.chips', classes.map((c) => chip(timeClass === c, c === 'all' ? 'All time controls' : TIME_CLASS_LABEL[c] ?? c, () => {
        timeClass = c;
        refresh();
      }))),
    );
  }

  function setColour(c) {
    colour = c;
    exp.setOrientation(c === 'w' ? 'white' : 'black');
    exp.setPath([]);
    refresh();
  }

  function refresh() {
    renderControls();
    const t = tree();
    exp.setTree(t);
    const { needsPractice, scoringWell } = lineLists(t, { minGames: minGamesFor(t.count) });
    const show = (line) => {
      exp.setPath(line.path);
      exp.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    clear(listsHost).append(
      h(
        'section.card',
        h('h2', 'Needs practice'),
        h('p.muted.small', 'Lines where you score 42% or less.'),
        needsPractice.length ? h('ul.list', needsPractice.map((l) => lineItem(l, { onShow: () => show(l), onPractise: () => practise(l.path) }))) : h('p.muted', 'Nothing stands out yet. Well done, or play a few more games.'),
      ),
      h(
        'section.card',
        h('h2', 'Scoring well'),
        h('p.muted.small', 'Lines where you score 58% or more. Keep playing these.'),
        scoringWell.length ? h('ul.list', scoringWell.map((l) => lineItem(l, { onShow: () => show(l) }))) : h('p.muted', 'Not enough games yet.'),
      ),
    );
  }

  refresh();
  return () => exp.destroy();
}
