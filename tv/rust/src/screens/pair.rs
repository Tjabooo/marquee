//! Starting up and signing the TV in: a code on the TV, approved on a phone (Settings → Sign in a TV),
//! or the shared Home network account.
use super::home::Home;
use crate::gfx::{hexa, rect};
use crate::host;
use crate::text::{body, display, Font};
use crate::ui::{self, Ease};
use crate::util::{f, s};
use crate::{key, t, Cx, Key, Nav, Res, Screen, TOKEN_KEY};
use alloc::boxed::Box;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde_json::Value;

const STATUS: u32 = 1;
const READY: u32 = 2;
const RETRY: u32 = 3;

pub struct Boot {
    sid: u32,
    note: String,
    waiting: u32,
    shown: Ease,
}
impl Boot {
    pub fn new(cx: &mut Cx, note: Option<String>) -> Boot {
        let sid = cx.sid();
        cx.get("/api/status", sid, STATUS);
        Boot { sid, note: note.unwrap_or_default(), waiting: 0, shown: Ease::at(0.0) }
    }
}
fn splash(cx: &mut Cx, note: &str, a: f32) {
    ui::room(cx);
    cx.g.push_alpha(a);
    ui::bulbs(cx, 960.0, 420.0, 11, 1.0);
    let f = display(120.0, 800).glow();
    let w = cx.tx.width(f, "Lilin");
    cx.tx.draw(&mut cx.g, f, "Lilin", 960.0 - w / 2.0, 450.0, ui::BULB);
    if !note.is_empty() {
        let lines = cx.tx.wrap(body(32.0, 400), note, 1100.0, 3);
        for (n, l) in lines.iter().enumerate() {
            cx.tx.draw_center(&mut cx.g, body(32.0, 400), l, 960.0, 640.0 + n as f32 * 42.0, ui::DUST);
        }
    }
    cx.g.pop_alpha();
}
impl Screen for Boot {
    fn sid(&self) -> u32 {
        self.sid
    }
    fn draw(&mut self, cx: &mut Cx) {
        self.shown.set(1.0);
        let a = self.shown.step01(cx, 6.0);
        splash(cx, &self.note, a);
    }
    fn key(&mut self, _cx: &mut Cx, _k: Key) -> bool {
        false
    }
    fn on_http(&mut self, cx: &mut Cx, tag: u32, res: Res) {
        match tag {
            STATUS => {
                if res.status == 401 {
                    host::forget(TOKEN_KEY);
                    let p = Pair::new(cx, false, None);
                    cx.nav.push(Nav::Reset(Box::new(p)));
                    return;
                }
                if !res.ok() {
                    self.note = t!("Can’t reach Lilin right now ({0}). Trying again…", res.error());
                    cx.timer(5000.0, self.sid, RETRY);
                    cx.redraw();
                    return;
                }
                let me = res.json.get("me").cloned().unwrap_or(Value::Null);
                let has_me = me.get("id").map(|x| !x.is_null()).unwrap_or(false);
                let token = cx.token();
                match token {
                    None => {
                        let p = Pair::new(cx, has_me, None);
                        cx.nav.push(Nav::Reset(Box::new(p)));
                    }
                    Some(tk) if tk != "home" && s(&me, "via") != "session" => {
                        // The TV's session ended (signed out elsewhere, password changed, or a year passed).
                        host::forget(TOKEN_KEY);
                        let p = Pair::new(cx, has_me, Some(String::from(t!("This TV was signed out. Sign it in again."))));
                        cx.nav.push(Nav::Reset(Box::new(p)));
                    }
                    Some(_) => {
                        cx.state.me = me;
                        self.waiting = 2;
                        cx.load_library(Some((self.sid, READY)));
                        cx.load_genres(Some((self.sid, READY)));
                    }
                }
            }
            READY => {
                self.waiting = self.waiting.saturating_sub(1);
                if self.waiting == 0 {
                    let h = Home::new(cx);
                    cx.nav.push(Nav::Reset(Box::new(h)));
                }
            }
            _ => {}
        }
    }
    fn on_timer(&mut self, cx: &mut Cx, tag: u32) {
        if tag == RETRY {
            cx.get("/api/status", self.sid, STATUS);
        }
    }
}

