// Opening trees, "needs practice" / "scoring well" lists and the likely-opening prediction.
import { Chess } from '../vendor/chess.js';

export const TREE_DEPTH = 20; // plies

const newNode = () => ({ count: 0, w: 0, d: 0, l: 0, children: new Map() });

/** Score from the tree owner's side: a win counts 1 and a draw ½. */
export const scoreOf = (n) => (n.count ? (n.w + n.d / 2) / n.count : 0);

/**
 * Builds a move tree from games played with `color` from the point of view of `player`.
 * games: [{ moves: SAN[], result: '1-0' | '0-1' | '1/2-1/2', color: 'w' | 'b' }]
 */
export function buildTree(games, depth = TREE_DEPTH) {
  const root = newNode();
  for (const g of games) {
    const outcome = g.outcome; // 'win' | 'draw' | 'loss' for the tree owner
    if (!outcome) continue;
    let node = root;
    const tally = (n) => {
      n.count++;
      if (outcome === 'win') n.w++;
      else if (outcome === 'draw') n.d++;
      else n.l++;
    };
    tally(node);
    for (const san of g.moves.slice(0, depth)) {
      if (!node.children.has(san)) node.children.set(san, newNode());
      node = node.children.get(san);
      tally(node);
    }
  }
  return root;
}

/** Node reached by a SAN path, or null. */
export function nodeAt(root, path) {
  let n = root;
  for (const san of path) {
    n = n.children.get(san);
    if (!n) return null;
  }
  return n;
}

/** Children sorted by how often they were played. */
export const childrenOf = (node) =>
  [...(node?.children ?? new Map()).entries()].map(([san, n]) => ({ san, node: n, score: scoreOf(n) })).sort((a, b) => b.node.count - a.node.count);

/**
 * Lines that score badly (≤ low) or well (≥ high) for the tree owner.
 * Ignores the first ply alone, prefers the shortest line that shows the problem, and drops
 * deeper lines that just repeat the same games.
 */
export function lineLists(root, { minGames = 3, low = 0.42, high = 0.58, maxDepth = 12, limit = 8 } = {}) {
  const bad = [];
  const good = [];
  const walk = (node, path, flaggedBad, flaggedGood) => {
    for (const [san, child] of node.children) {
      const p = [...path, san];
      if (child.count < minGames || p.length > maxDepth) continue;
      const s = scoreOf(child);
      let fb = flaggedBad;
      let fg = flaggedGood;
      if (p.length >= 2) {
        if (s <= low && !(flaggedBad && flaggedBad.count === child.count)) {
          bad.push({ path: p, node: child, score: s });
          fb = child;
        }
        if (s >= high && !(flaggedGood && flaggedGood.count === child.count)) {
          good.push({ path: p, node: child, score: s });
          fg = child;
        }
      }
      walk(child, p, fb, fg);
    }
  };
  walk(root, [], null, null);
  const byWeight = (a, b) => b.node.count - a.node.count || a.path.length - b.path.length;
  return {
    needsPractice: bad.sort((a, b) => a.score - b.score || byWeight(a, b)).slice(0, limit),
    scoringWell: good.sort((a, b) => b.score - a.score || byWeight(a, b)).slice(0, limit),
  };
}

/** Minimum games for a line to count, scaled to how many games there are. */
export const minGamesFor = (total) => (total < 40 ? 2 : 3);

/** "1. e4 e5 2. Nf3" */
export function pathText(path) {
  return path.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san)).join(' ');
}

/** FEN after a SAN path from the start position. */
export function fenAfter(path) {
  const c = new Chess();
  for (const san of path) c.move(san);
  return c.fen();
}

/**
 * Most likely opening against an opponent: at my turns I play my most common move in that
 * position, at theirs they play their most common reply. Stops when either side has no data.
 * myTree: my games with myColor; theirTree: their games with the other colour (their POV).
 */
export function likelyLine(myTree, theirTree, myColor, maxPlies = 12) {
  const path = [];
  let mine = myTree;
  let theirs = theirTree;
  for (let ply = 0; ply < maxPlies; ply++) {
    const myTurn = (ply % 2 === 0) === (myColor === 'w');
    const source = myTurn ? mine : theirs;
    const pick = childrenOf(source)[0];
    // My turn with no history of my own: fall back to what their opponents usually played.
    const choice = pick ?? (myTurn ? childrenOf(theirs)[0] : null);
    if (!choice) break;
    path.push(choice.san);
    mine = mine?.children.get(choice.san) ?? null;
    theirs = theirs?.children.get(choice.san) ?? null;
    if (!theirs) break;
  }
  return path;
}
