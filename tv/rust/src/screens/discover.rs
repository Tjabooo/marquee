//! Discover and Documentaries: the focused title fills the top half (backdrop, title, facts, description),
//! rows that keep loading as you move along them scroll underneath.
use super::browse::{self, Act, Card, Fetch, Kind, Row, Rows};
use super::grid::{GridScreen, Source};
use crate::gfx::{hexa, rect};
use crate::text::{body, display};
use crate::ui::{self, Ambient, Ease, Lit};
use crate::util::{arr, s};
use crate::{key, t, Cx, Key, Res, Screen};
use alloc::boxed::Box;
use alloc::string::String;
use alloc::vec::Vec;
use serde_json::Value;

const HOME: u32 = 1;
const GENRES: u32 = 2;

const SEE_ROW: u32 = 1000;
const GENRE_TILE: u32 = 2000;
const GENRE_ALL: u32 = 3000;
const CATEGORY: u32 = 4000;
const CAT_ALL: u32 = 5000;

/// The hero: what the focused title is. It changes once the focus rests a moment (pictures are slow on
/// the TV), the backdrop crossfading and the words fading in.
#[derive(Default)]
pub struct Hero {
    amb: Ambient,
    title: String,
    meta: String,
    text: String,
    key: String,
    next: Option<(String, Value, String)>,
    since: f64,
    text_in: Ease,
}
impl Hero {
    fn apply(&mut self, cx: &mut Cx, key: String, t: &Value, back: &str, docs: bool, first: bool) {
        self.title = String::from(s(t, "title"));
        self.meta = browse::hero_meta(cx, t, docs);
        self.text = String::from(s(t, "overview"));
        self.key = key;
        if first {
            self.amb.now(back);
            self.text_in = Ease::at(1.0);
        } else {
            self.amb.want(cx, back);
            self.text_in = Ease::at(0.0);
        }
    }
    fn follow(&mut self, cx: &mut Cx, card: Option<&Card>, docs: bool) {
        if let Some(c) = card {
            if let Some(t) = &c.hero {
                if self.key.is_empty() {
                    let t = t.clone();
                    self.apply(cx, c.key.clone(), &t, &c.back, docs, true);
                } else if c.key != self.key && self.next.as_ref().map(|n| &n.0) != Some(&c.key) {
                    self.next = Some((c.key.clone(), t.clone(), c.back.clone()));
                    self.since = cx.now;
                } else if c.key == self.key {
                    self.next = None;
                }
            }
        }
        if let Some((k, t, b)) = self.next.clone() {
            if cx.now - self.since >= 220.0 {
                self.next = None;
                self.apply(cx, k, &t, &b, docs, false);
            } else {
                cx.moving = true;
            }
        }
        self.amb.step(cx, 0.0);
        self.text_in.set(1.0);
        self.text_in.step01(cx, 9.0);
    }
    fn draw(&mut self, cx: &mut Cx) {
        let art = rect(0.0, 0.0, 1920.0, 900.0);
        self.amb.draw(cx, art, 0.85);
        cx.g.hgrad(art, &[(0.0, ui::VELVET), (0.30, hexa(0x1F1019, 0.78)), (0.64, hexa(0x1F1019, 0.1)), (1.0, hexa(0x1F1019, 0.0))]);
        cx.g.vgrad(art, &[(0.0, hexa(0x1F1019, 0.0)), (0.34, hexa(0x1F1019, 0.0)), (0.74, ui::VELVET), (1.0, ui::VELVET)]);
        cx.g.fill(rect(0.0, 900.0, 1920.0, 180.0), ui::VELVET);
        let a = self.text_in.v;
        cx.g.push_alpha(a);
        let h1 = display(76.0, 800);
        cx.tx.draw_fit(&mut cx.g, h1, &self.title, ui::EDGE - 3.0, 168.0, 1300.0, ui::PAPER);
        if !self.meta.is_empty() {
            ui::meta_dot(cx, ui::EDGE + 1.0, 275.0);
            cx.tx.draw_fit(&mut cx.g, body(26.0, 700), &self.meta, ui::EDGE + 25.0, 263.0, 1100.0, hexa(0xF6EADF, 0.86));
        }
        cx.tx.para(&mut cx.g, body(27.0, 400), &self.text, ui::EDGE, 314.0, 980.0, 3, 35.0, hexa(0xF6EADF, 0.82));
        cx.g.pop_alpha();
    }
}