const START: u32 = 10;
const POLL: u32 = 11;
const POLL_T: u32 = 12;
const NEW_T: u32 = 13;

pub struct Pair {
    sid: u32,
    home: bool,
    home_on: bool,
    code: String,
    poll: String,
    note: String,
    fixed_note: Option<String>,
    timer: u32,
    alive: bool,
    lit: Ease,
    shown: Ease,
}
impl Pair {
    pub fn new(cx: &mut Cx, home: bool, note: Option<String>) -> Pair {
        let sid = cx.sid();
        let mut p = Pair {
            sid,
            home,
            home_on: false,
            code: String::new(),
            poll: String::new(),
            note: note.clone().unwrap_or_default(),
            fixed_note: note,
            timer: 0,
            alive: true,
            lit: Ease::at(0.0),
            shown: Ease::at(0.0),
        };
        p.new_code(cx);
        p
    }
    fn new_code(&mut self, cx: &mut Cx) {
        if self.alive {
            cx.post("/api/tv/pair/start", Value::Object(Default::default()), self.sid, START);
        }
    }
    fn check(&mut self, cx: &mut Cx) {
        if self.alive {
            self.timer = cx.timer(2000.0, self.sid, POLL_T);
        }
    }
    fn signed_in(&mut self, cx: &mut Cx, token: Option<&str>, name: &str) {
        self.alive = false;
        host::save(TOKEN_KEY, token.filter(|t| !t.is_empty()).unwrap_or("home"));
        cx.toast(&t!("Signed in as {0}", if name.is_empty() { String::from(t!("you")) } else { String::from(name) }));
        let b = Boot::new(cx, None);
        cx.nav.push(Nav::Reset(Box::new(b)));
    }
}

/// Text in several styles on one line.
pub fn rich(cx: &mut Cx, x: f32, y: f32, parts: &[(&str, Font, crate::gfx::Rgba)]) -> f32 {
    let mut x = x;
    for (s, f, c) in parts {
        x += cx.tx.draw(&mut cx.g, *f, s, x, y, *c);
    }
    x
}

