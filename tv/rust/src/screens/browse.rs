//! Cards, rows of cards and grids: what Home, Discover, Documentaries, See all and Search are made of.
//! Rows grow while you move along them (a page at a time, up to ROW_MAX), load their first page only when
//! they come near the screen, and draw only the cards that are on it.
use crate::gfx::{hexa, rect, Rect, Rgba};
use crate::logic::{self, Pending};
use crate::text::{body, display, Font};
use crate::ui::{self, Ease, Lit};
use crate::util::{arr, f, i, id, s, year};
use crate::{t, Cx, Res};
use alloc::collections::BTreeSet;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde_json::Value;

pub const ROW_MAX: usize = 60;
pub const GRID_MAX: usize = 300;
pub const CARD_GAP: f32 = 32.0;
pub const ROW_WIDTH: f32 = 1920.0 - 2.0 * ui::EDGE;

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Wide,
    Poster,
    Tile,
    Genre(u8),
    Svt,
}
impl Kind {
    pub fn size(&self) -> (f32, f32) {
        match self {
            Kind::Wide => (448.0, 252.0),
            Kind::Poster => (236.0, 354.0),
            Kind::Tile => (196.0, 294.0),
            Kind::Genre(_) => (320.0, 180.0),
            Kind::Svt => (400.0, 225.0),
        }
    }
    fn fonts(&self) -> (Font, Font, f32) {
        match self {
            Kind::Tile => (body(25.0, 700), body(21.0, 400), 12.0),
            Kind::Svt => (body(26.0, 700), body(22.0, 400), 12.0),
            _ => (body(28.0, 700), body(24.0, 400), 16.0),
        }
    }
    /// Height of the whole card: art plus its name and the line under it.
    pub fn height(&self) -> f32 {
        let (_, h) = self.size();
        if matches!(self, Kind::Genre(_)) {
            return h;
        }
        let (nf, sf, gap) = self.fonts();
        h + gap + nf.line() + sf.line()
    }
}

#[derive(Clone)]
pub enum Act {
    /// A TMDB film or show: its page (download or play).
    Title(Value),
    Show(String),
    Film(String),
    Resume(String, f64),
    Pending(String),
    Svt(Value),
    /// Handled by the screen that owns the card (genre tiles, categories, See all).
    Local(u32),
    Nothing,
}

#[derive(Clone)]
pub struct Card {
    pub key: String,
    pub kind: Kind,
    pub title: String,
    pub sub: String,
    pub img: String,
    /// A wide picture for the screen's backdrop while this card has focus.
    pub back: String,
    pub badge: bool,
    pub svt: bool,
    pub see_all: bool,
    /// Some(progress) shows a bar; Some(None) = progress unknown.
    pub bar: Option<Option<f32>>,
    pub pct: String,
    pub act: Act,
    /// The title behind the card, for a hero to show.
    pub hero: Option<Value>,
}
impl Card {
    pub fn new(key: String, kind: Kind, title: String, act: Act) -> Card {
        Card { key, kind, title, sub: String::new(), img: String::new(), back: String::new(), badge: false, svt: false, see_all: false, bar: None, pct: String::new(), act, hero: None }
    }
    pub fn hash(&self) -> u64 {
        ui::hash(&self.key)
    }
}

pub fn type_word(tv: bool) -> &'static str {
    if tv {
        t!("Series")
    } else {
        t!("Film")
    }
}
pub fn title_sub(year: &str, tv: bool) -> String {
    crate::util::join(&[year, type_word(tv)], " · ")
}

/// What this person owns, for a TMDB title: Some(film id) / Some(show id).
pub enum Mine {
    Film(String),
    Show(String),
}
pub fn library_entry(cx: &mut Cx, ty: &str, tmdb: &str) -> Option<Mine> {
    let st = &mut cx.state;
    if ty == "movie" {
        let n = *st.owned().films.get(tmdb)?;
        Some(Mine::Film(String::from(s(&st.library[n], "id"))))
    } else {
        let n = *st.owned().shows.get(tmdb)?;
        Some(Mine::Show(String::from(s(&st.shows[n], "id"))))
    }
}
pub fn pending_for(cx: &Cx, ty: &str, tmdb: &str) -> Option<Pending> {
    let key = if ty == "tv" { alloc::format!("tv:tv-{}", tmdb) } else { alloc::format!("movie:{}", tmdb) };
    cx.state.pending.iter().find(|p| p.key == key).cloned()
}
pub fn pending_for_path(cx: &Cx, path: &str) -> Option<Pending> {
    cx.state.pending.iter().find(|p| p.items.iter().any(|d| s(d, "svtPath") == path)).cloned()
}
pub fn pending_named(cx: &Cx, name: &str) -> Option<Pending> {
    let k = crate::util::search_key(name);
    cx.state.pending.iter().find(|p| crate::util::search_key(&p.title) == k).cloned()
}
pub fn pending_percent(p: &Pending) -> String {
    match p.progress {
        Some(x) if x < 1.0 => alloc::format!("{} %", libm::floor(x * 100.0) as i64),
        _ => String::new(),
    }
}
pub fn pending_text(p: &Pending) -> String {
    crate::util::join(&[&pending_percent(p), &p.word], " · ")
}