/// The bar over a hero: the screen's name, then pill tabs on the right.
fn tabs_bar(cx: &mut Cx, name: &str, tabs: &[&str], active: Option<usize>, lit: &mut Lit, focus: Option<usize>) {
    cx.g.vgrad(rect(0.0, 0.0, 1920.0, 170.0), &[(0.0, hexa(0x1F1019, 0.7)), (1.0, hexa(0x1F1019, 0.0))]);
    let f = display(46.0, 800).glow();
    cx.tx.draw(&mut cx.g, f, name, ui::EDGE, 64.0, ui::BULB);
    let pf = body(26.0, 700);
    let ws: Vec<f32> = tabs.iter().map(|l| ui::pill_w(cx, l, pf, 28.0, 0.0)).collect();
    let total: f32 = ws.iter().sum::<f32>() + 16.0 * (tabs.len() as f32 - 1.0) + if tabs.len() > 1 { 12.0 } else { 0.0 };
    let mut x = 1920.0 - ui::EDGE - total;
    match focus {
        Some(i) => lit.focus(ui::hash(tabs[i])),
        None => lit.none(),
    }
    lit.step(cx);
    for (n, l) in tabs.iter().enumerate() {
        let r = rect(x, 60.0, ws[n], 58.0);
        let l_lit = lit.get(ui::hash(l));
        if active == Some(n) && l_lit < 1.0 {
            // The type you're looking at: a paper pill.
            ui::pill(cx, r, l, pf, ui::Pill::Primary, l_lit);
        } else {
            ui::pill(cx, r, l, pf, ui::Pill::Quiet, l_lit);
        }
        x += ws[n] + 16.0;
        if n == 0 && tabs.len() > 1 {
            x += 12.0;
        }
    }
}

pub fn types() -> [(&'static str, &'static str); 3] {
    [("all", t!("All")), ("movie", t!("Films")), ("tv", t!("Shows"))]
}

pub struct Discover {
    sid: u32,
    ty: &'static str,
    rows: Rows,
    at_top: bool,
    ti: usize,
    hero: Hero,
    lit: Lit,
    loading: bool,
    empty: Option<(String, String)>,
    data: Vec<(String, String)>,
    waiting: u32,
    home: Option<Value>,
}

