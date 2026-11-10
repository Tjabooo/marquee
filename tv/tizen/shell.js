// Loads Marquee's TV app from the server into this page, so a Marquee update reaches the TV without reinstalling
// anything. The app is the Rust one (public/tv-rs: WebAssembly drawing with WebGL, much lighter on the TV's CPU);
// if this TV can't run it (no WebGL or WebAssembly) or it stops, the JavaScript app (public/tv) takes over.
// If the server can't be reached, it says so and keeps trying.
(function () {
  'use strict';
  var server = String(window.MARQUEE_SERVER || '').replace(/\/+$/, '');
  var ENGINE_KEY = 'marquee:tv-engine'; // "js" forces the JavaScript app (a way back if the Rust one misbehaves)
  var added = [];
  var waiting = false;
  var jsStarted = false;

  function note(text) { var n = document.getElementById('shell-note'); if (n) n.textContent = text; }
  function add(el) { added.push(el); document.head.appendChild(el); }
  function script(src, done) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = function () { done(null); };
    s.onerror = function () { done(new Error('failed')); };
    add(s);
  }
  function retry() {
    added.forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
    added = [];
    waiting = true;
    note('Kan inte nå Marquee på ' + server + '. Är servern på? Försöker igen…');
    setTimeout(function () { waiting = false; load(); }, 5000);
  }
  function engine() { try { return localStorage.getItem(ENGINE_KEY) || ''; } catch (e) { return ''; } }

  // The JavaScript app: /tv/tv.css, /tv/sv.js, /tv/logic.js, /tv/tv.js.
  function loadJs() {
    if (jsStarted) return;
    jsStarted = true;
    var v = Date.now();
    var app = document.getElementById('app');
    if (app && !app.firstChild) app.innerHTML = '<div class="shell"><b>Marquee</b><p id="shell-note"></p></div>';
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = server + '/tv/tv.css?v=' + v;
    add(css);
    script(server + '/tv/sv.js?v=' + v, function (err0) {
      if (err0) { jsStarted = false; return retry(); }
      script(server + '/tv/logic.js?v=' + v, function (err) {
        if (err) { jsStarted = false; return retry(); }
        script(server + '/tv/tv.js?v=' + v, function (err2) { if (err2) { jsStarted = false; retry(); } });
      });
    });
  }

  // The Rust app: /tv-rs/host.js starts /tv-rs/marquee_tv.wasm.
  function load() {
    if (engine() === 'js') return loadJs();
    script(server + '/tv-rs/host.js?v=' + Date.now(), function (err) {
      if (err || !window.MarqueeTvHost) return retry();
      window.MarqueeTvHost.start({ server: server, onFail: function () { loadJs(); } });
    });
  }

  document.addEventListener('keydown', function (e) {
    if (waiting && (e.keyCode === 10009 || e.keyCode === 8)) {
      try { tizen.application.getCurrentApplication().exit(); } catch (x) { /* not on a TV */ }
    }
  });
  if (!server) { note('Den här appen byggdes utan Marquee-adress. Bygg om den med MARQUEE_URL.'); return; }
  // Marquee's own lettering for the splash (the same font the TV app uses), from the server.
  var face = document.createElement('style');
  face.textContent = '@font-face{font-family:"Bricolage Grotesque";font-weight:200 800;src:url("' + server + '/fonts/bricolage-grotesque-latin.woff2") format("woff2")}';
  document.head.appendChild(face);
  load();
})();