// ---------- cards from data ----------
pub fn title_card(cx: &mut Cx, t: &Value) -> Card {
    let ty = s(t, "type");
    let tv = ty == "tv";
    let tid = id(t, "id");
    let mut c = Card::new(alloc::format!("{}:{}", ty, tid), Kind::Tile, String::from(s(t, "title")), Act::Title(t.clone()));
    c.sub = title_sub(&year(t), tv);
    c.img = String::from(s(t, "poster"));
    c.back = String::from(s(t, "backdrop"));
    c.badge = library_entry(cx, ty, &tid).is_some();
    c.bar = pending_for(cx, ty, &tid).map(|p| p.progress.map(|x| x as f32));
    c.hero = Some(t.clone());
    c
}
pub fn show_card(cx: &Cx, sh: &Value, kind: Kind) -> Card {
    let tm = id(sh, "tmdbId");
    let key = if !tm.is_empty() { alloc::format!("tv:{}", tm) } else { String::from(s(sh, "id")) };
    let mut c = Card::new(key, kind, String::from(s(sh, "title")), Act::Show(String::from(s(sh, "id"))));
    c.img = String::from(s(sh, "poster"));
    c.back = String::from(s(sh, "backdrop"));
    if kind == Kind::Tile {
        c.badge = true;
        c.sub = title_sub(&year(sh), true);
    }
    let _ = cx;
    c
}
pub fn film_card(f: &Value, kind: Kind) -> Card {
    let tm = id(f, "tmdbId");
    let key = if !tm.is_empty() && tm != "0" { alloc::format!("movie:{}", tm) } else { String::from(s(f, "id")) };
    let name = if !s(f, "filmTitle").is_empty() { s(f, "filmTitle") } else { s(f, "title") };
    let mut c = Card::new(key, kind, String::from(name), Act::Film(String::from(s(f, "id"))));
    c.img = String::from(if !s(f, "poster").is_empty() { s(f, "poster") } else { s(f, "backdrop") });
    c.back = String::from(s(f, "backdrop"));
    c.sub = year(f);
    c.badge = kind == Kind::Tile;
    c
}
pub fn pending_card(p: &Pending) -> Card {
    let mut c = Card::new(p.key.clone(), Kind::Poster, p.title.clone(), Act::Pending(p.key.clone()));
    c.img = if !p.poster.is_empty() { p.poster.clone() } else { p.backdrop.clone() };
    c.back = p.backdrop.clone();
    c.sub = p.word.clone();
    c.pct = pending_percent(p);
    c.bar = Some(p.progress.map(|x| x as f32));
    c
}
pub fn update_pending_card(c: &mut Card, p: &Pending) {
    c.sub = p.word.clone();
    c.pct = pending_percent(p);
    c.bar = Some(p.progress.map(|x| x as f32));
}
pub fn continue_card(cx: &Cx, f: &Value) -> Option<Card> {
    let p = cx.state.progress.get(logic::progress_ref(f))?;
    let time = crate::util::f(p, "time").unwrap_or(0.0);
    let dur = crate::util::f(p, "duration").unwrap_or(1.0);
    let show = cx.state.show(s(f, "show"));
    let img = if crate::util::has(f, "season") {
        let still = s(f, "still");
        if !still.is_empty() {
            ui::tmdb_size(still, "w780")
        } else {
            String::from(show.map(|x| s(x, "backdrop")).unwrap_or(""))
        }
    } else if !s(f, "backdrop").is_empty() {
        String::from(s(f, "backdrop"))
    } else {
        String::from(s(f, "poster"))
    };
    let title = match show {
        Some(sh) => String::from(s(sh, "title")),
        None => String::from(if !s(f, "filmTitle").is_empty() { s(f, "filmTitle") } else { s(f, "title") }),
    };
    let mut c = Card::new(String::from(s(f, "id")), Kind::Wide, title, Act::Resume(String::from(s(f, "id")), time));
    c.back = match show {
        Some(sh) if !s(sh, "backdrop").is_empty() => String::from(s(sh, "backdrop")),
        _ => img.clone(),
    };
    c.img = img;
    c.sub = crate::util::join(&[&logic::episode_label(f), s(f, "episodeName"), &logic::minutes_left(p)], " · ");
    c.bar = Some(Some((time / dur).min(1.0) as f32));
    Some(c)
}
pub fn svt_owned(cx: &mut Cx, title: &str) -> bool {
    let k = crate::util::search_key(title);
    let st = &mut cx.state;
    let ids: Vec<String> = st.owned().show_ids.keys().cloned().collect();
    st.shows.iter().any(|sh| ids.iter().any(|x| x == s(sh, "id")) && crate::util::search_key(s(sh, "title")) == k)
        || st.library.iter().any(|f| {
            !crate::util::has(f, "season") && crate::util::search_key(if !s(f, "filmTitle").is_empty() { s(f, "filmTitle") } else { s(f, "title") }) == k
        })
}
pub fn svt_card(cx: &mut Cx, t: &Value, tile: bool) -> Card {
    let path = s(t, "path");
    let mut c = Card::new(alloc::format!("svt:{}", path), if tile { Kind::Tile } else { Kind::Svt }, String::from(s(t, "title")), Act::Svt(t.clone()));
    let (a, b) = if tile { ("poster", "wide") } else { ("wide", "poster") };
    c.img = String::from(if !s(t, a).is_empty() { s(t, a) } else { s(t, b) });
    c.back = String::from(if !s(t, "backdrop").is_empty() { s(t, "backdrop") } else { s(t, "wide") });
    c.svt = true;
    c.badge = svt_owned(cx, s(t, "title"));
    let p = pending_for_path(cx, path).or_else(|| pending_named(cx, s(t, "title")));
    c.bar = p.map(|p| p.progress.map(|x| x as f32));
    c.sub = title_sub(&year(t), s(t, "kind") == "series");
    c.hero = Some(t.clone());
    c
}
pub fn see_all_card(kind: Kind, tag: u32) -> Card {
    let mut c = Card::new(String::from("~see-all"), kind, String::from(t!("See all")), Act::Local(tag));
    c.see_all = true;
    c
}
pub fn genre_card(name: &str, n: usize, tag: u32) -> Card {
    Card::new(alloc::format!("genre:{}", name), Kind::Genre((n % 6) as u8), String::from(name), Act::Local(tag))
}

