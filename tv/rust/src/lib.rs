//! Lilin's Samsung TV app, in Rust. host.js (public/tv-rs) loads this as WebAssembly 1.0 (the 2020 TV runs
//! Chrome 69) and gives it a WebGL canvas, fetch, timers, storage and AVPlay. Rust keeps every screen's state,
//! handles the remote, talks to the Lilin API, and draws each frame as one vertex buffer.
//! Frames are drawn only when something changed or is moving; a still screen costs nothing.
#![no_std]
extern crate alloc;

pub mod gfx;
pub mod host;
pub mod i18n;
pub mod img;
pub mod logic;
pub mod screens;
pub mod text;
pub mod ui;
pub mod util;

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use gfx::Gfx;
use img::Images;
use serde_json::Value;
use text::Text;

#[global_allocator]
static ALLOC: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    let msg = alloc::format!("panic: {}", info);
    host::console(&msg);
    host::old_app();
    core::arch::wasm32::unreachable()
}

// ---------- keys ----------
pub mod key {
    pub const LEFT: i32 = 37;
    pub const UP: i32 = 38;
    pub const RIGHT: i32 = 39;
    pub const DOWN: i32 = 40;
    pub const ENTER: i32 = 13;
    pub const BACK: i32 = 10009;
    pub const BACKSPACE: i32 = 8;
    pub const ESC: i32 = 27;
    pub const PLAYPAUSE: i32 = 10252;
    pub const PLAY: i32 = 415;
    pub const PAUSE: i32 = 19;
    pub const STOP: i32 = 413;
    pub const FF: i32 = 417;
    pub const RW: i32 = 412;
}

#[derive(Clone, Copy)]
pub struct Key {
    /// Back, Backspace and Escape all arrive as BACK here.
    pub code: i32,
    pub raw: i32,
    /// The character typed on a real keyboard (or the remote's digits), if any.
    pub ch: Option<char>,
}
impl Key {
    pub fn is_arrow(&self) -> bool {
        matches!(self.code, key::LEFT | key::RIGHT | key::UP | key::DOWN)
    }
}

// ---------- the network ----------
pub struct Res {
    pub status: i32,
    pub body: String,
    pub json: Value,
}
impl Res {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    pub fn error(&self) -> String {
        if self.status == 0 {
            return if self.body.is_empty() { String::from("network") } else { self.body.clone() };
        }
        let e = util::s(&self.json, "error");
        if !e.is_empty() {
            return String::from(e);
        }
        t!("Lilin answered {0}.", self.status.to_string())
    }
    pub fn done() -> Res {
        Res { status: 200, body: String::new(), json: Value::Null }
    }
}

#[derive(Clone, Copy)]
pub enum Route {
    Screen(u32, u32),
    App(AppJob, u32),
}
#[derive(Clone, Copy, PartialEq)]
pub enum AppJob {
    Library,
    Progress,
    Downloads,
    Genres,
    Redraw,
    Toast,
    Ignore,
}

pub enum Nav {
    Push(Box<dyn Screen>),
    Back,
    Replace(Box<dyn Screen>),
    Reset(Box<dyn Screen>),
    GoLibrary,
}

pub trait Screen {
    fn sid(&self) -> u32;
    fn draw(&mut self, cx: &mut Cx);
    fn key(&mut self, cx: &mut Cx, k: Key) -> bool;
    fn on_http(&mut self, _cx: &mut Cx, _tag: u32, _res: Res) {}
    fn on_timer(&mut self, _cx: &mut Cx, _tag: u32) {}
    fn on_av(&mut self, _cx: &mut Cx, _kind: i32, _value: f64, _text: &str) {}
    fn on_hidden(&mut self, _cx: &mut Cx) {}
    /// Leaving for good (popped, replaced or reset).
    fn leave(&mut self, _cx: &mut Cx) {}
    /// Back on top after the screen above it closed.
    fn refresh(&mut self, _cx: &mut Cx) {}
    /// Drawn over the screen below it (dialogs).
    fn overlay(&self) -> bool {
        false
    }
    /// The page is see-through (a video plays under it).
    fn video(&self) -> bool {
        false
    }
    fn is_home(&self) -> bool {
        false
    }
}

