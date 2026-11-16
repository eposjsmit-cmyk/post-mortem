import { fetchStats } from '../chesscom.js';
import { MODEL } from '../claude.js';
import { db, getKv, getSettings, resetSettingsCache, saveSettings, setKv } from '../db.js';
import { autoSync } from '../main.js';
import { confirmDialog, h, timeAgo, toast } from '../ui.js';

export async function render(view) {
  const s = await getSettings();
  const last = await getKv('lastSync', 0);
  const counts = { games: await db.count('games'), reviews: await db.count('reviews'), puzzles: await db.count('puzzles') };

  const username = h('input.input', { name: 'username', value: s.username, placeholder: 'e.g. JokerAm1', autocomplete: 'off', autocapitalize: 'none', spellcheck: false });
  const months = h(
    'select.input',
    { name: 'months' },
    [1, 3, 6, 12].map((m) => h('option', { value: m, selected: s.monthsBack === m }, `${m} month${m === 1 ? '' : 's'}`)),
  );
  const syncMsg = h('p.muted.small', last ? `Last synced ${timeAgo(last)}.` : 'Not synced yet.');

  const saveAccount = async (e) => {
    e.preventDefault();
    const name = username.value.trim();
    if (!name) return toast('Type your chess.com username first.', { kind: 'error' });
    const btn = e.submitter;
    btn.disabled = true;
    syncMsg.textContent = 'Checking your username…';
    try {
      await fetchStats(name);
    } catch (err) {
      syncMsg.textContent = err.message;
      btn.disabled = false;
      return;
    }
    const changed = name.toLowerCase() !== s.username.toLowerCase() || Number(months.value) > s.monthsBack;
    await saveSettings({ username: name, monthsBack: Number(months.value) });
    if (changed) await setKv('fetchedMonths', []);
    syncMsg.textContent = 'Syncing your games…';
    const r = await autoSync({ force: true });
    syncMsg.textContent = r ? `Done. ${r.added} new game${r.added === 1 ? '' : 's'}, ${r.total} in total.` : 'Sync did not finish. Try again in a moment.';
    btn.disabled = false;
  };

  const keyInput = h('input.input', { type: 'password', value: s.apiKey, placeholder: 'sk-ant-…', autocomplete: 'off', spellcheck: false, 'aria-label': 'Anthropic API key' });
  const showKey = h('button.btn', { type: 'button', onclick: () => {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    showKey.textContent = keyInput.type === 'password' ? 'Show' : 'Hide';
  } }, 'Show');

  view.append(
    h('div.page-head', h('h1', 'Settings')),
    h(
      'section.card',
      h('h2', 'Your chess.com account'),
      h('p.muted', 'Post-Mortem reads your public games from chess.com. No password is needed.'),
      h(
        'form.stack',
        { onsubmit: saveAccount },
        h('label.field', 'chess.com username', username),
        h('label.field', 'How far back to sync', months),
        h('div.row.wrap', h('button.btn.primary', { type: 'submit' }, s.username ? 'Save and sync now' : 'Save and sync')),
        syncMsg,
      ),
    ),
    h(
      'section.card',
      h('h2', 'Claude explanations'),
      h('p.muted', 'Without a key, every "Ask Claude" button copies a ready-made prompt you can paste into a Claude chat. With a key, answers stream straight into the app.'),
      h('label.field', 'Anthropic API key (optional)', h('div.row', keyInput, showKey)),
      h('p.muted.small', `Your key is saved only in this browser on this device and is sent only to Anthropic. Model: ${MODEL}.`),
      h(
        'div.row.wrap',
        h('button.btn.primary', { type: 'button', onclick: async () => {
          await saveSettings({ apiKey: keyInput.value.trim() });
          toast(keyInput.value.trim() ? 'API key saved on this device.' : 'API key removed.');
        } }, 'Save key'),
        s.apiKey ? h('button.btn', { type: 'button', onclick: async () => {
          keyInput.value = '';
          await saveSettings({ apiKey: '' });
          toast('API key removed.');
        } }, 'Remove key') : null,
      ),
    ),
    h(
      'section.card',
      h('h2', 'Reviews'),
      h('label.check', h('input', { type: 'checkbox', checked: s.autoReview, onchange: (e) => saveSettings({ autoReview: e.target.checked }) }), 'Review new games automatically (a few at a time)'),
    ),
    h(
      'section.card',
      h('h2', 'Your data'),
      h('p.muted', `Stored in this browser: ${counts.games} games, ${counts.reviews} reviews, ${counts.puzzles} puzzles.`),
      h('div.row.wrap', h('button.btn.danger', { type: 'button', onclick: clearAll }, 'Clear all data')),
    ),
    h('p.muted.small', 'Engine: Stockfish 19 (lite). Board: chessground. Rules: chess.js. All analysis runs on your device.'),
  );

  async function clearAll() {
    const ok = await confirmDialog({
      title: 'Clear all data?',
      body: 'This deletes every game, review, puzzle and setting (including your API key) from this browser. Your games stay on chess.com and can be synced again. This cannot be undone.',
      confirm: 'Yes, clear everything',
      danger: true,
    });
    if (!ok) return;
    await db.clearAll();
    resetSettingsCache();
    toast('All data cleared.');
    location.hash = '#/home';
    location.reload();
  }
}
