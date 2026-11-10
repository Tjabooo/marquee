//! Marquee's look on the TV (docs/design/revamp.md): a velvet room lit from above, Bricolage Grotesque for
//! titles, the gold bulb for focus and progress only. Shared pieces every screen draws with.
use crate::gfx::{hex, hexa, rect, Rect, Rgba, SCREEN};
use crate::img;
use crate::text::{body, display, Font};
use crate::Cx;
use alloc::collections::BTreeMap;

pub const VELVET: Rgba = hex(0x1F1019);
pub const DEEP: Rgba = hex(0x160B12);
pub const CURTAIN: Rgba = hex(0x2B1724);
pub const SEAT: Rgba = hex(0x3A2031);
pub const LINE: Rgba = hex(0x4B2C3F);
pub const PAPER: Rgba = hex(0xF6EADF);
pub const DUST: Rgba = hex(0xBA9DAD);
pub const BULB: Rgba = hex(0xF4C152);
pub const BULB_DIM: Rgba = hex(0x9C7A33);
pub const ON_BULB: Rgba = hex(0x1F1019);
pub const ALERT: Rgba = hex(0xFF9B85);
pub const WHITE: Rgba = hex(0xFFFFFF);
pub const HAIR: Rgba = hexa(0xF6EADF, 0.1);
pub const PANEL: Rgba = hexa(0x2B1724, 0.92);
pub const EDGE: f32 = 96.0;

pub const F_BODY: Font = body(30.0, 400);

/// Eases toward a target; frames keep coming until it gets there.
#[derive(Clone, Copy, Default)]
pub struct Ease {
    pub v: f32,
    pub to: f32,
}
impl Ease {
    pub fn at(v: f32) -> Ease {
        Ease { v, to: v }
    }
    pub fn set(&mut self, to: f32) {
        self.to = to;
    }
    pub fn jump(&mut self, to: f32) {
        self.v = to;
        self.to = to;
    }
    /// Steps and returns the value. `speed`: higher is snappier (14 ≈ 0.25 s).
    pub fn step(&mut self, cx: &mut Cx, speed: f32) -> f32 {
        let d = self.to - self.v;
        if libm::fabsf(d) < 0.35 && libm::fabsf(d) < libm::fabsf(self.to) * 0.002 + 0.35 {
            self.v = self.to;
        } else {
            self.v += d * (1.0 - libm::expf(-cx.dt * speed));
            cx.moving = true;
        }
        self.v
    }
    /// Same for values between 0 and 1 (opacity, scale amounts).
    pub fn step01(&mut self, cx: &mut Cx, speed: f32) -> f32 {
        let d = self.to - self.v;
        if libm::fabsf(d) < 0.004 {
            self.v = self.to;
        } else {
            self.v += d * (1.0 - libm::expf(-cx.dt * speed));
            cx.moving = true;
        }
        self.v
    }
}

/// How lit each recently focused thing is (0..1), so focus grows in and fades out instead of jumping.
#[derive(Default)]
pub struct Lit {
    vals: BTreeMap<u64, f32>,
    on: u64,
}
pub fn hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h | 1
}
impl Lit {
    pub fn focus(&mut self, k: u64) {
        self.on = k;
    }
    pub fn none(&mut self) {
        self.on = 0;
    }
    /// Steps every value once per frame (call before drawing).
    pub fn step(&mut self, cx: &mut Cx) {
        let a = 1.0 - libm::expf(-cx.dt * 16.0);
        let on = self.on;
        if on != 0 {
            self.vals.entry(on).or_insert(0.0);
        }
        let mut moving = false;
        self.vals.retain(|k, v| {
            let to = if *k == on { 1.0 } else { 0.0 };
            *v += (to - *v) * a;
            if libm::fabsf(to - *v) < 0.01 {
                *v = to;
            } else {
                moving = true;
            }
            *v > 0.0 || *k == on
        });
        if moving {
            cx.moving = true;
        }
    }
    pub fn get(&self, k: u64) -> f32 {
        self.vals.get(&k).copied().unwrap_or(0.0)
    }
}

