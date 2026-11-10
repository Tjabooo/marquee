//! Home: Continue watching, what's on its way, Shows, Films, then the library by genre.
use super::browse::{self, Kind, Row, Rows};
use crate::gfx::{rect, SCREEN};
use crate::host;
use crate::logic;
use crate::text::{body, display};
use crate::ui::{self, Ambient, Lit};
use crate::util::s;
use crate::{key, t, Cx, Key, Nav, Res, Screen, TOKEN_KEY};
use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

const RELOADED: u32 = 1;
const WATCH_T: u32 = 2;
const PENDING_IN: u32 = 3;

pub struct Home {
    sid: u32,
    rows: Rows,
    at_top: bool,
    ti: usize,
    empty: bool,
    watch: u32,
    before: String,
    tops_lit: Lit,
    amb: Ambient,
    waiting: u32,
}

fn tops() -> [&'static str; 4] {
    [t!("Search"), t!("Discover"), t!("Documentaries"), t!("Switch account")]
}

impl Home {
    pub fn new(cx: &mut Cx) -> Home {
        let sid = cx.sid();
        let mut h = Home {
            sid,
            rows: Rows::new(40.0, 44.0, display(38.0, 700)),
            at_top: false,
            ti: 1,
            empty: false,
            watch: 0,
            before: String::new(),
            tops_lit: Lit::default(),
            amb: Ambient::default(),
            waiting: 0,
        };
        h.build(cx);
        h.watch_pending(cx);
        h
    }
    fn build(&mut self, cx: &mut Cx) {
        // Coming back from the player rebuilds the rows: keep the row and the card you were on.
        let mut was: BTreeMap<String, usize> = BTreeMap::new();
        for r in &self.rows.rows {
            was.insert(r.title.clone(), r.index);
        }
        let was_row = self.rows.rows.get(self.rows.r).map(|r| r.title.clone());
        let mut rows: Vec<Row> = Vec::new();
        let (cont, shows, films): (Vec<browse::Card>, Vec<browse::Card>, Vec<browse::Card>) = {
            let st = &cx.state;
            let data = logic::home_rows(&st.library, &st.shows, &st.progress);
            let cont = data.cont.iter().filter_map(|f| browse::continue_card(cx, f)).collect();
            let shows = data.shows.iter().map(|sh| (*sh).clone()).collect::<Vec<_>>();
            let films = data.films.iter().map(|f| browse::film_card(f, Kind::Poster)).collect();
            let shows = shows.iter().map(|sh| browse::show_card(cx, sh, Kind::Poster)).collect();
            (cont, shows, films)
        };
        if !cont.is_empty() {
            rows.push(Row::new(t!("Continue watching"), Kind::Wide, cont));
        }
        let on_way = t!("On its way");
        if !cx.state.pending.is_empty() {
            let cards = cx.state.pending.iter().map(browse::pending_card).collect();
            rows.push(Row::new(on_way, Kind::Poster, cards));
        }
        if !shows.is_empty() {
            rows.push(Row::new(t!("Shows"), Kind::Poster, shows));
        }
        if !films.is_empty() {
            rows.push(Row::new(t!("Films"), Kind::Poster, films));
        }
        let genre_rows: Vec<(String, Vec<browse::Card>)> = {
            let st = &cx.state;
            logic::genre_rows(&st.library, &st.shows, &st.genres)
                .into_iter()
                .map(|g| {
                    let cards = g
                        .titles
                        .iter()
                        .map(|t| match t {
                            logic::GenreTitle::Show(sh) => browse::show_card(cx, sh, Kind::Poster),
                            logic::GenreTitle::Film(f) => browse::film_card(f, Kind::Poster),
                        })
                        .collect();
                    (g.name, cards)
                })
                .collect()
        };
        for (name, cards) in genre_rows {
            rows.push(Row::new(&name, Kind::Poster, cards));
        }
        self.rows.set(rows);
        for (i, row) in self.rows.rows.iter_mut().enumerate() {
            if let Some(n) = was.get(&row.title) {
                row.index = (*n).min(row.cards.len().saturating_sub(1));
            }
            if Some(&row.title) == was_row.as_ref() {
                self.rows.r = i;
            }
        }
        if cx.state.focus_pending {
            cx.state.focus_pending = false;
            if let Some(i) = self.rows.rows.iter().position(|r| r.title == on_way) {
                self.rows.r = i;
                self.rows.rows[i].index = 0;
                self.at_top = false;
            }
        }
        self.empty = self.rows.rows.is_empty();
        if self.empty {
            self.at_top = true;
        }
        self.rows.on = !self.at_top;
        cx.redraw();
    }
    fn pending_keys(cx: &Cx) -> String {
        let v: Vec<&str> = cx.state.pending.iter().map(|p| p.key.as_str()).collect();
        v.join(",")
    }
    /// Keeps the row of what's on its way current while Home is on screen.
    fn watch_pending(&mut self, cx: &mut Cx) {
        cx.cancel(self.watch);
        let ms = if cx.state.pending.is_empty() { 30000.0 } else { 5000.0 };
        self.watch = cx.timer(ms, self.sid, WATCH_T);
    }
    fn reload(&mut self, cx: &mut Cx) {
        self.waiting = if cx.state.genres.is_empty() { 2 } else { 1 };
        cx.load_library(Some((self.sid, RELOADED)));
        if cx.state.genres.is_empty() {
            cx.load_genres(Some((self.sid, RELOADED)));
        }
    }
}

