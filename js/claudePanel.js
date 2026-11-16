// The Claude box used by every feature: "Ask Claude" (streams with the API key) and "Copy for Claude".
import { askClaude, copyPrompt, hasApiKey, makeRequest } from './claude.js';
import { h, markdown, toast } from './ui.js';

/**
 * opts:
 *  label        – button text, e.g. "Why was this a mistake?"
 *  question     – the first question
 *  facts()      – async () => facts text (built when needed, so it's always current)
 *  extra        – extra instructions for this feature
 *  chips        – quick follow-up questions (optional; enables the follow-up box)
 *  compact      – smaller layout
 */
export function claudePanel(opts) {
  let history = [];
  let controller = null;
  const out = h('div.claude-out', { 'aria-live': 'polite' });
  const status = h('p.claude-status.muted');
  const follow = h('div.claude-follow', { hidden: true });

  const askBtn = h('button.btn.primary', { type: 'button', onclick: () => run(opts.question) }, opts.label ?? 'Ask Claude');
  const copyBtn = h('button.btn', { type: 'button', onclick: () => copy(opts.question) }, 'Copy for Claude');
  const stopBtn = h('button.btn', { type: 'button', hidden: true, onclick: () => controller?.abort() }, 'Stop');
  const el = h(`section.claude${opts.compact ? '.compact' : ''}`, h('div.row.wrap', askBtn, copyBtn, stopBtn), status, out, follow);

  hasApiKey().then((has) => {
    if (!has) {
      askBtn.classList.remove('primary');
      askBtn.title = 'Add an API key in Settings to get answers here';
      copyBtn.classList.add('primary');
    }
  });

  async function request(question) {
    return makeRequest({ title: opts.label, facts: await opts.facts(), question, extra: opts.extra ?? '', history });
  }

  async function copy(question) {
    const req = await request(question);
    await copyPrompt(req);
    toast('Copied. Paste it into a Claude chat.');
  }

  async function run(question) {
    if (!(await hasApiKey())) {
      await copy(question);
      status.textContent = 'No API key saved, so the full prompt was copied instead. Paste it into claude.ai, or add a key in Settings.';
      return;
    }
    const req = await request(question);
    const turn = h('div.claude-turn');
    if (history.length) turn.append(h('p.claude-q', question));
    const answer = h('div.claude-a');
    turn.append(answer);
    out.append(turn);
    controller = new AbortController();
    askBtn.disabled = true;
    stopBtn.hidden = false;
    let raf = 0;
    try {
      const text = await askClaude(req, {
        signal: controller.signal,
        onStatus: (s) => {
          status.textContent = s === 'thinking' ? 'Claude is thinking…' : s === 'writing' ? 'Claude is writing…' : '';
        },
        onText: (_d, full) => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => (answer.innerHTML = markdown(full)));
        },
      });
      cancelAnimationFrame(raf);
      answer.innerHTML = markdown(text);
      history = [...history, { role: 'user', text: question }, { role: 'assistant', text }];
      status.textContent = '';
      showFollowUps();
    } catch (e) {
      status.textContent = e.message;
      if (!answer.textContent) turn.remove();
    } finally {
      askBtn.disabled = false;
      stopBtn.hidden = true;
      askBtn.textContent = 'Ask again';
    }
  }

  function showFollowUps() {
    if (!opts.chips) return;
    follow.hidden = false;
    follow.replaceChildren(
      h('div.chips', opts.chips.map((q) => h('button.chip', { type: 'button', onclick: () => run(q) }, q))),
      h(
        'form.row',
        {
          onsubmit: (e) => {
            e.preventDefault();
            const input = e.target.elements.q;
            if (!input.value.trim()) return;
            run(input.value.trim());
            input.value = '';
          },
        },
        h('input.input', { name: 'q', placeholder: 'Ask a follow-up question…', 'aria-label': 'Follow-up question', autocomplete: 'off' }),
        h('button.btn', { type: 'submit' }, 'Ask'),
        h('button.btn', { type: 'button', onclick: (e) => copy(e.target.form.elements.q.value.trim() || opts.question) }, 'Copy'),
      ),
    );
  }

  return {
    el,
    reset(newOpts) {
      controller?.abort();
      Object.assign(opts, newOpts);
      history = [];
      out.replaceChildren();
      status.textContent = '';
      follow.hidden = true;
      askBtn.textContent = opts.label ?? 'Ask Claude';
    },
  };
}
