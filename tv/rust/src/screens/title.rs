//! A film's or show's page from Discover or Search: play it if it's yours, or download it (Smart Download picks
//! the release on the server), with the season and quality to get.
use super::browse::{self, Mine};
use crate::gfx::{hexa, rect};
use crate::logic::Pending;
use crate::text::{body, display};
use crate::ui::{self, Lit};
use crate::util::{arr, b, f, id, s, year};
use crate::{key, t, Cx, Key, Nav, Res, Screen};
use alloc::boxed::Box;
use alloc::string::String;
use alloc::vec::Vec;
use serde_json::Value;

const LOGO: u32 = 1;
const CAST: u32 = 2;
const SEASONS: u32 = 3;
const STARTED: u32 = 4;
const JOB: u32 = 5;
const JOB_T: u32 = 6;
const FOLLOW_T: u32 = 7;
const FOLLOWED: u32 = 8;

#[derive(Clone, Copy, PartialEq)]
enum Do {
    Mine,
    Download,
    Quality,
    Library,
}

pub struct TitleScreen {
    sid: u32,
    t: Value,
    tv: bool,
    tid: String,
    mine: Option<Mine>,
    logo: String,
    cast: String,
    seasons: Vec<Value>,
    seasons_note: String,
    seasons_err: bool,
    si: usize,
    at_seasons: bool,
    actions: Vec<Do>,
    ai: usize,
    quality: usize,
    busy: bool,
    downloading_label: bool,
    status: String,
    status_err: bool,
    on_way: Option<Pending>,
    alive: bool,
    poll: u32,
    poll_id: String,
    follow: u32,
    lit: Lit,
    chip_scroll: ui::Ease,
}

const QUALITIES: [&str; 5] = ["", "2160p", "1440p", "1080p", "720p"];

impl TitleScreen {
    pub fn new(cx: &mut Cx, t: Value) -> TitleScreen {
        let sid = cx.sid();
        let ty = String::from(s(&t, "type"));
        let tv = ty == "tv";
        let tid = id(&t, "id");
        let mine = browse::library_entry(cx, &ty, &tid);
        let on_way = browse::pending_for(cx, &ty, &tid);
        if !tid.is_empty() && (ty == "movie" || ty == "tv") {
            cx.get(&alloc::format!("/api/title/{}/{}/page", ty, tid), sid, LOGO);
            cx.get(&alloc::format!("/api/title/{}/{}/cast", ty, tid), sid, CAST);
        }
        if tv {
            cx.get(&alloc::format!("/api/tv/{}/seasons", crate::util::enc(&tid)), sid, SEASONS);
        }
        let mut actions = Vec::new();
        if mine.is_some() {
            actions.push(Do::Mine);
        }
        actions.push(Do::Download);
        actions.push(Do::Quality);
        let status = if on_way.is_some() {
            String::new()
        } else if mine.is_some() {
            String::from(t!("Already in your library. Smart Download will avoid duplicates."))
        } else {
            String::new()
        };
        let mut me = TitleScreen {
            sid,
            t,
            tv,
            tid,
            at_seasons: tv && mine.is_none(),
            mine,
            logo: String::new(),
            cast: String::new(),
            seasons: Vec::new(),
            seasons_note: String::from(t!("Loading seasons…")),
            seasons_err: false,
            si: 0,
            actions,
            ai: 0,
            quality: 0,
            busy: false,
            downloading_label: false,
            status,
            status_err: false,
            on_way,
            alive: true,
            poll: 0,
            poll_id: String::new(),
            follow: 0,
            lit: Lit::default(),
            chip_scroll: ui::Ease::at(0.0),
        };
        if me.on_way.is_some() {
            me.offer_library();
        }
        me.follow = cx.timer(5000.0, sid, FOLLOW_T);
        me
    }
    /// Once it's on its way, the next thing to do is go and see it in the library.
    fn offer_library(&mut self) {
        if self.actions.contains(&Do::Library) {
            return;
        }
        self.actions.insert(0, Do::Library);
        self.at_seasons = false;
        self.ai = 0;
    }
    fn saved_quality(cx: &Cx) -> String {
        let q = cx.state.setting("quality");
        if !q.is_empty() && q != "all" {
            return String::from(q);
        }
        match cx.state.setting("downloadProfile") {
            "save" => String::from(t!("Save Space")),
            "balanced" => String::from(t!("Balanced · 1080p")),
            "best" => String::from(t!("Best Quality")),
            _ => String::from(t!("your saved settings")),
        }
    }
    fn label(&self, cx: &Cx, a: Do) -> String {
        match a {
            Do::Mine => String::from(match self.mine {
                Some(Mine::Film(_)) => t!("Play"),
                _ => t!("Open"),
            }),
            Do::Download => String::from(if !cx.state.can_download() {
                t!("Downloads disabled")
            } else if self.downloading_label {
                t!("Starting…")
            } else {
                t!("Download")
            }),
            Do::Quality => {
                let q = if self.quality == 0 { Self::saved_quality(cx) } else { String::from(QUALITIES[self.quality]) };
                t!("Quality: {0}", q)
            }
            Do::Library => String::from(t!("Go to library")),
        }
    }
    fn act(&mut self, cx: &mut Cx) {
        let Some(a) = self.actions.get(self.ai).copied() else { return };
        match a {
            Do::Mine => match &self.mine {
                Some(Mine::Film(fid)) => {
                    if let Some(file) = cx.state.file(fid).cloned() {
                        super::player::play_asked(cx, &file, false);
                    }
                }
                Some(Mine::Show(sid)) => {
                    if let Some(sh) = cx.state.show(sid).cloned() {
                        let s = super::show::ShowScreen::new(cx, sh);
                        cx.push(Box::new(s));
                    }
                }
                None => {}
            },
            Do::Download => self.download(cx),
            Do::Quality => self.quality = (self.quality + 1) % QUALITIES.len(),
            Do::Library => cx.nav.push(Nav::GoLibrary),
        }
    }
    fn download(&mut self, cx: &mut Cx) {
        if self.busy || !cx.state.can_download() {
            return;
        }
        if self.tv && self.seasons.is_empty() {
            cx.toast(t!("The season list is still loading."));
            return;
        }
        let tmdb: Value = self.t.get("id").cloned().unwrap_or(Value::Null);
        let mut body = serde_json::json!({ "type": s(&self.t, "type"), "tmdbId": tmdb });
        if self.tv {
            body["season"] = self.seasons[self.si].get("number").cloned().unwrap_or(Value::Null);
        }
        if self.quality > 0 {
            body["quality"] = Value::from(QUALITIES[self.quality]);
        }
        self.busy = true;
        self.status_err = false;
        self.downloading_label = true;
        self.status = String::from(t!("Finding the best download…"));
        cx.post("/api/downloads/smart", body, self.sid, STARTED);
    }
    fn stop_busy(&mut self, msg: String, err: bool) {
        self.busy = false;
        self.downloading_label = false;
        self.status = msg;
        self.status_err = err;
    }
}

