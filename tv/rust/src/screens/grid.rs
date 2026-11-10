//! See all, a genre, a documentary category: a grid that pages in as you move down, with type and sort chips.
use super::browse::{self, Grid, Kind, GRID_MAX};
use crate::gfx::{hexa, rect};
use crate::text::{body, display};
use crate::ui::{self, Lit};
use crate::util::{arr, enc, i};
use crate::{key, t, Cx, Key, Res, Screen};
use alloc::string::String;
use alloc::vec::Vec;

#[derive(Clone)]
pub enum Source {
    List(String),
    Genre(Option<i64>, Option<i64>),
    Docs(String, bool),
}

struct Chip {
    sort: bool,
    value: &'static str,
    label: &'static str,
}

pub struct GridScreen {
    sid: u32,
    title: String,
    src: Source,
    ty: &'static str,
    sort: &'static str,
    chips: Vec<Chip>,
    grid: Grid,
    seq: u32,
    page: u32,
    last: bool,
    busy: bool,
    note: String,
    at_top: bool,
    ci: usize,
    lit: Lit,
}

fn sorts() -> [(&'static str, &'static str); 3] {
    [("popular", t!("Popular")), ("rating", t!("Top rated")), ("newest", t!("Newest"))]
}

impl GridScreen {
    pub fn new(cx: &mut Cx, title: &str, src: Source, ty: &'static str, types: bool, sorts_on: bool) -> GridScreen {
        let sid = cx.sid();
        let mut chips = Vec::new();
        if types {
            for (v, l) in super::discover::types() {
                chips.push(Chip { sort: false, value: v, label: l });
            }
        }
        if sorts_on {
            for (v, l) in sorts() {
                chips.push(Chip { sort: true, value: v, label: l });
            }
        }
        let wide = matches!(src, Source::Docs(_, true));
        let grid = if wide { Grid::new(4, Kind::Svt) } else { Grid::new(8, Kind::Tile) };
        let mut g = GridScreen {
            sid,
            title: String::from(title),
            src,
            ty,
            sort: "popular",
            chips,
            grid,
            seq: 0,
            page: 0,
            last: false,
            busy: false,
            note: String::new(),
            at_top: false,
            ci: 0,
            lit: Lit::default(),
        };
        g.reload(cx);
        g
    }
    fn reload(&mut self, cx: &mut Cx) {
        self.seq = (self.seq + 1) & 0xfff;
        self.page = 0;
        self.last = false;
        self.busy = false;
        self.grid.clear();
        self.note = String::from(t!("Loading…"));
        self.more(cx);
    }
    fn url(&self, page: u32) -> String {
        match &self.src {
            Source::List(k) => alloc::format!("/api/discover/list?key={}&page={}", enc(k), page),
            Source::Genre(m, tv) => browse::genre_url(*m, *tv, self.ty, self.sort, page),
            Source::Docs(id, _) => browse::docs_url(id, self.ty, self.sort, page),
        }
    }
    fn more(&mut self, cx: &mut Cx) {
        if self.busy || self.last {
            return;
        }
        self.busy = true;
        let url = self.url(self.page + 1);
        cx.get(&url, self.sid, self.seq);
    }
}

impl Screen for GridScreen {
    fn sid(&self) -> u32 {
        self.sid
    }
    fn draw(&mut self, cx: &mut Cx) {
        ui::room(cx);
        let top = if self.chips.is_empty() { 170.0 } else { 250.0 };
        let view = rect(ui::EDGE, top, 1920.0 - 2.0 * ui::EDGE, 1080.0 - top);
        self.grid.draw(cx, view, !self.at_top);
        if !self.note.is_empty() {
            if self.grid.cards.is_empty() && self.busy {
                ui::loading(cx, 960.0, top + 160.0, &self.note.clone());
            } else {
                cx.tx.draw(&mut cx.g, body(28.0, 400), &self.note.clone(), ui::EDGE, top + 20.0, ui::DUST);
            }
        }
        cx.g.vgrad(rect(0.0, 0.0, 1920.0, top), &[(0.0, ui::VELVET), (0.8, ui::VELVET), (1.0, hexa(0x1F1019, 0.0))]);
        cx.tx.draw_fit(&mut cx.g, display(68.0, 800), &self.title, ui::EDGE - 3.0, 52.0, 1700.0, ui::PAPER);
        if !self.chips.is_empty() {
            let f = body(26.0, 700);
            match (self.at_top, self.chips.get(self.ci)) {
                (true, Some(c)) => self.lit.focus(ui::hash(c.label)),
                _ => self.lit.none(),
            }
            self.lit.step(cx);
            let mut x = ui::EDGE;
            let mut was_sort = false;
            for n in 0..self.chips.len() {
                let c = &self.chips[n];
                if c.sort && !was_sort && n > 0 {
                    x += 42.0;
                }
                was_sort = c.sort;
                let w = ui::pill_w(cx, c.label, f, 28.0, 0.0);
                let active = if c.sort { c.value == self.sort } else { c.value == self.ty };
                let lit = self.lit.get(ui::hash(c.label));
                let kind = if active { ui::Pill::Primary } else { ui::Pill::Quiet };
                let label = c.label;
                ui::pill(cx, rect(x, 150.0, w, 56.0), label, f, kind, lit);
                x += w + 14.0;
            }
        }
    }
    fn key(&mut self, cx: &mut Cx, k: Key) -> bool {
        cx.redraw();
        if self.at_top {
            match k.code {
                key::LEFT => self.ci = self.ci.saturating_sub(1),
                key::RIGHT => self.ci = (self.ci + 1).min(self.chips.len().saturating_sub(1)),
                key::DOWN => {
                    if !self.grid.cards.is_empty() {
                        self.at_top = false;
                    }
                }
                key::ENTER => {
                    if let Some(c) = self.chips.get(self.ci) {
                        if c.sort {
                            self.sort = c.value;
                        } else {
                            self.ty = c.value;
                        }
                        self.reload(cx);
                    }
                }
                key::UP => {}
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
            key::UP | key::DOWN | key::LEFT | key::RIGHT => {
                if !self.grid.go(k.code) && k.code == key::UP && !self.chips.is_empty() {
                    self.at_top = true;
                }
                if self.grid.near_end() {
                    self.more(cx);
                }
            }
            _ => return false,
        }
        true
    }
    fn on_http(&mut self, cx: &mut Cx, tag: u32, res: Res) {
        if tag != self.seq {
            return;
        }
        self.busy = false;
        if !res.ok() {
            self.last = true;
            self.note = res.error();
            cx.redraw();
            return;
        }
        let page = self.page + 1;
        self.page = page;
        let d = &res.json;
        let cards = match &self.src {
            Source::Docs(_, svt) => browse::docs_cards(cx, arr(d, "results"), *svt),
            _ => arr(d, "results").iter().map(|t| browse::title_card(cx, t)).collect(),
        };
        let before = self.grid.cards.len();
        self.grid.add(cards);
        if i(d, "page").unwrap_or(page as i64) >= i(d, "totalPages").unwrap_or(1) || self.grid.cards.len() == before || self.grid.cards.len() >= GRID_MAX {
            self.last = true;
        }
        self.note = if self.grid.cards.is_empty() { String::from(t!("Nothing here yet.")) } else { String::new() };
        if self.grid.cards.is_empty() && !self.chips.is_empty() {
            self.at_top = true;
        }
        if self.grid.near_end() {
            self.more(cx);
        }
        cx.redraw();
    }
    fn refresh(&mut self, cx: &mut Cx) {
        cx.redraw();
    }
}