impl Discover {
    pub fn new(cx: &mut Cx) -> Discover {
        let sid = cx.sid();
        let mut d = Discover {
            sid,
            ty: "all",
            rows: Rows::new(0.0, 30.0, display(34.0, 700)),
            at_top: false,
            ti: 1,
            hero: Hero::default(),
            lit: Lit::default(),
            loading: true,
            empty: None,
            data: Vec::new(),
            waiting: 0,
            home: None,
        };
        d.load(cx);
        d
    }
    fn load(&mut self, cx: &mut Cx) {
        self.rows.set(Vec::new());
        self.loading = true;
        self.empty = None;
        self.home = None;
        self.waiting = 1;
        cx.get(&alloc::format!("/api/discover/home?type={}", self.ty), self.sid, HOME | (self.rows.seq << 12));
        if cx.state.genres.is_empty() {
            self.waiting += 1;
            cx.load_genres(Some((self.sid, GENRES)));
        }
    }
    fn genres(&self, cx: &Cx) -> Vec<Value> {
        cx.state
            .genres
            .iter()
            .filter(|g| match self.ty {
                "movie" => crate::util::i(g, "movie").unwrap_or(0) != 0,
                "tv" => crate::util::i(g, "tv").unwrap_or(0) != 0,
                _ => true,
            })
            .cloned()
            .collect()
    }
    fn built(&mut self, cx: &mut Cx) {
        let Some(home) = self.home.take() else { return };
        self.loading = false;
        let rows_in = arr(&home, "rows");
        if rows_in.is_empty() {
            let err = s(&home, "error");
            self.empty = Some(if !err.is_empty() {
                (String::from(t!("Discover is unavailable")), String::from(err))
            } else {
                (String::from(t!("Nothing to discover right now")), String::from(t!("Check that TMDB is configured on the Lilin server.")))
            });
            self.at_top = true;
            cx.redraw();
            return;
        }
        let mut rows: Vec<Row> = Vec::new();
        self.data.clear();
        for (n, r) in rows_in.iter().enumerate() {
            let cards: Vec<Card> = arr(r, "items").iter().map(|t| browse::title_card(cx, t)).collect();
            let k = String::from(s(r, "key"));
            self.data.push((String::from(s(r, "title")), k.clone()));
            rows.push(Row::growing(s(r, "title"), Kind::Tile, cards, Fetch::List(k), Some(SEE_ROW + n as u32)));
        }
        let gs = self.genres(cx);
        if !gs.is_empty() {
            let tiles = gs.iter().enumerate().map(|(n, g)| browse::genre_card(s(g, "name"), n, GENRE_TILE + n as u32)).collect();
            rows.push(Row::new(t!("Browse by genre"), Kind::Genre(0), tiles));
            for (n, g) in gs.iter().enumerate() {
                let f = Fetch::Genre(crate::util::i(g, "movie"), crate::util::i(g, "tv"), self.ty);
                rows.push(Row::lazy(s(g, "name"), Kind::Tile, f, Some(GENRE_ALL + n as u32)));
            }
        }
        self.rows.set(rows);
        self.rows.update(cx, self.sid);
    }
    fn tabs(&self) -> Vec<&'static str> {
        let mut v = alloc::vec![t!("Search")];
        for (_, l) in types() {
            v.push(l);
        }
        v.push(t!("Documentaries"));
        v
    }
    fn local(&mut self, cx: &mut Cx, tag: u32) {
        let gs = self.genres(cx);
        if (SEE_ROW..GENRE_TILE).contains(&tag) {
            if let Some((title, k)) = self.data.get((tag - SEE_ROW) as usize).cloned() {
                let g = GridScreen::new(cx, &title, Source::List(k), "all", false, false);
                cx.push(Box::new(g));
            }
        } else if (GENRE_TILE..CATEGORY).contains(&tag) {
            let n = if tag >= GENRE_ALL { tag - GENRE_ALL } else { tag - GENRE_TILE } as usize;
            if let Some(g) = gs.get(n) {
                genre_grid(cx, g, self.ty);
            }
        }
    }
}

pub fn genre_grid(cx: &mut Cx, g: &Value, ty: &'static str) {
    let m = crate::util::i(g, "movie").filter(|x| *x != 0);
    let tv = crate::util::i(g, "tv").filter(|x| *x != 0);
    let both = m.is_some() && tv.is_some();
    let ty = if both { ty } else if m.is_some() { "movie" } else { "tv" };
    let s = GridScreen::new(cx, s(g, "name"), Source::Genre(m, tv), ty, both, true);
    cx.push(Box::new(s));
}

