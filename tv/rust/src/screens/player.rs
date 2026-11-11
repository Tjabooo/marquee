//! The player: the TV's own AVPlay (MKV, HEVC, surround) under a see-through page, with Skip intro, Up next,
//! subtitles and audio tracks, resume points, and a watchdog that reopens a stalled stream.
//! While a video plays a frame is drawn only when something on top of it changes.
use crate::gfx::{hexa, rect, Gfx, Rgba};
use crate::host::{self, av};
use crate::logic::{self, Cue};
use crate::text::{body, display};
use crate::ui::{self, Ease, Lit};
use crate::util::{arr, f, i, s};
use crate::{key, t, Cx, Key, Nav, Res, Screen, WATCHED_KEY};
use alloc::boxed::Box;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde_json::Value;

const LINK: u32 = 1;
const INTRO: u32 = 2;
const CREDITS: u32 = 3;
const LANGS_PREF: u32 = 4;
const LANGS_MENU: u32 = 5;
const SUB_FETCH: u32 = 6;
const SUB_FILE: u32 = 7;

const TICK_T: u32 = 20;
const OSD_T: u32 = 21;
const SEEK_T: u32 = 22;
const AUTO_T: u32 = 23;
const REOPEN_T: u32 = 24;

/// Resume or start over, when there's a resume point.
pub fn play_asked(cx: &mut Cx, f: &Value, replace: bool) {
    if crate::util::b(f, "converting") {
        cx.toast(t!("This one is still being prepared. Try again in a little while."));
        return;
    }
    let p = cx.state.progress.get(logic::progress_ref(f)).cloned();
    if !logic::resumable(p.as_ref()) {
        play(cx, f, 0.0, replace);
        return;
    }
    let d = Resume::new(cx, f.clone(), crate::util::f(p.as_ref().unwrap(), "time").unwrap_or(0.0));
    if replace {
        cx.nav.push(Nav::Replace(Box::new(d)));
    } else {
        cx.push(Box::new(d));
    }
}

pub fn play(cx: &mut Cx, f: &Value, at: f64, replace: bool) {
    if !av::ok() {
        cx.toast(t!("This TV can’t play videos from here."));
        return;
    }
    let p = Player::new(cx, f.clone(), at);
    if replace {
        cx.nav.push(Nav::Replace(Box::new(p)));
    } else {
        cx.push(Box::new(p));
    }
}

fn file_title(cx: &Cx, f: &Value) -> String {
    match cx.state.show(s(f, "show")) {
        Some(sh) => String::from(s(sh, "title")),
        None => String::from(if !s(f, "filmTitle").is_empty() { s(f, "filmTitle") } else { s(f, "title") }),
    }
}
fn episode_line(f: &Value) -> String {
    crate::util::join(&[&logic::episode_label(f), s(f, "episodeName")], " · ")
}

// ---------- resume dialog ----------
pub struct Resume {
    sid: u32,
    f: Value,
    at: f64,
    choice: usize,
    lit: Lit,
    shown: Ease,
}
impl Resume {
    fn new(cx: &mut Cx, f: Value, at: f64) -> Resume {
        Resume { sid: cx.sid(), f, at, choice: 0, lit: Lit::default(), shown: Ease::at(0.0) }
    }
}
impl Screen for Resume {
    fn sid(&self) -> u32 {
        self.sid
    }
    fn overlay(&self) -> bool {
        true
    }
    fn draw(&mut self, cx: &mut Cx) {
        self.shown.set(1.0);
        let a = self.shown.step01(cx, 12.0);
        cx.g.fill(rect(0.0, 0.0, 1920.0, 1080.0), hexa(0x160B12, 0.9 * a));
        cx.g.push_alpha(a);
        let r = rect(500.0, 330.0 + 20.0 * (1.0 - a), 920.0, 420.0);
        ui::shadow(cx, r, 30.0, 100.0, 0.6);
        cx.g.round_v(r, 30.0, ui::SEAT, ui::CURTAIN);
        cx.g.ring(r, 30.0, 2.0, ui::HAIR);
        let title = if crate::util::has(&self.f, "season") { episode_line(&self.f) } else { file_title(cx, &self.f) };
        cx.tx.draw_fit(&mut cx.g, display(46.0, 800), &title, r.x + 56.0, r.y + 52.0, r.w - 112.0, ui::PAPER);
        self.lit.focus(self.choice as u64 + 1);
        self.lit.step(cx);
        let labels = [t!("Resume from {0}", logic::fmt_time(self.at)), String::from(t!("Start over"))];
        let f = body(32.0, 700);
        for (n, l) in labels.iter().enumerate() {
            let b = rect(r.x + 56.0, r.y + 150.0 + n as f32 * 108.0, r.w - 112.0, 92.0);
            let lit = self.lit.get(n as u64 + 1);
            cx.g.pill(b, hexa(0xF6EADF, 0.08).mix(ui::BULB, lit));
            if lit > 0.0 {
                cx.g.glow(b, 46.0, 40.0, ui::BULB.alpha(0.35 * lit));
                cx.g.pill(b, hexa(0xF6EADF, 0.08).mix(ui::BULB, lit));
            }
            cx.tx.draw(&mut cx.g, f, l, b.x + 34.0, b.y + (92.0 - f.line()) / 2.0, ui::PAPER.mix(ui::ON_BULB, lit));
        }
        cx.g.pop_alpha();
    }
    fn key(&mut self, cx: &mut Cx, k: Key) -> bool {
        cx.redraw();
        match k.code {
            key::UP | key::LEFT => self.choice = 0,
            key::DOWN | key::RIGHT => self.choice = 1,
            key::ENTER => {
                let at = if self.choice == 0 { self.at } else { 0.0 };
                let f = self.f.clone();
                play(cx, &f, at, true);
            }
            _ => return false,
        }
        true
    }
}