// ---------- shared state ----------
pub struct Owned {
    pub films: BTreeMap<String, usize>,
    pub shows: BTreeMap<String, usize>,
    pub show_ids: BTreeMap<String, usize>,
}
pub struct State {
    pub me: Value,
    pub library: Vec<Value>,
    pub shows: Vec<Value>,
    pub progress: Value,
    pub genres: Vec<Value>,
    pub pending: Vec<logic::Pending>,
    pub focus_pending: bool,
    pub version: u64,
    owned: Option<(u64, Owned)>,
}
impl State {
    pub fn owned(&mut self) -> &Owned {
        if self.owned.as_ref().map(|o| o.0) != Some(self.version) {
            let mut films = BTreeMap::new();
            let mut shows = BTreeMap::new();
            let mut show_ids = BTreeMap::new();
            for (n, x) in self.library.iter().enumerate() {
                if !util::has(x, "season") {
                    let t = util::id(x, "tmdbId");
                    if !t.is_empty() && t != "0" {
                        films.entry(t).or_insert(n);
                    }
                } else if !util::s(x, "show").is_empty() {
                    show_ids.insert(String::from(util::s(x, "show")), n);
                }
            }
            for (n, sh) in self.shows.iter().enumerate() {
                let sid = util::s(sh, "id");
                if !show_ids.contains_key(sid) {
                    continue;
                }
                let t = util::id(sh, "tmdbId");
                if !t.is_empty() {
                    shows.insert(t, n);
                }
                if let Some(num) = sid.strip_prefix("tv-") {
                    shows.insert(String::from(num), n);
                }
            }
            self.owned = Some((self.version, Owned { films, shows, show_ids }));
        }
        &self.owned.as_ref().unwrap().1
    }
    pub fn show(&self, id: &str) -> Option<&Value> {
        self.shows.iter().find(|s| util::s(s, "id") == id)
    }
    pub fn file(&self, id: &str) -> Option<&Value> {
        self.library.iter().find(|f| util::s(f, "id") == id)
    }
    pub fn can_download(&self) -> bool {
        self.me.get("canDownload").and_then(|v| v.as_bool()) != Some(false)
    }
    pub fn setting(&self, k: &str) -> &str {
        self.me.get("settings").map(|s| util::s(s, k)).unwrap_or("")
    }
    pub fn genre_names(&self, tv: bool, ids: &[Value]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for gid in ids {
            let Some(gid) = gid.as_i64() else { continue };
            for g in &self.genres {
                if util::i(g, if tv { "tv" } else { "movie" }) == Some(gid) {
                    let n = String::from(util::s(g, "name"));
                    if !out.contains(&n) {
                        out.push(n);
                    }
                }
            }
        }
        out
    }
}

struct Join {
    left: u32,
    then: Option<(u32, u32)>,
}

pub const TOKEN_KEY: &str = "lilin:tv-session";
pub const WATCHED_KEY: &str = "lilin:tv-watched";

pub struct Cx {
    pub server: String,
    pub g: Gfx,
    pub tx: Text,
    pub im: Images,
    pub now: f64,
    /// Seconds since the last frame (for easing).
    pub dt: f32,
    pub state: State,
    next_sid: u32,
    reqs: BTreeMap<u32, Route>,
    next_req: u32,
    timers: BTreeMap<u32, Route>,
    next_timer: u32,
    joins: BTreeMap<u32, Join>,
    next_join: u32,
    pub nav: Vec<Nav>,
    mail: Vec<(u32, u32, Res)>,
    dirty: bool,
    /// Something is moving: draw the next frame too.
    pub moving: bool,
    /// Something slow and endless is moving (an unknown-progress stripe): redraw at a calm rate.
    pub ambient: bool,
    toast: Option<(String, f64)>,
    pub auto_chain: u32,
    pub hidden: bool,
    /// The screen on top (screens that poll check they're the one showing).
    pub top: u32,
}