/// A long bar with its words above (a download on its way).
pub fn strip(cx: &mut Cx, p: &Pending, x: f32, y: f32, w: f32) -> f32 {
    let f = body(28.0, 700);
    cx.tx.draw_fit(&mut cx.g, f, &browse::pending_text(p), x, y, w, ui::PAPER);
    let r = rect(x, y + f.line() + 10.0, w, 12.0);
    cx.g.glow(r, 6.0, 14.0, ui::BULB.alpha(0.18));
    ui::bar(cx, r, p.progress.map(|v| v as f32), hexa(0xFFFFFF, 0.14));
    f.line() + 22.0
}

/// The big backdrop of a title page, with the room's shadows over its left side and bottom.
pub fn page_backdrop(cx: &mut Cx, url: &str, alpha: f32) {
    ui::room(cx);
    let full = rect(0.0, 0.0, 1920.0, 1080.0);
    let big = ui::tmdb_size(url, "w1280");
    if !ui::backdrop(cx, &big, full, alpha) && big != url {
        ui::backdrop(cx, url, full, alpha);
    }
    cx.g.hgrad(full, &[(0.0, ui::VELVET), (0.32, hexa(0x1F1019, 0.9)), (0.66, hexa(0x1F1019, 0.25)), (1.0, hexa(0x1F1019, 0.1))]);
    cx.g.vgrad(full, &[(0.0, hexa(0x1F1019, 0.0)), (0.45, hexa(0x1F1019, 0.0)), (0.94, ui::VELVET), (1.0, ui::VELVET)]);
}

/// A title as its logo art when TMDB has one, else in big letters. Returns the height used.
pub fn heading(cx: &mut Cx, logo: &str, name: &str, x: f32, y: f32, size: f32, max_w: f32) -> f32 {
    if !logo.is_empty() {
        if let Some(b) = ui::contain(cx, logo, rect(x, y, 820.0f32.min(max_w), 210.0), 1.0) {
            return b.h + 18.0;
        }
        if !cx.im.failed(logo) {
            // Waiting for the logo: keep the space, show the name faintly.
        }
    }
    let f = display(size, 800);
    let lines = cx.tx.wrap(f, name, max_w, 2);
    let lh = size * 1.02;
    for (n, l) in lines.iter().enumerate() {
        cx.tx.draw(&mut cx.g, f, l, x - 3.0, y + n as f32 * lh, ui::PAPER);
    }
    lines.len() as f32 * lh + 16.0
}

