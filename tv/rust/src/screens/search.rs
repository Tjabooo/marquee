//! Search: an on-screen keyboard for the remote (a USB/Bluetooth keyboard and the remote's digits type too).
//! Your library answers at once; TMDB (through the server) once you stop typing.
use super::browse::{self, Card, Grid, Kind};
use crate::gfx::{hexa, rect};
use crate::text::{body, display};
use crate::ui::{self, Lit};
use crate::util::{arr, enc, has, s, search_key};
use crate::{key, t, Cx, Key, Res, Screen};
use alloc::string::String;
use alloc::vec::Vec;

const KEY_ROWS: usize = 7;
const KEYBOARD: &str = "abcdefghijklmnopqrstuvwxyzåäö1234567890-:.";
const RUN_T: u32 = 1;
const TRENDING: u32 = 2;
const RESULTS: u32 = 3;

pub struct Search {
    sid: u32,
    q: String,
    keys_zone: bool,
    kx: usize,
    ky: usize,
    seq: u32,
    timer: u32,
    label: String,
    grid: Grid,
    keys: Vec<char>,
    lit: Lit,
    local: Vec<Card>,
    query: String,
}

impl Search {
    pub fn new(cx: &mut Cx) -> Search {
        let sid = cx.sid();
        let mut s = Search {
            sid,
            q: String::new(),
            keys_zone: true,
            kx: 0,
            ky: 0,
            seq: 0,
            timer: 0,
            label: String::new(),
            grid: Grid::new(5, Kind::Tile),
            keys: KEYBOARD.chars().collect(),
            lit: Lit::default(),
            local: Vec::new(),
            query: String::new(),
        };
        s.run(cx);
        s
    }
    fn set_query(&mut self, cx: &mut Cx, q: String) {
        self.q = q;
        cx.cancel(self.timer);
        self.timer = cx.timer(450.0, self.sid, RUN_T);
        cx.redraw();
    }
    fn type_char(&mut self, cx: &mut Cx, c: char) {
        if self.q.chars().count() >= 60 || (c == ' ' && (self.q.is_empty() || self.q.ends_with(' '))) {
            return;
        }
        let mut q = self.q.clone();
        q.push(c);
        self.set_query(cx, q);
    }
    fn erase(&mut self, cx: &mut Cx) {
        let mut q = self.q.clone();
        q.pop();
        self.set_query(cx, q);
    }
    fn press(&mut self, cx: &mut Cx) {
        if self.ky < KEY_ROWS {
            let c = self.keys[self.ky * 6 + self.kx];
            self.type_char(cx, c);
        } else if self.kx < 2 {
            self.type_char(cx, ' ');
        } else if self.kx < 4 {
            self.erase(cx);
        } else {
            self.set_query(cx, String::new());
        }
    }
    fn results(&mut self, cx: &mut Cx, cards: Vec<Card>, label: String) {
        self.grid.clear();
        self.grid.add(cards);
        self.label = label;
        if !self.keys_zone && self.grid.cards.is_empty() {
            self.keys_zone = true;
        }
        cx.redraw();
    }
    fn library_matches(&self, cx: &mut Cx, query: &str) -> Vec<Card> {
        let q = search_key(query);
        if q.is_empty() {
            return Vec::new();
        }
        let mut out = Vec::new();
        let ids: Vec<String> = cx.state.owned().show_ids.keys().cloned().collect();
        for sh in &cx.state.shows {
            if ids.iter().any(|x| x == s(sh, "id")) && search_key(s(sh, "title")).contains(&q) {
                out.push(browse::show_card(cx, sh, Kind::Tile));
            }
        }
        let mut seen: Vec<String> = Vec::new();
        for f in &cx.state.library {
            if has(f, "season") {
                continue;
            }
            let tm = crate::util::id(f, "tmdbId");
            let k = if !tm.is_empty() { tm } else { String::from(s(f, "id")) };
            let name = if !s(f, "filmTitle").is_empty() { s(f, "filmTitle") } else { s(f, "title") };
            if seen.contains(&k) || !search_key(name).contains(&q) {
                continue;
            }
            seen.push(k);
            out.push(browse::film_card(f, Kind::Tile));
        }
        out.truncate(20);
        out
    }
    fn run(&mut self, cx: &mut Cx) {
        self.seq += 1;
        let query = String::from(self.q.trim());
        if query.is_empty() {
            self.label = String::from(t!("Trending this week"));
            cx.get("/api/discover/list?key=trending-all&page=1", self.sid, TRENDING | (self.seq << 4));
            return;
        }
        let local = self.library_matches(cx, &query);
        if query.chars().count() < 2 {
            let label = String::from(if local.is_empty() { t!("Keep typing…") } else { t!("In your library") });
            self.results(cx, local, label);
            return;
        }
        self.local = local.clone();
        self.query = query.clone();
        self.results(cx, local, t!("Searching for “{0}”…", query));
        cx.get(&alloc::format!("/api/search?q={}", enc(&query)), self.sid, RESULTS | (self.seq << 4));
    }
}

