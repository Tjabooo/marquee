//! A show in your library: its seasons and the episodes you have, starting where you left off.
use super::title::{page_backdrop, strip};
use crate::gfx::{hexa, rect};
use crate::host;
use crate::logic::{self, Pending};
use crate::text::{body, display};
use crate::ui::{self, Ease, Lit};
use crate::util::{f, id, s};
use crate::{key, t, Cx, Key, Res, Screen, WATCHED_KEY};
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde_json::Value;

const LOGO: u32 = 1;
const CAST: u32 = 2;
const FOLLOW_T: u32 = 3;
const FOLLOWED: u32 = 4;
const RELOADED: u32 = 5;
const REFRESHED: u32 = 6;

pub struct ShowScreen {
    sid: u32,
    show: Value,
    seasons: Vec<(i64, Vec<Value>)>,
    si: usize,
    ei: usize,
    at_tabs: bool,
    logo: String,
    cast: String,
    waited: usize,
    on_way: Option<Pending>,
    open: bool,
    follow: u32,
    list_y: Ease,
    lit: Lit,
}

fn seasons_of(cx: &Cx, show_id: &str) -> Vec<(i64, Vec<Value>)> {
    logic::show_seasons(&cx.state.library, show_id).into_iter().map(|s| (s.number, s.episodes.into_iter().cloned().collect())).collect()
}

impl ShowScreen {
    pub fn new(cx: &mut Cx, show: Value) -> ShowScreen {
        let sid = cx.sid();
        let show_id = String::from(s(&show, "id"));
        let seasons = seasons_of(cx, &show_id);
        let watched: Value = host::load(WATCHED_KEY).and_then(|w| serde_json::from_str(&w).ok()).unwrap_or(Value::Null);
        let (si, ei) = {
            let ls = logic::show_seasons(&cx.state.library, &show_id);
            logic::start_episode(&ls, &cx.state.progress, &watched)
        };
        let tm = id(&show, "tmdbId");
        if !tm.is_empty() {
            cx.get(&alloc::format!("/api/title/tv/{}/page", tm), sid, LOGO);
            cx.get(&alloc::format!("/api/title/tv/{}/cast", tm), sid, CAST);
        }
        let on_way = cx.state.pending.iter().find(|p| p.show_id == show_id).cloned();
        let waited = on_way.as_ref().map(|p| p.items.len()).unwrap_or(0);
        let follow = cx.timer(5000.0, sid, FOLLOW_T);
        ShowScreen { sid, show, seasons, si, ei, at_tabs: false, logo: String::new(), cast: String::new(), waited, on_way, open: true, follow, list_y: Ease::at(-1.0), lit: Lit::default() }
    }
    fn episodes(&self) -> &[Value] {
        self.seasons.get(self.si).map(|s| s.1.as_slice()).unwrap_or(&[])
    }
    fn rebuild(&mut self, cx: &mut Cx) {
        self.seasons = seasons_of(cx, s(&self.show, "id"));
        self.si = self.si.min(self.seasons.len().saturating_sub(1));
        self.ei = self.ei.min(self.episodes().len().saturating_sub(1));
    }
}

