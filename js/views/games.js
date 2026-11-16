import { saveImported } from '../chesscom.js';
import { db, getSettings, on } from '../db.js';
import { autoSync } from '../main.js';
import { myResult, parseManyPgn } from '../pgn.js';
import { enqueue, queueState, stopQueue } from '../reviewer.js';
import { TIME_CLASS_LABEL, clear, emptyState, fmtDate, h, progressBar, sheet, toast } from '../ui.js';

const RESULT_LABEL = { win: 'Won', draw: 'Drew', loss: 'Lost' };

export async function render(view) {
  const filters = { timeClass: 'all', result: 'all', reviewed: 'all' };
  let shown = 40;
  const listHost = h('div');
  const queueHost = h('div');
  const filterHost = h('div.chips.scroll');

  const settings = await getSettings();
  const syncBtn = h('button.btn', { type: 'button', onclick: async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing…';
    await autoSync({ force: true });
    syncBtn.disabled = false;
    syncBtn.textContent = 'Sync now';
  } }, 'Sync now');

  view.append(
    h(
      'div.page-head',
      h('h1', 'Games'),
      h('div.row.wrap', settings.username ? syncBtn : null, h('button.btn', { type: 'button', onclick: openImport }, 'Import PGN'), h('button.btn.primary', { type: 'button', onclick: reviewAll }, 'Review all')),
    ),
    queueHost,
    filterHost,
    h('section.card', listHost),
  );

  let games = [];
  async function load() {
    games = (await db.all('games')).sort((a, b) => b.date - a.date);
    renderFilters();
    renderList();
  }

  function renderFilters() {
    clear(filterHost);
    const classes = ['all', ...new Set(games.map((g) => g.timeClass))];
    const chip = (key, value, label) =>
      h(`button.chip${filters[key] === value ? '.active' : ''}`, { type: 'button', 'aria-pressed': filters[key] === value, onclick: () => {
        filters[key] = value;
        shown = 40;
        renderFilters();
        renderList();
      } }, label);
    filterHost.append(
      ...classes.map((c) => chip('timeClass', c, c === 'all' ? 'All' : TIME_CLASS_LABEL[c] ?? c)),
      chip('result', 'win', 'Wins'),
      chip('result', 'loss', 'Losses'),
      chip('reviewed', 'no', 'Not reviewed'),
      filters.result !== 'all' || filters.reviewed !== 'all' ? h('button.chip', { type: 'button', onclick: () => {
        filters.result = 'all';
        filters.reviewed = 'all';
        renderFilters();
        renderList();
      } }, 'Clear filters') : null,
    );
  }

  const visible = () =>
    games.filter(
      (g) =>
        (filters.timeClass === 'all' || g.timeClass === filters.timeClass) &&
        (filters.result === 'all' || myResult(g) === filters.result) &&
        (filters.reviewed === 'all' || (filters.reviewed === 'no' ? !g.reviewed : g.reviewed)),
    );

  function renderList() {
    clear(listHost);
    const list = visible();
    if (!games.length) {
      listHost.append(
        emptyState(
          'No games yet',
          settings.username ? 'Tap "Sync now" to fetch your games from chess.com.' : 'Add your chess.com username in Settings, or import a PGN file.',
          settings.username ? null : h('a.btn.primary', { href: '#/settings' }, 'Open Settings'),
        ),
      );
      return;
    }
    if (!list.length) {
      listHost.append(emptyState('No games match these filters'));
      return;
    }
    const ul = h('ul.list');
    for (const g of list.slice(0, shown)) ul.append(h('li', gameRow(g)));
    listHost.append(h('p.muted.small', `${list.length} game${list.length === 1 ? '' : 's'}`), ul);
    if (list.length > shown) listHost.append(h('button.btn', { type: 'button', onclick: () => {
      shown += 60;
      renderList();
    } }, 'Show more'));
  }

  function renderQueue(state = queueState()) {
    clear(queueHost);
    if (!state.running && !state.queue.length) return;
    const total = state.total || 1;
    const fraction = (state.done + state.progress) / total;
    queueHost.append(
      h(
        'section.card.queue',
        h('div.row.between', h('strong', `Reviewing game ${Math.min(state.done + 1, total)} of ${total}`), h('button.btn.small', { type: 'button', onclick: stopQueue }, 'Stop')),
        progressBar(fraction, 'Review progress'),
        state.running ? h('p.muted.small', `${state.running.white} vs ${state.running.black} · ${Math.round(state.progress * 100)}%`) : null,
      ),
    );
  }

  async function reviewAll() {
    const todo = games.filter((g) => !g.reviewed);
    if (!todo.length) return toast('Every game is already reviewed.');
    const n = enqueue(todo);
    toast(n ? `Reviewing ${n} game${n === 1 ? '' : 's'} on this device. You can keep using the app.` : 'Those games are already in the queue.');
  }

  function openImport() {
    const text = h('textarea.input', { placeholder: 'Paste one or more games in PGN format…', 'aria-label': 'PGN text' });
    const files = h('input', { type: 'file', accept: '.pgn,text/plain,application/x-chess-pgn', multiple: true, 'aria-label': 'PGN files' });
    const side = h('select.input', h('option', { value: 'auto' }, 'Work it out from my username'), h('option', { value: 'w' }, 'White'), h('option', { value: 'b' }, 'Black'));
    const msg = h('p.muted.small');
    const s = sheet(
      'Import PGN',
      h(
        'form.stack',
        { onsubmit: async (e) => {
          e.preventDefault();
          let all = text.value;
          for (const f of files.files) all += `\n\n${await f.text()}`;
          if (!all.trim()) return (msg.textContent = 'Paste a PGN or choose a file first.');
          const opts = { me: settings.username, myColor: side.value === 'auto' ? null : side.value };
          const { games: parsed, skipped } = parseManyPgn(all, opts);
          const fresh = await saveImported(parsed);
          const dupes = parsed.length - fresh.length;
          toast(`Imported ${fresh.length} game${fresh.length === 1 ? '' : 's'}${dupes ? `, ${dupes} already saved` : ''}${skipped ? `, ${skipped} skipped (variants or unreadable)` : ''}.`);
          s.close();
          if (fresh.length && settings.autoReview) enqueue(fresh.slice(0, 3));
        } },
        h('label.field', 'Paste PGN', text),
        h('label.field', 'Or choose .pgn files', files),
        h('label.field', 'Which side did you play?', side),
        msg,
        h('div.row.end', h('button.btn.primary', { type: 'submit' }, 'Import')),
      ),
    );
  }

  const offs = [on('games', load), on('reviews', load), on('review-queue', renderQueue)];
  await load();
  renderQueue();
  return () => offs.forEach((off) => off());
}

export function gameRow(g) {
  const res = myResult(g);
  const me = g.myColor;
  const opp = me === 'b' ? { name: g.white, elo: g.whiteElo } : { name: g.black, elo: g.blackElo };
  const acc = g.accuracy && me ? g.accuracy[me]?.accuracy : null;
  return h(
    'a.list-row',
    { href: `#/review/${encodeURIComponent(g.id)}` },
    h(`span.dot-colour.${me ?? 'w'}`, { title: me ? `You played ${me === 'w' ? 'White' : 'Black'}` : 'Side unknown' }),
    h(
      'span.list-main',
      h('span.list-title', me ? `vs ${opp.name}${opp.elo ? ` (${opp.elo})` : ''}` : `${g.white} vs ${g.black}`),
      h('span.list-sub', [TIME_CLASS_LABEL[g.timeClass] ?? g.timeClass, fmtDate(g.date), g.opening].filter(Boolean).join(' · ')),
    ),
    acc != null ? h('span.pill', { title: 'Your accuracy' }, `${Math.round(acc)}%`) : g.reviewed ? null : h('span.pill', { title: 'Not reviewed yet' }, 'New'),
    res ? h(`span.pill.${res}`, RESULT_LABEL[res]) : h('span.pill', g.result),
  );
}