// ---------- the player ----------
struct MenuItem {
    head: bool,
    label: String,
    on: bool,
    act: MenuAct,
}
enum MenuAct {
    None,
    Subs(String, String),
    Audio(i32),
}

pub struct Player {
    sid: u32,
    f: Value,
    start_at: f64,
    time: f64,
    duration: f64,
    playing: bool,
    ended: bool,
    intro: Option<(f64, f64)>,
    intro_done: bool,
    credits_at: Option<f64>,
    dismissed: bool,
    auto_left: Option<f64>,
    auto_last: f64,
    cues: Vec<Cue>,
    sub_lang: String,
    sub_name: String,
    last_save: f64,
    played: f64,
    play_tick: Option<f64>,
    closed: bool,
    busy: bool,
    osd_on: bool,
    osd: Ease,
    card_focus: usize,
    menu: Option<Vec<MenuItem>>,
    menu_i: usize,
    seek_target: Option<f64>,
    timers: [u32; 5],
    stream: String,
    buffering_since: f64,
    moved_at: f64,
    last_ms: f64,
    retries: u32,
    reopening: bool,
    pending_go: bool,
    open_at: f64,
    spinner: Option<String>,
    failed: bool,
    sig: String,
    next: Option<Value>,
    lit: Lit,
    /// Someone moved between the Up next buttons: no countdown until the card closes.
    held: bool,
}

