// Opening tree explorer: breadcrumb, board and the moves played from the current position.
import { createBoard } from './board.js';
import { childrenOf, fenAfter, nodeAt, pathText, scoreOf } from './openings.js';
import { clear, h, wdlBar } from './ui.js';

/**
 * opts: tree, orientation ('white'|'black'), ownerLabel ('you' / 'them'), onPractise(path), path (initial)
 * Returns { el, setTree(tree), setPath(path), destroy() }.
 */
export function explorer(opts) {
  let tree = opts.tree;
  let path = opts.path ?? [];
  const crumbs = h('nav.crumbs', { 'aria-label': 'Moves so far' });
  const rows = h('div');
  const boardHost = h('div.board-col');
  const info = h('p.muted.small');
  const practise = h('button.btn', { type: 'button', onclick: () => opts.onPractise?.(path) }, 'Practise from here vs Stockfish');
  const el = h('div.split', h('div.stack', h('div.board-area', boardHost), crumbs), h('div.side', h('section.card', h('div.card-head', h('h2', 'Moves from here'), opts.onPractise ? practise : null), info, rows)));
  const board = createBoard(boardHost, { fen: fenAfter(path), orientation: opts.orientation });

  function render() {
    const node = nodeAt(tree, path);
    clear(crumbs).append(
      h('button', { type: 'button', onclick: () => setPath([]) }, 'Start'),
      ...path.flatMap((san, i) => [h('span.muted', '›'), h('button', { type: 'button', onclick: () => setPath(path.slice(0, i + 1)) }, i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san)]),
    );
    let fen;
    try {
      fen = fenAfter(path);
    } catch {
      fen = fenAfter([]);
    }
    board.setPosition(fen);
    clear(rows);
    if (!node || node.count === 0) {
      info.textContent = 'No games reach this position.';
      return;
    }
    info.textContent = `${node.count} game${node.count === 1 ? '' : 's'} reached this position · ${opts.ownerLabel} scored ${Math.round(scoreOf(node) * 100)}%`;
    const kids = childrenOf(node);
    if (!kids.length) {
      rows.append(h('p.muted', 'This is as deep as the games go.'));
      return;
    }
    rows.append(h('div.tree-row.muted.small', { style: { cursor: 'default' } }, h('span', 'Move'), h('span', 'Games'), h('span', `Results for ${opts.ownerLabel}`), h('span.score', 'Score')));
    for (const k of kids) {
      rows.append(
        h(
          'button.tree-row',
          { type: 'button', onclick: () => setPath([...path, k.san]), 'aria-label': `${k.san}: ${k.node.count} games, ${opts.ownerLabel} scored ${Math.round(k.score * 100)}%` },
          h('span.san', `${path.length % 2 === 0 ? `${path.length / 2 + 1}.` : `${Math.floor(path.length / 2) + 1}...`} ${k.san}`),
          h('span', String(k.node.count)),
          wdlBar({ w: k.node.w, d: k.node.d, l: k.node.l }),
          h('span.score', `${Math.round(k.score * 100)}%`),
        ),
      );
    }
  }

  function setPath(p) {
    path = p;
    render();
  }

  render();
  return {
    el,
    get path() {
      return path;
    },
    setTree(t) {
      tree = t;
      if (!nodeAt(tree, path)) path = [];
      render();
    },
    setPath,
    setOrientation(o) {
      board.setOrientation(o);
    },
    destroy: () => board.destroy(),
  };
}

/** One line in a "needs practice" / "scoring well" list. */
export function lineItem(line, { onShow, onPractise }) {
  return h(
    'li.todo',
    h('div.todo-main', h('strong', pathText(line.path)), h('div.row', wdlBar({ w: line.node.w, d: line.node.d, l: line.node.l }), h('span.small.muted', `${line.node.count} games · ${Math.round(line.score * 100)}%`)), h('div.row.wrap', h('button.btn.small', { type: 'button', onclick: onShow }, 'Show'), onPractise ? h('button.btn.small', { type: 'button', onclick: onPractise }, 'Practise vs Stockfish') : null)),
  );
}