impl Screen for Home {
    fn sid(&self) -> u32 {
        self.sid
    }
    fn is_home(&self) -> bool {
        true
    }
    fn draw(&mut self, cx: &mut Cx) {
        ui::room(cx);
        // The focused title's backdrop, softly, top right: the room takes on its colour.
        let back = if self.at_top { String::new() } else { self.rows.current().map(|c| c.back.clone()).unwrap_or_default() };
        self.amb.want(cx, &back);
        self.amb.step(cx, 260.0);
        let art = rect(520.0, 0.0, 1400.0, 788.0);
        let shape = |x: f32, y: f32| ui::smooth(0.0, 0.55, x) * (1.0 - ui::smooth(0.35, 1.0, y)) * (0.55 + 0.45 * x);
        self.amb.draw_with(cx, art, 0.4, Some(&shape));

        let view = rect(0.0, 160.0, 1920.0, 920.0);
        self.rows.on = !self.at_top;
        self.rows.draw(cx, view);
        if self.empty {
            let h = display(64.0, 800);
            cx.tx.draw(&mut cx.g, h, t!("Your library is empty"), ui::EDGE, 300.0, ui::PAPER);
            cx.tx.para(&mut cx.g, body(34.0, 400), t!("Open Discover or Search above to find something to download."), ui::EDGE, 400.0, 1100.0, 3, 44.0, ui::DUST);
        }

        // The bar: the rows slide away under it.
        cx.g.vgrad(rect(0.0, 0.0, 1920.0, 176.0), &[(0.0, ui::VELVET), (0.85, ui::VELVET.alpha(0.96)), (1.0, ui::VELVET.alpha(0.0))]);
        ui::wordmark(cx, ui::EDGE, 66.0, 46.0);
        let f = body(26.0, 700);
        let labels = tops();
        let mut ws = [0.0f32; 4];
        for (n, l) in labels.iter().enumerate() {
            ws[n] = ui::pill_w(cx, l, f, 26.0, 0.0);
        }
        let name = String::from(s(&cx.state.me, "name"));
        let shared = shared_note(cx);
        let who = body(26.0, 400);
        let name_w = cx.tx.width(who, &name);
        let shared_w = if shared.is_empty() { 0.0 } else { cx.tx.width(who, &shared) + 28.0 };
        let mut x = 1920.0 - ui::EDGE - ws[3];
        let switch_x = x;
        x -= 28.0 + shared_w + name_w;
        let name_x = x;
        x -= 44.0;
        let mut xs = [0.0f32; 3];
        for n in (0..3).rev() {
            x -= ws[n];
            xs[n] = x;
            x -= 18.0;
        }
        let focus = if self.at_top { ui::hash(labels[self.ti]) } else { 0 };
        if focus != 0 {
            self.tops_lit.focus(focus);
        } else {
            self.tops_lit.none();
        }
        self.tops_lit.step(cx);
        let y = 56.0;
        for n in 0..3 {
            let lit = self.tops_lit.get(ui::hash(labels[n]));
            ui::pill(cx, rect(xs[n], y, ws[n], 58.0), labels[n], f, ui::Pill::Quiet, lit);
        }
        cx.tx.draw(&mut cx.g, who, &name, name_x, y + (58.0 - who.line()) / 2.0, ui::DUST);
        if !shared.is_empty() {
            cx.tx.draw(&mut cx.g, who, &shared, name_x + name_w + 28.0, y + (58.0 - who.line()) / 2.0, ui::DUST.alpha(0.8));
        }
        let lit = self.tops_lit.get(ui::hash(labels[3]));
        ui::pill(cx, rect(switch_x, y, ws[3], 58.0), labels[3], body(25.0, 700), ui::Pill::Quiet, lit);
        let _ = SCREEN;
    }
    fn key(&mut self, cx: &mut Cx, k: Key) -> bool {
        cx.redraw();
        if self.at_top {
            match k.code {
                key::LEFT => self.ti = self.ti.saturating_sub(1),
                key::RIGHT => self.ti = (self.ti + 1).min(3),
                key::DOWN => {
                    if !self.empty {
                        self.at_top = false;
                    }
                }
                key::ENTER => {
                    match self.ti {
                        0 => {
                            let s = super::search::Search::new(cx);
                            cx.push(Box::new(s));
                        }
                        1 => {
                            let s = super::discover::Discover::new(cx);
                            cx.push(Box::new(s));
                        }
                        2 => {
                            let s = super::discover::Docs::new(cx);
                            cx.push(Box::new(s));
                        }
                        _ => {
                            host::forget(TOKEN_KEY);
                            let p = super::pair::Pair::new(cx, true, None);
                            cx.nav.push(Nav::Reset(Box::new(p)));
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
                }
            }
            key::DOWN => {
                self.rows.move_v(1);
            }
            key::LEFT => self.rows.side(-1),
            key::RIGHT => self.rows.side(1),
            key::ENTER => {
                if let Some(c) = self.rows.current().cloned() {
                    browse::open(cx, &c);
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
        match tag {
            RELOADED => {
                self.waiting = self.waiting.saturating_sub(1);
                if self.waiting == 0 {
                    self.build(cx);
                    self.watch_pending(cx);
                }
            }
            PENDING_IN => {
                if cx.top != self.sid {
                    self.watch_pending(cx);
                    return;
                }
                if Self::pending_keys(cx) != self.before {
                    self.reload(cx);
                    return;
                }
                let on_way = t!("On its way");
                if let Some(row) = self.rows.rows.iter_mut().find(|r| r.title == on_way) {
                    for (n, p) in cx.state.pending.iter().enumerate() {
                        if let Some(c) = row.cards.get_mut(n) {
                            browse::update_pending_card(c, p);
                        }
                    }
                }
                cx.redraw();
                self.watch_pending(cx);
            }
            _ => {}
        }
    }
    fn on_timer(&mut self, cx: &mut Cx, tag: u32) {
        if tag == WATCH_T {
            if cx.top != self.sid {
                self.watch_pending(cx);
                return;
            }
            self.before = Self::pending_keys(cx);
            cx.load_pending(Some((self.sid, PENDING_IN)));
        }
    }
    fn refresh(&mut self, cx: &mut Cx) {
        self.reload(cx);
    }
    fn leave(&mut self, cx: &mut Cx) {
        cx.cancel(self.watch);
    }
}

/// "Shared with Anna and Per" when the library is shared (Settings → People on the web).
fn shared_note(cx: &Cx) -> String {
    let mates: Vec<&str> = crate::util::arr(&cx.state.me, "sharedWith").iter().map(|m| s(m, "name")).filter(|n| !n.is_empty()).collect();
    if mates.is_empty() {
        return String::new();
    }
    let names = if mates.len() < 2 {
        String::from(mates[0])
    } else {
        t!("{0} and {1}", mates[..mates.len() - 1].join(", "), mates[mates.len() - 1])
    };
    t!("Shared with {0}", names)
}