impl Screen for Discover {
    fn sid(&self) -> u32 {
        self.sid
    }
    fn draw(&mut self, cx: &mut Cx) {
        ui::room(cx);
        let cur = if self.at_top { None } else { self.rows.current().cloned() };
        self.hero.follow(cx, cur.as_ref().or_else(|| self.rows.rows.first().and_then(|r| r.cards.first())), false);
        self.hero.draw(cx);
        self.rows.on = !self.at_top;
        self.rows.draw(cx, rect(0.0, 490.0, 1920.0, 590.0));
        if self.loading {
            ui::loading(cx, 960.0, 640.0, t!("Loading Discover…"));
        }
        if let Some((h, p)) = self.empty.clone() {
            cx.tx.draw(&mut cx.g, display(64.0, 800), &h, ui::EDGE, 560.0, ui::PAPER);
            cx.tx.para(&mut cx.g, body(34.0, 400), &p, ui::EDGE, 660.0, 1100.0, 3, 44.0, ui::DUST);
        }
        let tabs = self.tabs();
        let active = types().iter().position(|x| x.0 == self.ty).map(|n| n + 1);
        tabs_bar(cx, t!("Discover"), &tabs, active, &mut self.lit, if self.at_top { Some(self.ti) } else { None });
    }
    fn key(&mut self, cx: &mut Cx, k: Key) -> bool {
        cx.redraw();
        let n_tabs = self.tabs().len();
        if self.at_top {
            match k.code {
                key::LEFT => self.ti = self.ti.saturating_sub(1),
                key::RIGHT => self.ti = (self.ti + 1).min(n_tabs - 1),
                key::DOWN => {
                    if self.rows.current().is_some() {
                        self.at_top = false;
                    }
                }
                key::ENTER => {
                    if self.ti == 0 {
                        let s = super::search::Search::new(cx);
                        cx.push(Box::new(s));
                    } else if self.ti > 3 {
                        let s = Docs::new(cx);
                        cx.push(Box::new(s));
                    } else {
                        let ty = types()[self.ti - 1].0;
                        if ty != self.ty {
                            self.ty = ty;
                            self.load(cx);
                        }
                    }
                }
                key::UP => {}
                _ => return false,
            }
            return true;
        }
        match k.code {
            key::UP => {
                if !self.rows.move_v(-1) {
                    self.at_top = true;
                    self.ti = 1 + types().iter().position(|x| x.0 == self.ty).unwrap_or(0);
                }
            }
            key::DOWN => {
                self.rows.move_v(1);
            }
            key::LEFT => self.rows.side(-1),
            key::RIGHT => self.rows.side(1),
            key::ENTER => {
                if let Some(c) = self.rows.current().cloned() {
                    if !browse::open(cx, &c) {
                        if let Act::Local(tag) = c.act {
                            self.local(cx, tag);
                        }
                    }
                }
            }
            _ => return false,
        }
        self.rows.update(cx, self.sid);
        true
    }
    fn on_http(&mut self, cx: &mut Cx, tag: u32, res: Res) {
        if self.rows.on_page(cx, self.sid, tag, &res) {
            return;
        }
        if tag & 0xfff == HOME {
            if tag >> 12 != self.rows.seq {
                return;
            }
            self.home = Some(if res.ok() { res.json } else { serde_json::json!({ "rows": [], "error": res.error() }) });
            self.waiting = self.waiting.saturating_sub(1);
        } else if tag == GENRES {
            self.waiting = self.waiting.saturating_sub(1);
        }
        if self.waiting == 0 {
            self.built(cx);
        }
    }
    fn refresh(&mut self, cx: &mut Cx) {
        cx.redraw();
    }
}

// ---------- Documentaries ----------
pub struct Docs {
    sid: u32,
    rows: Rows,
    at_top: bool,
    hero: Hero,
    lit: Lit,
    loading: bool,
    empty: Option<(String, String)>,
    cats: Vec<Value>,
    /// (category, title) for each row's See all.
    sources: Vec<(Value, String)>,
}

impl Docs {
    pub fn new(cx: &mut Cx) -> Docs {
        let sid = cx.sid();
        cx.get("/api/docs/home", sid, HOME);
        Docs { sid, rows: Rows::new(0.0, 30.0, display(34.0, 700)), at_top: false, hero: Hero::default(), lit: Lit::default(), loading: true, empty: None, cats: Vec::new(), sources: Vec::new() }
    }
    fn row_for(&mut self, cx: &mut Cx, c: &Value, title: &str, items: Option<&[Value]>) -> Row {
        let svt = s(c, "source") == "svt";
        let kind = if svt { Kind::Svt } else { Kind::Tile };
        let f = Fetch::Docs(crate::util::id(c, "id"), svt);
        let tag = CAT_ALL + self.sources.len() as u32;
        self.sources.push((c.clone(), String::from(title)));
        match items {
            Some(items) => {
                let cards = browse::docs_cards(cx, items, true);
                Row::growing(title, kind, cards, f, Some(tag))
            }
            None => Row::lazy(title, kind, f, Some(tag)),
        }
    }
}

pub fn docs_grid(cx: &mut Cx, c: &Value, title: &str) {
    let svt = s(c, "source") == "svt";
    let name = if !title.is_empty() { title } else if !s(c, "name").is_empty() { s(c, "name") } else { s(c, "title") };
    let g = GridScreen::new(cx, name, Source::Docs(crate::util::id(c, "id"), svt), "all", true, !svt);
    cx.push(Box::new(g));
}

