//! What the browser side (public/tv-rs/host.js) gives Rust: WebGL frames, fetch, timers, storage,
//! text rasterising, image decoding and AVPlay. Everything else happens in Rust.
use alloc::string::String;
use alloc::vec::Vec;

#[link(wasm_import_module = "env")]
extern "C" {
    fn log(p: *const u8, n: usize);
    fn now() -> f64;
    fn wall() -> f64;
    fn request_frame();
    fn set_timer(id: u32, ms: f64);
    fn clear_timer(id: u32);
    #[allow(clippy::too_many_arguments)]
    fn http(id: u32, mp: *const u8, ml: usize, up: *const u8, ul: usize, hp: *const u8, hl: usize, bp: *const u8, bl: usize);
    fn store_get(kp: *const u8, kl: usize) -> i32;
    fn store_set(kp: *const u8, kl: usize, vp: *const u8, vl: usize);
    fn store_del(kp: *const u8, kl: usize);
    fn font_def(id: u32, cp: *const u8, cl: usize, line: f64, blur: f64, rgba: u32, dy: f64);
    fn text_measure(font: u32, p: *const u8, n: usize) -> f64;
    fn text_make(font: u32, p: *const u8, n: usize) -> i32;
    fn text_reset();
    fn image_load(id: u32, p: *const u8, n: usize);
    fn image_free(id: u32);
    fn gl_frame(vp: *const u32, quads: u32, bp: *const i32, nb: u32, clear: u32);
    fn video_mode(on: u32);
    fn exit_app();
    fn reload_js();
    fn av_ok() -> i32;
    fn av_open(p: *const u8, n: usize) -> i32;
    fn av_play() -> i32;
    fn av_pause() -> i32;
    fn av_seek(ms: f64) -> i32;
    fn av_time() -> f64;
    fn av_close();
    fn av_audio() -> i32;
    fn av_select_audio(i: i32) -> i32;
}

/// Where host.js writes answers that don't fit a return value.
pub static mut SCRATCH: [f64; 16] = [0.0; 16];

pub fn scratch(i: usize) -> f64 {
    unsafe { (*core::ptr::addr_of!(SCRATCH))[i] }
}

/// A string host.js copied into our memory (pointer and length in the scratch area). We own it now.
fn take_answer() -> String {
    let p = scratch(0) as usize;
    let n = scratch(1) as usize;
    if n == 0 {
        return String::new();
    }
    let v = unsafe { Vec::from_raw_parts(p as *mut u8, n, n) };
    String::from_utf8(v).unwrap_or_default()
}

pub fn console(s: &str) {
    unsafe { log(s.as_ptr(), s.len()) }
}
pub fn time() -> f64 {
    unsafe { now() }
}
pub fn epoch_ms() -> f64 {
    unsafe { wall() }
}
pub fn frame() {
    unsafe { request_frame() }
}
pub fn timer(id: u32, ms: f64) {
    unsafe { set_timer(id, ms) }
}
pub fn untimer(id: u32) {
    unsafe { clear_timer(id) }
}
pub fn fetch(id: u32, method: &str, url: &str, headers: &str, body: &str) {
    unsafe {
        http(id, method.as_ptr(), method.len(), url.as_ptr(), url.len(), headers.as_ptr(), headers.len(), body.as_ptr(), body.len())
    }
}
pub fn load(key: &str) -> Option<String> {
    if unsafe { store_get(key.as_ptr(), key.len()) } == 0 {
        return None;
    }
    Some(take_answer())
}
pub fn save(key: &str, value: &str) {
    unsafe { store_set(key.as_ptr(), key.len(), value.as_ptr(), value.len()) }
}
pub fn forget(key: &str) {
    unsafe { store_del(key.as_ptr(), key.len()) }
}
pub fn define_font(id: u32, css: &str, line: f32, blur: f32, rgba: u32, dy: f32) {
    unsafe { font_def(id, css.as_ptr(), css.len(), line as f64, blur as f64, rgba, dy as f64) }
}
pub fn measure(font: u32, s: &str) -> f32 {
    unsafe { text_measure(font, s.as_ptr(), s.len()) as f32 }
}
/// (page, x, y, w, h, pad, advance) or None when the atlas is full.
pub fn raster(font: u32, s: &str) -> Option<[f32; 7]> {
    if unsafe { text_make(font, s.as_ptr(), s.len()) } == 0 {
        return None;
    }
    let mut out = [0.0; 7];
    for (i, v) in out.iter_mut().enumerate() {
        *v = scratch(i) as f32;
    }
    Some(out)
}
pub fn atlas_reset() {
    unsafe { text_reset() }
}
pub fn picture(id: u32, url: &str) {
    unsafe { image_load(id, url.as_ptr(), url.len()) }
}
pub fn drop_picture(id: u32) {
    unsafe { image_free(id) }
}
pub fn draw(verts: &[u32], quads: u32, batches: &[i32]) {
    unsafe { gl_frame(verts.as_ptr(), quads, batches.as_ptr(), (batches.len() / 4) as u32, 1) }
}
pub fn see_through(on: bool) {
    unsafe { video_mode(on as u32) }
}
pub fn quit() {
    unsafe { exit_app() }
}
pub fn old_app() {
    unsafe { reload_js() }
}

pub mod av {
    use super::*;
    pub fn ok() -> bool {
        unsafe { av_ok() != 0 }
    }
    pub fn open(url: &str) -> bool {
        unsafe { av_open(url.as_ptr(), url.len()) != 0 }
    }
    pub fn play() -> bool {
        unsafe { av_play() != 0 }
    }
    pub fn pause() -> bool {
        unsafe { av_pause() != 0 }
    }
    pub fn seek(ms: f64) -> bool {
        unsafe { av_seek(ms) != 0 }
    }
    pub fn time_ms() -> f64 {
        unsafe { av_time() }
    }
    pub fn close() {
        unsafe { av_close() }
    }
    pub fn audio() -> String {
        if unsafe { av_audio() } == 0 {
            return String::new();
        }
        take_answer()
    }
    pub fn select_audio(i: i32) -> bool {
        unsafe { av_select_audio(i) != 0 }
    }
}
