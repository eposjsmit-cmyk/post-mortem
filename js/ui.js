// Small DOM helpers, formatting and shared UI pieces.

/** h('div.card', { onclick }, 'text', child) -> element. Tag may carry .classes and #id. */
export function h(tag, props = {}, ...children) {
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    children.unshift(props);
    props = {};
  }
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = name === 'svg' || props.svg ? document.createElementNS('http://www.w3.org/2000/svg', name) : document.createElement(name || 'div');
  for (const part of rest) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false || k === 'svg') continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.classList.add(...String(v).split(/\s+/).filter(Boolean));
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string' && !(el instanceof SVGElement)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = (el) => {
  el.replaceChildren();
  return el;
};

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Minimal Markdown (paragraphs, bullets, bold, italics, headings) for Claude's answers. */
export function markdown(text) {
  const lines = escapeHtml(text).split('\n');
  const out = [];
  let list = null;
  const inline = (s) =>
    s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  const flush = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || num) {
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flush();
        list = { tag, items: [] };
      }
      list.items.push((bullet ?? num)[1]);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const head = line.match(/^#{1,4}\s+(.*)$/);
    if (head) out.push(`<h4>${inline(head[1])}</h4>`);
    else if (/^takeaway:/i.test(line.trim())) out.push(`<p class="takeaway">${inline(line.trim())}</p>`);
    else out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('');
}

// ---------- Formatting (South African English) ----------

export const fmtDate = (ms) => new Date(ms).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
export const fmtDay = (ms) => new Date(ms).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
export const fmtPct = (n, digits = 0) => (n == null ? '–' : `${n.toFixed(digits)}%`);

export function fmtClock(sec) {
  if (sec == null) return '';
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const ss = r < 10 && s < 60 ? r.toFixed(1).padStart(4, '0') : String(Math.floor(r)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fmtSeconds(sec) {
  if (sec == null) return '–';
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)} s`;
  return `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
}

export function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtDay(ms);
}

export const TIME_CLASSES = ['rapid', 'blitz', 'bullet', 'daily'];
export const TIME_CLASS_LABEL = { rapid: 'Rapid', blitz: 'Blitz', bullet: 'Bullet', daily: 'Daily', practice: 'Practice', unknown: 'Other' };
export const capital = (s) => s[0].toUpperCase() + s.slice(1);

// ---------- Toasts and confirm ----------

export function toast(message, { kind = 'info', ms = 3500 } = {}) {
  let host = $('#toasts');
  if (!host) {
    host = h('div#toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const t = h(`div.toast.${kind}`, message);
  host.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

/** In-page confirm dialog. Resolves true/false. */
export function confirmDialog({ title, body, confirm = 'Yes', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const close = (v) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    const dlg = h(
      'dialog.dialog',
      { onclose: () => resolve(false), oncancel: () => resolve(false) },
      h('h3', title),
      body ? h('p', body) : null,
      h('div.row.end', h('button.btn', { type: 'button', onclick: () => close(false) }, cancel), h(`button.btn.${danger ? 'danger' : 'primary'}`, { type: 'button', onclick: () => close(true) }, confirm)),
    );
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** Modal sheet with arbitrary content; returns { el, close }. */
export function sheet(title, content, { onClose } = {}) {
  const dlg = h('dialog.sheet', h('header.sheet-head', h('h3', title), h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => close() }, '✕')), h('div.sheet-body', content));
  const close = () => {
    dlg.close();
    dlg.remove();
    onClose?.();
  };
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
  document.body.append(dlg);
  dlg.showModal();
  return { el: dlg, close };
}

export function progressBar(fraction, label) {
  return h('div.progress', { role: 'progressbar', 'aria-valuenow': Math.round(fraction * 100), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': label }, h('span', { style: { width: `${Math.round(fraction * 100)}%` } }));
}

export function emptyState(title, text, action) {
  return h('div.empty', h('p.empty-title', title), text ? h('p', text) : null, action ?? null);
}

/** Won/drawn/lost bar with labels for screen readers. */
export function wdlBar({ w, d, l }, { labels = true } = {}) {
  const total = w + d + l || 1;
  const seg = (cls, n, name) => (n ? h(`span.${cls}`, { style: { flexGrow: n }, title: `${name}: ${n}` }, labels && n / total > 0.14 ? `${Math.round((n / total) * 100)}%` : '') : null);
  return h('div.wdl', { role: 'img', 'aria-label': `Won ${w}, drawn ${d}, lost ${l}` }, seg('w', w, 'Won'), seg('d', d, 'Drawn'), seg('l', l, 'Lost'));
}