impl Screen for Search {
    fn sid(&self) -> u32 {
        self.sid
    }
    fn draw(&mut self, cx: &mut Cx) {
        ui::room(cx);
        cx.tx.draw(&mut cx.g, display(46.0, 800).glow(), t!("Search"), ui::EDGE, 64.0, ui::BULB);
        cx.tx.draw_right(&mut cx.g, body(24.0, 400), t!("OK: type · Right: results · Back: close"), 1920.0 - ui::EDGE, 76.0, ui::DUST);

        // The field.
        let field = rect(ui::EDGE, 170.0, 520.0, 78.0);
        cx.g.pill(field, hexa(0x2B1724, 0.9));
        cx.g.ring(field, 39.0, 2.0, hexa(0xF4C152, 0.45));
        let f = body(34.0, 700);
        let ty = field.y + (78.0 - f.line()) / 2.0;
        if self.q.is_empty() {
            cx.tx.draw(&mut cx.g, body(34.0, 400), t!("Films and shows"), field.x + 28.0, ty, ui::DUST);
        } else {
            let q = self.q.clone();
            // The end of what you typed stays in view.
            let mut shown = q.clone();
            while cx.tx.width(f, &shown) > 440.0 && !shown.is_empty() {
                shown.remove(0);
            }
            let w = cx.tx.draw(&mut cx.g, f, &shown, field.x + 28.0, ty, ui::PAPER);
            let blink = ((cx.now / 530.0) as i64) % 2 == 0;
            if blink {
                cx.g.fill(rect(field.x + 30.0 + w, field.y + 20.0, 3.0, 38.0), ui::BULB);
            }
            cx.ambient = true;
        }
        // The keys.
        let kf = body(30.0, 700);
        let wf = body(24.0, 700);
        let focus = if self.keys_zone { Some(if self.ky < KEY_ROWS { self.ky * 6 + self.kx } else { 100 + self.kx / 2 }) } else { None };
        match focus {
            Some(n) => self.lit.focus(n as u64 + 1),
            None => self.lit.none(),
        }
        self.lit.step(cx);
        let y0 = 274.0;
        for (n, c) in self.keys.clone().iter().enumerate() {
            let r = rect(ui::EDGE + (n % 6) as f32 * 86.0, y0 + (n / 6) as f32 * 74.0, 78.0, 66.0);
            let lit = self.lit.get(n as u64 + 1);
            key_cap(cx, r, &upper(*c), kf, lit);
        }
        let bottom = [t!("Space"), "", t!("Clear")];
        for (n, l) in bottom.iter().enumerate() {
            let r = rect(ui::EDGE + n as f32 * 172.0, y0 + KEY_ROWS as f32 * 74.0, 164.0, 66.0);
            let lit = self.lit.get(100 + n as u64 + 1);
            key_cap(cx, r, l, wf, lit);
            if n == 1 {
                erase_icon(cx, r.scale(1.0 + 0.06 * lit), ui::PAPER.mix(ui::ON_BULB, lit));
            }
        }
        // Results.
        let lf = body(32.0, 700);
        cx.tx.draw_fit(&mut cx.g, lf, &self.label.clone(), 686.0, 160.0, 1100.0, ui::PAPER);
        let view = rect(686.0, 220.0, 1920.0 - 686.0 - 40.0, 860.0);
        self.grid.draw(cx, view, !self.keys_zone);
    }
    fn key(&mut self, cx: &mut Cx, k: Key) -> bool {
        cx.redraw();
        // A real keyboard: letters and digits type, Backspace erases (Back still closes when there's nothing to erase).
        if k.raw == key::BACKSPACE && !self.q.is_empty() {
            self.erase(cx);
            return true;
        }
        if let Some(c) = k.ch {
            if !c.is_control() {
                for l in c.to_lowercase() {
                    self.type_char(cx, l);
                }
                return true;
            }
        }
        if self.keys_zone {
            match k.code {
                key::LEFT => {
                    self.kx = if self.ky == KEY_ROWS { (self.kx / 2).saturating_sub(1) * 2 } else { self.kx.saturating_sub(1) };
                }
                key::RIGHT => {
                    let at_edge = if self.ky == KEY_ROWS { self.kx >= 4 } else { self.kx == 5 };
                    if at_edge {
                        if !self.grid.cards.is_empty() {
                            self.keys_zone = false;
                            self.grid.i = self.grid.i.min(self.grid.cards.len() - 1);
                        }
                    } else {
                        self.kx = if self.ky == KEY_ROWS { (self.kx / 2 + 1) * 2 } else { self.kx + 1 };
                    }
                }
                key::UP => self.ky = self.ky.saturating_sub(1),
                key::DOWN => self.ky = (self.ky + 1).min(KEY_ROWS),
                key::ENTER => self.press(cx),
                _ => return false,
            }
            return true;
        }
        match k.code {
            key::ENTER => {
                if let Some(c) = self.grid.current().cloned() {
                    browse::open(cx, &c);
                }
            }
            key::LEFT if self.grid.i % self.grid.cols == 0 => self.keys_zone = true,
            key::UP | key::DOWN | key::LEFT | key::RIGHT => {
                self.grid.go(k.code);
            }
            _ => return false,
        }
        true
    }
    fn on_timer(&mut self, cx: &mut Cx, tag: u32) {
        if tag == RUN_T {
            self.run(cx);
        }
    }
    fn on_http(&mut self, cx: &mut Cx, tag: u32, res: Res) {
        if tag >> 4 != self.seq {
            return;
        }
        match tag & 15 {
            TRENDING => {
                if res.ok() {
                    let cards = arr(&res.json, "results").iter().map(|t| browse::title_card(cx, t)).collect();
                    self.results(cx, cards, String::from(t!("Trending this week")));
                } else {
                    self.results(cx, Vec::new(), String::from(t!("Type to search films and shows")));
                }
            }
            RESULTS => {
                let query = self.query.clone();
                let mut all = self.local.clone();
                if !res.ok() {
                    self.results(cx, all, res.error());
                    return;
                }
                for t in arr(&res.json, "svt") {
                    all.push(browse::svt_card(cx, t, true));
                }
                for t in arr(&res.json, "results") {
                    all.push(browse::title_card(cx, t));
                }
                let label = if all.is_empty() { t!("Nothing found for “{0}”", query) } else { t!("Results for “{0}”", query) };
                self.results(cx, all, label);
            }
            _ => {}
        }
    }
    fn leave(&mut self, cx: &mut Cx) {
        cx.cancel(self.timer);
        self.seq += 1;
    }
    fn refresh(&mut self, cx: &mut Cx) {
        cx.redraw();
    }
}