impl Player {
    fn new(cx: &mut Cx, f: Value, at: f64) -> Player {
        let sid = cx.sid();
        let fid = String::from(s(&f, "id"));
        let variant = "browser-hevc";
        cx.get(&alloc::format!("/api/play-link?kind=lib&id={}&variant={}", crate::util::enc(&fid), variant), sid, LINK);
        let base = alloc::format!("/api/media/lib/{}", crate::util::enc(&fid));
        cx.get(&alloc::format!("{}/intro", base), sid, INTRO);
        cx.get(&alloc::format!("{}/credits", base), sid, CREDITS);
        if !cx.state.setting("subLang").is_empty() {
            cx.get(&alloc::format!("/api/subs/langs?kind=lib&id={}", crate::util::enc(&fid)), sid, LANGS_PREF);
        }
        let next = logic::next_episode(&fid, &cx.state.library, &cx.state.shows).cloned();
        let mut p = Player {
            sid,
            f,
            start_at: at,
            time: at,
            duration: 0.0,
            playing: false,
            ended: false,
            intro: None,
            intro_done: false,
            credits_at: None,
            dismissed: false,
            auto_left: None,
            auto_last: 0.0,
            cues: Vec::new(),
            sub_lang: String::new(),
            sub_name: String::new(),
            last_save: 0.0,
            played: 0.0,
            play_tick: None,
            closed: false,
            busy: false,
            osd_on: false,
            osd: Ease::at(0.0),
            card_focus: 0,
            menu: None,
            menu_i: 0,
            seek_target: None,
            timers: [0; 5],
            stream: String::new(),
            buffering_since: 0.0,
            moved_at: 0.0,
            last_ms: -1.0,
            retries: 0,
            reopening: false,
            pending_go: false,
            open_at: 0.0,
            spinner: Some(String::from(t!("Loading…"))),
            failed: false,
            sig: String::new(),
            next,
            lit: Lit::default(),
            held: false,
        };
        p.timers[0] = cx.timer(500.0, sid, TICK_T);
        p
    }
    fn now_time(&self) -> f64 {
        let ms = av::time_ms();
        if ms >= 0.0 {
            ms / 1000.0
        } else {
            self.time
        }
    }
    fn show_osd(&mut self, cx: &mut Cx, stay: bool) {
        self.osd_on = true;
        cx.cancel(self.timers[1]);
        if !stay {
            self.timers[1] = cx.timer(4000.0, self.sid, OSD_T);
        }
        cx.redraw();
    }
    fn count_played(&mut self) {
        let t = host::time();
        if let Some(tick) = self.play_tick {
            self.played += (t - tick) / 1000.0;
        }
        self.play_tick = if self.playing { Some(t) } else { None };
    }
    fn save(&mut self, cx: &mut Cx, force: bool) {
        if self.duration <= 0.0 {
            return;
        }
        let t = host::time();
        if !force && t - self.last_save < 15000.0 {
            return;
        }
        self.last_save = t;
        self.count_played();
        let done = self.ended || self.duration - self.time < logic::DONE_SECONDS;
        let key = logic::progress_ref(&self.f);
        let wall = host::epoch_ms();
        if let Value::Object(m) = &mut cx.state.progress {
            if done {
                m.remove(&key);
            } else {
                m.insert(key.clone(), serde_json::json!({ "time": self.time, "duration": self.duration, "at": wall }));
            }
        }
        if done {
            let mut watched: Value = host::load(WATCHED_KEY).and_then(|w| serde_json::from_str(&w).ok()).unwrap_or(Value::Object(Default::default()));
            if let Value::Object(m) = &mut watched {
                m.insert(key.clone(), Value::from(wall));
            }
            host::save(WATCHED_KEY, &serde_json::to_string(&watched).unwrap_or_default());
        }
        let watched_secs = libm::round(self.played * 10.0) / 10.0;
        self.played = 0.0;
        let f = &self.f;
        let title = if !s(f, "filmTitle").is_empty() {
            s(f, "filmTitle")
        } else if !s(f, "canonicalTitle").is_empty() {
            s(f, "canonicalTitle")
        } else {
            s(f, "title")
        };
        let body = serde_json::json!({
            "ref": key,
            "time": if done { Value::Null } else { Value::from(self.time) },
            "duration": self.duration,
            "watched": watched_secs,
            "about": {
                "titleKey": logic::title_key(f),
                "title": title,
                "season": f.get("season").cloned().unwrap_or(Value::Null),
                "episode": f.get("episode").cloned().unwrap_or(Value::Null),
            }
        });
        cx.post_quiet("/api/me/progress", body);
    }
    fn seek_to(&mut self, cx: &mut Cx, sec: f64) {
        let hi = if self.duration > 0.0 { self.duration - 2.0 } else { sec };
        let sec = sec.min(hi).max(0.0);
        self.time = sec;
        av::seek(libm::floor(sec * 1000.0));
        cx.redraw();
    }
    fn nudge(&mut self, cx: &mut Cx, delta: f64) {
        if self.duration <= 0.0 {
            return;
        }
        let from = self.seek_target.unwrap_or(self.time);
        self.seek_target = Some((from + delta).clamp(0.0, self.duration - 2.0));
        self.show_osd(cx, true);
        cx.cancel(self.timers[2]);
        self.timers[2] = cx.timer(700.0, self.sid, SEEK_T);
    }
    fn toggle(&mut self, cx: &mut Cx, want_pause: Option<bool>) {
        let pause = want_pause.unwrap_or(self.playing);
        let ok = if pause { av::pause() } else { av::play() };
        if !ok {
            return;
        }
        self.playing = !pause;
        self.moved_at = host::time();
        self.count_played();
        if pause {
            self.save(cx, true);
        }
        self.show_osd(cx, pause);
    }
    fn skip_intro(&mut self, cx: &mut Cx) {
        let Some((_, end)) = self.intro else { return };
        self.intro_done = true;
        self.seek_to(cx, end);
    }
    fn intro_on(&self) -> bool {
        !self.ended && logic::intro_showing(self.time, self.intro)
    }
    fn up_next_on(&self) -> bool {
        self.next.is_some() && !self.dismissed && logic::is_next_time(self.time, self.duration, self.credits_at, self.ended)
    }
    /// Starts or stops the Up next countdown to match what's on screen; auto-skips intros when asked to.
    fn settle(&mut self, cx: &mut Cx) {
        if self.intro_on() && !self.intro_done && self.playing && cx.state.setting("skipIntro") == "auto" {
            self.skip_intro(cx);
        }
        let on = self.up_next_on();
        let counting = on && !self.busy && !self.held && cx.auto_chain < logic::AUTOPLAY_CHAIN;
        if counting && self.auto_left.is_none() {
            self.auto_left = Some(logic::AUTOPLAY_SECONDS);
            self.auto_last = host::time();
            self.timers[3] = cx.timer(250.0, self.sid, AUTO_T);
        } else if !on {
            self.stop_countdown(cx);
        }
    }
    fn stop_countdown(&mut self, cx: &mut Cx) {
        cx.cancel(self.timers[3]);
        self.auto_left = None;
    }
    fn close(&mut self, cx: &mut Cx) {
        if self.closed {
            return;
        }
        self.save(cx, true);
        self.closed = true;
        for t in self.timers {
            cx.cancel(t);
        }
        self.auto_left = None;
        av::close();
    }
    fn leave_player(&mut self, cx: &mut Cx) {
        self.close(cx);
        cx.back();
    }
    fn play_next(&mut self, cx: &mut Cx) {
        let Some(next) = self.next.clone() else { return };
        if self.busy {
            return;
        }
        self.busy = true;
        self.ended = true; // counts as watched
        self.close(cx);
        let p = cx.state.progress.get(logic::progress_ref(&next)).cloned();
        let at = if logic::resumable(p.as_ref()) { f(p.as_ref().unwrap(), "time").unwrap_or(0.0) } else { 0.0 };
        play(cx, &next, at, true);
    }
    fn fail(&mut self, cx: &mut Cx, msg: &str) {
        self.failed = true;
        self.spinner = Some(alloc::format!("{} {}", t!("This video can’t play on the TV."), msg));
        cx.redraw();
    }
    fn open_stream(&mut self, cx: &mut Cx, at: f64) {
        self.moved_at = host::time();
        self.buffering_since = 0.0;
        self.open_at = at;
        if !av::open(&self.stream) {
            self.fail(cx, "");
        }
    }
    fn go(&mut self, cx: &mut Cx) {
        if av::play() {
            self.playing = true;
            self.play_tick = Some(host::time());
            self.spinner = None;
            self.show_osd(cx, false);
        } else {
            self.fail(cx, "");
        }
    }
    /// AVPlay on older Tizen can sit in "Loading…" forever after a dropped connection: reopen where it stopped.
    fn reopen(&mut self, cx: &mut Cx) -> bool {
        if self.closed || self.reopening || self.stream.is_empty() || self.retries >= 5 {
            return false;
        }
        self.retries += 1;
        self.reopening = true;
        let mut at = self.time;
        let ms = av::time_ms();
        if ms >= 0.0 {
            let live = ms / 1000.0;
            if live > 5.0 || at <= 5.0 {
                at = live;
            }
        }
        self.time = at;
        self.save(cx, true);
        self.spinner = Some(String::from(t!("Reconnecting…")));
        av::close();
        self.open_at = at;
        self.timers[4] = cx.timer(1000.0, self.sid, REOPEN_T);
        cx.redraw();
        true
    }
    fn watch_stall(&mut self, cx: &mut Cx) {
        if self.reopening || self.ended || self.seek_target.is_some() || self.failed {
            return;
        }
        let t = host::time();
        if (self.buffering_since > 0.0 && t - self.buffering_since > 12000.0) || (self.playing && t - self.moved_at > 12000.0) {
            self.reopen(cx);
        }
    }
    fn set_subs(&mut self, cx: &mut Cx, lang: &str, name: &str) {
        self.sub_lang = String::from(lang);
        self.sub_name = String::from(name);
        self.cues.clear();
        if lang.is_empty() {
            return;
        }
        let body = serde_json::json!({ "kind": "lib", "id": s(&self.f, "id"), "lang": lang });
        cx.post("/api/subs/fetch", body, self.sid, SUB_FETCH);
    }
    fn open_menu(&mut self, cx: &mut Cx) {
        self.show_osd(cx, true);
        cx.get(&alloc::format!("/api/subs/langs?kind=lib&id={}", crate::util::enc(s(&self.f, "id"))), self.sid, LANGS_MENU);
    }
    fn build_menu(&mut self, langs: &[Value]) {
        let mut items = alloc::vec![
            MenuItem { head: true, label: String::from(t!("Subtitles")), on: false, act: MenuAct::None },
            MenuItem { head: false, label: String::from(t!("Off")), on: self.sub_lang.is_empty(), act: MenuAct::Subs(String::new(), String::new()) },
        ];
        for l in langs {
            let code = String::from(s(l, "code"));
            let name = String::from(s(l, "name"));
            items.push(MenuItem { head: false, label: name.clone(), on: self.sub_lang == code, act: MenuAct::Subs(code, name) });
        }
        let audio: Value = serde_json::from_str(&av::audio()).unwrap_or(Value::Null);
        let tracks = arr(&audio, "tracks");
        if tracks.len() > 1 {
            let current = i(&audio, "current").unwrap_or(-1);
            items.push(MenuItem { head: true, label: String::from(t!("Audio")), on: false, act: MenuAct::None });
            for tr in tracks {
                let idx = i(tr, "index").unwrap_or(0);
                let lang = s(tr, "language");
                let name_lang = if lang.is_empty() { t!("Track {0}", (idx + 1).to_string()) } else { lang.to_uppercase() };
                let ch = i(tr, "channels").filter(|c| *c > 0).map(|c| alloc::format!("{} ch", c)).unwrap_or_default();
                let label = crate::util::join(&[&name_lang, &ch, s(tr, "codec")], " · ");
                items.push(MenuItem { head: false, label, on: idx == current, act: MenuAct::Audio(idx as i32) });
            }
        }
        self.menu_i = items.iter().position(|m| m.on && !m.head).unwrap_or(1);
        self.menu = Some(items);
    }
    fn menu_move(&mut self, d: isize) {
        let Some(items) = &self.menu else { return };
        let mut i = self.menu_i as isize;
        loop {
            i += d;
            if i < 0 || i as usize >= items.len() {
                return;
            }
            if !items[i as usize].head {
                break;
            }
        }
        self.menu_i = i as usize;
    }
    /// What's on screen, as text: a frame is drawn only when this changes.
    fn signature(&self) -> String {
        let t = self.seek_target.unwrap_or(self.time);
        let pos = if self.osd_on { logic::fmt_time(t) } else { String::new() };
        let sub = if self.cues.is_empty() { String::new() } else { logic::cue_text(&self.cues, self.time) };
        alloc::format!("{}|{}|{}|{}|{}|{:?}|{}", pos, sub, self.intro_on(), self.up_next_on(), self.playing, self.auto_left.map(|x| libm::ceil(x) as i64), self.osd_on)
    }
}