impl Screen for ShowScreen {
    fn sid(&self) -> u32 {
        self.sid
    }
    fn draw(&mut self, cx: &mut Cx) {
        let back = String::from(s(&self.show, "backdrop"));
        page_backdrop(cx, &back, 0.7);
        let x = ui::EDGE;
        let mut y = 72.0;
        let logo = self.logo.clone();
        let name = String::from(s(&self.show, "title"));
        if !logo.is_empty() {
            if let Some(b) = ui::contain(cx, &logo, rect(x, y, 700.0, 150.0), 1.0) {
                y += b.h + 18.0;
            } else {
                y += 168.0;
            }
        } else {
            let f = display(84.0, 800);
            cx.tx.draw_fit(&mut cx.g, f, &name, x - 3.0, y, 1300.0, ui::PAPER);
            y += 100.0;
        }
        let ov = String::from(s(&self.show, "overview"));
        if !ov.is_empty() {
            y += cx.tx.para(&mut cx.g, body(26.0, 400), &ov, x, y, 1150.0, 2, 34.0, ui::DUST);
        }
        if !self.cast.is_empty() {
            let c = self.cast.clone();
            cx.tx.draw_fit(&mut cx.g, body(24.0, 400), &c, x, y + 6.0, 1150.0, ui::DUST);
            y += 40.0;
        }
        if let Some(p) = self.on_way.clone() {
            y += 14.0;
            y += strip(cx, &p, x, y, 760.0);
        }
        y += 24.0;
        // season tabs
        let focus = if self.at_tabs { 1000 + self.si as u64 } else { self.ei as u64 + 1 };
        self.lit.focus(focus);
        self.lit.step(cx);
        let tf = body(26.0, 700);
        let mut tx = x;
        for n in 0..self.seasons.len() {
            let label = t!("Season {0}", self.seasons[n].0.to_string());
            let w = ui::pill_w(cx, &label, tf, 28.0, 0.0);
            let lit = self.lit.get(1000 + n as u64);
            let kind = if n == self.si { ui::Pill::Primary } else { ui::Pill::Quiet };
            ui::pill(cx, rect(tx, y, w, 56.0), &label, tf, kind, lit);
            tx += w + 16.0;
        }
        y += 82.0;
        // episodes
        let top = y.max(400.0);
        let view = rect(0.0, top, 1920.0, 1080.0 - top);
        let item_h = 208.0 + 12.0;
        let target = (self.ei as f32 * item_h - 170.0).max(0.0);
        if self.list_y.v < 0.0 {
            self.list_y.jump(target);
        }
        self.list_y.set(target);
        let ly = self.list_y.step(cx, 13.0);
        cx.g.push_clip(view);
        let eps: Vec<Value> = self.episodes().to_vec();
        let progress = cx.state.progress.clone();
        let first = libm::floorf((ly / item_h).max(0.0)) as usize;
        for (n, e) in eps.iter().enumerate().skip(first.saturating_sub(1)).take(8) {
            let r = rect(x, top + 10.0 + n as f32 * item_h - ly, 1300.0, 208.0);
            let lit = self.lit.get(n as u64 + 1);
            let busy = crate::util::b(e, "converting");
            cx.g.push_alpha(if busy { 0.5 } else { 1.0 });
            if lit > 0.0 {
                cx.g.glow(r, 20.0, 40.0, ui::BULB.alpha(0.25 * lit));
                cx.g.round(r, 20.0, hexa(0x3A2031, 0.92 * lit));
                cx.g.ring(r, 20.0, 3.0, ui::BULB.alpha(lit));
            }
            let art = rect(r.x + 14.0, r.y + 14.0, 320.0, 180.0);
            let still = String::from(s(e, "still"));
            let pic = if still.is_empty() { back.clone() } else { still };
            ui::picture(cx, &pic, art, 12.0, Some(ui::SEAT), 1.0);
            let p = progress.get(logic::progress_ref(e));
            let ok = logic::resumable(p);
            if ok {
                let p = p.unwrap();
                let frac = (f(p, "time").unwrap_or(0.0) / f(p, "duration").unwrap_or(1.0)) as f32;
                ui::bar(cx, rect(art.x + 12.0, art.b() - 17.0, art.w - 24.0, 7.0), Some(frac), hexa(0xFFFFFF, 0.28));
            }
            let mut label = t!("Episode {0}", crate::util::id(e, "episode"));
            if ok {
                label.push_str(" · ");
                label.push_str(&logic::minutes_left(p.unwrap()));
            }
            if busy {
                label.push_str(" · ");
                label.push_str(t!("getting ready"));
                if let Some(pc) = f(e, "convertPercent") {
                    label.push_str(&alloc::format!(" {} %", libm::floor(pc) as i64));
                }
            }
            let tx0 = art.r() + 32.0;
            cx.tx.draw(&mut cx.g, body(24.0, 400), &label, tx0, r.y + 62.0, ui::DUST);
            let en = if s(e, "episodeName").is_empty() { logic::episode_label(e) } else { String::from(s(e, "episodeName")) };
            cx.tx.draw_fit(&mut cx.g, body(34.0, 700), &en, tx0, r.y + 96.0, 900.0, ui::PAPER.mix(ui::WHITE, lit));
            cx.g.pop_alpha();
        }
        cx.g.pop_clip();
    }
    fn key(&mut self, cx: &mut Cx, k: Key) -> bool {
        cx.redraw();
        if self.at_tabs {
            match k.code {
                key::LEFT if self.si > 0 => {
                    self.si -= 1;
                    self.ei = 0;
                }
                key::RIGHT if self.si + 1 < self.seasons.len() => {
                    self.si += 1;
                    self.ei = 0;
                }
                key::DOWN | key::ENTER => self.at_tabs = false,
                key::LEFT | key::RIGHT | key::UP => {}
                _ => return false,
            }
            return true;
        }
        match k.code {
            key::UP => {
                if self.ei > 0 {
                    self.ei -= 1;
                } else if self.seasons.len() > 1 {
                    self.at_tabs = true;
                }
            }
            key::DOWN => self.ei = (self.ei + 1).min(self.episodes().len().saturating_sub(1)),
            key::LEFT | key::RIGHT => {}
            key::ENTER => {
                if let Some(e) = self.episodes().get(self.ei).cloned() {
                    super::player::play_asked(cx, &e, false);
                }
            }
            _ => return false,
        }
        true
    }
    fn on_http(&mut self, cx: &mut Cx, tag: u32, res: Res) {
        if !self.open {
            return;
        }
        match tag {
            LOGO => {
                if let Some(u) = res.json.get("page").and_then(|p| p.get("logo")).map(|l| s(l, "url")) {
                    self.logo = String::from(u);
                }
            }
            CAST => {
                let names: Vec<&str> = crate::util::arr(&res.json, "cast").iter().filter_map(|c| c.as_str()).collect();
                if !names.is_empty() {
                    self.cast = alloc::format!("{} {}", t!("Cast:"), names.join(", "));
                }
            }
            FOLLOWED => {
                let show_id = s(&self.show, "id");
                self.on_way = cx.state.pending.iter().find(|p| p.show_id == show_id).cloned();
                let now = self.on_way.as_ref().map(|p| p.items.len()).unwrap_or(0);
                // An episode finished while you were here: it joins the list.
                if now != self.waited {
                    self.waited = now;
                    cx.load_library(Some((self.sid, RELOADED)));
                }
                self.follow = cx.timer(5000.0, self.sid, FOLLOW_T);
            }
            RELOADED => self.rebuild(cx),
            REFRESHED => {
                self.rebuild(cx);
                if self.seasons.is_empty() {
                    cx.back();
                }
            }
            _ => {}
        }
        cx.redraw();
    }
    fn on_timer(&mut self, cx: &mut Cx, tag: u32) {
        if tag == FOLLOW_T && self.open {
            cx.load_pending(Some((self.sid, FOLLOWED)));
        }
    }
    fn refresh(&mut self, cx: &mut Cx) {
        cx.load_library(Some((self.sid, REFRESHED)));
    }
    fn leave(&mut self, cx: &mut Cx) {
        self.open = false;
        cx.cancel(self.follow);
    }
}