impl Screen for Docs {
    fn sid(&self) -> u32 {
        self.sid
    }
    fn draw(&mut self, cx: &mut Cx) {
        ui::room(cx);
        let cur = if self.at_top { None } else { self.rows.current().cloned() };
        self.hero.follow(cx, cur.as_ref().or_else(|| self.rows.rows.first().and_then(|r| r.cards.first())), true);
        self.hero.draw(cx);
        self.rows.on = !self.at_top;
        self.rows.draw(cx, rect(0.0, 490.0, 1920.0, 590.0));
        if self.loading {
            ui::loading(cx, 960.0, 640.0, t!("Loading documentaries…"));
        }
        if let Some((h, p)) = self.empty.clone() {
            cx.tx.draw(&mut cx.g, display(64.0, 800), &h, ui::EDGE, 560.0, ui::PAPER);
            cx.tx.para(&mut cx.g, body(34.0, 400), &p, ui::EDGE, 660.0, 1100.0, 3, 44.0, ui::DUST);
        }
        tabs_bar(cx, t!("Documentaries"), &[t!("Search")], None, &mut self.lit, if self.at_top { Some(0) } else { None });
    }
    fn key(&mut self, cx: &mut Cx, k: Key) -> bool {
        cx.redraw();
        if self.at_top {
            match k.code {
                key::DOWN => {
                    if self.rows.current().is_some() {
                        self.at_top = false;
                    }
                }
                key::ENTER => {
                    let s = super::search::Search::new(cx);
                    cx.push(Box::new(s));
                }
                key::UP | key::LEFT | key::RIGHT => {}
                _ => return false,
            }
            return true;
        }
        match k.code {
            key::UP => {
                if !self.rows.move_v(-1) {
                    self.at_top = true;
                }
            }
            key::DOWN => {
                self.rows.move_v(1);
            }
            key::LEFT => self.rows.side(-1),
            key::RIGHT => self.rows.side(1),
            key::ENTER => {
                if let Some(c) = self.rows.current().cloned() {
                    if !browse::open(cx, &c) {
                        if let Act::Local(tag) = c.act {
                            if (CATEGORY..CAT_ALL).contains(&tag) {
                                if let Some(cat) = self.cats.get((tag - CATEGORY) as usize).cloned() {
                                    docs_grid(cx, &cat, "");
                                }
                            } else if let Some((cat, title)) = self.sources.get((tag - CAT_ALL) as usize).cloned() {
                                docs_grid(cx, &cat, &title);
                            }
                        }
                    }
                }
            }
            _ => return false,
        }
        self.rows.update(cx, self.sid);
        true
    }
    fn on_http(&mut self, cx: &mut Cx, tag: u32, res: Res) {
        if self.rows.on_page(cx, self.sid, tag, &res) {
            return;
        }
        if tag != HOME {
            return;
        }
        self.loading = false;
        if !res.ok() {
            self.empty = Some((String::from(t!("Couldn’t load documentaries")), res.error()));
            self.at_top = true;
            cx.redraw();
            return;
        }
        let data = res.json;
        let mut rows: Vec<Row> = Vec::new();
        for r in arr(&data, "rows") {
            let row = self.row_for(cx, r, s(r, "title"), Some(arr(r, "items")));
            rows.push(row);
        }
        self.cats = arr(&data, "categories").to_vec();
        let tiles: Vec<Card> = self.cats.iter().enumerate().map(|(n, c)| browse::genre_card(s(c, "name"), n, CATEGORY + n as u32)).collect();
        if !tiles.is_empty() {
            let at = rows.len().min(1);
            rows.insert(at, Row::new(t!("Browse documentaries"), Kind::Genre(0), tiles));
        }
        for c in arr(&data, "more") {
            let row = self.row_for(cx, c, s(c, "title"), None);
            rows.push(row);
        }
        if rows.is_empty() {
            self.empty = Some((String::from(t!("Nothing here yet.")), String::new()));
            self.at_top = true;
        }
        self.rows.set(rows);
        self.rows.update(cx, self.sid);
    }
    fn refresh(&mut self, cx: &mut Cx) {
        cx.redraw();
    }
}
