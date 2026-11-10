//! An SVT Play title: add the film or a whole season, or pick one episode. OK on an episode plays it when it's
//! here and adds it when it isn't. Saved copies join the library like any download.
use super::browse;
use super::title::{page_backdrop, strip};
use crate::gfx::{hexa, rect};
use crate::logic;
use crate::text::{body, display};
use crate::ui::{self, Ease, Lit};
use crate::util::{arr, f, i, id, s, year};
use crate::{key, t, Cx, Key, Nav, Res, Screen};
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde_json::Value;

const LOAD: u32 = 1;
const TICK: u32 = 2;
const TICK_T: u32 = 3;
const ADDED: u32 = 4;
const LIB: u32 = 5;
const PENDING: u32 = 6;

#[derive(Clone, Copy, PartialEq)]
enum Zone {
    Seasons,
    Actions,
    Episodes,
}

pub struct SvtScreen {
    sid: u32,
    t: Value,
    path: String,
    data: Option<Value>,
    si: usize,
    ei: usize,
    zone: Zone,
    timer: u32,
    busy: bool,
    alive: bool,
    status: String,
    status_err: bool,
    first: bool,
    lit: Lit,
    list_y: Ease,
    chip_x: Ease,
    waiting: u32,
}

impl SvtScreen {
    pub fn new(cx: &mut Cx, t: Value) -> SvtScreen {
        let sid = cx.sid();
        let path = String::from(s(&t, "path"));
        let mut me = SvtScreen {
            sid,
            t,
            path,
            data: None,
            si: 0,
            ei: 0,
            zone: Zone::Actions,
            timer: 0,
            busy: false,
            alive: true,
            status: String::new(),
            status_err: false,
            first: true,
            lit: Lit::default(),
            list_y: Ease::at(0.0),
            chip_x: Ease::at(0.0),
            waiting: 0,
        };
        me.load(cx);
        me
    }
    fn load(&mut self, cx: &mut Cx) {
        self.waiting = 2;
        cx.get(&alloc::format!("/api/svt/title?path={}", crate::util::enc(&self.path)), self.sid, LOAD);
        cx.load_pending(Some((self.sid, PENDING)));
    }
    fn seasons(&self) -> &[Value] {
        self.data.as_ref().map(|d| arr(d, "seasons")).unwrap_or(&[])
    }
    fn season(&self) -> Option<&Value> {
        self.seasons().get(self.si)
    }
    fn episodes(&self) -> Vec<Value> {
        self.season().map(|s| arr(s, "episodes").to_vec()).unwrap_or_default()
    }
    fn open_eps(&self) -> usize {
        self.episodes().iter().filter(|e| !matches!(s(e, "status"), "library" | "queued")).count()
    }
    fn action_text(&self) -> String {
        let Some(d) = &self.data else { return String::from(t!("Loading…")) };
        if s(d, "kind") == "film" {
            return String::from(match s(d, "status") {
                "library" => t!("Play"),
                "queued" => t!("Go to library"),
                _ => t!("Add to library"),
            });
        }
        let rest = self.open_eps();
        if rest == 0 {
            return String::from(if self.episodes().iter().any(|e| s(e, "status") == "queued") { t!("Go to library") } else { t!("Open") });
        }
        if rest == 1 {
            String::from(t!("Add 1 episode"))
        } else {
            t!("Add {0} episodes", rest.to_string())
        }
    }
    fn label_for(e: &Value) -> String {
        let st = s(e, "status");
        let word = if st == "queued" {
            logic::transfer_word(&serde_json::json!({ "state": s(e, "state"), "progress": f(e, "progress").unwrap_or(0.0) }))
        } else {
            String::from(match st {
                "library" => t!("In your library"),
                "server" => t!("On server"),
                "failed" => t!("Couldn’t save this"),
                _ => "",
            })
        };
        let pct = if st == "queued" && s(e, "state") == "downloading" {
            alloc::format!("{} %", libm::floor(f(e, "progress").unwrap_or(0.0) * 100.0) as i64)
        } else {
            String::new()
        };
        let mins = i(e, "minutes").map(|m| t!("{0} min", m.to_string())).unwrap_or_default();
        crate::util::join(&[&t!("Episode {0}", id(e, "number")), &mins, &word, &pct], " · ")
    }
    fn waiting_on(d: &Value) -> bool {
        s(d, "status") == "queued" || arr(d, "seasons").iter().any(|se| arr(se, "episodes").iter().any(|e| s(e, "status") == "queued"))
    }
    fn here_count(d: &Value) -> usize {
        if s(d, "status") == "library" {
            return 1;
        }
        arr(d, "seasons").iter().map(|se| arr(se, "episodes").iter().filter(|e| s(e, "status") == "library").count()).sum()
    }
    fn schedule(&mut self, cx: &mut Cx) {
        cx.cancel(self.timer);
        if self.data.as_ref().map(Self::waiting_on).unwrap_or(false) {
            self.timer = cx.timer(4000.0, self.sid, TICK_T);
        }
    }
    fn add(&mut self, cx: &mut Cx, mut payload: Value) {
        if self.busy {
            return;
        }
        if !cx.state.can_download() {
            cx.toast(t!("Downloads disabled"));
            return;
        }
        self.busy = true;
        self.status_err = false;
        self.status = String::from(t!("Starting…"));
        payload["path"] = Value::from(self.path.clone());
        cx.post("/api/svt/add", payload, self.sid, ADDED);
    }
    fn play_id(&self, cx: &mut Cx, fid: &str) {
        match cx.state.file(fid).cloned() {
            Some(file) => super::player::play_asked(cx, &file, false),
            None => cx.toast(t!("This one is still being prepared. Try again in a little while.")),
        }
    }
    fn press_action(&mut self, cx: &mut Cx) {
        let Some(d) = self.data.clone() else { return };
        if s(&d, "kind") == "film" {
            match s(&d, "status") {
                "library" => self.play_id(cx, &id(&d, "libraryId")),
                "queued" => cx.nav.push(Nav::GoLibrary),
                _ => self.add(cx, serde_json::json!({})),
            }
            return;
        }
        let number = self.season().and_then(|s| s.get("number").cloned()).unwrap_or(Value::Null);
        if self.open_eps() > 0 {
            self.add(cx, serde_json::json!({ "seasons": [number] }));
            return;
        }
        let eps = self.episodes();
        if eps.iter().any(|e| s(e, "status") == "queued") {
            cx.nav.push(Nav::GoLibrary);
            return;
        }
        if let Some(n) = eps.iter().position(|e| s(e, "status") == "library") {
            self.zone = Zone::Episodes;
            self.ei = n;
        }
    }
    fn press_episode(&mut self, cx: &mut Cx) {
        let eps = self.episodes();
        let Some(e) = eps.get(self.ei) else { return };
        match s(e, "status") {
            "library" => self.play_id(cx, &id(e, "libraryId")),
            "queued" => {}
            _ => {
                let number = self.season().and_then(|s| s.get("number").cloned()).unwrap_or(Value::Null);
                let ep = e.get("number").cloned().unwrap_or(Value::Null);
                self.add(cx, serde_json::json!({ "seasons": [number], "episodes": [ep] }));
            }
        }
    }
}