// ---------- drawing a card ----------
const GENRE_FROM: [u32; 6] = [0x7A3B1E, 0x6A2741, 0x7A5A1C, 0x4B2C5F, 0x7A2A2A, 0x3E3A5A];

pub fn draw_card(cx: &mut Cx, c: &Card, x: f32, y: f32, lit: f32) {
    let (w, h) = c.kind.size();
    let base = rect(x, y, w, h);
    let r = base.scale(1.0 + 0.06 * lit);
    let radius = 16.0;
    ui::shadow(cx, r, radius, 18.0 + 30.0 * lit, 0.3 + 0.25 * lit);
    ui::focus_ring(cx, r, radius, lit);
    if let Kind::Genre(n) = c.kind {
        let from = crate::gfx::hex(GENRE_FROM[n as usize % 6]);
        cx.g.round_diag(r, radius, from, ui::CURTAIN);
        let f = display(36.0 * (1.0 + 0.06 * lit), 800);
        let lines = cx.tx.wrap(f, &c.title, r.w - 52.0, 2);
        let lh = f.size * 1.05;
        let mut ly = r.b() - 22.0 - lines.len() as f32 * lh - (f.line() - lh) / 2.0;
        for l in &lines {
            cx.tx.draw(&mut cx.g, f, l, r.x + 26.0, ly, ui::PAPER);
            ly += lh;
        }
        cx.g.ring(r, radius, 1.0, hexa(0xF6EADF, 0.08));
        return;
    }
    if c.see_all {
        cx.g.round(r, radius, hexa(0x2B1724, 0.9));
        cx.g.ring(r, radius, 2.0, ui::HAIR.alpha(1.0 - lit));
        let f = body(28.0, 700);
        let lh = f.line();
        cx.tx.draw_center(&mut cx.g, f, &c.title, r.x + r.w / 2.0, r.y + (r.h - lh) / 2.0, ui::DUST.mix(ui::PAPER, lit));
        return;
    }
    let shown = ui::picture(cx, &c.img, r, radius, Some(ui::SEAT), 1.0);
    if !shown {
        // No picture (yet): the title, quietly, so the card is never just a blank box.
        let f = display(26.0, 700);
        let lines = cx.tx.wrap(f, &c.title, r.w - 36.0, 3);
        let mut ly = r.y + r.h / 2.0 - lines.len() as f32 * 17.0;
        for l in &lines {
            cx.tx.draw_center(&mut cx.g, f, l, r.x + r.w / 2.0, ly, ui::DUST.alpha(0.55));
            ly += 34.0;
        }
    }
    if c.svt {
        let f = body(18.0, 700);
        let tw = cx.tx.width(f, "SVT Play");
        let b = rect(r.x + 12.0, r.y + 12.0, tw + 20.0, 34.0);
        cx.g.round(b, 8.0, hexa(0x093A24, 0.94));
        cx.tx.draw(&mut cx.g, f, "SVT Play", b.x + 10.0, b.y + (34.0 - f.line()) / 2.0, ui::WHITE);
    }
    if c.badge {
        let f = body(18.0, 700);
        let label = t!("In library");
        let tw = cx.tx.width(f, label);
        let b = rect(r.x + 12.0, r.b() - 12.0 - 34.0, tw + 20.0, 34.0);
        cx.g.round(b, 8.0, hexa(0x1F1019, 0.92));
        cx.tx.draw(&mut cx.g, f, label, b.x + 10.0, b.y + (34.0 - f.line()) / 2.0, ui::BULB);
    }
    if !c.pct.is_empty() {
        let f = body(24.0, 700);
        let tw = cx.tx.width(f, &c.pct);
        let b = rect(r.r() - 10.0 - tw - 20.0, r.b() - 18.0 - 36.0, tw + 20.0, 36.0);
        cx.g.round(b, 8.0, hexa(0x000000, 0.65));
        cx.tx.draw(&mut cx.g, f, &c.pct, b.x + 10.0, b.y + (36.0 - f.line()) / 2.0, ui::PAPER);
    }
    if let Some(p) = c.bar {
        // A soft dark floor under the bar so it reads on bright pictures.
        cx.g.vgrad(rect(r.x, r.b() - 60.0, r.w, 60.0), &[(0.0, hexa(0x000000, 0.0)), (1.0, hexa(0x000000, 0.45))]);
        ui::bar(cx, rect(r.x + 12.0, r.b() - 17.0, r.w - 24.0, 7.0), p, hexa(0xFFFFFF, 0.28));
    }
    cx.g.ring(r, radius, 1.0, hexa(0xF6EADF, 0.08));
    let (nf, sf, gap) = c.kind.fonts();
    let ty = base.b() + gap + 6.0 * lit;
    let name_c = ui::PAPER.mix(ui::WHITE, lit);
    cx.tx.draw_fit(&mut cx.g, nf, &c.title, x, ty, w, name_c);
    if !c.sub.is_empty() {
        cx.tx.draw_fit(&mut cx.g, sf, &c.sub, x, ty + nf.line(), w, ui::DUST);
    }
}

