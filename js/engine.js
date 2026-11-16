// Stockfish in a Web Worker: the lite single-threaded WASM build, with the asm.js build as a fallback.
// Each Engine runs one job at a time from a queue; live jobs can be cancelled.
import { Chess } from '../vendor/chess.js';

const BASE = new URL('../vendor/stockfish/', import.meta.url);
const WASM_ENGINE = new URL('stockfish-19-lite-single.js', BASE).href;
const ASM_ENGINE = new URL('stockfish-19-asm.js', BASE).href;

const canWasm = (() => {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  } catch {
    return false;
  }
})();

/** Parses one UCI "info" line. Scores are from the side to move. */
export function parseInfo(line) {
  if (!line.startsWith('info ') || !line.includes(' pv ')) return null;
  const tok = line.split(' ');
  const out = { multipv: 1 };
  for (let i = 1; i < tok.length; i++) {
    const t = tok[i];
    if (t === 'depth') out.depth = Number(tok[++i]);
    else if (t === 'multipv') out.multipv = Number(tok[++i]);
    else if (t === 'score') {
      const kind = tok[++i];
      const val = Number(tok[++i]);
      if (kind === 'cp') out.cp = val;
      else if (kind === 'mate') out.mate = val;
      if (tok[i + 1] === 'lowerbound' || tok[i + 1] === 'upperbound') out.bound = tok[++i];
    } else if (t === 'nodes') out.nodes = Number(tok[++i]);
    else if (t === 'pv') {
      out.pv = tok.slice(i + 1);
      break;
    }
  }
  return out;
}

/** Converts a side-to-move score to White's point of view. */
export function toWhite(info, fen) {
  const flip = fen.split(' ')[1] === 'b' ? -1 : 1;
  if (info.mate != null) return { mate: info.mate * flip };
  return { cp: (info.cp ?? 0) * flip };
}

export class Engine {
  constructor(label = 'engine') {
    this.label = label;
    this.worker = null;
    this.flavour = null;
    this.handlers = new Set();
    this.queue = [];
    this.current = null;
    this.ready = this.boot();
  }

  async boot() {
    if (canWasm) {
      try {
        await this.start(WASM_ENGINE);
        this.flavour = 'wasm';
        return;
      } catch (e) {
        console.warn('Stockfish WASM failed, falling back to asm.js', e);
      }
    }
    await this.start(ASM_ENGINE, 60000);
    this.flavour = 'asm';
  }

  start(url, timeout = 20000) {
    return new Promise((resolve, reject) => {
      this.worker?.terminate();
      const w = new Worker(url);
      this.worker = w;
      const timer = setTimeout(() => {
        w.terminate();
        reject(new Error('Engine did not start in time'));
      }, timeout);
      w.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : String(e.data);
        if (line === 'uciok') {
          clearTimeout(timer);
          this.post('setoption name Hash value 16');
          this.post('isready');
          resolve();
        }
        this.handlers.forEach((h) => h(line));
      };
      w.onerror = (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(e.message || 'Engine worker error'));
      };
      w.postMessage('uci');
    });
  }

  post(cmd) {
    this.worker?.postMessage(cmd);
  }

  /**
   * Analyses a position. Resolves with { lines: [{ score (White POV), pv, depth }], best, depth, cancelled }.
   * opts: depth, multipv, movetime, skill (0-20), onInfo(partial result), priority (true = jump the queue).
   */
  analyse(fen, opts = {}) {
    const job = { fen, opts, cancelled: false };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    job.cancel = () => {
      job.cancelled = true;
      if (this.current === job) this.post('stop');
      else {
        this.queue = this.queue.filter((j) => j !== job);
        job.resolve({ lines: [], best: null, cancelled: true });
      }
    };
    if (opts.priority) this.queue.unshift(job);
    else this.queue.push(job);
    this.pump();
    return job;
  }

  async pump() {
    if (this.current || this.queue.length === 0) return;
    const job = this.queue.shift();
    this.current = job;
    try {
      await this.ready;
      job.resolve(await this.run(job));
    } catch (e) {
      job.reject(e);
    } finally {
      this.current = null;
      this.pump();
    }
  }

  run(job) {
    const { fen, opts } = job;
    const multipv = opts.multipv ?? 1;
    const lines = [];
    let lastEmit = 0;
    return new Promise((resolve) => {
      const handler = (line) => {
        if (line.startsWith('info ')) {
          const info = parseInfo(line);
          if (!info || info.bound) return;
          lines[info.multipv - 1] = { score: toWhite(info, fen), pv: info.pv, depth: info.depth };
          const now = performance.now();
          if (opts.onInfo && now - lastEmit > 120) {
            lastEmit = now;
            opts.onInfo(snapshot());
          }
        } else if (line.startsWith('bestmove')) {
          this.handlers.delete(handler);
          const best = line.split(' ')[1];
          const result = snapshot();
          result.best = best && best !== '(none)' ? best : (result.lines[0]?.pv?.[0] ?? null);
          result.cancelled = job.cancelled;
          opts.onInfo?.(result);
          resolve(result);
        }
      };
      const snapshot = () => {
        const ls = lines.filter(Boolean).slice(0, multipv);
        return { lines: ls, best: ls[0]?.pv?.[0] ?? null, depth: ls[0]?.depth ?? 0 };
      };
      this.handlers.add(handler);
      this.post(`setoption name MultiPV value ${multipv}`);
      this.post(`setoption name Skill Level value ${opts.skill ?? 20}`);
      this.post(`position fen ${fen}`);
      if (opts.movetime) this.post(`go movetime ${opts.movetime}${opts.depth ? ` depth ${opts.depth}` : ''}`);
      else this.post(`go depth ${opts.depth ?? 12}`);
    });
  }

  /** Cancel everything queued and stop the running job. */
  cancelAll() {
    for (const j of this.queue) j.resolve({ lines: [], best: null, cancelled: true });
    this.queue = [];
    if (this.current) {
      this.current.cancelled = true;
      this.post('stop');
    }
  }

  newGame() {
    this.post('ucinewgame');
  }
}

// One engine per purpose, created when first needed: background reviews, live analysis, and the sparring bot.
const engines = {};
export function getEngine(kind) {
  engines[kind] ??= new Engine(kind);
  return engines[kind];
}

/** Win/draw/loss score for a finished position, or null if the game goes on. */
export function finishedScore(fen) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { cp: c.turn() === 'w' ? -10000 : 10000, terminal: 'checkmate' };
  if (c.isStalemate() || c.isInsufficientMaterial() || c.isDrawByFiftyMoves()) return { cp: 0, terminal: 'draw' };
  return null;
}

/** Engine evaluation for review: finished positions are scored directly, others by Stockfish. */
export async function evaluate(engine, fen, depth = 12) {
  const done = finishedScore(fen);
  if (done) return { score: done, best: null, pv: [] };
  const r = await engine.analyse(fen, { depth }).promise;
  const top = r.lines[0];
  return { score: top?.score ?? { cp: 0 }, best: r.best, pv: top?.pv ?? [] };
}
