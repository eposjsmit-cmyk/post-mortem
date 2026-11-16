// Reads PGN text (one game or many) into the app's game records.
import { Chess } from '../vendor/chess.js';

/** Splits a PGN file into one string per game. */
export function splitPgn(text) {
  const clean = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '').trim();
  if (!clean) return [];
  // A new game starts at a header line that follows movetext (or the start of the file).
  const games = [];
  let current = [];
  let inMoves = false;
  for (const line of clean.split('\n')) {
    const isHeader = /^\s*\[\w+\s+".*"\]\s*$/.test(line);
    if (isHeader && inMoves) {
      games.push(current.join('\n'));
      current = [];
      inMoves = false;
    }
    if (!isHeader && line.trim()) inMoves = true;
    current.push(line);
  }
  if (current.some((l) => l.trim())) games.push(current.join('\n'));
  return games.map((g) => g.trim()).filter(Boolean);
}

export function parseHeaders(pgn) {
  const headers = {};
  for (const m of pgn.matchAll(/^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm)) headers[m[1]] = m[2].replace(/\\"/g, '"');
  return headers;
}

/** "1:02:03.4" -> seconds */
export function clockSeconds(text) {
  const parts = text.split(':').map(Number);
  return parts.reduce((s, p) => s * 60 + p, 0);
}

/**
 * Pulls SAN moves and the [%clk] remaining-time comments out of movetext.
 * Variations, other comments, NAGs and move numbers are dropped.
 */
export function parseMovetext(pgn) {
  // Movetext is everything after the last header line.
  const body = pgn.replace(/^\s*\[\w+\s+".*"\]\s*$/gm, '').trim();
  const sans = [];
  const clocks = [];
  let i = 0;
  let depth = 0;
  const n = body.length;
  while (i < n) {
    const ch = body[i];
    if (ch === '{') {
      const end = body.indexOf('}', i);
      const comment = body.slice(i + 1, end === -1 ? n : end);
      if (depth === 0) {
        const clk = comment.match(/\[%clk\s+([\d:.]+)\]/);
        if (clk && sans.length > 0) clocks[sans.length - 1] = clockSeconds(clk[1]);
      }
      i = end === -1 ? n : end + 1;
    } else if (ch === ';') {
      const end = body.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
    } else if (ch === '(') {
      depth++;
      i++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (/\s/.test(ch)) {
      i++;
    } else {
      let j = i;
      while (j < n && !/[\s{}();]/.test(body[j])) j++;
      const token = body.slice(i, j);
      i = j;
      if (depth > 0) continue;
      if (/^\$\d+$/.test(token)) continue; // NAG
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)) continue; // result
      const san = token.replace(/^\d+\.+/, '').replace(/[!?]+$/, '');
      if (!san || /^\d+\.*$/.test(san)) continue;
      sans.push(san);
    }
  }
  return { sans, clocks };
}

/** "600+5" -> { base: 600, inc: 5 } */
export function parseTimeControl(tc) {
  if (!tc || tc === '-' || tc.includes('/')) return null;
  const [base, inc] = tc.split('+').map(Number);
  if (!Number.isFinite(base)) return null;
  return { base, inc: Number.isFinite(inc) ? inc : 0 };
}

/** chess.com-style time class from a TimeControl header. */
export function timeClassOf(tc) {
  if (!tc || tc === '-') return 'unknown';
  if (tc.includes('/')) return 'daily';
  const t = parseTimeControl(tc);
  if (!t) return 'unknown';
  const est = t.base + 40 * t.inc;
  if (est < 180) return 'bullet';
  if (est < 600) return 'blitz';
  return 'rapid';
}

/** Seconds spent on each ply, from remaining-clock readings and the increment. */
export function timeSpent(clocks, tc, plies) {
  const t = parseTimeControl(tc);
  if (!t || clocks.length === 0) return [];
  const out = [];
  const last = { 0: t.base, 1: t.base };
  for (let i = 0; i < plies; i++) {
    const c = clocks[i];
    if (c == null) {
      out.push(null);
      continue;
    }
    const side = i % 2;
    out.push(Math.max(0, Math.round((last[side] - c + t.inc) * 10) / 10));
    last[side] = c;
  }
  return out;
}

