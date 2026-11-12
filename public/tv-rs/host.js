// The thin browser side of Lilin's Rust TV app (tv/rust). Everything you see, every screen, the remote-control
// navigation, the API calls and the player logic live in Rust (lilin_tv.wasm) and are drawn with WebGL in one
// canvas: no DOM per card, no CSS layout, no style recalculation, which is what made the old app slow on the TV.
// This file only hands the TV's own services to Rust: WebGL, fetch, timers, localStorage, text rasterising,
// image decoding (createImageBitmap, off the main thread) and AVPlay.
// Written for the TV's browser engine (Samsung 2020 = Chrome 69): no optional chaining or nullish coalescing, WebAssembly 1.0 only.
(function (root) {
  'use strict';

  var W = 1920, H = 1080;
  var ATLAS = 2048, ATLAS_PAGES = 2;
  var FLOATS = 13; // per vertex, see gfx.rs

  function start(opts) {
    var server = String(opts.server || '').replace(/\/+$/, '');
    var fail = opts.onFail || function () {};
    var failed = false;
    function giveUp(why) {
      if (failed) return;
      failed = true;
      try { console.error('Lilin (Rust) stopped: ' + why); } catch (e) { /* no console */ }
      try { teardown(); } catch (e) { /* half built */ }
      fail(why);
    }

    // ---------- canvas and WebGL ----------
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px;z-index:5;';
    var gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) return giveUp('no WebGL');
    if (typeof WebAssembly !== 'object') return giveUp('no WebAssembly');

    function shader(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var VS = [
      'attribute vec2 a_pos; attribute vec2 a_uv; attribute vec4 a_box; attribute vec4 a_p; attribute vec4 a_col;',
      'uniform vec2 u_screen;',
      'varying vec2 v_uv; varying vec2 v_local; varying vec2 v_half; varying vec4 v_p; varying vec4 v_col;',
      'void main() {',
      '  gl_Position = vec4(a_pos.x / u_screen.x * 2.0 - 1.0, 1.0 - a_pos.y / u_screen.y * 2.0, 0.0, 1.0);',
      '  v_uv = a_uv; v_local = a_pos - a_box.xy; v_half = a_box.zw; v_p = a_p; v_col = a_col;',
      '}'].join('\n');
    // One shader draws everything: flat or gradient boxes with rounded corners, soft shadows and glows (a signed
    // distance to the rounded box, feathered), rings, pictures and text (textures), and radial light.
    var FS = [
      '#ifdef GL_FRAGMENT_PRECISION_HIGH', 'precision highp float;', '#else', 'precision mediump float;', '#endif',
      'uniform sampler2D u_tex;',
      'varying vec2 v_uv; varying vec2 v_local; varying vec2 v_half; varying vec4 v_p; varying vec4 v_col;',
      'float box(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + vec2(r); return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }',
      'void main() {',
      '  vec4 c = v_col;',
      '  float mode = v_p.w;',
      '  if (mode > 1.5) {', // radial light: 1 in the middle, 0 at the ellipse's edge
      '    float d = length(v_local / max(v_half, vec2(1.0)));',
      '    gl_FragColor = c * (1.0 - smoothstep(0.0, 1.0, d));',
      '    return;',
      '  }',
      '  if (mode > 0.5) c *= texture2D(u_tex, v_uv);',
      '  float r = v_p.x, f = v_p.y, ring = v_p.z;',
      '  if (r > 0.0 || f > 0.0 || ring > 0.0) {',
      '    float d = box(v_local, v_half, min(r, min(v_half.x, v_half.y)));',
      '    float a = f > 0.0 ? 1.0 - smoothstep(-f, f, d) : clamp(0.5 - d, 0.0, 1.0);',
      '    if (ring > 0.0) a *= clamp(0.5 + d + ring, 0.0, 1.0);',
      '    c *= a;',
      '  }',
      '  gl_FragColor = c;',
      '}'].join('\n');
    var prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) { return giveUp('shader: ' + e.message); }
    gl.useProgram(prog);
    var vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    var stride = FLOATS * 4;
    function attr(name, size, type, norm, offset) {
      var loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, norm, stride, offset);
    }
    attr('a_pos', 2, gl.FLOAT, false, 0);
    attr('a_uv', 2, gl.FLOAT, false, 8);
    attr('a_box', 4, gl.FLOAT, false, 16);
    attr('a_p', 4, gl.FLOAT, false, 32);
    attr('a_col', 4, gl.UNSIGNED_BYTE, true, 48);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_screen'), W, H);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    var MAX_QUADS = 16000;
    var idx = new Uint16Array(MAX_QUADS * 6);
    for (var q = 0; q < MAX_QUADS; q++) {
      idx[q * 6] = q * 4; idx[q * 6 + 1] = q * 4 + 1; idx[q * 6 + 2] = q * 4 + 2;
      idx[q * 6 + 3] = q * 4 + 2; idx[q * 6 + 4] = q * 4 + 1; idx[q * 6 + 5] = q * 4 + 3;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.viewport(0, 0, W, H);

    function newTexture() {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    var white = newTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

    // ---------- text: rasterised once per string into an atlas, then drawn as textured boxes ----------
    var fonts = [];
    var pages = [], shelf = { page: 0, x: 0, y: 0, h: 0 };
    var tc = document.createElement('canvas'), tx = tc.getContext('2d');
    var mc = document.createElement('canvas').getContext('2d');
    function newPage() {
      var t = newTexture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ATLAS, ATLAS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      pages.push(t);
    }
    function textReset() {
      pages.forEach(function (t) { gl.deleteTexture(t); });
      pages = []; shelf = { page: 0, x: 0, y: 0, h: 0 };
      newPage();
    }
    // A spot for a w×h box: along the current shelf, else a new shelf, else the next page; false when all full.
    function place(w, h) {
      if (w > ATLAS || h > ATLAS) return null;
      if (shelf.x + w > ATLAS) { shelf.x = 0; shelf.y += shelf.h + 1; shelf.h = 0; }
      if (shelf.y + h > ATLAS) {
        if (pages.length >= ATLAS_PAGES) return null;
        newPage(); shelf = { page: pages.length - 1, x: 0, y: 0, h: 0 };
      }
      var at = { page: shelf.page, x: shelf.x, y: shelf.y };
      shelf.x += w + 1; shelf.h = Math.max(shelf.h, h);
      return at;
    }

    // ---------- images: fetched as blobs (no CORS taint), decoded off the main thread ----------
    var images = {}; // id -> texture
    var loading = {}; // id -> true while fetching (image_free during a load drops the result)
    function decode(blob) {
      if (typeof createImageBitmap === 'function') return createImageBitmap(blob, { premultiplyAlpha: 'premultiply' })
        .catch(function () { return createImageBitmap(blob); });
      return new Promise(function (ok, bad) {
        var u = URL.createObjectURL(blob), i = new Image();
        i.onload = function () { URL.revokeObjectURL(u); ok(i); };
        i.onerror = function () { URL.revokeObjectURL(u); bad(new Error('decode')); };
        i.src = u;
      });
    }

    // ---------- AVPlay ----------
    var av = root.webapis && root.webapis.avplay;
    var avObject = null;

    // ---------- the WebAssembly instance ----------
    var inst = null, mem = null, ex = null;
    var dec = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
    var enc = typeof TextEncoder === 'function' ? new TextEncoder() : null;
    function bytes() { return new Uint8Array(mem.buffer); }
    function str(ptr, len) {
      if (!len) return '';
      var b = new Uint8Array(mem.buffer, ptr, len);
      if (dec) return dec.decode(b);
      var s = ''; for (var i = 0; i < len; i++) s += String.fromCharCode(b[i]);
      return decodeURIComponent(escape(s));
    }
    function utf8(s) {
      if (enc) return enc.encode(s);
      var u = unescape(encodeURIComponent(s)), out = new Uint8Array(u.length);
      for (var i = 0; i < u.length; i++) out[i] = u.charCodeAt(i);
      return out;
    }
    // Copies bytes into Rust's memory (Rust owns them afterwards) and returns the pointer.
    function give(b) {
      if (!b.length) return 0;
      var p = ex.alloc(b.length);
      bytes().set(b, p);
      return p;
    }
    function scratch() { return new Float64Array(mem.buffer, ex.scratch(), 16); }
    // A string answer: pointer in scratch[0], length in scratch[1].
    function answer(s) {
      var b = utf8(s == null ? '' : String(s));
      var p = give(b), sc = scratch();
      sc[0] = p; sc[1] = b.length;
      return 1;
    }
    function guard(fn) {
      return function () {
        if (failed) return 0;
        try { return fn.apply(null, arguments); } catch (e) { giveUp(e && e.message || String(e)); return 0; }
      };
    }

    var timers = {};
    var frameAsked = false;
    function onFrame(t) {
      frameAsked = false;
      if (failed) return;
      try { ex.frame(t); } catch (e) { giveUp('frame: ' + (e && e.message || e)); }
    }

    var env = {
      log: function (p, n) { try { console.log('[lilin] ' + str(p, n)); } catch (e) { /* none */ } },
      now: function () { return root.performance ? performance.now() : Date.now(); },
      wall: function () { return Date.now(); },
      request_frame: function () { if (!frameAsked) { frameAsked = true; requestAnimationFrame(onFrame); } },
      set_timer: function (id, ms) {
        clearTimeout(timers[id]);
        timers[id] = setTimeout(guard(function () { delete timers[id]; ex.timer(id); }), ms);
      },
      clear_timer: function (id) { clearTimeout(timers[id]); delete timers[id]; },
      http: function (id, mp, ml, up, ul, hp, hl, bp, bl) {
        var method = str(mp, ml), url = str(up, ul), hs = str(hp, hl), body = bl ? str(bp, bl) : undefined;
        var headers = {};
        hs.split('\n').forEach(function (line) { var i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1).replace(/^\s+/, ''); });
        fetch(url, { method: method, headers: headers, body: body, credentials: 'omit' }).then(function (r) {
          return r.arrayBuffer().then(function (buf) { return { status: r.status, body: new Uint8Array(buf) }; });
        }).catch(function (e) {
          return { status: 0, body: utf8(String(e && e.message || e)) };
        }).then(guard(function (res) {
          ex.http_done(id, res.status, give(res.body), res.body.length);
        }));
      },
      store_get: function (kp, kl) {
        var v = null;
        try { v = localStorage.getItem(str(kp, kl)); } catch (e) { /* private */ }
        if (v == null) return 0;
        return answer(v);
      },
      store_set: function (kp, kl, vp, vl) { try { localStorage.setItem(str(kp, kl), str(vp, vl)); } catch (e) { /* full */ } },
      store_del: function (kp, kl) { try { localStorage.removeItem(str(kp, kl)); } catch (e) { /* none */ } },
      // A font: CSS font, line height, and an optional shadow (blur, colour as 0xRRGGBBAA, y offset).
      font_def: function (id, cp, cl, line, blur, rgba, dy) {
        fonts[id] = { css: str(cp, cl), line: line, blur: blur, color: 'rgba(' + (rgba >>> 24 & 255) + ',' + (rgba >>> 16 & 255) + ',' +
          (rgba >>> 8 & 255) + ',' + ((rgba & 255) / 255).toFixed(3) + ')', dy: dy };
      },
      text_measure: function (font, p, n) { mc.font = fonts[font].css; return mc.measureText(str(p, n)).width; },
      // Rasterises a line of text in white (Rust tints it) into the atlas. scratch: page, x, y, w, h, pad, width.
      text_make: function (font, p, n) {
        var f = fonts[font], text = str(p, n);
        mc.font = f.css;
        var width = Math.ceil(mc.measureText(text).width);
        var pad = Math.ceil(f.blur * 1.5) + 2 + Math.abs(f.dy);
        var w = width + pad * 2, h = Math.ceil(f.line) + pad * 2;
        var at = place(w, h);
        if (!at) return 0;
        tc.width = w; tc.height = h;
        tx.clearRect(0, 0, w, h);
        tx.font = f.css;
        tx.textBaseline = 'middle';
        tx.fillStyle = '#fff';
        if (f.blur > 0) { tx.shadowBlur = f.blur; tx.shadowColor = f.color; tx.shadowOffsetY = f.dy; }
        tx.fillText(text, pad, pad + f.line / 2 + 1);
        gl.bindTexture(gl.TEXTURE_2D, pages[at.page]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, at.x, at.y, gl.RGBA, gl.UNSIGNED_BYTE, tc);
        var sc = scratch();
        sc[0] = at.page; sc[1] = at.x; sc[2] = at.y; sc[3] = w; sc[4] = h; sc[5] = pad; sc[6] = width;
        return 1;
      },
      text_reset: textReset,
      image_load: function (id, up, ul) {
        var url = str(up, ul);
        loading[id] = true;
        // The Accept of the TV's own <img>: hosts that pick a format (SVT's format=auto) must not send AVIF.
        fetch(url, { credentials: 'omit', headers: { Accept: 'image/webp,image/apng,image/*,*/*;q=0.8' } }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.blob();
        }).then(decode).then(guard(function (pic) {
          if (!loading[id]) { if (pic.close) pic.close(); return; }
          delete loading[id];
          var t = newTexture();
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pic);
          images[id] = t;
          var w = pic.width, h = pic.height;
          if (pic.close) pic.close();
          ex.image_done(id, 1, w, h);
        })).catch(guard(function () {
          if (!loading[id]) return;
          delete loading[id];
          ex.image_done(id, 0, 0, 0);
        }));
      },
      image_free: function (id) {
        delete loading[id];
        if (images[id]) { gl.deleteTexture(images[id]); delete images[id]; }
      },
      // One frame: all boxes in one buffer, then one draw call per run of boxes on the same texture.
      // batches: [kind (0 plain, 1 image, 2 text page), texture id, first box, box count] × n
      gl_frame: function (vp, quads, bp, nb, clear) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (!quads) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(mem.buffer, vp, quads * 4 * stride), gl.STREAM_DRAW);
        var b = new Int32Array(mem.buffer, bp, nb * 4);
        for (var i = 0; i < nb; i++) {
          var kind = b[i * 4], tex = b[i * 4 + 1], first = b[i * 4 + 2], count = b[i * 4 + 3];
          var t = kind === 1 ? images[tex] : kind === 2 ? pages[tex] : white;
          gl.bindTexture(gl.TEXTURE_2D, t || white);
          gl.drawElements(gl.TRIANGLES, count * 6, gl.UNSIGNED_SHORT, first * 12);
        }
      },
      // The page under the canvas: velvet normally, see-through while a video plays (AVPlay draws below the page).
      video_mode: function (on) {
        var bg = on ? 'transparent' : '#1F1019';
        document.documentElement.style.background = bg;
        document.body.style.background = bg;
      },
      exit_app: function () { try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* a desktop browser */ } },
      reload_js: function () { giveUp('asked for the JavaScript app'); },

      // ---- AVPlay (events come back through av_event: 1 buffering start, 2 buffering done, 3 time ms,
      // 4 completed, 5 error, 6 prepared, 7 prepare failed, 8 seek done, 9 seek failed) ----
      av_ok: function () { return av ? 1 : 0; },
      av_open: guard(function (up, ul) {
        if (!avObject) {
          avObject = document.createElement('object');
          avObject.type = 'application/avplayer';
          avObject.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px;z-index:0;';
          document.body.insertBefore(avObject, document.body.firstChild);
        }
        av.open(str(up, ul));
        av.setDisplayRect(0, 0, 1920, 1080);
        try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) { /* older firmware */ }
        var ev = function (k, v, s) { return guard(function () { var b = utf8(s || ''); ex.av_event(k, v || 0, give(b), b.length); }); };
        av.setListener({
          onbufferingstart: function () { ev(1)(); },
          onbufferingcomplete: function () { ev(2)(); },
          oncurrentplaytime: function (ms) { ev(3, ms)(); },
          onstreamcompleted: function () { ev(4)(); },
          onerror: function (e) { ev(5, 0, String(e))(); },
          onevent: function () {},
        });
        av.prepareAsync(function () { ev(6, av.getDuration())(); }, function (e) { ev(7, 0, String(e && e.name || e))(); });
        return 1;
      }),
      av_play: function () { try { av.play(); return 1; } catch (e) { return 0; } },
      av_pause: function () { try { av.pause(); return 1; } catch (e) { return 0; } },
      av_seek: function (ms) {
        var ev = function (k, s) { return guard(function () { var b = utf8(s || ''); ex.av_event(k, 0, give(b), b.length); }); };
        try { av.seekTo(Math.floor(ms), function () { ev(8)(); }, function (e) { ev(9, String(e && e.name || e))(); }); return 1; } catch (e) { return 0; }
      },
      av_time: function () { try { return av.getCurrentTime(); } catch (e) { return -1; } },
      av_close: function () {
        try { av.stop(); } catch (e) { /* already */ }
        try { av.close(); } catch (e) { /* already */ }
        if (avObject && avObject.parentNode) avObject.parentNode.removeChild(avObject);
        avObject = null;
      },
      // Audio tracks as JSON: [{ index, language, channels, codec }], and the one playing (or -1).
      av_audio: function () {
        var out = [], cur = -1;
        try {
          av.getTotalTrackInfo().forEach(function (t) {
            if (t.type !== 'AUDIO') return;
            var info = {}; try { info = JSON.parse(t.extra_info); } catch (e) { /* none */ }
            out.push({ index: t.index, language: info.language || '', channels: info.channels || 0, codec: info.fourCC || '' });
          });
          var c = av.getCurrentStreamInfo().filter(function (t) { return t.type === 'AUDIO'; })[0];
          cur = c ? c.index : -1;
        } catch (e) { /* not ready */ }
        return answer(JSON.stringify({ tracks: out, current: cur }));
      },
      av_select_audio: function (i) { try { av.setSelectTrack('AUDIO', i); return 1; } catch (e) { return 0; } },
    };
    var wrapped = {};
    Object.keys(env).forEach(function (k) { wrapped[k] = env[k]; });

    function teardown() {
      Object.keys(timers).forEach(function (k) { clearTimeout(timers[k]); });
      timers = {};
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onVis);
      if (avObject) env.av_close();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      document.documentElement.style.background = '';
      document.body.style.background = '';
    }

    var KEYS = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    function onKey(e) {
      if (failed || !ex) return;
      var ch = e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey ? e.key.charCodeAt(0) : 0;
      var handled = 0;
      try { handled = ex.key(e.keyCode, ch); } catch (err) { giveUp('key: ' + (err && err.message || err)); return; }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }
    function onVis() { if (ex && !failed) guard(function () { ex.visibility(document.hidden ? 1 : 0); })(); }

    // Bricolage Grotesque (titles) must be loaded before any text is rasterised; never wait more than 4 s.
    function fontsReady() {
      var waits = [];
      if (root.FontFace && document.fonts) {
        try {
          var face = new FontFace('Bricolage Grotesque', 'url("' + server + '/fonts/bricolage-grotesque-latin.woff2")', { weight: '200 800' });
          document.fonts.add(face);
          waits.push(face.load());
        } catch (e) { /* old engine */ }
      }
      var all = Promise.all(waits).catch(function () {});
      return Promise.race([all, new Promise(function (ok) { setTimeout(ok, 4000); })]);
    }

    var v = Date.now();
    Promise.all([
      fetch(server + '/tv-rs/lilin_tv.wasm?v=' + v, { credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error('lilin_tv.wasm: HTTP ' + r.status);
        return r.arrayBuffer();
      }),
      fontsReady(),
    ]).then(function (r) {
      return WebAssembly.instantiate(r[0], { env: wrapped });
    }).then(function (res) {
      inst = res.instance; ex = inst.exports; mem = ex.memory;
      textReset();
      try { KEYS.forEach(function (k) { try { tizen.tvinputdevice.registerKey(k); } catch (e) { /* not on this model */ } }); } catch (e) { /* not a TV */ }
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('visibilitychange', onVis);
      var app = document.getElementById('app');
      var b = utf8(server);
      ex.start(give(b), b.length);
      if (failed) return;
      document.body.appendChild(canvas);
      // The splash goes once Rust has drawn its first frame.
      setTimeout(function () { if (app && !failed) app.innerHTML = ''; }, 300);
    }).catch(function (e) { giveUp(e && e.message || String(e)); });
  }

  root.LilinTvHost = { start: start };
})(this);