impl Cx {
    pub fn sid(&mut self) -> u32 {
        self.next_sid += 1;
        self.next_sid
    }
    pub fn redraw(&mut self) {
        if !self.dirty {
            self.dirty = true;
            host::frame();
        }
    }
    pub fn token(&self) -> Option<String> {
        host::load(TOKEN_KEY)
    }
    fn request(&mut self, method: &str, path: &str, body: Option<&Value>, route: Route) -> u32 {
        self.next_req += 1;
        let id = self.next_req;
        self.reqs.insert(id, route);
        let mut headers = String::from("X-Lilin-TV: 1\nX-Lilin-Lang: sv\n");
        if let Some(t) = self.token() {
            if t != "home" && !t.is_empty() {
                headers.push_str("X-Lilin-Session: ");
                headers.push_str(&t);
                headers.push('\n');
            }
        }
        let body = match body {
            Some(b) => {
                headers.push_str("Content-Type: application/json\n");
                serde_json::to_string(b).unwrap_or_default()
            }
            None => String::new(),
        };
        let url = if path.starts_with("http") { String::from(path) } else { alloc::format!("{}{}", self.server, path) };
        host::fetch(id, method, &url, &headers, &body);
        id
    }
    pub fn get(&mut self, path: &str, sid: u32, tag: u32) {
        self.request("GET", path, None, Route::Screen(sid, tag));
    }
    pub fn post(&mut self, path: &str, body: Value, sid: u32, tag: u32) {
        self.request("POST", path, Some(&body), Route::Screen(sid, tag));
    }
    /// Fire and forget.
    pub fn post_quiet(&mut self, path: &str, body: Value) {
        self.request("POST", path, Some(&body), Route::App(AppJob::Ignore, 0));
    }
    pub fn timer(&mut self, ms: f64, sid: u32, tag: u32) -> u32 {
        self.next_timer += 1;
        let id = self.next_timer;
        self.timers.insert(id, Route::Screen(sid, tag));
        host::timer(id, ms);
        id
    }
    pub fn cancel(&mut self, id: u32) {
        if id != 0 && self.timers.remove(&id).is_some() {
            host::untimer(id);
        }
    }
    fn app_timer(&mut self, ms: f64, job: AppJob) -> u32 {
        self.next_timer += 1;
        let id = self.next_timer;
        self.timers.insert(id, Route::App(job, 0));
        host::timer(id, ms);
        id
    }
    /// Library, resume points and downloads; `then` hears about it when all three are in.
    pub fn load_library(&mut self, then: Option<(u32, u32)>) {
        self.next_join += 1;
        let j = self.next_join;
        self.joins.insert(j, Join { left: 3, then });
        self.request("GET", "/api/library", None, Route::App(AppJob::Library, j));
        self.request("GET", "/api/me/progress", None, Route::App(AppJob::Progress, j));
        self.request("GET", "/api/downloads", None, Route::App(AppJob::Downloads, j));
    }
    /// Just the downloads (what's on its way).
    pub fn load_pending(&mut self, then: Option<(u32, u32)>) {
        self.next_join += 1;
        let j = self.next_join;
        self.joins.insert(j, Join { left: 1, then });
        self.request("GET", "/api/downloads", None, Route::App(AppJob::Downloads, j));
    }
    pub fn load_genres(&mut self, then: Option<(u32, u32)>) {
        self.next_join += 1;
        let j = self.next_join;
        self.joins.insert(j, Join { left: 1, then });
        self.request("GET", "/api/discover/genres", None, Route::App(AppJob::Genres, j));
    }
    fn joined(&mut self, j: u32) {
        let finished = match self.joins.get_mut(&j) {
            Some(join) => {
                join.left = join.left.saturating_sub(1);
                join.left == 0
            }
            None => false,
        };
        if finished {
            if let Some(Join { then: Some((sid, tag)), .. }) = self.joins.remove(&j) {
                self.mail.push((sid, tag, Res::done()));
            }
        }
    }
    pub fn push(&mut self, s: Box<dyn Screen>) {
        self.nav.push(Nav::Push(s));
    }
    pub fn back(&mut self) {
        self.nav.push(Nav::Back);
    }
    pub fn toast(&mut self, s: &str) {
        self.toast = Some((String::from(s), self.now));
        self.app_timer(3800.0, AppJob::Toast);
        self.redraw();
    }
    pub fn picture(&mut self, url: &str) -> Option<img::Got> {
        self.im.get(url, self.now)
    }
}

// ---------- the app ----------
pub struct App {
    pub cx: Cx,
    stack: Vec<Box<dyn Screen>>,
    last_frame: f64,
    ambient_timer: bool,
    video: bool,
}

static mut APP: Option<App> = None;

#[allow(static_mut_refs)]
fn app() -> &'static mut App {
    unsafe { APP.as_mut().unwrap() }
}