/** "Italian Game: Two Knights Defense" from a chess.com ECOUrl. */
export function openingFromEcoUrl(url) {
  if (!url) return '';
  const slug = decodeURIComponent(url.split('/openings/')[1] ?? '').split('?')[0];
  if (!slug) return '';
  return slug
    .replace(/(?:-|\.{3})\d+\.{1,3}.*$/, '') // drop trailing move lists like "-3...Nf6-4.Ng5" or "...3.d3-dxe4"
    .replace(/\.+$/, '')
    .replace(/Caro-Kann/gi, 'Caro~Kann')
    .replace(/-/g, ' ')
    .replace(/~/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** chess.com game id from a game link, if any. */
export function chessComId(url) {
  const m = url?.match(/chess\.com\/(?:game\/)?(?:live|daily|computer)\/(?:game\/)?(\d+)/);
  return m ? m[1] : null;
}

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** PGN date "2026.11.15" + time "18:04:11" -> ms (UTC). */
function pgnDate(h) {
  const d = (h.UTCDate || h.Date || '').replace(/\?/g, '01');
  const t = h.UTCTime || h.EndTime || h.StartTime || '00:00:00';
  const m = d.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (!m) return Date.now();
  const tm = t.match(/(\d{1,2}):(\d{2}):(\d{2})/) ?? [0, 0, 0, 0];
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +tm[1], +tm[2], +tm[3]);
}

/** How the game ended, from chess.com's per-player result codes (the loser's code says how). */
export function terminationFromCodes(whiteCode, blackCode) {
  const code = whiteCode === 'win' ? blackCode : blackCode === 'win' ? whiteCode : whiteCode;
  const map = {
    checkmated: 'checkmate',
    resigned: 'resignation',
    timeout: 'timeout',
    abandoned: 'abandoned',
    stalemate: 'stalemate',
    repetition: 'repetition',
    agreed: 'agreement',
    insufficient: 'insufficient',
    '50move': '50-move',
    timevsinsufficient: 'timeout-draw',
  };
  return map[code] ?? null;
}

/** How the game ended, from the Termination header. */
export function terminationOf(text, result) {
  const t = (text || '').toLowerCase();
  if (t.includes('checkmate')) return 'checkmate';
  if (t.includes('resign')) return 'resignation';
  if (t.includes('abandon')) return 'abandoned';
  if (t.includes('time') && (t.includes('insufficient') || result === '1/2-1/2')) return 'timeout-draw';
  if (t.includes('time')) return 'timeout';
  if (t.includes('stalemate')) return 'stalemate';
  if (t.includes('repetition')) return 'repetition';
  if (t.includes('agree')) return 'agreement';
  if (t.includes('insufficient')) return 'insufficient';
  if (t.includes('50')) return '50-move';
  return result === '1/2-1/2' ? 'draw' : 'other';
}

export const TERMINATION_LABELS = {
  checkmate: 'Checkmate',
  resignation: 'Resigned',
  timeout: 'Ran out of time',
  abandoned: 'Abandoned',
  stalemate: 'Stalemate',
  repetition: 'Repetition',
  agreement: 'Agreed draw',
  insufficient: 'Not enough material',
  '50-move': '50-move rule',
  'timeout-draw': 'Time out, not enough material',
  draw: 'Draw',
  other: 'Other',
};

/**
 * One PGN game -> game record, or null if it is a non-standard variant or unreadable.
 * `me` is the user's chess.com username (to work out which side they played), or an explicit colour.
 */
export function gameFromPgn(pgn, { me = '', myColor = null, source = 'pgn', extra = {} } = {}) {
  const h = parseHeaders(pgn);
  const variant = (h.Variant || '').toLowerCase();
  if (variant && variant !== 'standard' && variant !== 'chess') return null;
  if (h.SetUp === '1' || h.FEN) return null; // custom start positions (e.g. Chess960, odds games)

  const { sans, clocks } = parseMovetext(pgn);
  const chess = new Chess();
  const moves = [];
  const ucis = [];
  for (const san of sans) {
    let m;
    try {
      m = chess.move(san);
    } catch {
      break;
    }
    moves.push(m.san);
    ucis.push(m.from + m.to + (m.promotion ?? ''));
  }
  if (moves.length === 0) return null;

  const white = h.White || 'White';
  const black = h.Black || 'Black';
  const lower = me.toLowerCase();
  const color = myColor ?? (lower && white.toLowerCase() === lower ? 'w' : lower && black.toLowerCase() === lower ? 'b' : null);
  const link = h.Link || (h.Site && h.Site.startsWith('http') ? h.Site : '');
  const ccId = chessComId(link);
  const result = h.Result || '*';

  return {
    id: ccId ? `cc:${ccId}` : `pgn:${hash(white + black + (h.Date || '') + moves.join(' '))}`,
    source,
    pgn,
    white,
    black,
    whiteElo: Number(h.WhiteElo) || null,
    blackElo: Number(h.BlackElo) || null,
    result,
    myColor: color,
    timeControl: h.TimeControl || '',
    timeClass: timeClassOf(h.TimeControl),
    date: pgnDate(h),
    opening: openingFromEcoUrl(h.ECOUrl) || h.Opening || '',
    eco: h.ECO || '',
    termination: terminationOf(h.Termination, result),
    terminationText: h.Termination || '',
    url: link,
    moves,
    ucis,
    clocks: clocks.slice(0, moves.length),
    reviewed: false,
    ...extra,
  };
}

/** Result from the user's point of view: 'win' | 'draw' | 'loss' | null. */
export function myResult(game) {
  if (!game.myColor || game.result === '*') return null;
  if (game.result === '1/2-1/2') return 'draw';
  const whiteWon = game.result === '1-0';
  return (game.myColor === 'w') === whiteWon ? 'win' : 'loss';
}

/** Parses many games from text; returns { games, skipped }. */
export function parseManyPgn(text, opts) {
  const games = [];
  let skipped = 0;
  for (const g of splitPgn(text)) {
    const game = gameFromPgn(g, opts);
    if (game) games.push(game);
    else skipped++;
  }
  return { games, skipped };
}
