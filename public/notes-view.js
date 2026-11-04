import { parseDiscordExport } from './notes-import.js';

export function createNotesView({ h, icon, api, jsonPost, toast, query, clearQuery, copyText }) {
  const state = { anchor: null, focus: null, items: [], filter: 'all', total: 0, due: 0, cursor: null, loaded: false, loading: false, draft: '', reminder: '', files: [], sending: false, follow: true, edit: null, request: 0 };
  let shell, history, list, summary, composer, draft, reminder, send, older, error, importing, fileInput, mediaInput, uploads, filterSelect, viewKey, fit;
  let reminderToggle, reminderChip, reminderText, reminderRemove, reminderClear, attach, latest;
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
  // Share links: Discord shows a preview card; opening the link still needs a Marquee sign-in.
  async function shareNote(note, stop = false) {
    showError('');
    try {
      const r = await api(`/api/admin/notes/${note.id}/${stop ? 'unshare' : 'share'}`, jsonPost({}));
      Object.assign(note, r.note);
      if (stop) toast('Link removed');
      else toast(await copyText(r.url) ? 'Link copied · Discord shows a preview' : r.url);
      render();
    } catch (e) { showError(e.message); }
  }
  function card(note) {
    const editing = state.edit === note.id;
    const row = h('article', { class: `note-message${note.doneAt ? ' is-done' : ''}`, 'data-note-id': note.id },
      h('header', { class: 'note-meta' }, h('strong', {}, note.authorName || 'Admin'),
        h('time', { datetime: new Date(note.createdAt).toISOString(), title: new Date(note.createdAt).toISOString() }, date(note.createdAt)),
        note.pinned && h('span', { class: 'note-tag' }, 'Pinned'),
        note.shareToken && !note.deletedAt && h('span', { class: 'note-tag is-shared', title: 'Anyone with the link sees a preview; opening it needs Marquee access' }, 'Shared'),
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
    if (note.attachments.length) row.append(h('div', { class: 'note-attachments' }, note.attachments.map(attachmentView)));
    if (note.reminderAt) row.append(h('p', { class: `note-deadline${!note.doneAt && note.reminderAt <= Date.now() ? ' is-due' : ''}` },
      note.doneAt ? 'Done · ' : note.reminderAt <= Date.now() ? 'Due · ' : 'Reminder · ', date(note.reminderAt)));
    const actions = note.deletedAt
      ? [button('Restore', () => mutate(note, {}, 'restore'))]
      : [button('Edit', () => { state.edit = note.id; render(); shell.querySelector('.note-edit')?.focus(); }),
        button(note.pinned ? 'Unpin' : 'Pin', () => mutate(note, { pinned: !note.pinned })),
        note.reminderAt && button(note.doneAt ? 'Mark not done' : 'Mark done', () => mutate(note, { done: !note.doneAt })),
        button(note.shareToken ? 'Copy link' : 'Share', () => shareNote(note)),
        note.shareToken && button('Stop sharing', () => shareNote(note, true)),
        button('Move to trash', () => mutate(note, {}, 'trash'))];
    row.append(h('div', { class: 'note-actions' }, actions));
    return row;
  }
  function attachmentView(a) {
    const href = a.fileId ? `/api/admin/notes/files/${a.fileId}` : a.url;
    let preview;
    if (a.fileId && a.mime?.startsWith('image/')) {
      const img = h('img', { src: `${href}?view=1`, loading: 'lazy', alt: a.name });
      img.addEventListener('error', () => { img.hidden = true; });
      preview = h('a', { href: `${href}?view=1`, target: '_blank', rel: 'noopener' }, img);
    } else if (a.fileId && a.mime?.startsWith('video/')) preview = h('video', { src: `${href}?view=1`, controls: true, playsinline: true, preload: 'metadata' });
    else if (a.fileId && a.mime?.startsWith('audio/')) preview = h('audio', { src: `${href}?view=1`, controls: true, preload: 'metadata' });
    const media = preview?.querySelector('img') || (preview?.tagName === 'VIDEO' ? preview : null);
    if (media) media.addEventListener(media.tagName === 'IMG' ? 'load' : 'loadedmetadata', () => { if (state.follow) history.scrollTop = history.scrollHeight; });
    return h('div', { class: 'note-attachment' }, preview,
      h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'note-file-link' }, a.name));
  }
  function updateComposer() {
    if (!send) return;
    send.disabled = state.sending || state.files.some((f) => !f.attachment) || (!state.draft.trim() && !state.files.length);
    draft.readOnly = state.sending;
    attach.disabled = state.sending;
    reminder.disabled = reminderToggle.disabled = reminderRemove.disabled = reminderClear.disabled = state.sending;
    reminderToggle.classList.toggle('has-reminder', !!state.reminder);
    reminderToggle.setAttribute('aria-label', state.reminder ? 'Edit reminder' : 'Add reminder');
    reminderClear.hidden = reminderChip.hidden = !state.reminder;
    reminderText.textContent = state.reminder ? new Date(state.reminder).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    uploads.hidden = !state.files.length;
    uploads.replaceChildren(...state.files.map((f) => h('div', { class: `note-upload${f.error ? ' has-error' : ''}` },
      h('span', { class: 'note-upload-name' }, f.file.name),
      h('span', { class: 'note-upload-state', role: 'status' }, f.error || (f.attachment ? 'Ready' : `${f.progress || 0}%`)),
      button('×', () => {
        f.cancelled = true; f.controller?.abort(); state.files = state.files.filter((x) => x !== f); updateComposer();
        if (f.id) api(`/api/admin/notes/uploads/${f.id}/cancel`, jsonPost({})).catch(() => {});
      }, { 'aria-label': `Remove ${f.file.name}`, disabled: state.sending }))));
  }
  async function uploadFile(entry) {
    const file = entry.file; entry.controller = new AbortController();
    try {
      if (!file.size || file.size > 1024 ** 3) throw new Error('Choose a file up to 1 GB.');
      const opts = { signal: entry.controller.signal };
      const session = await api('/api/admin/notes/uploads', { ...jsonPost({ name:file.name, size:file.size, type:file.type }), ...opts });
      entry.id = session.id;
      let offset = session.offset, retries = 0;
      while (offset < file.size) {
        if (entry.cancelled) return;
        try {
          const next = await api(`/api/admin/notes/uploads/${session.id}?offset=${offset}`, {
            method:'POST', body:file.slice(offset,offset + session.chunkSize), headers:{'content-type':'application/octet-stream'}, ...opts,
          });
          offset = next.offset; retries = 0;
        } catch (e) {
          if (entry.cancelled || ++retries > 3) throw e;
          await new Promise((r) => setTimeout(r, retries * 400));
          offset = (await api(`/api/admin/notes/uploads/${session.id}`, opts)).offset;
        }
        entry.progress = Math.round(offset / file.size * 100); updateComposer();
      }
      const done = await api(`/api/admin/notes/uploads/${session.id}/finish`, { ...jsonPost({}), ...opts }).catch(async (error) => {
        if (entry.cancelled) throw error;
        const status = await api(`/api/admin/notes/uploads/${session.id}`, opts);
        if (!status.attachment) throw error;
        return status;
      });
      entry.attachment = done.attachment;
    } catch (e) { if (!entry.cancelled) entry.error = e.message; }
    finally { updateComposer(); }
  }
  async function addFiles(files) {
    if (!files?.length || state.sending) return;
    if (files.length + state.files.length > 50) { showError('Attach up to 50 files per note.'); return; }
    const entries = [...files].map((file) => ({ file, progress:0 })); state.files.push(...entries); updateComposer();
    for (const entry of entries) if (!entry.cancelled) await uploadFile(entry);
  }
  function setup() {
    const target = document.querySelector('#notes-body');
    if (!target || shell) return;
    error = h('p', { class: 'note-error', role: 'alert', hidden: true });
    summary = h('span', { class: 'note-summary', 'aria-live': 'polite' });
    filterSelect = h('select', { class: 'note-filter', 'aria-label': 'Notes filter' },
      [['all', 'All notes'], ['pinned', 'Pinned'], ['due', 'Due'], ['trash', 'Trash']].map(([key,label]) => h('option', { value:key }, label)));
    filterSelect.addEventListener('change', () => { state.filter = filterSelect.value; state.edit = null; state.anchor = null; load(); });
    const menu = h('details', { class: 'note-menu' });
    menu.append(h('summary', { 'aria-label': 'Notes menu', title: 'Notes menu' }, '⋯'),
      h('div', { class: 'note-menu-panel' },
        button('Refresh', () => { menu.open = false; if (state.edit) { showError('Finish editing before refreshing.'); return; } load(); }),
        button('Import Discord', () => { menu.open = false; fileInput.click(); })));
    latest = button('Show latest notes', () => { state.anchor = state.focus = null; load(); }, { class: 'retry note-latest', hidden: true });
    older = button('Load older messages', async () => { older.disabled = true; await load(true); older.disabled = false; }, { class: 'retry', hidden: true });
    list = h('div', { class: 'notes-messages', role: 'list', 'aria-label': 'Shared notes' });
    draft = h('textarea', { class: 'note-draft', placeholder: 'Write a note…', 'aria-label': 'New note', maxlength: 30000, rows: 1 }); draft.value = state.draft;
    draft.addEventListener('input', () => {
      state.draft = draft.value; draft.style.height = 'auto'; draft.style.height = `${Math.min(160,draft.scrollHeight)}px`; updateComposer();
    });
    draft.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); if (!send.disabled) composer.requestSubmit(); }
    });
    draft.addEventListener('paste', (e) => { if (e.clipboardData?.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } });
    reminder = h('input', { type: 'datetime-local', 'aria-label': 'Reminder date' }); reminder.value = state.reminder;
    reminder.addEventListener('input', () => { state.reminder = reminder.value; updateComposer(); });
    const closeReminder = (focus = false) => {
      panel.hidden = true; reminderToggle.setAttribute('aria-expanded', 'false');
      if (focus) reminderToggle.focus({ preventScroll: true });
    };
    const clearReminder = () => { reminder.value = state.reminder = ''; updateComposer(); };
    reminderToggle = button([icon('bell'), h('span', { class: 'note-reminder-label' }, 'Reminder')], () => {
      if (!panel.hidden) { closeReminder(); return; }
      panel.hidden = false; reminderToggle.setAttribute('aria-expanded', 'true'); reminder.focus({ preventScroll: true });
    }, { class: 'note-reminder-toggle', 'aria-label': 'Add reminder', 'aria-expanded': 'false', 'aria-controls': 'note-reminder-panel' });
    reminderClear = button('Remove reminder', clearReminder, { hidden: true });
    const panel = h('div', { id: 'note-reminder-panel', class: 'note-menu-panel note-reminder-panel', hidden: true },
      h('label', { class: 'note-reminder' }, 'Remind me', reminder),
      h('p', { class: 'muted' }, 'Appears in Due at this time.'),
      h('div', { class: 'note-reminder-actions' }, reminderClear, button('Done', () => closeReminder(true))));
    const options = h('div', { class: 'note-compose-options' }, reminderToggle, panel);
    reminder.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); closeReminder(true); } });
    document.addEventListener('pointerdown', (e) => { if (!panel.hidden && !options.contains(e.target)) closeReminder(); });
    options.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) { e.preventDefault(); e.stopPropagation(); closeReminder(true); }
    });
    reminderText = h('span');
    reminderRemove = button('×', clearReminder, { 'aria-label': 'Remove reminder', class: 'note-reminder-remove' });
    reminderChip = h('div', { class: 'note-reminder-chip', hidden: true }, icon('bell'), reminderText, reminderRemove);
    mediaInput = h('input', { type:'file', multiple:true, accept:'image/*,video/*,audio/*,.pdf', hidden:true, 'aria-label':'Attach media files' });
    mediaInput.addEventListener('change', () => { addFiles(mediaInput.files); mediaInput.value = ''; });
    send = h('button', { type: 'submit', class: 'note-send', 'aria-label':'Send', title:'Send', disabled:true }, icon('send'));
    attach = button(icon('plus'), () => mediaInput.click(), { class:'note-attach', 'aria-label':'Attach media', title:'Attach photos, videos or files' });
    uploads = h('div', { class:'note-uploads', hidden:true });
    composer = h('form', { class: 'note-composer', onsubmit: async (e) => {
      e.preventDefault(); if (send.disabled || state.sending) return;
      state.sending = true; closeReminder(); updateComposer(); showError('');
      try {
        await api('/api/admin/notes', jsonPost({ text:draft.value, attachments:state.files.map((f) => f.attachment), reminderAt:reminder.value ? new Date(reminder.value).getTime() : null }));
        draft.value = state.draft = ''; draft.style.height = ''; reminder.value = state.reminder = ''; state.files = []; state.filter = 'all'; state.anchor = state.focus = null;
        updateComposer();
        clearQuery(); await load(); history.scrollTop = history.scrollHeight;
      } catch (err) { showError(err.message); }
      finally { state.sending = false; updateComposer(); }
    } }, uploads, reminderChip, h('div', { class:'note-compose-row' }, attach, draft, options, send), mediaInput);
    fileInput = h('input', { type: 'file', accept: '.json,.csv,application/json,text/csv', hidden: true, 'aria-label': 'Discord message export' });
    fileInput.addEventListener('change', () => prepareImport(fileInput.files?.[0]));
    importing = h('div', { class: 'note-import', hidden: true });
    history = h('div', { class: 'notes-history', tabindex: 0, 'aria-label': 'Message history' }, older, list, latest);
    history.addEventListener('scroll', () => { state.follow = history.scrollHeight - history.scrollTop - history.clientHeight < 48; });
    shell = h('div', { class: 'notes-app' },
      h('div', { class: 'notes-toolbar' }, filterSelect, summary, menu), error, fileInput, importing, history, composer);
    target.append(shell); updateComposer();
    fit = () => {
      if (!shell.offsetParent) return;
      const height = window.visualViewport?.height || window.innerHeight;
      const keyboard = height < window.innerHeight - 100;
      const tabs = document.querySelector('.tabs')?.getBoundingClientRect();
      const bottom = keyboard ? 0 : tabs ? Math.max(0,window.innerHeight - tabs.top) : 76;
      shell.style.height = `${Math.max(180,height - Math.max(0,shell.getBoundingClientRect().top) - bottom - 12)}px`;
    };
    window.addEventListener('resize',fit); window.visualViewport?.addEventListener('resize',fit);
    requestAnimationFrame(fit);
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
    fit?.();
    const previousHeight = history.scrollHeight, previousTop = history.scrollTop;
    const wasAtEnd = previousHeight - previousTop - history.clientHeight < 48;
    const key = `${state.filter}:${query()}`;
    const request = ++state.request; state.loading = true; if (!appendOlder) state.edit = null;
    const params = new URLSearchParams({ q: query(), filter: state.filter });
    if (appendOlder && state.cursor) params.set('before', state.cursor);
    else if (state.anchor && !query()) params.set('before', state.anchor);
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
      if (state.focus && !appendOlder) {
        const el = list.querySelector(`[data-note-id="${state.focus}"]`);
        if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('is-focused'); setTimeout(() => el.classList.remove('is-focused'), 2600); }
        state.focus = null;
      }
    } }
  }
  // Opens one note in place (from a shared link): the list ends at that note, older ones above it.
  async function focus(id) {
    setup(); if (!shell) return;
    try {
      const { note } = await api(`/api/admin/notes/${id}`);
      clearQuery(); state.edit = null;
      state.filter = note.deletedAt ? 'trash' : 'all';
      state.anchor = `${note.createdAt}:${note.id + 1}`; state.focus = note.id;
      await load();
    } catch (e) { showError(e.message); }
  }
  function render() {
    setup(); if (!shell) return;
    summary.textContent = `${state.total.toLocaleString()} ${query() ? 'matching ' : ''}notes${state.due ? ` · ${state.due} due` : ''}`;
    filterSelect.value = state.filter;
    older.hidden = !state.cursor; latest.hidden = !state.anchor || !!query(); composer.hidden = state.filter === 'trash';
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
    if (state.anchor || state.edit || state.draft || state.files.length || state.sending || state.loading || state.items.length > 100 || query() || document.getSelection()?.toString()) return;
    const scroll = window.scrollY; await load(); window.scrollTo(0, scroll);
  }
  return { load, render, poll, focus };
}