// ---------- rows ----------
#[derive(Clone)]
pub enum Fetch {
    List(String),
    /// TMDB genre (film genre, show genre) for a type ("all", "movie", "tv").
    Genre(Option<i64>, Option<i64>, &'static str),
    Docs(String, bool),
}
impl Fetch {
    pub fn url(&self, page: u32) -> String {
        match self {
            Fetch::List(k) => alloc::format!("/api/discover/list?key={}&page={}", crate::util::enc(k), page),
            Fetch::Genre(m, tv, ty) => genre_url(*m, *tv, ty, "popular", page),
            Fetch::Docs(c, _) => docs_url(c, "all", "popular", page),
        }
    }
    pub fn parse(&self, cx: &mut Cx, d: &Value, page: u32) -> (Vec<Card>, bool) {
        let last = i(d, "page").unwrap_or(page as i64) >= i(d, "totalPages").unwrap_or(1);
        let cards = match self {
            Fetch::Docs(_, _) => docs_cards(cx, arr(d, "results"), true),
            _ => arr(d, "results").iter().map(|t| title_card(cx, t)).collect(),
        };
        (cards, last)
    }
}
pub fn genre_url(movie: Option<i64>, tv: Option<i64>, ty: &str, sort: &str, page: u32) -> String {
    let mut u = alloc::format!("/api/discover/genre?type={}", ty);
    if let (Some(m), true) = (movie, ty != "tv") {
        if m != 0 {
            u.push_str(&alloc::format!("&movie={}", m));
        }
    }
    if let (Some(t), true) = (tv, ty != "movie") {
        if t != 0 {
            u.push_str(&alloc::format!("&tv={}", t));
        }
    }
    u.push_str(&alloc::format!("&sort={}&page={}", sort, page));
    u
}
pub fn docs_url(id: &str, ty: &str, sort: &str, page: u32) -> String {
    alloc::format!("/api/docs/category?id={}&type={}&sort={}&page={}", crate::util::enc(id), ty, sort, page)
}
pub fn docs_cards(cx: &mut Cx, items: &[Value], wide: bool) -> Vec<Card> {
    items.iter().map(|t| if s(t, "type") == "svt" { svt_card(cx, t, !wide) } else { title_card(cx, t) }).collect()
}

pub struct Row {
    pub title: String,
    pub kind: Kind,
    pub cards: Vec<Card>,
    pub index: usize,
    pub scroll: Ease,
    pub fetch: Option<Fetch>,
    pub page: u32,
    pub busy: bool,
    pub done: bool,
    pub lazy: bool,
    pub skip: bool,
    pub see_all: Option<u32>,
    seen: BTreeSet<String>,
    pub tag: u32,
}
impl Row {
    pub fn new(title: &str, kind: Kind, cards: Vec<Card>) -> Row {
        let mut r = Row {
            title: String::from(title),
            kind,
            cards: Vec::new(),
            index: 0,
            scroll: Ease::at(0.0),
            fetch: None,
            page: 1,
            busy: false,
            done: true,
            lazy: false,
            skip: false,
            see_all: None,
            seen: BTreeSet::new(),
            tag: 0,
        };
        r.add(cards);
        r
    }
    /// A row that grows as you move along it.
    pub fn growing(title: &str, kind: Kind, cards: Vec<Card>, fetch: Fetch, see_all: Option<u32>) -> Row {
        let mut r = Row::new(title, kind, Vec::new());
        r.fetch = Some(fetch);
        r.done = false;
        r.see_all = see_all;
        r.add_end();
        r.add(cards);
        r
    }
    /// A row that loads its first page when it comes near the screen.
    pub fn lazy(title: &str, kind: Kind, fetch: Fetch, see_all: Option<u32>) -> Row {
        let mut r = Row::new(title, kind, Vec::new());
        r.fetch = Some(fetch);
        r.done = false;
        r.lazy = true;
        r.page = 0;
        r.see_all = see_all;
        r
    }
    fn add_end(&mut self) {
        if let Some(tag) = self.see_all {
            if !self.cards.iter().any(|c| c.see_all) {
                let k = if matches!(self.kind, Kind::Tile | Kind::Svt) { self.kind } else { Kind::Poster };
                self.cards.push(see_all_card(k, tag));
            }
        }
    }
    pub fn count(&self) -> usize {
        self.cards.iter().filter(|c| !c.see_all).count()
    }
    pub fn add(&mut self, cards: Vec<Card>) {
        let has_end = self.cards.last().map(|c| c.see_all).unwrap_or(false);
        let mut n = self.count();
        for c in cards {
            if n >= ROW_MAX || !self.seen.insert(c.key.clone()) {
                continue;
            }
            if has_end {
                let at = self.cards.len() - 1;
                self.cards.insert(at, c);
            } else {
                self.cards.push(c);
            }
            n += 1;
        }
        if n >= ROW_MAX {
            self.done = true;
        }
    }
    pub fn step(&self) -> f32 {
        self.kind.size().0 + CARD_GAP
    }
}

/// Up/Down between rows, Left/Right along one.
pub struct Rows {
    pub rows: Vec<Row>,
    pub r: usize,
    pub on: bool,
    pub y: Ease,
    pub lit: Lit,
    pub seq: u32,
    /// Where the focused row's top sits, from the top of the view.
    pub top: f32,
    pub gap: f32,
    pub h2: Font,
}

pub const TAG_ROWS: u32 = 1 << 20;

impl Rows {
    pub fn new(top: f32, gap: f32, h2: Font) -> Rows {
        Rows { rows: Vec::new(), r: 0, on: true, y: Ease::at(0.0), lit: Lit::default(), seq: 0, top, gap, h2 }
    }
    pub fn set(&mut self, rows: Vec<Row>) {
        self.seq = (self.seq + 1) & 0x3ff;
        self.rows = rows;
        self.r = self.find(0, 1).unwrap_or(0);
    }
    fn find(&self, from: isize, dir: isize) -> Option<usize> {
        let mut i = from;
        while i >= 0 && (i as usize) < self.rows.len() {
            if !self.rows[i as usize].skip {
                return Some(i as usize);
            }
            i += dir;
        }
        None
    }
    pub fn current(&self) -> Option<&Card> {
        let row = self.rows.get(self.r)?;
        if row.skip {
            return None;
        }
        row.cards.get(row.index)
    }
    pub fn move_v(&mut self, dir: isize) -> bool {
        match self.find(self.r as isize + dir, dir) {
            Some(i) => {
                self.r = i;
                true
            }
            None => false,
        }
    }
    pub fn side(&mut self, dir: isize) {
        if let Some(row) = self.rows.get_mut(self.r) {
            if row.cards.is_empty() {
                return;
            }
            row.index = (row.index as isize + dir).clamp(0, row.cards.len() as isize - 1) as usize;
        }
    }
    fn row_h(&self, row: &Row) -> f32 {
        if row.lazy && row.cards.is_empty() && !row.skip {
            return self.h2.line() + 14.0 + 36.0 + row.kind.height() + self.gap;
        }
        self.h2.line() + 14.0 + 36.0 + row.kind.height() + self.gap
    }
    /// Loads rows near the focus and the next page of the focused row. Call after every move.
    pub fn update(&mut self, cx: &mut Cx, sid: u32) {
        let lo = self.r.saturating_sub(1);
        let hi = (self.r + 3).min(self.rows.len());
        for n in lo..hi {
            let row = &mut self.rows[n];
            if row.lazy && !row.busy && !row.skip {
                row.lazy = false;
                row.busy = true;
                let url = row.fetch.as_ref().unwrap().url(1);
                cx.get(&url, sid, TAG_ROWS | (self.seq << 10) | n as u32);
            }
        }
        if let Some(row) = self.rows.get_mut(self.r) {
            let count = row.count();
            if !row.done && !row.busy && !row.lazy && row.fetch.is_some() && row.index + 8 >= count {
                row.busy = true;
                let url = row.fetch.as_ref().unwrap().url(row.page + 1);
                cx.get(&url, sid, TAG_ROWS | (self.seq << 10) | self.r as u32);
            }
        }
        cx.redraw();
    }
    /// A page for one of the rows arrived. True when the tag was one of ours.
    pub fn on_page(&mut self, cx: &mut Cx, sid: u32, tag: u32, res: &Res) -> bool {
        if tag & TAG_ROWS == 0 {
            return false;
        }
        if (tag >> 10) & 0x3ff != self.seq {
            return true;
        }
        let n = (tag & 0x3ff) as usize;
        let Some(row) = self.rows.get_mut(n) else { return true };
        row.busy = false;
        if !res.ok() {
            if row.page == 0 {
                row.skip = true;
            }
            row.done = true;
        } else {
            let fetch = row.fetch.clone().unwrap();
            let page = row.page + 1;
            let (cards, last) = fetch.parse(cx, &res.json, page);
            let row = &mut self.rows[n];
            let first = row.page == 0;
            row.page = page;
            let before = row.cards.len();
            if first {
                row.add_end();
            }
            row.add(cards);
            if last || (!first && row.cards.len() == before) {
                row.done = true;
            }
            if row.count() == 0 {
                row.skip = true;
            }
        }
        if self.rows.get(self.r).map(|r| r.skip).unwrap_or(false) {
            if let Some(i) = self.find(self.r as isize, 1).or_else(|| self.find(self.r as isize, -1)) {
                self.r = i;
            }
        }
        self.update(cx, sid);
        true
    }

