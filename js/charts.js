// Small SVG charts: one axis, thin marks, recessive grid, hover/tap tooltips, legends for 2+ series.
import { escapeHtml, fmtDay, h } from './ui.js';

/** Fixed categorical order (never cycled). Values are CSS variables defined for light and dark. */
export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

const niceTicks = (min, max, count = 4) => {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? step0;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
};

function tooltip(host) {
  const tip = h('div.chart-tip', { role: 'status' });
  host.append(tip);
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.style.display = 'block';
      const hw = host.clientWidth;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(0, x - tw / 2), hw - tw)}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
    },
    hide() {
      tip.style.display = 'none';
    },
  };
}

function legend(items) {
  return h(
    'div.legend',
    items.map((it) => h('span.legend-item', h('span.swatch', { style: { background: it.color } }), it.label)),
  );
}

/**
 * Line chart over time. series: [{ label, color, points: [{ x: ms, y, note? }] }].
 */
export function timeLineChart(series, { height = 200, yLabel = '' } = {}) {
  const host = h('div.chart');
  const used = series.filter((s) => s.points.length);
  if (!used.length) return host;
  if (used.length > 1) host.append(legend(used));
  const W = 600;
  const H = height;
  const pad = { l: 40, r: 12, t: 12, b: 24 };
  const xs = used.flatMap((s) => s.points.map((p) => p.x));
  const ys = used.flatMap((s) => s.points.map((p) => p.y));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const yTicks = niceTicks(Math.min(...ys) - 10, Math.max(...ys) + 10);
  const y0 = yTicks[0];
  const y1 = yTicks[yTicks.length - 1];
  const X = (x) => pad.l + (x1 === x0 ? 0.5 : (x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(yLabel)} over time">`;
  for (const t of yTicks) svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="axis" x="${pad.l - 6}" y="${Y(t) + 4}" text-anchor="end">${t}</text>`;
  svg += `<text class="axis" x="${pad.l}" y="${H - 6}">${fmtDay(x0)}</text><text class="axis" x="${W - pad.r}" y="${H - 6}" text-anchor="end">${fmtDay(x1)}</text>`;
  for (const s of used) {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = s.points[s.points.length - 1];
    svg += `<circle cx="${X(last.x)}" cy="${Y(last.y)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
  }
  svg += `<line class="crosshair" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" style="display:none"/><g class="hover-dots"></g></svg>`;
  const box = h('div.chart-plot', { html: svg });
  host.append(box);
  const tip = tooltip(box);
  const svgEl = box.querySelector('svg');
  const cross = svgEl.querySelector('.crosshair');
  const dots = svgEl.querySelector('.hover-dots');

  const move = (clientX) => {
    const r = svgEl.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * W;
    const t = x0 + ((x - pad.l) / (W - pad.l - pad.r)) * (x1 - x0);
    const rows = [];
    dots.innerHTML = '';
    let cx = null;
    for (const s of used) {
      let best = s.points[0];
      for (const p of s.points) if (Math.abs(p.x - t) < Math.abs(best.x - t)) best = p;
      cx ??= X(best.x);
      rows.push(`<div><span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.label)} <b>${best.y}</b> <span class="muted">${fmtDay(best.x)}</span></div>`);
      dots.innerHTML += `<circle cx="${X(best.x)}" cy="${Y(best.y)}" r="5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
    }
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.style.display = '';
    tip.show(rows.join(''), (cx / W) * r.width, 0);
  };
  const leave = () => {
    cross.style.display = 'none';
    dots.innerHTML = '';
    tip.hide();
  };
  svgEl.addEventListener('pointermove', (e) => move(e.clientX));
  svgEl.addEventListener('pointerdown', (e) => move(e.clientX));
  svgEl.addEventListener('pointerleave', leave);
  return host;
}

/**
 * Horizontal 100% stacked bars of won / drawn / lost. rows: [{ label, w, d, l }].
 */
export function resultBars(rows) {
  const host = h('div.chart');
  host.append(legend([
    { label: 'Won', color: 'var(--win)' },
    { label: 'Drawn', color: 'var(--draw)' },
    { label: 'Lost', color: 'var(--loss)' },
  ]));
  for (const r of rows) {
    const total = r.w + r.d + r.l;
    if (!total) continue;
    const seg = (cls, n, name) =>
      n ? h(`span.${cls}`, { style: { flexGrow: n }, title: `${name}: ${n} (${Math.round((n / total) * 100)}%)` }, n / total > 0.12 ? String(n) : '') : null;
    host.append(
      h(
        'div.hbar-row',
        h('span.hbar-label', r.label),
        h('div.wdl', { role: 'img', 'aria-label': `${r.label}: won ${r.w}, drawn ${r.d}, lost ${r.l}` }, seg('w', r.w, 'Won'), seg('d', r.d, 'Drawn'), seg('l', r.l, 'Lost')),
        h('span.hbar-value', `${total}`),
      ),
    );
  }
  return host;
}

/**
 * Simple horizontal bars, one series. rows: [{ label, value, display?, onClick?, color? }].
 * Clickable rows get a button so they work with keyboard and touch.
 */
export function barList(rows, { unit = '', max = null } = {}) {
  const host = h('div.chart');
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  for (const r of rows) {
    const bar = h('div.hbar-track', h('span.hbar-fill', { style: { width: `${Math.max(2, (r.value / top) * 100)}%`, background: r.color ?? 'var(--series-1)' } }));
    const content = [h('span.hbar-label', r.label), bar, h('span.hbar-value', r.display ?? `${r.value}${unit}`)];
    host.append(r.onClick ? h('button.hbar-row.clickable', { type: 'button', onclick: r.onClick, title: r.title ?? '' }, content) : h('div.hbar-row', content));
  }
  return host;
}

/**
 * Advantage graph for a review: White's winning chance per ply, dots on inaccuracies, mistakes and blunders.
 * points: [{ win (0-100, White), verdict?, label }], onPick(index).
 */
export function advantageGraph(points, { onPick, colours }) {
  const W = 600;
  const H = 110;
  const n = points.length;
  const X = (i) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const Y = (w) => H - (w / 100) * H;
  let area = `M0,${H} `;
  points.forEach((p, i) => (area += `L${X(i).toFixed(1)},${Y(p.win).toFixed(1)} `));
  area += `L${W},${H} Z`;
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Advantage over the game">`;
  svg += `<rect width="${W}" height="${H}" class="adv-bg"/><path d="${area}" class="adv-white"/><line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="adv-mid"/>`;
  svg += `<line class="adv-cursor" x1="0" x2="0" y1="0" y2="${H}"/>`;
  svg += '</svg>';
  const box = h('div.adv-graph', { html: svg });
  const svgEl = box.querySelector('svg');
  // Dots are HTML so they stay round when the SVG stretches.
  points.forEach((p, i) => {
    if (!['inaccuracy', 'mistake', 'blunder'].includes(p.verdict)) return;
    box.append(
      h('button.adv-dot', {
        type: 'button',
        style: { left: `${(X(i) / W) * 100}%`, top: `${(Y(p.win) / H) * 100}%`, background: colours[p.verdict] },
        title: p.label,
        'aria-label': p.label,
        onclick: (e) => {
          e.stopPropagation();
          onPick(i);
        },
      }),
    );
  });
  const pick = (clientX) => {
    const r = svgEl.getBoundingClientRect();
    const i = Math.round(((clientX - r.left) / r.width) * (n - 1));
    onPick(Math.max(0, Math.min(n - 1, i)));
  };
  svgEl.addEventListener('pointerdown', (e) => pick(e.clientX));
  return {
    el: box,
    setCursor(i) {
      const c = svgEl.querySelector('.adv-cursor');
      c.setAttribute('x1', X(i));
      c.setAttribute('x2', X(i));
    },
  };
}
