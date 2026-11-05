// People's faces across Marquee: a profile picture or, without one, their initial on a colour of
// their own (the same colour on every device, picked from the name). Also the picture editor used
// in Settings → You and in the owner's People list: choose a photo, drag it into the circle, zoom,
// save. The browser crops it to a 256 px square, so the server only ever stores a small image.
//
// app.js passes in its helpers (h, api, toast) so this file has no globals beyond the DOM.

// Warm stage-light tints that all read on the dark theme and carry dark text.
export const TINTS = ['#F4C152', '#FF9B85', '#E9A0C4', '#C3ACF2', '#93D6BA', '#97C9F2', '#F5AE6B', '#D9C79A'];
export const firstLetter = (name) => (Array.from(String(name || '').trim())[0] || '?').toUpperCase();
export function tintOf(name) {
  let hash = 0;
  for (const ch of String(name || '').trim().toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return TINTS[hash % TINTS.length];
}

const OUT = 256; // stored picture size
const ZOOM_MAX = 4;

export function createPeople({ h, api, toast, me = () => null }) {
  // One face. person: { name, avatar } or a plain name. Decorative (aria-hidden) unless label is given.
  function face(person, { size = 32, label = '', cls = '' } = {}) {
    const p = typeof person === 'string' ? { name: person } : person || {};
    const el = h('span', { class: `face${cls ? ` ${cls}` : ''}`, style: `--face:${size}px;--tint:${tintOf(p.name)}`,
      ...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': 'true' }) }, firstLetter(p.name));
    if (p.avatar) {
      const img = h('img', { src: p.avatar, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      img.onerror = () => img.remove(); // the initial underneath shows instead
      el.append(img);
    }
    return el;
  }

  // Overlapping faces, "+2" for the rest. null when there's nobody.
  function faces(people, { size = 24, max = 4, cls = '' } = {}) {
    const list = (people || []).filter(Boolean);
    if (!list.length) return null;
    const shown = list.slice(0, max);
    const rest = list.length - shown.length;
    return h('span', { class: `faces${cls ? ` ${cls}` : ''}`, style: `--face:${size}px`, 'aria-hidden': 'true' },
      shown.map((p) => face(p, { size })),
      rest > 0 && h('span', { class: 'face more', style: `--face:${size}px` }, `+${rest}`));
  }

  // Opens the file chooser (must run inside a click) and calls onFile with the chosen image.
  function choosePhoto(onFile) {
    const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
    input.addEventListener('change', () => { const f = input.files?.[0]; input.remove(); if (f) onFile(f); });
    document.body.append(input);
    input.click();
    setTimeout(() => input.remove(), 60000); // cancelled choosers never fire change
  }

  async function loadImage(file) {
    if (!/^image\//.test(file.type || 'image/')) throw new Error('Choose a photo (JPEG, PNG, WebP or HEIC).');
    if (file.size > 40 * 1024 * 1024) throw new Error('That photo is very large. Choose a smaller one.');
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* older Safari */ }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } catch { throw new Error('This browser can’t open that photo. Try a JPEG or PNG.'); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  async function encode(canvas) {
    const webp = await toBlob(canvas, 'image/webp', 0.88);
    if (webp?.type === 'image/webp') return webp;
    return toBlob(canvas, 'image/jpeg', 0.9); // Safari can't write WebP
  }

  // The editor's contents for a sheet. upload(blob) saves; done() closes the sheet.
  // Drag to move, wheel / pinch / slider to zoom, arrow keys nudge.
  async function editor({ file, title = 'Your picture', upload, done, onError = toast }) {
    const img = await loadImage(file);
    const iw = img.width, ih = img.height;
    const canvas = h('canvas', { class: 'face-edit-canvas', 'aria-hidden': 'true' });
    const view = h('div', { class: 'face-edit-view', tabindex: '0', role: 'group',
      'aria-label': 'Picture position. Drag or use the arrow keys to move it, plus and minus to zoom.' }, canvas);
    const zoomInput = h('input', { type: 'range', min: '1', max: String(ZOOM_MAX), step: '0.01', value: '1', class: 'face-edit-zoom', 'aria-label': 'Zoom' });
    const preview = h('canvas', { class: 'face-edit-preview', width: '96', height: '96', 'aria-hidden': 'true' });
    const status = h('p', { class: 'muted', role: 'status' });
    const save = h('button', { type: 'button', class: 'play-btn' }, 'Save picture');
    const cancel = h('button', { type: 'button', class: 'chip' }, 'Cancel');
    let zoom = 1, ox = 0, oy = 0, size = 280;

    const base = () => Math.max(size / iw, size / ih);
    const clamp = () => {
      const s = base() * zoom;
      const mx = Math.max(0, (iw * s - size) / 2), my = Math.max(0, (ih * s - size) / 2);
      ox = Math.max(-mx, Math.min(mx, ox)); oy = Math.max(-my, Math.min(my, oy));
    };
    const drawTo = (ctx, px) => {
      const k = px / size, s = base() * zoom * k;
      ctx.clearRect(0, 0, px, px);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, px / 2 - (iw * s) / 2 + ox * k, px / 2 - (ih * s) / 2 + oy * k, iw * s, ih * s);
    };
    const draw = () => {
      clamp();
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const px = Math.round(size * dpr);
      if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
      drawTo(canvas.getContext('2d'), px);
      drawTo(preview.getContext('2d'), 96);
    };
    const setZoom = (z, cx = 0, cy = 0) => {
      const next = Math.max(1, Math.min(ZOOM_MAX, z));
      // keep the point under the cursor (cx, cy from the centre) where it is
      ox = cx - ((cx - ox) * next) / zoom; oy = cy - ((cy - oy) * next) / zoom;
      zoom = next; zoomInput.value = String(zoom); draw();
    };

    zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value)));
    const pointers = new Map();
    let pinch = null;
    view.addEventListener('pointerdown', (e) => {
      view.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      view.classList.add('dragging');
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom };
      }
    });
    view.addEventListener('pointermove', (e) => {
      const last = pointers.get(e.pointerId);
      if (!last) return;
      const now = { x: e.clientX, y: e.clientY };
      pointers.set(e.pointerId, now);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        setZoom(pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / (pinch.d || 1)));
        return;
      }
      ox += now.x - last.x; oy += now.y - last.y; draw();
    });
    const lift = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) view.classList.remove('dragging'); };
    view.addEventListener('pointerup', lift);
    view.addEventListener('pointercancel', lift);
    view.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = view.getBoundingClientRect();
      setZoom(zoom * Math.exp(-e.deltaY / 500), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    }, { passive: false });
    view.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 20 : 6;
      const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[e.key]) { e.preventDefault(); ox += moves[e.key][0]; oy += moves[e.key][1]; draw(); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom * 1.1); }
      else if (e.key === '-') { e.preventDefault(); setZoom(zoom / 1.1); }
    });
    let attached = false;
    const resize = new ResizeObserver(() => {
      if (view.isConnected) attached = true;
      else if (attached) { resize.disconnect(); return; } // the sheet closed
      const w = view.clientWidth;
      if (!w || w === size) return;
      ox *= w / size; oy *= w / size; size = w; draw();
    });
    resize.observe(view);

    save.addEventListener('click', async () => {
      save.disabled = true; save.textContent = 'Saving…'; status.textContent = '';
      try {
        const out = h('canvas', { width: String(OUT), height: String(OUT) });
        drawTo(out.getContext('2d'), OUT);
        const blob = await encode(out);
        if (!blob) throw new Error('This browser couldn’t save the picture.');
        await upload(blob);
        done();
      } catch (err) { status.textContent = err.message; onError?.(err.message); }
      finally { save.disabled = false; save.textContent = 'Save picture'; }
    });
    cancel.addEventListener('click', () => done());
    requestAnimationFrame(() => { size = view.clientWidth || size; draw(); view.focus({ preventScroll: true }); });

    return [h('h2', { id: 'picker-title' }, title),
      h('p', { class: 'muted' }, 'Drag to move it into the circle; zoom with the slider, a pinch or the scroll wheel.'),
      h('div', { class: 'face-edit' }, view,
        h('div', { class: 'face-edit-side' },
          h('div', { class: 'face-edit-sample' }, preview, h('small', {}, 'How it looks beside your name')),
          h('label', { class: 'face-edit-zoom-row' }, h('span', { 'aria-hidden': 'true' }, '−'), zoomInput, h('span', { 'aria-hidden': 'true' }, '+')))),
      h('div', { class: 'face-edit-actions' }, save, cancel), status];
  }

  // Upload helpers: yours, or (owner) someone else's. An empty body removes the picture.
  const send = (path, blob) => api(path, { method: 'POST', body: blob || '', headers: blob ? { 'Content-Type': blob.type } : {} });
  const saveMine = (blob) => send('/api/me/avatar', blob);
  const saveFor = (id, blob) => send(`/api/admin/users/${Number(id)}/avatar`, blob);

  return { face, faces, choosePhoto, editor, saveMine, saveFor, me };
}