impl App {
    /// Delivers queued results and applies navigation until nothing is left.
    fn settle(&mut self) {
        for _ in 0..64 {
            if !self.cx.mail.is_empty() {
                let mail = core::mem::take(&mut self.cx.mail);
                for (sid, tag, res) in mail {
                    if let Some(i) = self.stack.iter().position(|s| s.sid() == sid) {
                        let s = &mut self.stack[i];
                        s.on_http(&mut self.cx, tag, res);
                    }
                }
                continue;
            }
            if self.cx.nav.is_empty() {
                break;
            }
            let nav = core::mem::take(&mut self.cx.nav);
            for n in nav {
                self.apply(n);
            }
        }
        self.cx.top = self.stack.last().map(|s| s.sid()).unwrap_or(0);
        let video = self.stack.last().map(|s| s.video()).unwrap_or(false);
        if video != self.video {
            self.video = video;
            host::see_through(video);
        }
        self.cx.redraw();
    }
    fn apply(&mut self, n: Nav) {
        match n {
            Nav::Push(s) => self.stack.push(s),
            Nav::Back => {
                if self.stack.len() <= 1 {
                    host::quit();
                    return;
                }
                if let Some(mut s) = self.stack.pop() {
                    s.leave(&mut self.cx);
                }
                if let Some(t) = self.stack.last_mut() {
                    t.refresh(&mut self.cx);
                }
            }
            Nav::Replace(s) => {
                if let Some(mut old) = self.stack.pop() {
                    old.leave(&mut self.cx);
                }
                self.stack.push(s);
            }
            Nav::Reset(s) => {
                while let Some(mut old) = self.stack.pop() {
                    old.leave(&mut self.cx);
                }
                self.stack.push(s);
            }
            Nav::GoLibrary => {
                if self.stack.len() < 2 || !self.stack[0].is_home() {
                    return;
                }
                self.cx.state.focus_pending = true;
                while self.stack.len() > 1 {
                    if let Some(mut s) = self.stack.pop() {
                        s.leave(&mut self.cx);
                    }
                }
                if let Some(t) = self.stack.last_mut() {
                    t.refresh(&mut self.cx);
                }
            }
        }
    }

    fn frame(&mut self, t: f64) {
        let cx = &mut self.cx;
        cx.now = t;
        let dt = if self.last_frame > 0.0 { ((t - self.last_frame) / 1000.0) as f32 } else { 1.0 / 60.0 };
        // After a pause the first step is a normal one, so easing starts smoothly instead of jumping.
        cx.dt = if dt > 0.1 { 1.0 / 60.0 } else { dt.max(0.001) };
        self.last_frame = t;
        cx.dirty = false;
        cx.im.frame += 1;
        for _attempt in 0..2 {
            let cx = &mut self.cx;
            cx.moving = false;
            cx.ambient = false;
            cx.im.fading = false;
            cx.tx.redo = false;
            cx.g.begin();
            let n = self.stack.len();
            if n >= 2 && self.stack[n - 1].overlay() {
                self.stack[n - 2].draw(&mut self.cx);
            }
            if let Some(s) = self.stack.last_mut() {
                s.draw(&mut self.cx);
            }
            ui::toast(&mut self.cx);
            if !self.cx.tx.redo {
                break;
            }
        }
        let cx = &mut self.cx;
        host::draw(&cx.g.v, cx.g.quads, &cx.g.b);
        cx.im.pump();
        if cx.moving || cx.im.fading {
            cx.redraw();
        } else if cx.ambient && !self.ambient_timer {
            self.ambient_timer = true;
            cx.app_timer(66.0, AppJob::Redraw);
        }
        if !cx.moving {
            self.last_frame = 0.0;
        }
    }

    fn app_job(&mut self, job: AppJob, j: u32, res: Option<Res>) {
        let cx = &mut self.cx;
        match job {
            AppJob::Library => {
                if let Some(r) = res {
                    if r.ok() {
                        cx.state.library = util::arr(&r.json, "items").to_vec();
                        cx.state.shows = util::arr(&r.json, "shows").to_vec();
                        cx.state.version += 1;
                    }
                }
                cx.joined(j);
            }
            AppJob::Progress => {
                if let Some(r) = res {
                    if r.ok() {
                        cx.state.progress = r.json.get("progress").cloned().unwrap_or(Value::Object(Default::default()));
                    }
                }
                cx.joined(j);
            }
            AppJob::Downloads => {
                if let Some(r) = res {
                    cx.state.pending = if r.ok() { logic::pending_titles(util::arr(&r.json, "items")) } else { Vec::new() };
                }
                cx.joined(j);
            }
            AppJob::Genres => {
                if let Some(r) = res {
                    if r.ok() {
                        cx.state.genres = util::arr(&r.json, "genres").to_vec();
                    }
                }
                cx.joined(j);
            }
            AppJob::Redraw => {
                self.ambient_timer = false;
                cx.redraw();
            }
            AppJob::Toast => {
                if let Some((_, at)) = &cx.toast {
                    if host::time() - *at > 3500.0 {
                        cx.redraw();
                    }
                }
            }
            AppJob::Ignore => {}
        }
    }
}

// ---------- what host.js calls ----------
#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(n);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn scratch() -> *const f64 {
    core::ptr::addr_of!(host::SCRATCH) as *const f64
}