/// The room: deep velvet with warm light from above. Full screen, drawn under everything.
pub fn room(cx: &mut Cx) {
    let g = &mut cx.g;
    g.vgrad(SCREEN, &[(0.0, VELVET), (1.0, DEEP)]);
    g.light(rect(960.0 - 1500.0, -160.0 - 700.0, 3000.0, 1400.0), hexa(0x3D2234, 1.0));
}

/// A row of marquee bulbs, centred on cx.
pub fn bulbs(cx: &mut Cx, mid: f32, y: f32, n: usize, lit: f32) {
    let step = 33.0;
    let x0 = mid - step * (n as f32 - 1.0) / 2.0;
    for i in 0..n {
        let x = x0 + i as f32 * step;
        let r = rect(x - 5.0, y - 5.0, 10.0, 10.0);
        cx.g.glow(r, 5.0, 16.0, BULB.alpha(0.35 * lit));
        cx.g.round(r, 5.0, BULB.alpha(lit));
    }
}

pub fn wordmark(cx: &mut Cx, x: f32, y: f32, size: f32) -> f32 {
    let f = display(size, 800).glow();
    cx.tx.draw(&mut cx.g, f, "Marquee", x, y, BULB)
}

/// The gold focus: a ring just outside `r` and a warm glow.
pub fn focus_ring(cx: &mut Cx, r: Rect, radius: f32, lit: f32) {
    if lit <= 0.0 {
        return;
    }
    cx.g.glow(r, radius, 46.0, BULB.alpha(0.40 * lit));
    cx.g.ring(r.grow(5.0), radius + 5.0, 5.0, BULB.alpha(lit));
}

pub fn shadow(cx: &mut Cx, r: Rect, radius: f32, blur: f32, a: f32) {
    cx.g.glow(r.shift(0.0, blur * 0.4), radius, blur, hexa(0x000000, a));
}

#[derive(Clone, Copy, PartialEq)]
pub enum Pill {
    Plain,
    Primary,
    Quiet,
}
/// A rounded button: gold when focused (lit 0..1), paper when it's the main action.
pub fn pill(cx: &mut Cx, r: Rect, label: &str, f: Font, kind: Pill, lit: f32) {
    let r = r.scale(1.0 + 0.04 * lit);
    let (bg, fg, border) = match kind {
        Pill::Primary => (PAPER, ON_BULB, PAPER),
        Pill::Plain => (hexa(0xF6EADF, 0.12), PAPER, hexa(0xF6EADF, 0.16)),
        Pill::Quiet => (hexa(0x2B1724, 0.9), PAPER, HAIR),
    };
    if lit > 0.0 {
        cx.g.glow(r, r.h / 2.0, 44.0, BULB.alpha(0.45 * lit));
    }
    let bg = bg.mix(BULB, lit);
    let fg = fg.mix(ON_BULB, lit);
    let border = border.mix(BULB, lit);
    cx.g.pill(r, bg);
    cx.g.ring(r, r.h / 2.0, 2.0, border);
    let w = cx.tx.width(f, label);
    let lh = f.line();
    let max = r.w - 24.0;
    if w > max {
        cx.tx.draw_fit(&mut cx.g, f, label, r.x + 12.0, r.y + (r.h - lh) / 2.0, max, fg);
    } else {
        cx.tx.draw(&mut cx.g, f, label, r.x + (r.w - w) / 2.0, r.y + (r.h - lh) / 2.0, fg);
    }
}
/// The width a pill needs for its label.
pub fn pill_w(cx: &mut Cx, label: &str, f: Font, pad: f32, min: f32) -> f32 {
    (cx.tx.width(f, label) + pad * 2.0).max(min)
}

/// A thin progress bar; `None` = nobody knows yet (a stripe moves back and forth).
pub fn bar(cx: &mut Cx, r: Rect, p: Option<f32>, track: Rgba) {
    cx.g.round(r, r.h / 2.0, track);
    match p {
        Some(p) => {
            let w = r.w * p.clamp(0.0, 1.0);
            if w > 0.5 {
                cx.g.round(rect(r.x, r.y, w.max(r.h), r.h), r.h / 2.0, BULB);
            }
        }
        None => {
            let phase = (cx.now / 1800.0) % 2.0;
            let t = if phase > 1.0 { 2.0 - phase } else { phase } as f32;
            let t = t * t * (3.0 - 2.0 * t);
            let w = r.w * 0.3;
            cx.g.push_clip(r);
            cx.g.round(rect(r.x + (r.w - w) * t, r.y, w, r.h), r.h / 2.0, BULB);
            cx.g.pop_clip();
            cx.ambient = true;
        }
    }
}

