// Discord's own data exports and common JSON/CSV conversation exports. No account tokens needed.
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted || !cell) quoted = !quoted;
      else cell += c;
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(cell); cell = '';
      if (c !== ',') { if (row.some(Boolean)) rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else cell += c;
  }
  if (quoted) throw new Error('The CSV ends inside a quoted message.');
  row.push(cell); if (row.some(Boolean)) rows.push(row);
  const headers = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  if (!headers.includes('id') || !headers.includes('timestamp')) throw new Error('Choose a Discord messages CSV with ID and Timestamp columns.');
  return rows.map((values) => Object.fromEntries(headers.map((key, i) => [key, values[i] || ''])));
}

export function importTimestamp(value, id) {
  if ((value === undefined || value === null || value === '') && /^\d{16,22}$/.test(String(id || ''))) {
    return Number((BigInt(id) >> 22n) + 1420070400000n);
  }
  let date = value;
  if (typeof date === 'string') {
    date = date.trim();
    // Old Discord CSVs contain UTC timestamps without a timezone marker.
    if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(date)) date = date.replace(' ', 'T') + 'Z';
  }
  const ms = typeof date === 'number' ? date : Date.parse(date);
  if (!Number.isFinite(ms) || ms < 0 || ms > 8640000000000000) throw new Error('A message has a missing or invalid original date.');
  return ms;
}

export function parseDiscordExport(text) {
  text = text.replace(/^\uFEFF/, '').trim();
  let data;
  try { data = /^[\[{]/.test(text) ? JSON.parse(text) : parseCsv(text); }
  catch (e) { throw new Error(`Could not read the message export: ${e.message}`); }
  const rows = Array.isArray(data) ? data : data.messages;
  if (!Array.isArray(rows)) throw new Error('Choose the MEE6 conversation’s messages.json or messages.csv file.');
  if (!rows.length) throw new Error('This export contains no messages.');
  const authors = new Map();
  const messages = rows.map((row, i) => {
    const r = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
    const id = r.id ?? r.messageid;
    if (typeof id === 'number' && !Number.isSafeInteger(id)) throw new Error('Message IDs must be strings so their original precision is preserved.');
    if (!/^\d{16,22}$/.test(String(id))) throw new Error(`Message ${i + 1} has no valid Discord message ID.`);
    const author = r.author;
    const authorId = author?.id == null ? null : String(author.id);
    if (authorId) authors.set(authorId, { id: authorId, name: author.name || author.nickname || author.username || authorId, bot: Boolean(author.isBot ?? author.bot) });
    let attachments = r.attachments || [];
    if (typeof attachments === 'string') attachments = attachments.match(/https?:\/\/\S+/g) || [];
    if (!Array.isArray(attachments)) throw new Error(`Message ${i + 1} has invalid attachments.`);
    return {
      id: String(id), authorId, text: String(r.contents ?? r.content ?? r.text ?? ''),
      createdAt: importTimestamp(r.timestamp ?? r.createdat, String(id)),
      editedAt: r.timestampedited || r.edited_timestamp || r.editedat ? importTimestamp(r.timestampedited || r.edited_timestamp || r.editedat, id) : null,
      attachments: attachments.map((a) => typeof a === 'string' ? { url: a, name: 'Attachment' } : { url: a.url, name: a.fileName || a.filename || a.name || 'Attachment', ...(a.fileId ? { fileId: a.fileId } : {}) }),
    };
  });
  return { messages, authors: [...authors.values()], channelId: String(data.channel?.id || data.channelId || ''), channelName: data.channel?.name || data.channelName || 'Discord' };
}