impl Screen for SvtScreen {
    fn sid(&self) -> u32 {
        self.sid
    }
    fn draw(&mut self, cx: &mut Cx) {
        let back = String::from(s(&self.t, "backdrop"));
        page_backdrop(cx, &back, 0.75);
        let x = ui::EDGE;
        let mut y = 76.0;
        let title = String::from(match &self.data {
            Some(d) if !s(d, "title").is_empty() => s(d, "title"),
            _ => s(&self.t, "title"),
        });
        cx.tx.draw_fit(&mut cx.g, display(64.0, 800), &title, x - 3.0, y, 1500.0, ui::PAPER);
        y += 84.0;
        let meta = match &self.data {
            Some(d) => {
                let series = s(d, "kind") == "series";
                let mins = i(d, "minutes").map(|m| t!("{0} min", m.to_string())).unwrap_or_default();
                crate::util::join(&[&year(d), browse::type_word(series), &mins, t!("Free on SVT Play")], " · ")
            }
            None => String::from(t!("Free on SVT Play")),
        };
        ui::meta_dot(cx, x + 1.0, y + 13.0);
        cx.tx.draw_fit(&mut cx.g, body(26.0, 700), &meta, x + 25.0, y, 1200.0, hexa(0xF6EADF, 0.86));
        y += 50.0;
        let ov = match &self.data {
            Some(d) if !s(d, "overview").is_empty() => String::from(s(d, "overview")),
            _ if !s(&self.t, "overview").is_empty() => String::from(s(&self.t, "overview")),
            Some(_) => String::from(t!("No description available.")),
            None => String::new(),
        };
        y += cx.tx.para(&mut cx.g, body(27.0, 400), &ov, x, y, 1100.0, 2, 35.0, ui::DUST) + 16.0;
        let focus = match self.zone {
            Zone::Seasons => 1000 + self.si as u64,
            Zone::Actions => 1,
            Zone::Episodes => 2000 + self.ei as u64,
        };
        self.lit.focus(focus);
        self.lit.step(cx);
        let seasons = self.seasons().to_vec();
        if seasons.len() > 1 {
            cx.tx.draw(&mut cx.g, body(22.0, 700), &t!("Season").to_uppercase(), x, y, ui::DUST);
            y += 38.0;
            let cf = body(26.0, 700);
            let mut xs = Vec::new();
            let mut cxp = 0.0;
            for se in &seasons {
                let label = if crate::util::b(se, "dated") && !s(se, "name").is_empty() { String::from(s(se, "name")) } else { id(se, "number") };
                let w = ui::pill_w(cx, &label, cf, 24.0, 0.0);
                xs.push((cxp, w, label));
                cxp += w + 14.0;
            }
            let target = xs.get(self.si).map(|v| (v.0 - 480.0).max(0.0)).unwrap_or(0.0);
            self.chip_x.set(target);
            let sx = self.chip_x.step(cx, 14.0);
            cx.g.push_clip(rect(x - 20.0, y - 20.0, 1800.0, 100.0));
            for (n, (px, w, label)) in xs.iter().enumerate() {
                let lit = self.lit.get(1000 + n as u64);
                let kind = if n == self.si { ui::Pill::Primary } else { ui::Pill::Quiet };
                ui::pill(cx, rect(x + px - sx, y, *w, 56.0), label, cf, kind, lit);
            }
            cx.g.pop_clip();
            y += 78.0;
        }
        let label = self.action_text();
        let pf = body(30.0, 700);
        let w = ui::pill_w(cx, &label, pf, 34.0, 270.0);
        let lit = self.lit.get(1);
        ui::pill(cx, rect(x, y, w, 78.0), &label, pf, ui::Pill::Primary, lit);
        y += 96.0;
        let p = browse::pending_for_path(cx, &self.path);
        if let Some(p) = p {
            y += strip(cx, &p, x, y, 760.0);
        }
        if !self.status.is_empty() {
            let st = self.status.clone();
            cx.tx.draw_fit(&mut cx.g, body(24.0, 400), &st, x, y, 1500.0, if self.status_err { ui::ALERT } else { ui::DUST });
        }
        // Episodes.
        let top = 590.0f32.max(y + 44.0);
        let view = rect(0.0, top, 1920.0, 1080.0 - top);
        let item_h = 155.0 + 8.0;
        let target = if self.zone == Zone::Episodes { (self.ei as f32 * item_h - 10.0).max(0.0) } else { 0.0 };
        self.list_y.set(target);
        let ly = self.list_y.step(cx, 13.0);
        cx.g.push_clip(view);
        let eps = self.episodes();
        let first = libm::floorf(ly / item_h) as usize;
        for (n, e) in eps.iter().enumerate().skip(first.saturating_sub(1)).take(7) {
            let r = rect(x, top + n as f32 * item_h - ly, 1500.0, 155.0);
            let lit = self.lit.get(2000 + n as u64);
            if lit > 0.0 {
                cx.g.glow(r, 20.0, 40.0, ui::BULB.alpha(0.25 * lit));
                cx.g.round(r, 20.0, hexa(0x3A2031, 0.92 * lit));
                cx.g.ring(r, 20.0, 3.0, ui::BULB.alpha(lit));
            }
            let art = rect(r.x + 14.0, r.y + 10.0, 240.0, 135.0);
            let still = String::from(s(e, "still"));
            ui::picture(cx, &still, art, 12.0, Some(ui::SEAT), 1.0);
            if s(e, "status") == "queued" {
                let p = f(e, "progress").unwrap_or(0.0) as f32;
                ui::bar(cx, rect(art.x + 12.0, art.b() - 17.0, art.w - 24.0, 7.0), Some(p), hexa(0xFFFFFF, 0.28));
            }
            let tx0 = art.r() + 26.0;
            cx.tx.draw_fit(&mut cx.g, body(23.0, 400), &Self::label_for(e), tx0, r.y + 38.0, 1150.0, ui::DUST);
            cx.tx.draw_fit(&mut cx.g, body(30.0, 700), s(e, "name"), tx0, r.y + 70.0, 1150.0, ui::PAPER.mix(ui::WHITE, lit));
        }
        cx.g.pop_clip();
    }
    fn key(&mut self, cx: &mut Cx, k: Key) -> bool {
        cx.redraw();
        let many = self.seasons().len() > 1;
        match self.zone {
            Zone::Seasons => match k.code {
                key::LEFT if self.si > 0 => {
                    self.si -= 1;
                    self.ei = 0;
                }
                key::RIGHT if self.si + 1 < self.seasons().len() => {
                    self.si += 1;
                    self.ei = 0;
                }
                key::DOWN | key::ENTER => self.zone = Zone::Actions,
                key::UP | key::LEFT | key::RIGHT => {}
                _ => return false,
            },
            Zone::Actions => match k.code {
                key::UP => {
                    if many {
                        self.zone = Zone::Seasons;
                    }
                }
                key::DOWN => {
                    if !self.episodes().is_empty() {
                        self.zone = Zone::Episodes;
                    }
                }
                key::ENTER => self.press_action(cx),
                key::LEFT | key::RIGHT => {}
                _ => return false,
            },
            Zone::Episodes => match k.code {
                key::UP => {
                    if self.ei > 0 {
                        self.ei -= 1;
                    } else {
                        self.zone = Zone::Actions;
                    }
                }
                key::DOWN => self.ei = (self.ei + 1).min(self.episodes().len().saturating_sub(1)),
                key::ENTER => self.press_episode(cx),
                key::LEFT | key::RIGHT => {}
                _ => return false,
            },
        }
        true
    }
    fn on_http(&mut self, cx: &mut Cx, tag: u32, res: Res) {
        if !self.alive {
            return;
        }
        match tag {
            LOAD | TICK => {
                if !res.ok() {
                    if tag == LOAD {
                        self.status = res.error();
                        self.status_err = true;
                    }
                    self.schedule(cx);
                    cx.redraw();
                    return;
                }
                let arrived = self.data.as_ref().map(|d| Self::here_count(d) != Self::here_count(&res.json)).unwrap_or(false);
                self.data = Some(res.json);
                self.si = self.si.min(self.seasons().len().saturating_sub(1));
                self.schedule(cx);
                if let Some(d) = &self.data {
                    let failed = if s(d, "status") == "failed" {
                        Some(String::from(s(d, "error")))
                    } else {
                        arr(d, "seasons").iter().flat_map(|se| arr(se, "episodes").iter()).find(|e| s(e, "status") == "failed").map(|e| String::from(s(e, "error")))
                    };
                    if let Some(err) = failed.filter(|e| !e.is_empty()) {
                        self.status = err;
                        self.status_err = true;
                    }
                }
                if tag == LOAD {
                    self.waiting = self.waiting.saturating_sub(1);
                    if self.waiting == 0 {
                        cx.load_library(Some((self.sid, LIB)));
                    }
                } else if arrived {
                    cx.load_library(None);
                }
            }
            PENDING => {
                if self.waiting > 0 {
                    self.waiting -= 1;
                    if self.waiting == 0 {
                        cx.load_library(Some((self.sid, LIB)));
                    }
                }
            }
            LIB => {
                if self.first && !self.status_err {
                    self.status = String::from(t!("Saved to your library in full quality, with Swedish subtitles."));
                }
                self.first = false;
            }
            ADDED => {
                self.busy = false;
                if res.ok() {
                    let m = s(&res.json, "message");
                    self.status = String::from(if m.is_empty() { t!("On its way from SVT Play.") } else { m });
                    self.first = false;
                    self.load(cx);
                } else {
                    self.status = res.error();
                    self.status_err = true;
                }
            }
            _ => {}
        }
        cx.redraw();
    }
    fn on_timer(&mut self, cx: &mut Cx, tag: u32) {
        if tag == TICK_T && self.alive {
            cx.get(&alloc::format!("/api/svt/title?path={}", crate::util::enc(&self.path)), self.sid, TICK);
            cx.load_pending(None);
        }
    }
    fn refresh(&mut self, cx: &mut Cx) {
        if self.data.is_some() {
            self.load(cx);
        }
    }
    fn leave(&mut self, cx: &mut Cx) {
        self.alive = false;
        cx.cancel(self.timer);
    }
}