impl Screen for Pair {
    fn sid(&self) -> u32 {
        self.sid
    }
    fn draw(&mut self, cx: &mut Cx) {
        ui::room(cx);
        self.shown.set(1.0);
        let a = self.shown.step01(cx, 7.0);
        cx.g.push_alpha(a);
        // A warm pool of light behind the code.
        cx.g.light(rect(-300.0, 380.0, 1700.0, 700.0), hexa(0x4A2A3C, 0.55));
        ui::wordmark(cx, ui::EDGE, 112.0, 46.0);
        let h1 = display(84.0, 800);
        cx.tx.draw(&mut cx.g, h1, t!("Sign in this TV"), ui::EDGE - 4.0, 196.0, ui::PAPER);
        let step = body(38.0, 400);
        let bold = body(38.0, 700);
        let num = display(38.0, 800);
        rich(cx, ui::EDGE, 330.0, &[("1  ", num, ui::BULB), (t!("On your phone, open Lilin and go to "), step, ui::DUST), (t!("Settings"), bold, ui::PAPER), (".", step, ui::DUST)]);
        rich(cx, ui::EDGE, 388.0, &[("2  ", num, ui::BULB), (t!("Under "), step, ui::DUST), (t!("Sign in a TV"), bold, ui::PAPER), (t!(", enter this code:"), step, ui::DUST)]);
        // The code: lit letters in little lilin boxes.
        let mut x = ui::EDGE;
        let y = 480.0;
        let chars: Vec<char> = self.code.chars().collect();
        let n = if chars.is_empty() { 6 } else { chars.len() };
        for i in 0..n {
            if i == 3 {
                x += 40.0;
            }
            let r = rect(x, y, 128.0, 170.0);
            ui::shadow(cx, r, 20.0, 40.0, 0.35);
            cx.g.round_v(r, 20.0, ui::SEAT, ui::CURTAIN);
            cx.g.ring(r, 20.0, 2.0, hexa(0xF4C152, 0.28));
            cx.g.ring(rect(r.x + 2.0, r.y + 2.0, r.w - 4.0, 2.0), 0.0, 1.0, hexa(0xFFFFFF, 0.06));
            if let Some(c) = chars.get(i) {
                let f = display(104.0, 800).glow();
                let mut b = [0u8; 4];
                let s = c.encode_utf8(&mut b);
                cx.tx.draw_center(&mut cx.g, f, s, r.x + 64.0, r.y + (170.0 - f.line()) / 2.0, ui::BULB);
            } else {
                let ph = ((cx.now / 300.0) as usize + i) % n;
                let lit = if ph == 0 { 1.0 } else { 0.3 };
                cx.g.round(rect(r.x + 58.0, r.y + 79.0, 12.0, 12.0), 6.0, ui::BULB.alpha(lit));
                cx.ambient = true;
            }
            x += 128.0 + 16.0;
        }
        let note = body(30.0, 400);
        cx.tx.draw_fit(&mut cx.g, note, &self.note, ui::EDGE, 690.0, 1500.0, ui::DUST);
        if self.home {
            self.lit.set(if self.home_on { 1.0 } else { 0.0 });
            let lit = self.lit.step01(cx, 16.0);
            let hint = body(26.0, 400);
            cx.tx.draw(&mut cx.g, hint, t!("No account? Press Down for"), ui::EDGE, 790.0, ui::DUST);
            let f = body(30.0, 700);
            let label = t!("Use the shared Home network account");
            let w = ui::pill_w(cx, label, f, 34.0, 200.0);
            ui::pill(cx, rect(ui::EDGE, 840.0, w, 74.0), label, f, ui::Pill::Quiet, lit);
        }
        cx.g.pop_alpha();
    }
    fn key(&mut self, cx: &mut Cx, k: Key) -> bool {
        if !self.home {
            return false;
        }
        match k.code {
            key::DOWN | key::UP => {
                // Nothing is focused at first, so a stray OK can't sign the TV in as the shared account.
                self.home_on = k.code == key::DOWN;
                cx.redraw();
                true
            }
            key::ENTER if self.home_on => {
                self.signed_in(cx, None, "Home network");
                true
            }
            _ => false,
        }
    }
    fn on_http(&mut self, cx: &mut Cx, tag: u32, res: Res) {
        if !self.alive {
            return;
        }
        match tag {
            START => {
                if !res.ok() {
                    self.note = alloc::format!("{} {}", res.error(), t!("Trying again…"));
                    self.timer = cx.timer(5000.0, self.sid, NEW_T);
                    return;
                }
                self.poll = crate::util::id(&res.json, "poll");
                self.code = String::from(s(&res.json, "code"));
                let mins = libm::round(f(&res.json, "expiresIn").unwrap_or(600.0) / 60.0) as i64;
                self.note = match &self.fixed_note {
                    Some(n) => n.clone(),
                    None => t!("The code changes every {0} minutes.", mins.to_string()),
                };
                self.check(cx);
            }
            POLL => {
                if res.ok() {
                    match s(&res.json, "state") {
                        "approved" => {
                            let g = res.json.get("grant").cloned().unwrap_or(Value::Null);
                            let token = String::from(s(&g, "token"));
                            let name = String::from(s(&g, "name"));
                            self.signed_in(cx, Some(&token), &name);
                            return;
                        }
                        "expired" => {
                            self.new_code(cx);
                            return;
                        }
                        _ => {}
                    }
                }
                self.check(cx);
            }
            _ => {}
        }
    }
    fn on_timer(&mut self, cx: &mut Cx, tag: u32) {
        match tag {
            POLL_T => cx.get(&alloc::format!("/api/tv/pair/poll?id={}", crate::util::enc(&self.poll)), self.sid, POLL),
            NEW_T => self.new_code(cx),
            _ => {}
        }
    }
    fn leave(&mut self, cx: &mut Cx) {
        self.alive = false;
        cx.cancel(self.timer);
    }
}
