import { parseDiscordExport } from './notes-import.js';

export function createNotesView({ h, api, jsonPost, toast, query, clearQuery }) {
  const state = { items: [], filter: 'all', total: 0, due: 0, cursor: null, loaded: false, loading: false, draft: '', reminder: '', edit: null, request: 0 };
  let shell, history, list, summary, composer, draft, reminder, send, older, error, importing, fileInput, viewKey;
  const date = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const localInput = (ms) => {
    if (!ms) return '';
    const d = new Date(ms); return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const showError = (message) => { error.textContent = message || ''; error.hidden = !message; };
  const button = (label, action, props = {}) => h('button', { type: 'button', class: 'note-action', onclick: action, ...props }, label);

  function bodyText(text) {
    return text.split(/(https?:\/\/[^\s<>]+)/g).map((part) => /^https?:\/\//.test(part)
      ? h('a', { href: part, target: '_blank', rel: 'noopener noreferrer' }, part) : part);
  }
  async function mutate(note, patch, action = '') {
    try {
      await api(`/api/admin/notes/${note.id}${action ? `/${action}` : ''}`, jsonPost({ version: note.version, ...patch }));
      await load();
    } catch (e) { showError(e.message); }
  }
  function card(note) {
    const editing = state.edit === note.id;
    const row = h('article', { class: `note-message${note.doneAt ? ' is-done' : ''}`, 'data-note-id': note.id },
      h('header', { class: 'note-meta' }, h('strong', {}, note.authorName || 'Admin'),
        h('time', { datetime: new Date(note.createdAt).toISOString(), title: new Date(note.createdAt).toISOString() }, date(note.createdAt)),
        note.pinned && h('span', { class: 'note-tag' }, 'Pinned'),
        !note.sourceId && note.version > 1 && h('span', { title: date(note.updatedAt) }, 'edited'),
        note.sourceId && h('span', { class: 'note-tag', title: `Original Discord message ${note.sourceId}` }, 'Discord')));
    if (editing) {
      const text = h('textarea', { class: 'note-edit', 'aria-label': 'Edit note', maxlength: 30000 }); text.value = note.text;
      const at = h('input', { type: 'datetime-local', 'aria-label': 'Edit reminder date' }); at.value = localInput(note.reminderAt);
      const save = h('button', { type: 'submit', class: 'retry is-primary' }, 'Save changes');
      const form = h('form', { class: 'note-edit-form', onsubmit: async (e) => {
        e.preventDefault(); save.disabled = true; showError('');
        try {
          await api(`/api/admin/notes/${note.id}`, jsonPost({ version: note.version, text: text.value, reminderAt: at.value ? new Date(at.value).getTime() : null }));
          state.edit = null; await load(); toast('Note updated');
        } catch (err) { showError(err.message); } finally { save.disabled = false; }
      } }, text, h('label', { class: 'note-reminder' }, 'Remind me', at), h('div', { class: 'note-actions' }, save,
        button('Cancel', () => { state.edit = null; render(); })));
      text.addEventListener('keydown', (e) => { if (e.key === 'Escape') { state.edit = null; render(); } });
      row.append(form); return row;
    }
    row.append(h('div', { class: 'note-text' }, bodyText(note.text)));
    if (note.attachments.length) row.append(h('ul', { class: 'note-attachments' }, note.attachments.map((a) => h('li', {},
      h('a', { href: a.fileId ? `/api/admin/notes/files/${a.fileId}` : a.url, target: '_blank', rel: 'noopener noreferrer' }, a.name)))));
    if (note.reminderAt) row.append(h('p', { class: `note-deadline${!note.doneAt && note.reminderAt <= Date.now() ? ' is-due' : ''}` },
      note.doneAt ? 'Done · ' : note.reminderAt <= Date.now() ? 'Due · ' : 'Reminder · ', date(note.reminderAt)));
    const actions = note.deletedAt
      ? [button('Restore', () => mutate(note, {}, 'restore'))]
      : [button('Edit', () => { state.edit = note.id; render(); shell.querySelector('.note-edit')?.focus(); }),
        button(note.pinned ? 'Unpin' : 'Pin', () => mutate(note, { pinned: !note.pinned })),
        note.reminderAt && button(note.doneAt ? 'Mark not done' : 'Mark done', () => mutate(note, { done: !note.doneAt })),
        button('Move to trash', () => mutate(note, {}, 'trash'))];
    row.append(h('div', { class: 'note-actions' }, actions));
    return row;
  }
  function setup() {
    const target = document.querySelector('#notes-body');
    if (!target || shell) return;
    error = h('p', { class: 'note-error', role: 'alert', hidden: true });
    summary = h('p', { class: 'note-summary', 'aria-live': 'polite' });
    const filters = h('div', { class: 'note-filters', 'aria-label': 'Notes filters' },
      [['all', 'All notes'], ['pinned', 'Pinned'], ['due', 'Due'], ['trash', 'Trash']].map(([key, label]) => button(label, async () => {
        state.filter = key; state.edit = null; await load();
      }, { 'data-filter': key, 'aria-pressed': key === state.filter })));
    older = button('Load older messages', async () => { older.disabled = true; await load(true); older.disabled = false; }, { class: 'retry', hidden: true });
    list = h('div', { class: 'notes-messages', role: 'list', 'aria-label': 'Shared notes' });
    draft = h('textarea', { class: 'note-draft', placeholder: 'Write a note…', 'aria-label': 'New note', maxlength: 30000, rows: 2 }); draft.value = state.draft;
    draft.addEventListener('input', () => { state.draft = draft.value; send.disabled = !draft.value.trim(); });
    draft.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); if (!send.disabled) composer.requestSubmit(); }
    });
    reminder = h('input', { type: 'datetime-local', 'aria-label': 'Reminder date' }); reminder.value = state.reminder;
    reminder.addEventListener('input', () => { state.reminder = reminder.value; });
    send = h('button', { type: 'submit', class: 'retry is-primary', disabled: !state.draft.trim() }, 'Send');
    composer = h('form', { class: 'note-composer', onsubmit: async (e) => {
      e.preventDefault(); if (!draft.value.trim()) return;
      send.disabled = true; showError('');
      try {
        await api('/api/admin/notes', jsonPost({ text: draft.value, reminderAt: reminder.value ? new Date(reminder.value).getTime() : null }));
        draft.value = state.draft = ''; reminder.value = state.reminder = ''; state.filter = 'all';
        clearQuery(); await load(); draft.focus(); history.scrollTop = history.scrollHeight;
      } catch (err) { showError(err.message); } finally { send.disabled = !draft.value.trim(); }
    } }, draft, h('div', { class: 'note-compose-footer' }, h('label', { class: 'note-reminder' }, 'Remind me', reminder), send),
    h('p', { class: 'note-keyboard-hint' }, 'Enter to send · Shift+Enter for a new line'),
    h('p', { class: 'note-reminder-hint' }, 'Reminders appear in Due when you open Notes.'));
    fileInput = h('input', { type: 'file', accept: '.json,.csv,application/json,text/csv', hidden: true, 'aria-label': 'Discord message export' });
    fileInput.addEventListener('change', () => prepareImport(fileInput.files?.[0]));
    importing = h('div', { class: 'note-import', hidden: true });
    history = h('div', { class: 'notes-history', tabindex: 0, 'aria-label': 'Message history' }, older, list);
    shell = h('div', { class: 'notes-app' },
      h('p', { class: 'muted' }, 'Shared with Marquee admins.'),
      h('div', { class: 'notes-toolbar' }, filters, h('div', { class: 'note-actions' },
        button('Refresh', () => { if (state.edit) { showError('Finish editing before refreshing.'); return; } load(); }),
        button('Import Discord', () => fileInput.click()))),
      summary, error, fileInput, importing, history, composer);
    target.append(shell);
  }
  async function prepareImport(file) {
    if (!file) return;
    setup(); showError(''); importing.hidden = true; fileInput.value = '';
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Choose a conversation export smaller than 20 MB.');
      const parsed = parseDiscordExport(await file.text());
      const people = parsed.authors.filter((a) => !a.bot);
      const choose = h('select', { 'aria-label': 'Import messages by' },
        h('option', { value: '' }, 'Select your Discord account'), people.map((a) => h('option', { value: a.id }, a.name)));
      if (people.length === 1) choose.value = people[0].id;
      const count = h('p'); const submit = h('button', { type: 'button', class: 'retry is-primary' }, 'Import messages');
      const selected = () => parsed.messages.filter((m) => !parsed.authors.length || m.authorId === choose.value);
      const update = () => { const items = selected(); count.textContent = `${items.length.toLocaleString()} messages will be imported with their original dates. Existing message IDs are skipped.`; submit.disabled = !items.length; };
      choose.addEventListener('change', update); update();
      submit.addEventListener('click', async () => {
        submit.disabled = true; showError('');
        try {
          const result = await api('/api/admin/notes/import', jsonPost({ messages: selected(), channelId: parsed.channelId }));
          importing.hidden = true; toast(`Imported ${result.added} messages; ${result.skipped} already existed`); await load();
        } catch (e) { showError(e.message); submit.disabled = false; }
      });
      importing.replaceChildren(h('h3', {}, 'Import your Discord notes'),
        h('p', {}, `${file.name} · ${parsed.channelName}`),
        parsed.authors.length ? h('label', {}, 'Import messages by ', choose) : h('p', {}, 'Discord’s data package contains only the messages you sent.'), count,
        h('p', { class: 'muted' }, 'Choose only the MEE6 conversation. Attachments are preserved as links; Discord links may expire.'),
        h('div', { class: 'note-actions' }, submit, button('Cancel', () => { importing.hidden = true; })));
      importing.hidden = false;
    } catch (e) { showError(e.message); }
  }
  async function load(appendOlder = false) {
    setup(); if (!shell) return;
    const previousHeight = history.scrollHeight, previousTop = history.scrollTop;
    const wasAtEnd = previousHeight - previousTop - history.clientHeight < 48;
    const key = `${state.filter}:${query()}`;
    const request = ++state.request; state.loading = true; if (!appendOlder) state.edit = null;
    const params = new URLSearchParams({ q: query(), filter: state.filter });
    if (appendOlder && state.cursor) params.set('before', state.cursor);
    try {
      const result = await api(`/api/admin/notes?${params}`);
      if (request !== state.request) return;
      state.items = appendOlder ? [...result.notes, ...state.items] : result.notes;
      state.total = result.total; state.due = result.due; state.cursor = result.nextBefore; state.loaded = true; showError('');
    } catch (e) { if (request === state.request) showError(e.message); }
    finally { if (request === state.request) {
      state.loading = false; render();
      if (appendOlder) history.scrollTop = previousTop + history.scrollHeight - previousHeight;
      else if (key !== viewKey) history.scrollTop = state.filter === 'all' && !query() ? history.scrollHeight : 0;
      else history.scrollTop = wasAtEnd ? history.scrollHeight : previousTop;
      viewKey = key;
    } }
  }
  function render() {
    setup(); if (!shell) return;
    summary.textContent = `${state.total.toLocaleString()} ${query() ? 'matching ' : ''}notes${state.due ? ` · ${state.due} due` : ''}`;
    for (const el of shell.querySelectorAll('[data-filter]')) el.setAttribute('aria-pressed', String(el.dataset.filter === state.filter));
    older.hidden = !state.cursor; composer.hidden = state.filter === 'trash';
    if (!state.loaded) { list.replaceChildren(h('p', { class: 'muted' }, 'Loading notes…')); return; }
    if (!state.items.length) { list.replaceChildren(h('p', { class: 'notes-empty' }, query() ? 'No notes match those keywords.' : state.filter === 'trash' ? 'Trash is empty.' : state.filter === 'due' ? 'No reminders are due.' : state.filter === 'pinned' ? 'No pinned notes yet.' : 'Send yourself the first note below.')); return; }
    const out = []; let day = '';
    for (const note of state.items) {
      const label = new Date(note.createdAt).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
      if (label !== day) { out.push(h('h3', { class: 'note-day' }, label)); day = label; }
      out.push(card(note));
    }
    const scroll = history.scrollTop; list.replaceChildren(...out); history.scrollTop = scroll;
  }
  async function poll() {
    if (state.edit || state.draft || state.loading || state.items.length > 100 || query() || document.getSelection()?.toString()) return;
    const scroll = window.scrollY; await load(); window.scrollTo(0, scroll);
  }
  return { load, render, poll };
}