fn take(p: *mut u8, n: usize) -> String {
    if n == 0 || p.is_null() {
        return String::new();
    }
    let v = unsafe { Vec::from_raw_parts(p, n, n) };
    match String::from_utf8(v) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    }
}

#[no_mangle]
pub extern "C" fn start(p: *mut u8, n: usize) {
    let server = take(p, n);
    let cx = Cx {
        server,
        g: Gfx::new(),
        tx: Text::new(),
        im: Images::new(),
        now: host::time(),
        dt: 1.0 / 60.0,
        state: State {
            me: Value::Null,
            library: Vec::new(),
            shows: Vec::new(),
            progress: Value::Object(Default::default()),
            genres: Vec::new(),
            pending: Vec::new(),
            focus_pending: false,
            version: 0,
            owned: None,
        },
        next_sid: 0,
        reqs: BTreeMap::new(),
        next_req: 0,
        timers: BTreeMap::new(),
        next_timer: 0,
        joins: BTreeMap::new(),
        next_join: 0,
        nav: Vec::new(),
        mail: Vec::new(),
        dirty: false,
        moving: false,
        ambient: false,
        toast: None,
        auto_chain: 0,
        hidden: false,
        top: 0,
    };
    unsafe {
        APP = Some(App { cx, stack: Vec::new(), last_frame: 0.0, ambient_timer: false, video: false });
    }
    let a = app();
    let boot = screens::pair::Boot::new(&mut a.cx, None);
    a.stack.push(Box::new(boot));
    a.settle();
}

#[no_mangle]
pub extern "C" fn frame(t: f64) {
    app().frame(t);
}

#[no_mangle]
pub extern "C" fn key(code: i32, ch: u32) -> i32 {
    let a = app();
    a.cx.auto_chain = 0; // someone is there: Up next may chain again
    a.cx.now = host::time();
    let norm = if code == key::BACKSPACE || code == key::ESC { key::BACK } else { code };
    let k = Key { code: norm, raw: code, ch: if ch > 0 { char::from_u32(ch) } else { None } };
    let handled = match a.stack.last_mut() {
        Some(s) => s.key(&mut a.cx, k),
        None => false,
    };
    let mut out = handled;
    if !handled && norm == key::BACK {
        a.cx.back();
        out = true;
    }
    a.settle();
    out as i32
}

#[no_mangle]
pub extern "C" fn timer(id: u32) {
    let a = app();
    a.cx.now = host::time();
    match a.cx.timers.remove(&id) {
        Some(Route::Screen(sid, tag)) => {
            if let Some(s) = a.stack.iter_mut().find(|s| s.sid() == sid) {
                s.on_timer(&mut a.cx, tag);
            }
        }
        Some(Route::App(job, j)) => a.app_job(job, j, None),
        None => {}
    }
    a.settle();
}

#[no_mangle]
pub extern "C" fn http_done(id: u32, status: i32, p: *mut u8, n: usize) {
    let a = app();
    a.cx.now = host::time();
    let body = take(p, n);
    let json = if status > 0 { serde_json::from_str(&body).unwrap_or(Value::Null) } else { Value::Null };
    let res = Res { status, body, json };
    match a.cx.reqs.remove(&id) {
        Some(Route::Screen(sid, tag)) => {
            if let Some(s) = a.stack.iter_mut().find(|s| s.sid() == sid) {
                s.on_http(&mut a.cx, tag, res);
            }
        }
        Some(Route::App(job, j)) => a.app_job(job, j, Some(res)),
        None => {}
    }
    a.settle();
}

#[no_mangle]
pub extern "C" fn image_done(id: u32, ok: i32, w: i32, h: i32) {
    let a = app();
    a.cx.now = host::time();
    a.cx.im.done(id, ok != 0, w as f32, h as f32, a.cx.now);
    a.cx.im.pump();
    a.cx.redraw();
}

#[no_mangle]
pub extern "C" fn av_event(kind: i32, value: f64, p: *mut u8, n: usize) {
    let a = app();
    a.cx.now = host::time();
    let text = take(p, n);
    if let Some(s) = a.stack.last_mut() {
        s.on_av(&mut a.cx, kind, value, &text);
    }
    a.settle();
}

#[no_mangle]
pub extern "C" fn visibility(hidden: i32) {
    let a = app();
    a.cx.hidden = hidden != 0;
    if hidden != 0 {
        if let Some(s) = a.stack.last_mut() {
            s.on_hidden(&mut a.cx);
        }
    }
    a.settle();
}
