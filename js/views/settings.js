import { fetchStats } from '../chesscom.js';
import { KEYS_URL, MODELS, checkKey } from '../claude.js';
import { db, getKv, getSettings, resetSettingsCache, saveSettings, setKv } from '../db.js';
import { autoSync } from '../main.js';
import { THEMES, applyTheme, currentTheme } from '../theme.js';
import { confirmDialog, h, timeAgo, toast } from '../ui.js';
import { VERSION } from '../version.js';

export async function render(view, { params } = {}) {
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

  const claudeCard = h('section.card#claude');

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
    claudeCard,
    h(
      'section.card',
      h('h2', 'Look and feel'),
      themePicker(),
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
    h('p.muted.small', `Post-Mortem version ${VERSION}. Engine: Stockfish 19 (lite). Board: chessground. Rules: chess.js. All analysis runs on your device.`),
  );

  drawClaude(s.apiKey);
  if (params?.section === 'claude') requestAnimationFrame(() => claudeCard.scrollIntoView({ block: 'start' }));

  /** The "Claude coach" card: connected, or a step-by-step guide to connect. */
  function drawClaude(savedKey, { editing = false, message = '' } = {}) {
    const connected = !!savedKey && !editing;
    const pill = connected ? h('span.pill.win', '✓ Connected') : h('span.pill', 'Not connected');
    if (connected) {
      const msg = h('p.muted.small', message);
      claudeCard.replaceChildren(
        h('div.row.between', h('h2', 'Claude coach'), pill),
        h('p', 'Every "Ask Claude" button now answers right here in the app, and you can ask follow-up questions.'),
        h('p.muted.small', `Key ending in …${savedKey.slice(-4)} · saved only on this device`),
        h('span.small.muted', 'Which Claude answers'),
        modelPicker(),
        h(
          'div.row.wrap',
          h('button.btn', { type: 'button', onclick: async (e) => {
            e.currentTarget.disabled = true;
            msg.textContent = 'Checking…';
            const r = await checkKey(savedKey, (await getSettings()).model);
            drawClaude(savedKey, { message: r.ok ? 'All good: Claude is reachable.' : r.message });
          } }, 'Test connection'),
          h('button.btn', { type: 'button', onclick: () => drawClaude(savedKey, { editing: true }) }, 'Change key'),
          h('button.btn.danger', { type: 'button', onclick: async () => {
            await saveSettings({ apiKey: '' });
            toast('Claude disconnected. The key was removed from this device.');
            drawClaude('');
          } }, 'Disconnect'),
        ),
        msg,
      );
      return;
    }

    const keyInput = h('input.input', { type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', spellcheck: false, 'aria-label': 'Anthropic API key' });
    const msg = h('p.small', { role: 'status' }, message);
    const connectBtn = h('button.btn.primary', { type: 'submit' }, 'Connect');
    const pasteBtn = h('button.btn', { type: 'button', hidden: !navigator.clipboard?.readText, onclick: async () => {
      try {
        keyInput.value = (await navigator.clipboard.readText()).trim();
        if (keyInput.value) connect();
      } catch {
        msg.textContent = 'Could not read the clipboard. Long-press the box and choose Paste instead.';
      }
    } }, 'Paste');

    async function connect() {
      connectBtn.disabled = true;
      msg.className = 'small';
      msg.textContent = 'Checking your key with Anthropic…';
      const r = await checkKey(keyInput.value, (await getSettings()).model);
      connectBtn.disabled = false;
      if (!r.ok) {
        msg.className = 'small bad-text';
        msg.textContent = r.message;
        return;
      }
      await saveSettings({ apiKey: keyInput.value.trim() });
      toast('Claude is connected. Try any "Ask Claude" button.');
      drawClaude(keyInput.value.trim());
    }

    const step = (n, ...content) => h('li.step', h('span.step-num', String(n)), h('div.stack', ...content));
    claudeCard.replaceChildren(
      h('div.row.between', h('h2', 'Claude coach'), pill),
      h('p', 'Connect Claude and every "Ask Claude" button explains your moves right here, like a coach next to you. It takes about two minutes.'),
      h(
        'ol.steps',
        step(1, h('span', 'Open the Anthropic console and sign in or create an account.'), h('a.btn.small', { href: KEYS_URL, target: '_blank', rel: 'noopener' }, 'Open the console ↗')),
        step(2, h('span', 'Under ', h('strong', 'Billing'), ', add a little credit. Set a monthly limit there too, so it can never surprise you.')),
        step(3, h('span', 'Under ', h('strong', 'API keys'), ', tap ', h('strong', 'Create key'), ', call it "Post-Mortem" and copy it.')),
        step(
          4,
          h('span', 'Come back here and paste it:'),
          h(
            'form.stack',
            { onsubmit: (e) => {
              e.preventDefault();
              connect();
            } },
            h('div.row', keyInput, pasteBtn),
            h('div.row.wrap', connectBtn, savedKey ? h('button.btn', { type: 'button', onclick: () => drawClaude(savedKey) }, 'Cancel') : null),
            msg,
          ),
        ),
      ),
      h('p.muted.small', 'The API is paid separately from a Claude subscription: you pay Anthropic per answer (you can pick a cheaper model once connected). Your key is saved only on this device and is sent only to Anthropic.'),
      h('p.small', h('strong', 'No key? '), 'Every Claude button still works: it opens your Claude app with the question ready, using your normal Claude subscription.'),
    );
  }

  /** Opus / Sonnet / Haiku: better answers or lower cost. */
  function modelPicker() {
    const host = h('div.stack', { role: 'radiogroup', 'aria-label': 'Claude model' });
    const draw = async () => {
      const chosen = (await getSettings()).model;
      host.replaceChildren(
        ...MODELS.map((m) =>
          h(
            `button.model-option${chosen === m.id ? '.active' : ''}`,
            { type: 'button', role: 'radio', 'aria-checked': chosen === m.id, onclick: async () => {
              await saveSettings({ model: m.id });
              draw();
            } },
            h('strong', m.label),
            h('span.muted.small', m.note),
          ),
        ),
      );
    };
    draw();
    return host;
  }

  /** Theme cards with a little preview of each look. */
  function themePicker() {
    const host = h('div.theme-grid', { role: 'radiogroup', 'aria-label': 'Theme' });
    const draw = () => {
      const current = currentTheme();
      host.replaceChildren(
        ...THEMES.map((t) =>
          h(
            `button.theme-card.t-${t.id}${current === t.id ? '.active' : ''}`,
            { type: 'button', role: 'radio', 'aria-checked': current === t.id, onclick: () => {
              applyTheme(t.id);
              draw();
            } },
            h(
              'span.theme-preview',
              { 'aria-hidden': 'true', style: { background: t.paper } },
              h('span.tp-card', { style: { background: t.card, borderColor: t.ink } }, h('span.tp-line', { style: { background: t.ink } }), h('span.tp-btn', { style: { background: t.accent } })),
            ),
            h('span.theme-name', t.label),
          ),
        ),
      );
    };
    draw();
    return host;
  }

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
    try {
      localStorage.removeItem('pm-theme');
      localStorage.removeItem('pm-level');
    } catch {
      // Nothing stored.
    }
    toast('All data cleared.');
    location.hash = '#/home';
    location.reload();
  }
}
