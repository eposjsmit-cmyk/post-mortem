// Chessground board wrapper: legal-move dragging, arrows, verdict badges and an evaluation bar.
import { Chess } from '../vendor/chess.js';
import { Chessground } from '../vendor/chessground/chessground.js';
import { VERDICT_INFO, whiteWin } from './analysis.js';
import { h } from './ui.js';

/** Map of square -> legal destination squares, for chessground. */
export function destsFor(chess) {
  const dests = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return dests;
}

export const VERDICT_COLOURS = {
  forced: '#8b8a85',
  best: '#2e9e57',
  excellent: '#5cae6f',
  good: '#7d9c86',
  inaccuracy: '#e0a800',
  mistake: '#e5732f',
  blunder: '#d03b3b',
};

/** A small badge drawn in the top-right corner of a square. */
export function badgeShape(square, verdict) {
  const colour = VERDICT_COLOURS[verdict];
  const sym = VERDICT_INFO[verdict].symbol;
  const size = sym.length > 1 ? 22 : 28;
  return {
    orig: square,
    customSvg: {
      html: `<g><circle cx="38" cy="-38" r="19" fill="${colour}" stroke="#fff" stroke-width="3"/><text x="38" y="-38" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-weight="800" font-size="${size}" fill="#fff">${sym}</text></g>`,
    },
  };
}

export const arrow = (uci, brush = 'green') => (uci ? { orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush } : null);

/**
 * Creates a board in `el`. Options:
 *  fen, orientation ('white'|'black'), lastMove ([from, to]), interactive (bool),
 *  onMove(uci, chessAfter) called after a legal move by the user (promotion defaults to queen).
 */
export function createBoard(el, opts = {}) {
  const wrap = h('div.board-wrap');
  const boardEl = h('div.board.cg-wrap');
  wrap.append(boardEl);
  el.append(wrap);
  let chess = new Chess(opts.fen);
  let shapes = [];
  let interactive = !!opts.interactive;
  let onMove = opts.onMove;
  let movableColor = opts.movableColor ?? null; // null = side to move

  const cg = Chessground(boardEl, {
    fen: chess.fen(),
    orientation: opts.orientation ?? 'white',
    lastMove: opts.lastMove,
    coordinates: true,
    animation: { enabled: true, duration: 180 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true },
    draggable: { showGhost: true },
    premovable: { enabled: false },
    drawable: { enabled: true, visible: true, defaultSnapToValidMove: true },
    events: {
      move: (from, to) => {
        const piece = chess.get(from);
        const promo = piece?.type === 'p' && (to[1] === '8' || to[1] === '1') ? 'q' : undefined;
        let m;
        try {
          m = chess.move({ from, to, promotion: promo });
        } catch {
          sync();
          return;
        }
        sync({ lastMove: [from, to] });
        onMove?.(m.from + m.to + (m.promotion ?? ''), chess, m);
      },
    },
  });

  function sync(extra = {}) {
    const turn = chess.turn() === 'w' ? 'white' : 'black';
    const canMove = interactive && !chess.isGameOver() && (!movableColor || movableColor === turn);
    cg.set({
      fen: chess.fen(),
      turnColor: turn,
      check: chess.inCheck() ? turn : false,
      movable: { color: canMove ? turn : undefined, dests: canMove ? destsFor(chess) : new Map() },
      ...extra,
    });
    cg.setAutoShapes(shapes);
  }

  sync({ lastMove: opts.lastMove });

  return {
    el: wrap,
    cg,
    get chess() {
      return chess;
    },
    /** Show a position. */
    setPosition(fen, { lastMove, shapes: s = [] } = {}) {
      chess = new Chess(fen);
      shapes = s.filter(Boolean);
      sync({ lastMove: lastMove ?? undefined });
      if (!lastMove) cg.set({ lastMove: undefined });
    },
    setShapes(s) {
      shapes = s.filter(Boolean);
      cg.setAutoShapes(shapes);
    },
    setInteractive(on, color = null) {
      interactive = on;
      movableColor = color;
      sync();
    },
    setOnMove(fn) {
      onMove = fn;
    },
    /** Plays a move from code (e.g. the engine's reply), with animation. */
    playUci(uci) {
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      cg.move(m.from, m.to);
      sync({ lastMove: [m.from, m.to] });
      return m;
    },
    orientation: () => cg.state.orientation,
    flip() {
      cg.toggleOrientation();
    },
    setOrientation(o) {
      cg.set({ orientation: o });
    },
    destroy() {
      cg.destroy();
      wrap.remove();
    },
  };
}

/** Vertical evaluation bar. update(score) with a White-POV score. */
export function evalBar() {
  const fill = h('div.evalbar-white');
  const label = h('span.evalbar-label');
  const el = h('div.evalbar', { role: 'img', 'aria-label': 'Evaluation' }, fill, label);
  let flipped = false;
  return {
    el,
    update(score, text) {
      const w = score ? whiteWin(score) : 50;
      fill.style.height = `${w}%`;
      label.textContent = text ?? '';
      label.classList.toggle('dark', w < 50);
      el.setAttribute('aria-label', `Evaluation ${text ?? ''}, White's winning chance ${Math.round(w)}%`);
    },
    setFlipped(f) {
      flipped = f;
      el.classList.toggle('flipped', flipped);
    },
  };
}