    /// Draws the rows inside `view`, the focused one `top` px down.
    pub fn draw(&mut self, cx: &mut Cx, view: Rect) {
        let mut ys: Vec<f32> = Vec::with_capacity(self.rows.len());
        let mut y = 0.0;
        for row in &self.rows {
            ys.push(y);
            if !row.skip {
                y += self.row_h(row);
            }
        }
        let target = if self.on { (ys.get(self.r).copied().unwrap_or(0.0) - self.top).max(0.0) } else { 0.0 };
        self.y.set(target);
        let scroll = self.y.step(cx, 13.0);
        let focus = if self.on { self.current().map(|c| c.hash()) } else { None };
        match focus {
            Some(k) => self.lit.focus(k),
            None => self.lit.none(),
        }
        self.lit.step(cx);
        cx.g.push_clip(view);
        for (n, row) in self.rows.iter_mut().enumerate() {
            if row.skip {
                continue;
            }
            let ry = view.y + ys[n] - scroll;
            let rh = self.h2.line() + 14.0 + 36.0 + row.kind.height() + self.gap;
            if ry > view.b() + 40.0 || ry + rh < view.y - 40.0 {
                continue;
            }
            cx.tx.draw(&mut cx.g, self.h2, &row.title, ui::EDGE, ry, ui::PAPER);
            let art_y = ry + self.h2.line() + 14.0 + 18.0;
            if row.cards.is_empty() {
                if row.busy || row.lazy {
                    ui::loading(cx, ui::EDGE + 140.0, art_y + 80.0, t!("Loading…"));
                }
                continue;
            }
            let stepw = row.step();
            let visible = libm::floorf(ROW_WIDTH / stepw).max(1.0) as usize;
            let first = row.index.saturating_sub(1).min(row.cards.len().saturating_sub(visible));
            row.scroll.set(first as f32 * stepw);
            let sx = row.scroll.step(cx, 14.0);
            let lo = libm::floorf(sx / stepw).max(0.0) as usize;
            let hi = (lo + visible + 2).min(row.cards.len());
            for k in lo..hi {
                let c = &row.cards[k];
                let x = ui::EDGE + k as f32 * stepw - sx;
                let lit = self.lit.get(c.hash());
                if lit > 0.0 {
                    continue; // drawn last, over its neighbours
                }
                draw_card(cx, c, x, art_y, 0.0);
            }
            for k in lo..hi {
                let c = &row.cards[k];
                let lit = self.lit.get(c.hash());
                if lit > 0.0 {
                    let x = ui::EDGE + k as f32 * stepw - sx;
                    draw_card(cx, c, x, art_y, lit);
                }
            }
            // The next few pictures start loading before they scroll in.
            for c in row.cards.iter().skip(hi).take(3) {
                if !c.img.is_empty() {
                    let _ = cx.picture(&c.img);
                }
            }
        }
        cx.g.pop_clip();
    }
}

// ---------- grids ----------
pub struct Grid {
    pub cols: usize,
    pub cards: Vec<Card>,
    pub i: usize,
    pub scroll: Ease,
    pub lit: Lit,
    seen: BTreeSet<String>,
    pub step_x: f32,
    pub step_y: f32,
}
impl Grid {
    pub fn new(cols: usize, kind: Kind) -> Grid {
        let (w, _) = kind.size();
        Grid { cols, cards: Vec::new(), i: 0, scroll: Ease::at(0.0), lit: Lit::default(), seen: BTreeSet::new(), step_x: w + 20.0, step_y: kind.height() + 30.0 }
    }
    pub fn clear(&mut self) {
        self.cards.clear();
        self.seen.clear();
        self.i = 0;
        self.scroll.jump(0.0);
    }
    pub fn add(&mut self, cards: Vec<Card>) {
        for c in cards {
            if self.seen.insert(c.key.clone()) {
                self.cards.push(c);
            }
        }
    }
    pub fn current(&self) -> Option<&Card> {
        self.cards.get(self.i)
    }
    /// False at an edge, so the screen can move focus elsewhere.
    pub fn go(&mut self, code: i32) -> bool {
        let n = self.cards.len();
        let cols = self.cols;
        let i = self.i;
        let col = i % cols;
        let next = match code {
            crate::key::LEFT if col > 0 => i - 1,
            crate::key::RIGHT if col + 1 < cols && i + 1 < n => i + 1,
            crate::key::UP if i >= cols => i - cols,
            crate::key::DOWN if n > 0 && i / cols < (n - 1) / cols => (i + cols).min(n - 1),
            _ => return false,
        };
        self.i = next;
        true
    }
    /// True when the focus is within a couple of rows of the end (time to ask for more).
    pub fn near_end(&self) -> bool {
        !self.cards.is_empty() && self.i / self.cols + 2 >= (self.cards.len() - 1) / self.cols
    }
    pub fn draw(&mut self, cx: &mut Cx, view: Rect, on: bool) {
        let row = self.i / self.cols;
        self.scroll.set(if row > 0 { (row - 1) as f32 * self.step_y } else { 0.0 });
        let sy = self.scroll.step(cx, 13.0);
        match (on, self.cards.get(self.i)) {
            (true, Some(c)) => self.lit.focus(c.hash()),
            _ => self.lit.none(),
        }
        self.lit.step(cx);
        cx.g.push_clip(rect(view.x - 40.0, view.y, view.w + 80.0, view.h));
        let first_row = libm::floorf((sy - 40.0).max(0.0) / self.step_y) as usize;
        let rows_vis = libm::ceilf(view.h / self.step_y) as usize + 2;
        let lo = first_row * self.cols;
        let hi = ((first_row + rows_vis) * self.cols).min(self.cards.len());
        let mut lit_one: Option<(usize, f32)> = None;
        for k in lo..hi {
            let c = &self.cards[k];
            let lit = self.lit.get(c.hash());
            let x = view.x + (k % self.cols) as f32 * self.step_x;
            let y = view.y + 18.0 + (k / self.cols) as f32 * self.step_y - sy;
            if lit > 0.0 {
                lit_one = Some((k, lit));
                continue;
            }
            draw_card(cx, c, x, y, 0.0);
        }
        // Several can be lit while focus moves; draw all of them on top.
        for k in lo..hi {
            let c = &self.cards[k];
            let lit = self.lit.get(c.hash());
            if lit > 0.0 && Some(k) != lit_one.map(|x| x.0) {
                draw_card(cx, c, view.x + (k % self.cols) as f32 * self.step_x, view.y + 18.0 + (k / self.cols) as f32 * self.step_y - sy, lit);
            }
        }
        if let Some((k, lit)) = lit_one {
            let c = &self.cards[k];
            draw_card(cx, c, view.x + (k % self.cols) as f32 * self.step_x, view.y + 18.0 + (k / self.cols) as f32 * self.step_y - sy, lit);
        }
        cx.g.pop_clip();
    }
}

/// Opens what a card points at. False for cards the screen handles itself.
pub fn open(cx: &mut Cx, c: &Card) -> bool {
    match &c.act {
        Act::Title(t) => {
            let s = super::title::TitleScreen::new(cx, t.clone());
            cx.push(alloc::boxed::Box::new(s));
        }
        Act::Show(sid) => {
            if let Some(sh) = cx.state.show(sid).cloned() {
                let s = super::show::ShowScreen::new(cx, sh);
                cx.push(alloc::boxed::Box::new(s));
            }
        }
        Act::Film(fid) => {
            if let Some(file) = cx.state.file(fid).cloned() {
                super::player::play_asked(cx, &file, false);
            }
        }
        Act::Resume(fid, at) => {
            if let Some(file) = cx.state.file(fid).cloned() {
                super::player::play(cx, &file, *at, false);
            }
        }
        Act::Pending(key) => {
            let Some(p) = cx.state.pending.iter().find(|p| &p.key == key).cloned() else { return true };
            if p.tv {
                if let Some(sh) = cx.state.show(&p.show_id).cloned() {
                    let s = super::show::ShowScreen::new(cx, sh);
                    cx.push(alloc::boxed::Box::new(s));
                    return true;
                }
            }
            let path = p.items.first().map(|d| String::from(s(d, "svtPath"))).unwrap_or_default();
            if !path.is_empty() {
                let v = serde_json::json!({ "type": "svt", "path": path, "title": p.title, "backdrop": p.backdrop, "kind": if p.tv { "series" } else { "film" } });
                let s = super::svt::SvtScreen::new(cx, v);
                cx.push(alloc::boxed::Box::new(s));
                return true;
            }
            if !p.tmdb_id.is_empty() {
                let idv: Value = p.tmdb_id.parse::<i64>().map(Value::from).unwrap_or(Value::from(p.tmdb_id.clone()));
                let v = serde_json::json!({ "type": if p.tv { "tv" } else { "movie" }, "id": idv, "title": p.title, "poster": p.poster, "backdrop": p.backdrop, "year": p.year.parse::<i64>().ok() });
                let s = super::title::TitleScreen::new(cx, v);
                cx.push(alloc::boxed::Box::new(s));
                return true;
            }
            cx.toast(&p.word);
        }
        Act::Svt(t) => {
            let s = super::svt::SvtScreen::new(cx, t.clone());
            cx.push(alloc::boxed::Box::new(s));
        }
        Act::Local(_) => return false,
        Act::Nothing => {}
    }
    true
}

/// Hero text for a title: "2024 · Film · ★ 8 · Drama · Crime".
pub fn hero_meta(cx: &Cx, t: &Value, docs: bool) -> String {
    let tv = s(t, "type") == "tv" || s(t, "kind") == "series";
    let y = year(t);
    let mut parts: Vec<String> = Vec::new();
    if !y.is_empty() {
        parts.push(y);
    }
    parts.push(String::from(type_word(tv)));
    if docs && s(t, "type") == "svt" {
        parts.push(String::from(t!("Free on SVT Play")));
    }
    if let Some(r) = f(t, "rating") {
        if r > 0.0 {
            parts.push(alloc::format!("★ {}", fmt_rating(r)));
        }
    }
    if !docs {
        for g in cx.state.genre_names(tv, arr(t, "genres")).into_iter().take(3) {
            parts.push(g);
        }
    }
    parts.join("  ·  ")
}
pub fn fmt_rating(r: f64) -> String {
    if libm::floor(r) == r {
        (r as i64).to_string()
    } else {
        alloc::format!("{:.1}", r)
    }
}

/// The colour a card title has against `bg` when not focused.
pub fn dim(c: Rgba) -> Rgba {
    c.alpha(0.86)
}