/// A picture covering `r`, rounded, fading in when it arrives. Placeholder: `bg` (None = nothing).
pub fn picture(cx: &mut Cx, url: &str, r: Rect, radius: f32, bg: Option<Rgba>, alpha: f32) -> bool {
    if let Some(bg) = bg {
        cx.g.round(r, radius, bg.alpha(alpha));
    }
    if url.is_empty() || !cx.g.visible(&r) {
        return false;
    }
    match cx.picture(url) {
        Some(p) => {
            let uv = img::cover(p.w, p.h, r.w, r.h);
            cx.g.image(p.id, r, uv, radius, WHITE.alpha(p.fade * alpha));
            true
        }
        None => false,
    }
}
/// A big backdrop anchored to the top (faces stay in).
pub fn backdrop(cx: &mut Cx, url: &str, r: Rect, alpha: f32) -> bool {
    if url.is_empty() {
        return false;
    }
    match cx.picture(url) {
        Some(p) => {
            let uv = img::cover_top(p.w, p.h, r.w, r.h);
            cx.g.image(p.id, r, uv, 0.0, WHITE.alpha(p.fade * alpha));
            true
        }
        None => false,
    }
}
/// A backdrop that melts into the room: `alpha(x, y)` over the box (0..1 each way).
pub fn backdrop_fade(cx: &mut Cx, url: &str, r: Rect, alpha: f32, shape: &dyn Fn(f32, f32) -> f32) -> bool {
    if url.is_empty() {
        return false;
    }
    match cx.picture(url) {
        Some(p) => {
            let uv = img::cover_top(p.w, p.h, r.w, r.h);
            cx.g.image_fade(p.id, r, uv, WHITE.alpha(p.fade * alpha), 8, 6, shape);
            true
        }
        None => false,
    }
}
/// Smooth 0→1 between a and b.
pub fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// A picture fitted inside `r` (logo art), top-left aligned. Returns the box it took.
pub fn contain(cx: &mut Cx, url: &str, r: Rect, alpha: f32) -> Option<Rect> {
    let p = cx.picture(url)?;
    let s = (r.w / p.w).min(r.h / p.h);
    let w = p.w * s;
    let h = p.h * s;
    let b = rect(r.x, r.y, w, h);
    cx.g.image(p.id, b, [0.0, 0.0, 1.0, 1.0], 0.0, WHITE.alpha(p.fade * alpha));
    Some(b)
}

/// The TMDB picture in another size (w300 → w780…).
pub fn tmdb_size(url: &str, size: &str) -> alloc::string::String {
    for from in ["/w92/", "/w154/", "/w185/", "/w300/", "/w342/", "/w500/", "/w780/"] {
        if url.contains("image.tmdb.org") && url.contains(from) {
            return url.replacen(from, &alloc::format!("/{}/", size), 1);
        }
    }
    alloc::string::String::from(url)
}

/// The little notice that drops in at the top.
pub fn toast(cx: &mut Cx) {
    let Some((text, at)) = cx.toast.clone() else { return };
    let age = (cx.now - at) as f32;
    let a = if age < 200.0 {
        age / 200.0
    } else if age > 3500.0 {
        1.0 - (age - 3500.0) / 200.0
    } else {
        1.0
    };
    if a <= 0.0 && age > 3500.0 {
        cx.toast = None;
        return;
    }
    if age < 200.0 || age > 3500.0 {
        cx.moving = true;
    }
    let a = a.clamp(0.0, 1.0);
    let f = body(28.0, 700);
    let w = cx.tx.width(f, &text).min(1500.0) + 36.0 + 30.0 + 26.0;
    let y = 64.0 - 20.0 * (1.0 - a);
    let r = rect(960.0 - w / 2.0, y, w, 70.0);
    cx.g.push_alpha(a);
    shadow(cx, r, 35.0, 50.0, 0.5);
    cx.g.pill(r, PAPER);
    let dot = rect(r.x + 30.0, r.y + 29.0, 12.0, 12.0);
    cx.g.glow(dot, 6.0, 10.0, BULB.alpha(0.8));
    cx.g.round(dot, 6.0, BULB);
    cx.tx.draw_fit(&mut cx.g, f, &text, r.x + 56.0, r.y + (70.0 - f.line()) / 2.0, 1500.0, ON_BULB);
    cx.g.pop_alpha();
}