/// ▶ drawn as thin slices (the shader has no triangles).
fn play_glyph(g: &mut Gfx, x: f32, y: f32, w: f32, h: f32, c: Rgba) {
    let n = h as usize;
    for k in 0..n {
        let m = 1.0 - libm::fabsf(2.0 * (k as f32 + 0.5) / h - 1.0);
        g.fill(rect(x, y + k as f32, w * m, 1.0), c);
    }
}

impl Screen for Player {
    fn sid(&self) -> u32 {
        self.sid
    }
    fn video(&self) -> bool {
        true
    }
    fn draw(&mut self, cx: &mut Cx) {
        self.osd.set(if self.osd_on || self.menu.is_some() { 1.0 } else { 0.0 });
        let o = self.osd.step01(cx, 12.0);
        let shown_t = self.seek_target.unwrap_or(self.time);
        // OSD
        if o > 0.0 {
            cx.g.push_alpha(o);
            let r = rect(0.0, 1080.0 - 420.0, 1920.0, 420.0);
            cx.g.vgrad(r, &[(0.0, hexa(0x0A0508, 0.0)), (0.45, hexa(0x0A0508, 0.7)), (1.0, hexa(0x0A0508, 0.92))]);
            let y = 1080.0 - 64.0 - 22.0 * 1.3 - 18.0 - 28.0 * 1.3 - 14.0 - 10.0 - 24.0 - 44.0 * 1.3;
            let tf = display(44.0, 700);
            let title = file_title(cx, &self.f);
            let w = cx.tx.draw_fit(&mut cx.g, tf, &title, ui::EDGE, y, 1100.0, ui::PAPER);
            if crate::util::has(&self.f, "season") {
                let ep = alloc::format!("  {}", episode_line(&self.f));
                cx.tx.draw_fit(&mut cx.g, tf, &ep, ui::EDGE + w, y, 1728.0 - w - 10.0, ui::DUST);
            }
            let by = y + tf.line() + 24.0;
            let bar = rect(ui::EDGE, by, 1920.0 - 2.0 * ui::EDGE, 10.0);
            cx.g.round(bar, 5.0, hexa(0xF6EADF, 0.22));
            if self.duration > 0.0 {
                let fw = (bar.w * (shown_t / self.duration) as f32).clamp(0.0, bar.w);
                if fw > 0.0 {
                    let fill = rect(bar.x, bar.y, fw.max(10.0), 10.0);
                    cx.g.glow(fill, 5.0, 16.0, ui::BULB.alpha(0.5));
                    cx.g.round(fill, 5.0, ui::BULB);
                }
                if self.seek_target.is_some() {
                    let knob = rect(bar.x + fw - 12.0, by - 7.0, 24.0, 24.0);
                    cx.g.glow(knob, 12.0, 20.0, ui::BULB.alpha(0.6));
                    cx.g.round(knob, 12.0, ui::PAPER);
                }
            }
            let ty = by + 10.0 + 14.0;
            let nf = body(28.0, 400);
            cx.tx.draw(&mut cx.g, nf, &logic::fmt_time(shown_t), ui::EDGE, ty, ui::DUST);
            if self.duration > 0.0 {
                cx.tx.draw_right(&mut cx.g, nf, &logic::fmt_time(self.duration), 1920.0 - ui::EDGE, ty, ui::DUST);
            }
            if !self.playing && !self.ended {
                cx.tx.draw_center(&mut cx.g, body(28.0, 700), t!("Paused"), 960.0, ty, ui::BULB);
            }
            let hy = ty + nf.line() + 18.0;
            let hf = body(22.0, 400);
            let mut hx = ui::EDGE;
            for h in [t!("Left / Right: 10 s"), t!("OK: pause"), t!("Down: subtitles and audio")] {
                hx += cx.tx.draw(&mut cx.g, hf, h, hx, hy, ui::DUST.alpha(0.8)) + 40.0;
            }
            if !self.sub_name.is_empty() {
                cx.tx.draw_right(&mut cx.g, hf, &self.sub_name.clone(), 1920.0 - ui::EDGE, hy, ui::DUST.alpha(0.8));
            }
            cx.g.pop_alpha();
        }
        // Subtitles
        if !self.cues.is_empty() {
            let text = logic::cue_text(&self.cues, self.time);
            if !text.is_empty() {
                let f = body(52.0, 700).dark();
                let lines = cx.tx.wrap(f, &text, 1600.0, 4);
                let lh = 65.0;
                let bottom = 1080.0 - if o > 0.5 { 300.0 } else { 90.0 };
                let mut y = bottom - lines.len() as f32 * lh;
                for l in &lines {
                    cx.tx.draw_center(&mut cx.g, f, l, 960.0, y, ui::WHITE);
                    y += lh;
                }
            }
        }
        let menu_open = self.menu.is_some();
        let k = if menu_open { 0 } else if self.up_next_on() { 10 + self.card_focus as u64 } else if self.intro_on() { 1 } else { 0 };
        self.lit.focus(k);
        self.lit.step(cx);
        // Skip intro
        if self.intro_on() && !self.up_next_on() {
            let f = body(34.0, 700);
            let label = t!("Skip intro");
            let w = cx.tx.width(f, label) + 38.0 * 2.0 + 46.0;
            let r = rect(1920.0 - ui::EDGE - w, 1080.0 - 300.0 - 88.0, w, 88.0);
            let lit = self.lit.get(1);
            ui::shadow(cx, r, 44.0, 40.0, 0.5);
            if lit > 0.0 {
                cx.g.glow(r, 44.0, 44.0, ui::BULB.alpha(0.4 * lit));
            }
            cx.g.pill(r, hexa(0x140A10, 0.88).mix(ui::BULB, lit));
            cx.g.ring(r, 44.0, 2.0, hexa(0xF6EADF, 0.4).mix(ui::BULB, lit));
            let c = ui::PAPER.mix(ui::ON_BULB, lit);
            cx.tx.draw(&mut cx.g, f, label, r.x + 38.0, r.y + (88.0 - f.line()) / 2.0, c);
            let gx = r.r() - 38.0 - 30.0;
            play_glyph(&mut cx.g, gx, r.y + 29.0, 15.0, 30.0, c);
            play_glyph(&mut cx.g, gx + 15.0, r.y + 29.0, 15.0, 30.0, c);
        }
        // Up next
        if self.up_next_on() {
            if let Some(next) = self.next.clone() {
                let r = rect(1920.0 - ui::EDGE - 660.0, 1080.0 - 300.0 - 520.0, 660.0, 520.0);
                ui::panel(cx, r, 28.0, hexa(0x1C1018, 0.96));
                let art = rect(r.x + 30.0, r.y + 30.0, 600.0, 250.0);
                let still = String::from(s(&next, "still"));
                let pic = if !still.is_empty() { ui::tmdb_size(&still, "w780") } else { String::from(cx.state.show(s(&next, "show")).map(|x| s(x, "backdrop")).unwrap_or("")) };
                ui::picture(cx, &pic, art, 12.0, Some(ui::SEAT), 1.0);
                cx.tx.draw(&mut cx.g, body(22.0, 700), &t!("Up next").to_uppercase(), r.x + 30.0, art.b() + 20.0, ui::DUST);
                cx.tx.draw_fit(&mut cx.g, body(34.0, 700), &episode_line(&next), r.x + 30.0, art.b() + 52.0, 600.0, ui::PAPER);
                let by = r.b() - 30.0 - 72.0;
                let left = self.auto_left.map(|l| libm::ceil(l).max(1.0) as i64);
                let label = if self.busy {
                    String::from(t!("Starting…"))
                } else if let Some(l) = left {
                    t!("Next episode in {0}", l.to_string())
                } else {
                    String::from(t!("Next episode"))
                };
                let b1 = rect(r.x + 30.0, by, 292.0, 72.0);
                let b2 = rect(b1.r() + 16.0, by, 292.0, 72.0);
                let f = body(28.0, 700);
                let l1 = self.lit.get(10);
                let l2 = self.lit.get(11);
                if l1 > 0.0 {
                    cx.g.ring(b1.grow(4.0), 40.0, 4.0, ui::BULB.alpha(l1));
                }
                match self.auto_left {
                    Some(al) => {
                        let p = (1.0 - al / logic::AUTOPLAY_SECONDS).clamp(0.0, 1.0) as f32;
                        cx.g.pill(b1, ui::BULB_DIM);
                        cx.g.push_clip(rect(b1.x, b1.y, b1.w * p, b1.h));
                        cx.g.pill(b1, ui::BULB);
                        cx.g.pop_clip();
                        cx.moving = true;
                    }
                    None => cx.g.pill(b1, ui::BULB),
                }
                cx.tx.draw_center(&mut cx.g, f, &label, b1.x + b1.w / 2.0, b1.y + (72.0 - f.line()) / 2.0, ui::ON_BULB);
                cx.g.pill(b2, hexa(0xF6EADF, 0.1));
                if l2 > 0.0 {
                    cx.g.ring(b2.grow(4.0), 40.0, 4.0, ui::BULB.alpha(l2));
                }
                let keep = if self.ended { t!("Back") } else { t!("Keep watching") };
                cx.tx.draw_center(&mut cx.g, f, keep, b2.x + b2.w / 2.0, b2.y + (72.0 - f.line()) / 2.0, ui::PAPER);
            }
        }
        // Menu
        if let Some(items) = &self.menu {
            let n = items.len();
            let h = (48.0 + items.iter().map(|m| if m.head { 52.0 } else { 62.0 }).sum::<f32>()).min(760.0);
            let r = rect(1920.0 - ui::EDGE - 580.0, 120.0, 580.0, h);
            let labels: Vec<(bool, String, bool)> = items.iter().map(|m| (m.head, m.label.clone(), m.on)).collect();
            let sel = self.menu_i;
            ui::panel(cx, r, 28.0, hexa(0x1C1018, 0.97));
            cx.g.push_clip(r);
            let mut y = r.y + 24.0;
            // Keep the focused item in view in long lists.
            let mut before = 0.0;
            for (k, it) in labels.iter().enumerate() {
                if k == sel {
                    break;
                }
                before += if it.0 { 52.0 } else { 62.0 };
            }
            if before > h - 160.0 {
                y -= before - (h - 160.0);
            }
            for (k, (head, label, on)) in labels.iter().enumerate() {
                if *head {
                    cx.tx.draw(&mut cx.g, body(22.0, 700), &label.to_uppercase(), r.x + 32.0, y + 14.0, ui::DUST);
                    y += 52.0;
                    continue;
                }
                let ir = rect(r.x + 24.0, y, r.w - 48.0, 58.0);
                if k == sel {
                    cx.g.round(ir, 12.0, ui::SEAT);
                    cx.g.ring(ir, 12.0, 3.0, ui::BULB);
                }
                cx.tx.draw_fit(&mut cx.g, body(30.0, 400), label, ir.x + 20.0, ir.y + (58.0 - body(30.0, 400).line()) / 2.0, ir.w - 70.0, ui::PAPER);
                if *on {
                    let dot = rect(ir.r() - 34.0, ir.y + 22.0, 14.0, 14.0);
                    cx.g.glow(dot, 7.0, 12.0, ui::BULB.alpha(0.8));
                    cx.g.round(dot, 7.0, ui::BULB);
                }
                y += 62.0;
            }
            let _ = n;
            cx.g.pop_clip();
        }
        // Loading / errors
        if let Some(sp) = self.spinner.clone() {
            let f = body(32.0, 400);
            let lines = cx.tx.wrap(f, &sp, 1100.0, 3);
            let w = lines.iter().map(|l| cx.tx.width(f, l)).fold(0.0f32, f32::max) + 72.0;
            let h = lines.len() as f32 * 42.0 + 40.0 + if self.failed { 0.0 } else { 40.0 };
            let r = rect(960.0 - w / 2.0, 540.0 - h / 2.0, w, h);
            cx.g.round(r, 14.0, hexa(0x140A10, 0.85));
            for (n, l) in lines.iter().enumerate() {
                cx.tx.draw_center(&mut cx.g, f, l, 960.0, r.y + 20.0 + n as f32 * 42.0, if self.failed { ui::ALERT } else { ui::PAPER });
            }
            if !self.failed {
                for k in 0..3 {
                    let ph = ((cx.now / 420.0) as f32 - k as f32 * 0.6) % 3.0;
                    let lit = if ph < 1.0 { 0.35 + 0.65 * libm::sinf(ph * core::f32::consts::PI) } else { 0.35 };
                    let d = rect(960.0 - 40.0 + k as f32 * 34.0 - 6.0, r.b() - 34.0, 12.0, 12.0);
                    cx.g.round(d, 6.0, ui::BULB.alpha(lit));
                }
                cx.ambient = true;
            }
        }
    }
    fn key(&mut self, cx: &mut Cx, k: Key) -> bool {
        cx.redraw();
        if self.menu.is_some() {
            match k.code {
                key::UP => self.menu_move(-1),
                key::DOWN => self.menu_move(1),
                key::ENTER => {
                    let act = self.menu.as_ref().and_then(|m| m.get(self.menu_i)).map(|m| match &m.act {
                        MenuAct::Subs(c, n) => MenuAct::Subs(c.clone(), n.clone()),
                        MenuAct::Audio(i) => MenuAct::Audio(*i),
                        MenuAct::None => MenuAct::None,
                    });
                    self.menu = None;
                    match act {
                        Some(MenuAct::Subs(code, name)) => {
                            if !code.is_empty() {
                                cx.toast(&t!("Getting {0} subtitles…", name.clone()));
                            }
                            self.set_subs(cx, &code, &name);
                        }
                        Some(MenuAct::Audio(i)) => {
                            if !av::select_audio(i) {
                                cx.toast(t!("This audio track can’t be picked here."));
                            }
                        }
                        _ => {}
                    }
                    self.show_osd(cx, false);
                }
                key::BACK | key::LEFT => {
                    self.menu = None;
                    self.show_osd(cx, false);
                }
                _ => {}
            }
            return true;
        }
        if self.up_next_on() {
            match k.code {
                key::LEFT | key::RIGHT => {
                    self.card_focus = 1 - self.card_focus;
                    self.held = true;
                    self.stop_countdown(cx);
                    return true;
                }
                key::ENTER => {
                    if self.card_focus == 0 {
                        self.play_next(cx);
                    } else {
                        self.dismissed = true;
                        if self.ended {
                            self.leave_player(cx);
                        }
                    }
                    return true;
                }
                key::BACK => {
                    self.dismissed = true;
                    if self.ended {
                        self.leave_player(cx);
                    }
                    return true;
                }
                _ => {}
            }
        }
        match k.code {
            key::ENTER if self.intro_on() => self.skip_intro(cx),
            key::ENTER | key::PLAYPAUSE => self.toggle(cx, None),
            key::PLAY => self.toggle(cx, Some(false)),
            key::PAUSE => self.toggle(cx, Some(true)),
            key::LEFT | key::RW => self.nudge(cx, -10.0),
            key::RIGHT | key::FF => self.nudge(cx, if k.code == key::FF { 30.0 } else { 10.0 }),
            key::DOWN => self.open_menu(cx),
            key::UP => self.show_osd(cx, false),
            key::BACK | key::STOP => self.leave_player(cx),
            _ => {}
        }
        self.settle(cx);
        true
    }
    fn on_http(&mut self, cx: &mut Cx, tag: u32, res: Res) {
        if self.closed {
            return;
        }
        match tag {
            LINK => {
                if !res.ok() {
                    let e = res.error();
                    self.fail(cx, &e);
                    return;
                }
                self.stream = alloc::format!("{}{}", cx.server, s(&res.json, "url"));
                let at = self.start_at;
                self.open_stream(cx, at);
            }
            INTRO => {
                if let Some(it) = res.json.get("intro") {
                    let (a, b) = (f(it, "start").unwrap_or(0.0), f(it, "end").unwrap_or(0.0));
                    if b - a >= 5.0 {
                        self.intro = Some((a, b));
                    }
                }
            }
            CREDITS => {
                if let Some(c) = f(&res.json, "creditsAt") {
                    if c > 0.0 {
                        self.credits_at = Some(c);
                    }
                }
            }
            LANGS_PREF => {
                let pref = String::from(cx.state.setting("subLang"));
                if let Some(l) = arr(&res.json, "languages").iter().find(|l| s(l, "code") == pref) {
                    let name = String::from(s(l, "name"));
                    self.set_subs(cx, &pref, &name);
                }
            }
            LANGS_MENU => {
                let langs = arr(&res.json, "languages").to_vec();
                self.build_menu(&langs);
            }
            SUB_FETCH => {
                if res.ok() {
                    let url = alloc::format!("{}{}", cx.server, s(&res.json, "url"));
                    cx.get(&url, self.sid, SUB_FILE | ((self.sub_lang.len() as u32) << 8));
                } else {
                    cx.toast(&t!("Couldn’t get those subtitles: {0}", res.error()));
                }
            }
            t if t & 0xff == SUB_FILE => {
                if res.ok() {
                    self.cues = logic::parse_vtt(&res.body);
                } else {
                    cx.toast(&t!("Couldn’t get those subtitles: {0}", res.error()));
                }
            }
            _ => {}
        }
        self.settle(cx);
        cx.redraw();
    }
    fn on_timer(&mut self, cx: &mut Cx, tag: u32) {
        if self.closed {
            return;
        }
        match tag {
            TICK_T => {
                if self.playing && self.seek_target.is_none() {
                    self.time = self.now_time();
                }
                if self.playing {
                    self.save(cx, false);
                }
                self.watch_stall(cx);
                self.settle(cx);
                let sig = self.signature();
                if sig != self.sig {
                    self.sig = sig;
                    cx.redraw();
                }
                self.timers[0] = cx.timer(500.0, self.sid, TICK_T);
            }
            OSD_T => {
                if self.playing && self.menu.is_none() {
                    self.osd_on = false;
                    cx.redraw();
                }
            }
            SEEK_T => {
                if let Some(t) = self.seek_target.take() {
                    self.seek_to(cx, t);
                    self.show_osd(cx, false);
                }
            }
            AUTO_T => {
                if let Some(left) = self.auto_left {
                    let t = host::time();
                    let mut left = left;
                    if self.playing || self.ended {
                        left -= (t - self.auto_last) / 1000.0;
                    }
                    self.auto_last = t;
                    if left <= 0.0 {
                        self.stop_countdown(cx);
                        cx.auto_chain += 1;
                        self.play_next(cx);
                        return;
                    }
                    self.auto_left = Some(left);
                    self.timers[3] = cx.timer(250.0, self.sid, AUTO_T);
                    cx.redraw();
                }
            }
            REOPEN_T => {
                self.reopening = false;
                let at = self.open_at;
                self.open_stream(cx, at);
            }
            _ => {}
        }
    }
    fn on_av(&mut self, cx: &mut Cx, kind: i32, value: f64, text: &str) {
        if self.closed {
            return;
        }
        let now = host::time();
        match kind {
            1 => {
                self.spinner = Some(String::from(t!("Loading…")));
                self.buffering_since = now;
            }
            2 => {
                if !self.failed && !self.reopening {
                    self.spinner = None;
                }
                self.buffering_since = 0.0;
            }
            3 => {
                if self.seek_target.is_none() {
                    self.time = value / 1000.0;
                }
                if value != self.last_ms {
                    self.last_ms = value;
                    self.moved_at = now;
                    if value > 1000.0 {
                        self.retries = 0;
                    }
                }
                let sig = self.signature();
                if sig != self.sig {
                    self.sig = sig;
                    cx.redraw();
                }
                self.settle(cx);
                return;
            }
            4 => {
                self.ended = true;
                self.playing = false;
                self.count_played();
                self.save(cx, true);
                if self.next.is_some() && !self.dismissed {
                    self.card_focus = 0;
                } else {
                    self.leave_player(cx);
                    return;
                }
            }
            5 => {
                if !self.reopen(cx) {
                    self.fail(cx, text);
                }
            }
            6 => {
                self.duration = value / 1000.0;
                let at = self.open_at;
                if at > 5.0 {
                    self.time = at;
                    self.pending_go = true;
                    if !av::seek(libm::floor(at * 1000.0)) {
                        self.pending_go = false;
                        self.go(cx);
                    }
                } else {
                    self.go(cx);
                }
            }
            7 => {
                if !self.reopen(cx) {
                    self.fail(cx, text);
                }
            }
            8 => {
                if self.pending_go {
                    self.pending_go = false;
                    self.go(cx);
                }
            }
            9 => {
                if self.pending_go {
                    self.pending_go = false;
                    if !self.reopen(cx) {
                        let m = alloc::format!("{} {}", t!("Couldn’t restore your playback position."), text);
                        self.fail(cx, &m);
                    }
                }
            }
            _ => {}
        }
        self.settle(cx);
        cx.redraw();
    }
    fn on_hidden(&mut self, cx: &mut Cx) {
        // The TV's home button or another app: stop, keep the resume point.
        self.leave_player(cx);
    }
    fn leave(&mut self, cx: &mut Cx) {
        self.close(cx);
    }
}
