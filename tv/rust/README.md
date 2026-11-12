# Lilin TV app (Rust)

The Samsung TV app's whole UI, in Rust. It runs as WebAssembly 1.0 inside the Tizen shell (`tv/tizen`) and draws
every frame with WebGL, so the TV's slow CPU never does page layout, styling or DOM work. Samsung only lets
non-partner apps run as web apps, so Rust reaches the TV as WebAssembly.

- **Rust (`src/`)** keeps every screen's state, handles the remote, talks to the Lilin API, runs the player logic
  (resume points, Skip intro, Up next, subtitles, stall recovery) and builds each frame as one vertex buffer.
- **`public/tv-rs/host.js`** is the browser side (about 400 lines): WebGL with a single shader (rounded boxes, soft
  shadows and glows, rings, pictures, text), fetch, timers, localStorage, text rasterising into an atlas, image
  decoding with `createImageBitmap` (off the main thread), and AVPlay.
- Frames are drawn only when something changes or moves. A still screen costs nothing; while a video plays, the
  overlay redraws only when its text changes.

| File | What |
| --- | --- |
| `src/lib.rs` | app core: screen stack, request and timer routing, shared state, frames, exports |
| `src/gfx.rs` | the renderer (boxes, gradients, clipping, batching) |
| `src/text.rs`, `src/img.rs` | text cache (measure, ellipsis, wrap) and picture cache (memory budget, fade-in) |
| `src/ui.rs` | the look: palette, room light, pills, focus glow, bars, easing |
| `src/logic.rs` | the same rules as `public/tv/logic.js` |
| `src/screens/` | sign-in, Home, Discover, Documentaries, grids, Search, title, show, SVT Play, player |

Strings are the English lines of `public/tv/sv.js`, compiled in by `build.rs`; `tests/tv-app.test.mjs` fails when a
`t!("…")` line has no Swedish.

## Build

Needs Rust with the `wasm32v1-none` target (WebAssembly 1.0: Samsung's 2020 TVs run Chrome 69):

```bash
rustup target add wasm32v1-none      # or on Arch: pacman -S rust-wasm
bash tv/rust/build.sh                # writes public/tv-rs/lilin_tv.wasm
```

Without root on a distro Rust, unpack the distro's wasm std into a folder and point `RUST_WASM_SYSROOT` at it (a
sysroot with `lib/rustlib/wasm32v1-none` plus a link to the host's `lib/rustlib/x86_64-unknown-linux-gnu`).
If `wasm-tools` is installed, the build checks the module uses WebAssembly 1.0 features only.

The built `.wasm` is committed, so the Lilin server needs no Rust; commit it with the source change.

## Try it in a desktop browser

```bash
LILIN_URL=http://192.168.1.10:8080 node tv/rust/dev/server.mjs 8099
node tv/rust/dev/drive.mjs "http://localhost:8099/?mock=av" /tmp/shots "wait:4000 shot:home down right enter wait:2000 shot:page"
```

`dev/server.mjs` serves the shell and the app and passes API reads through to a real Lilin; it refuses writes
(except `/api/subs/fetch`), so browsing a live library is safe. It signs in as the shared Home network account.
`?mock=av` adds a pretend AVPlay (`dev/avplay-mock.js`, `&speed=20` plays 20× faster) to try the player's overlay.
`dev/drive.mjs` runs headless Chromium (WebGL through SwiftShader, web security off like the TV's
`<access origin="*">`) and takes screenshots; steps are `wait:MS`, `shot:NAME`, `left right up down enter back`
(with `:N` to repeat), `type:TEXT`, `eval:JS`.