/// A dark panel with a hairline edge and a deep shadow (dialogs, menus, cards over video).
pub fn panel(cx: &mut Cx, r: Rect, radius: f32, bg: Rgba) {
    shadow(cx, r, radius, 80.0, 0.55);
    cx.g.round(r, radius, bg);
    cx.g.ring(r, radius, 2.0, HAIR);
}

/// "Loading…" with three breathing bulbs.
pub fn loading(cx: &mut Cx, mid: f32, y: f32, label: &str) {
    let f = body(28.0, 400);
    cx.tx.draw_center(&mut cx.g, f, label, mid, y, DUST);
    for i in 0..3 {
        let ph = ((cx.now / 420.0) as f32 - i as f32 * 0.6) % 3.0;
        let lit = if ph < 1.0 { 0.35 + 0.65 * libm::sinf(ph * core::f32::consts::PI) } else { 0.35 };
        let r = rect(mid - 40.0 + i as f32 * 34.0 - 6.0, y + 52.0, 12.0, 12.0);
        cx.g.glow(r, 6.0, 14.0, BULB.alpha(0.3 * lit));
        cx.g.round(r, 6.0, BULB.alpha(lit));
    }
    cx.ambient = true;
}

/// The little gold dot that starts a meta line.
pub fn meta_dot(cx: &mut Cx, x: f32, y: f32) {
    let r = rect(x, y, 11.0, 11.0);
    cx.g.glow(r, 5.5, 12.0, BULB.alpha(0.7));
    cx.g.round(r, 5.5, BULB);
}

/// A backdrop that follows the focus: it switches once the focus has rested a moment (pictures are slow
/// on the TV) and crossfades from the last one.
#[derive(Default)]
pub struct Ambient {
    pub cur: alloc::string::String,
    prev: alloc::string::String,
    want: alloc::string::String,
    since: f64,
    t: Ease,
    /// The text that goes with it fades in with it.
    pub text_in: f32,
}
impl Ambient {
    pub fn want(&mut self, cx: &mut Cx, url: &str) {
        if url != self.want {
            self.want = alloc::string::String::from(url);
            self.since = cx.now;
        }
    }
    /// Switches straight away (first draw of a screen).
    pub fn now(&mut self, url: &str) {
        self.want = alloc::string::String::from(url);
        self.cur = self.want.clone();
        self.prev.clear();
        self.t = Ease::at(1.0);
    }
    /// True when it just switched (so the screen can switch its text too).
    pub fn step(&mut self, cx: &mut Cx, delay: f64) -> bool {
        let mut switched = false;
        if self.want != self.cur {
            if cx.now - self.since >= delay {
                self.prev = core::mem::take(&mut self.cur);
                self.cur = self.want.clone();
                self.t = Ease::at(0.0);
                switched = true;
            } else {
                cx.moving = true;
            }
        }
        self.t.set(1.0);
        self.text_in = self.t.step01(cx, 9.0);
        switched
    }
    pub fn draw(&mut self, cx: &mut Cx, r: Rect, alpha: f32) {
        self.draw_with(cx, r, alpha, None);
    }
    pub fn draw_with(&mut self, cx: &mut Cx, r: Rect, alpha: f32, shape: Option<&dyn Fn(f32, f32) -> f32>) {
        let paint = |cx: &mut Cx, url: &str, a: f32| -> bool {
            match shape {
                Some(sh) => backdrop_fade(cx, url, r, a, sh),
                None => backdrop(cx, url, r, a),
            }
        };
        if !self.prev.is_empty() {
            let prev = self.prev.clone();
            paint(cx, &prev, alpha);
        }
        let cur = self.cur.clone();
        let shown = paint(cx, &cur, alpha * self.t.v);
        if shown && self.t.v >= 1.0 && !cx.im.fading {
            self.prev.clear();
        }
        if cur.is_empty() && self.t.v >= 1.0 {
            self.prev.clear();
        }
    }
}