impl Screen for TitleScreen {
    fn sid(&self) -> u32 {
        self.sid
    }
    fn draw(&mut self, cx: &mut Cx) {
        let back = String::from(if !s(&self.t, "backdrop").is_empty() { s(&self.t, "backdrop") } else { s(&self.t, "poster") });
        page_backdrop(cx, &back, 0.75);
        let x = ui::EDGE;
        let mut y = 118.0;
        let name = String::from(s(&self.t, "title"));
        let logo = self.logo.clone();
        y += heading(cx, &logo, &name, x, y, 84.0, 1040.0);
        // facts
        let mut parts: Vec<String> = Vec::new();
        let yr = year(&self.t);
        if !yr.is_empty() {
            parts.push(yr);
        }
        parts.push(String::from(browse::type_word(self.tv)));
        if let Some(r) = f(&self.t, "rating") {
            if r > 0.0 {
                parts.push(alloc::format!("★ {}", browse::fmt_rating(r)));
            }
        }
        for g in cx.state.genre_names(self.tv, arr(&self.t, "genres")) {
            parts.push(g);
        }
        ui::meta_dot(cx, x + 1.0, y + 13.0);
        cx.tx.draw_fit(&mut cx.g, body(26.0, 700), &parts.join(" · "), x + 25.0, y, 1000.0, hexa(0xF6EADF, 0.86));
        y += 52.0;
        let overview = if s(&self.t, "overview").is_empty() { String::from(t!("No description available.")) } else { String::from(s(&self.t, "overview")) };
        let h = cx.tx.para(&mut cx.g, body(27.0, 400), &overview, x, y, 950.0, 3, 35.0, ui::DUST);
        y += h.max(105.0) + 14.0;
        if !self.cast.is_empty() {
            let c = self.cast.clone();
            cx.tx.draw_fit(&mut cx.g, body(24.0, 400), &c, x, y, 950.0, ui::DUST);
        }
        y += 44.0;
        // seasons
        let chip_focus = if self.at_seasons { Some(1000 + self.si as u64) } else { None };
        let act_focus = if self.at_seasons { None } else { Some(self.ai as u64 + 1) };
        match chip_focus.or(act_focus) {
            Some(k) => self.lit.focus(k),
            None => self.lit.none(),
        }
        self.lit.step(cx);
        if self.tv {
            if self.seasons.is_empty() {
                let note = self.seasons_note.clone();
                cx.tx.draw(&mut cx.g, body(25.0, 400), &note, x, y, if self.seasons_err { ui::ALERT } else { ui::DUST });
                y += 60.0;
            } else {
                cx.tx.draw(&mut cx.g, body(22.0, 700), &crate::util::lower(t!("Season")).to_uppercase(), x, y, ui::DUST);
                y += 40.0;
                self.chip_scroll.set(self.si.saturating_sub(5) as f32 * 86.0);
                let sx = self.chip_scroll.step(cx, 14.0);
                cx.g.push_clip(rect(x - 20.0, y - 20.0, 760.0, 110.0));
                for (n, se) in self.seasons.clone().iter().enumerate() {
                    let r = rect(x + n as f32 * 86.0 - sx, y, 70.0, 60.0);
                    let lit = self.lit.get(1000 + n as u64);
                    let up = b(se, "upcoming");
                    let label = crate::util::id(se, "number");
                    let kind = if n == self.si { ui::Pill::Primary } else { ui::Pill::Quiet };
                    cx.g.push_alpha(if up { 0.45 } else { 1.0 });
                    ui::pill(cx, r, &label, body(26.0, 700), kind, lit);
                    cx.g.pop_alpha();
                }
                cx.g.pop_clip();
                y += 90.0;
            }
        }
        // actions
        let pf = body(30.0, 700);
        let mut ax = x;
        for (n, a) in self.actions.clone().iter().enumerate() {
            let label = self.label(cx, *a);
            let w = ui::pill_w(cx, &label, pf, 34.0, 270.0);
            let primary = match a {
                Do::Library => true,
                Do::Mine => !self.actions.contains(&Do::Library),
                Do::Download => self.mine.is_none() && !self.actions.contains(&Do::Library),
                Do::Quality => false,
            };
            let lit = self.lit.get(n as u64 + 1);
            ui::pill(cx, rect(ax, y, w, 78.0), &label, pf, if primary { ui::Pill::Primary } else { ui::Pill::Plain }, lit);
            ax += w + 18.0;
        }
        y += 100.0;
        if let Some(p) = self.on_way.clone() {
            y += strip(cx, &p, x, y, 760.0) + 10.0;
        }
        if !self.status.is_empty() {
            let st = self.status.clone();
            cx.tx.para(&mut cx.g, body(24.0, 400), &st, x, y, 1100.0, 2, 32.0, if self.status_err { ui::ALERT } else { ui::DUST });
        }
    }
    fn key(&mut self, cx: &mut Cx, k: Key) -> bool {
        cx.redraw();
        if self.at_seasons {
            match k.code {
                key::LEFT if self.si > 0 => self.si -= 1,
                key::RIGHT if self.si + 1 < self.seasons.len() => self.si += 1,
                key::DOWN | key::ENTER => {
                    self.at_seasons = false;
                    self.ai = self.actions.iter().position(|a| *a == Do::Download).unwrap_or(0);
                }
                key::UP | key::LEFT | key::RIGHT => {}
                _ => return false,
            }
            return true;
        }
        match k.code {
            key::UP if self.tv && !self.seasons.is_empty() => self.at_seasons = true,
            key::LEFT => self.ai = self.ai.saturating_sub(1),
            key::RIGHT => self.ai = (self.ai + 1).min(self.actions.len() - 1),
            key::ENTER => self.act(cx),
            key::DOWN if self.actions.get(self.ai) == Some(&Do::Quality) => self.quality = (self.quality + 1) % QUALITIES.len(),
            key::UP | key::DOWN => {}
            _ => return false,
        }
        true
    }
    fn on_http(&mut self, cx: &mut Cx, tag: u32, res: Res) {
        if !self.alive {
            return;
        }
        match tag {
            LOGO => {
                if let Some(u) = res.json.get("page").and_then(|p| p.get("logo")).map(|l| s(l, "url")) {
                    self.logo = String::from(u);
                }
            }
            CAST => {
                let names: Vec<&str> = arr(&res.json, "cast").iter().filter_map(|c| c.as_str()).collect();
                if !names.is_empty() {
                    self.cast = alloc::format!("{} {}", t!("Cast:"), names.join(", "));
                }
            }
            SEASONS => {
                if !res.ok() {
                    self.seasons_note = t!("Couldn’t load seasons: {0}", res.error());
                    self.seasons_err = true;
                    self.at_seasons = false;
                } else {
                    let all = arr(&res.json, "seasons");
                    let mut list: Vec<Value> = all.iter().filter(|x| !b(x, "upcoming")).cloned().collect();
                    if list.is_empty() {
                        list = all.to_vec();
                    }
                    self.si = list.len().saturating_sub(1);
                    self.seasons = list;
                    if self.seasons.is_empty() {
                        self.at_seasons = false;
                    }
                }
            }
            STARTED => {
                if res.ok() {
                    let job = crate::util::id(&res.json, "id");
                    cx.get(&alloc::format!("/api/downloads/smart/{}", crate::util::enc(&job)), self.sid, JOB);
                    self.status = String::from(t!("Finding the best download…"));
                    self.poll_id = job;
                } else {
                    self.stop_busy(res.error(), true);
                }
            }
            JOB => {
                if !res.ok() {
                    self.stop_busy(res.error(), true);
                    return;
                }
                let j = &res.json;
                let state = s(j, "state");
                let msg = if !s(j, "message").is_empty() {
                    String::from(s(j, "message"))
                } else if !s(j, "step").is_empty() {
                    String::from(s(j, "step"))
                } else if state == "running" {
                    String::from(t!("Finding the best download…"))
                } else {
                    String::from(t!("Download request finished."))
                };
                self.status = msg.clone();
                if state == "running" {
                    self.poll = cx.timer(1400.0, self.sid, JOB_T);
                } else {
                    let failed = state == "failed";
                    self.stop_busy(msg, failed);
                    cx.load_library(None);
                    if !failed && s(j, "outcome") != "none" {
                        self.offer_library();
                    }
                }
            }
            FOLLOWED => {
                let was = self.on_way.is_some();
                self.on_way = browse::pending_for(cx, s(&self.t, "type"), &self.tid);
                if self.on_way.is_some() && !was && !self.busy {
                    self.status.clear();
                }
                self.follow = cx.timer(5000.0, self.sid, FOLLOW_T);
            }
            _ => {}
        }
        cx.redraw();
    }
    fn on_timer(&mut self, cx: &mut Cx, tag: u32) {
        if !self.alive {
            return;
        }
        match tag {
            JOB_T => {
                let id = self.poll_id.clone();
                cx.get(&alloc::format!("/api/downloads/smart/{}", crate::util::enc(&id)), self.sid, JOB);
            }
            FOLLOW_T => cx.load_pending(Some((self.sid, FOLLOWED))),
            _ => {}
        }
    }
    fn leave(&mut self, cx: &mut Cx) {
        self.alive = false;
        cx.cancel(self.poll);
        cx.cancel(self.follow);
    }
    fn refresh(&mut self, cx: &mut Cx) {
        cx.redraw();
    }
}