/// ⌫, drawn (the TV's fonts don't all have it): a tag pointing left with a × in it.
fn erase_icon(cx: &mut Cx, r: crate::gfx::Rect, c: crate::gfx::Rgba) {
    let (w, h) = (44.0, 28.0);
    let x = r.x + (r.w - w) / 2.0 + 6.0;
    let y = r.y + (r.h - h) / 2.0;
    for k in 0..h as usize {
        let m = 1.0 - libm::fabsf(2.0 * (k as f32 + 0.5) / h - 1.0);
        let tip = 12.0 * (1.0 - m);
        cx.g.fill(rect(x - 12.0 + tip, y + k as f32, 12.0 - tip + 1.0, 1.0), c);
    }
    cx.g.round(rect(x, y, w - 12.0, h), 4.0, c);
    let f = body(26.0, 700);
    let bg = crate::gfx::hexa(0x2B1724, 1.0).mix(ui::BULB, if c == ui::PAPER { 0.0 } else { 1.0 });
    cx.tx.draw_center(&mut cx.g, f, "×", x + (w - 12.0) / 2.0, y + (h - f.line()) / 2.0, bg);
}

fn upper(c: char) -> String {
    c.to_uppercase().collect()
}

fn key_cap(cx: &mut Cx, r: crate::gfx::Rect, label: &str, f: crate::text::Font, lit: f32) {
    let r = r.scale(1.0 + 0.06 * lit);
    if lit > 0.0 {
        cx.g.glow(r, 14.0, 36.0, ui::BULB.alpha(0.4 * lit));
    }
    cx.g.round(r, 14.0, hexa(0x2B1724, 0.9).mix(ui::BULB, lit));
    let c = ui::PAPER.mix(ui::ON_BULB, lit);
    cx.tx.draw_center(&mut cx.g, f, label, r.x + r.w / 2.0, r.y + (r.h - f.line()) / 2.0, c);
}
