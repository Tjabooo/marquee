#!/usr/bin/env bash
# Builds the Rust TV app into public/tv-rs/marquee_tv.wasm (served by Marquee; the TV loads it at every start).
# Needs Rust with the wasm32v1-none target (WebAssembly 1.0: the 2020 TVs run Chrome 69):
#   rustup target add wasm32v1-none     (or Arch: pacman -S rust-wasm)
# RUST_WASM_SYSROOT: a sysroot holding lib/rustlib/wasm32v1-none, when the target can't be installed system-wide.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
flags="${RUSTFLAGS:-}"
[ -n "${RUST_WASM_SYSROOT:-}" ] && flags="$flags --sysroot=$RUST_WASM_SYSROOT"
RUSTFLAGS="$flags" cargo build --release --target wasm32v1-none
cp target/wasm32v1-none/release/marquee_tv.wasm "$here/../../public/tv-rs/marquee_tv.wasm"
if command -v wasm-tools >/dev/null; then wasm-tools validate --features=mvp,mutable-global "$here/../../public/tv-rs/marquee_tv.wasm"; fi
ls -l "$here/../../public/tv-rs/marquee_tv.wasm"
