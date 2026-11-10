//! The renderer: every frame is a list of boxes in one vertex buffer, drawn by host.js with one shader
//! (see FS in host.js). A box can be flat, a gradient, rounded, feathered (soft shadows and glows), a ring,
//! a picture or a piece of text from the atlas. Boxes that don't sample a texture join any draw call, so a
//! whole screen is a handful of draw calls.
use alloc::vec::Vec;

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Rgba(pub f32, pub f32, pub f32, pub f32);

pub const fn hex(h: u32) -> Rgba {
    Rgba(((h >> 16) & 255) as f32 / 255.0, ((h >> 8) & 255) as f32 / 255.0, (h & 255) as f32 / 255.0, 1.0)
}
pub const fn hexa(h: u32, a: f32) -> Rgba {
    let c = hex(h);
    Rgba(c.0, c.1, c.2, a)
}
impl Rgba {
    pub fn alpha(self, a: f32) -> Rgba {
        Rgba(self.0, self.1, self.2, self.3 * a)
    }
    pub fn mix(self, o: Rgba, t: f32) -> Rgba {
        Rgba(self.0 + (o.0 - self.0) * t, self.1 + (o.1 - self.1) * t, self.2 + (o.2 - self.2) * t, self.3 + (o.3 - self.3) * t)
    }
    /// Premultiplied, as four bytes (r, g, b, a in memory order).
    fn pack(self, ga: f32) -> u32 {
        let a = (self.3 * ga).clamp(0.0, 1.0);
        let r = (self.0 * a * 255.0 + 0.5) as u32;
        let g = (self.1 * a * 255.0 + 0.5) as u32;
        let b = (self.2 * a * 255.0 + 0.5) as u32;
        let a = (a * 255.0 + 0.5) as u32;
        r | (g << 8) | (b << 16) | (a << 24)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}
pub const fn rect(x: f32, y: f32, w: f32, h: f32) -> Rect {
    Rect { x, y, w, h }
}
impl Rect {
    pub fn r(&self) -> f32 {
        self.x + self.w
    }
    pub fn b(&self) -> f32 {
        self.y + self.h
    }
    pub fn grow(&self, d: f32) -> Rect {
        rect(self.x - d, self.y - d, self.w + 2.0 * d, self.h + 2.0 * d)
    }
    /// Scaled around its centre.
    pub fn scale(&self, s: f32) -> Rect {
        let w = self.w * s;
        let h = self.h * s;
        rect(self.x - (w - self.w) / 2.0, self.y - (h - self.h) / 2.0, w, h)
    }
    pub fn shift(&self, dx: f32, dy: f32) -> Rect {
        rect(self.x + dx, self.y + dy, self.w, self.h)
    }
    pub fn and(&self, o: &Rect) -> Rect {
        let x = self.x.max(o.x);
        let y = self.y.max(o.y);
        rect(x, y, (self.r().min(o.r()) - x).max(0.0), (self.b().min(o.b()) - y).max(0.0))
    }
    pub fn hits(&self, o: &Rect) -> bool {
        self.x < o.r() && o.x < self.r() && self.y < o.b() && o.y < self.b()
    }
}

pub const SCREEN: Rect = rect(0.0, 0.0, 1920.0, 1080.0);

const PLAIN: i32 = 0;
pub const IMAGE: i32 = 1;
pub const TEXT: i32 = 2;

#[derive(Clone, Copy)]
struct Shape {
    r: f32,
    f: f32,
    ring: f32,
    mode: f32,
}
const FLAT: Shape = Shape { r: 0.0, f: 0.0, ring: 0.0, mode: 0.0 };

pub struct Gfx {
    pub v: Vec<u32>,
    pub b: Vec<i32>,
    pub quads: u32,
    kind: i32,
    tex: i32,
    clip: Rect,
    clips: Vec<Rect>,
    alpha: f32,
    alphas: Vec<f32>,
}

impl Gfx {
    pub fn new() -> Gfx {
        Gfx { v: Vec::with_capacity(4096 * 52), b: Vec::new(), quads: 0, kind: -1, tex: -1, clip: SCREEN, clips: Vec::new(), alpha: 1.0, alphas: Vec::new() }
    }
    pub fn begin(&mut self) {
        self.v.clear();
        self.b.clear();
        self.quads = 0;
        self.kind = -1;
        self.tex = -1;
        self.clip = SCREEN;
        self.clips.clear();
        self.alpha = 1.0;
        self.alphas.clear();
    }
    pub fn push_clip(&mut self, r: Rect) {
        self.clips.push(self.clip);
        self.clip = self.clip.and(&r);
    }
    pub fn pop_clip(&mut self) {
        self.clip = self.clips.pop().unwrap_or(SCREEN);
    }
    pub fn push_alpha(&mut self, a: f32) {
        self.alphas.push(self.alpha);
        self.alpha *= a;
    }
    pub fn pop_alpha(&mut self) {
        self.alpha = self.alphas.pop().unwrap_or(1.0);
    }
    pub fn visible(&self, r: &Rect) -> bool {
        self.clip.hits(r)
    }

    /// One box. `area`: where it's drawn; `shape_box`: the box the rounded/feathered shape is measured from.
    /// cols: top-left, top-right, bottom-left, bottom-right.
    #[allow(clippy::too_many_arguments)]
    fn quad(&mut self, area: Rect, uv: [f32; 4], cols: [Rgba; 4], shape_box: Rect, s: Shape, kind: i32, tex: i32) {
        if self.alpha <= 0.002 || area.w <= 0.0 || area.h <= 0.0 {
            return;
        }
        let c = area.and(&self.clip);
        if c.w <= 0.0 || c.h <= 0.0 {
            return;
        }
        if self.quads >= 15990 {
            return;
        }
        if kind != PLAIN && (kind != self.kind || tex != self.tex) {
            self.b.extend_from_slice(&[kind, tex, self.quads as i32, 0]);
            self.kind = kind;
            self.tex = tex;
        } else if self.b.is_empty() {
            self.b.extend_from_slice(&[PLAIN, 0, self.quads as i32, 0]);
            self.kind = PLAIN;
            self.tex = 0;
        }
        let n = self.b.len();
        self.b[n - 1] += 1;
        self.quads += 1;
        let tx0 = (c.x - area.x) / area.w;
        let tx1 = (c.r() - area.x) / area.w;
        let ty0 = (c.y - area.y) / area.h;
        let ty1 = (c.b() - area.y) / area.h;
        let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
        let u0 = lerp(uv[0], uv[2], tx0);
        let u1 = lerp(uv[0], uv[2], tx1);
        let v0 = lerp(uv[1], uv[3], ty0);
        let v1 = lerp(uv[1], uv[3], ty1);
        let flat = cols[0] == cols[1] && cols[0] == cols[2] && cols[0] == cols[3];
        let col = |tx: f32, ty: f32| -> u32 {
            if flat {
                return cols[0].pack(self.alpha);
            }
            let top = cols[0].mix(cols[1], tx);
            let bot = cols[2].mix(cols[3], tx);
            top.mix(bot, ty).pack(self.alpha)
        };
        let cx = shape_box.x + shape_box.w / 2.0;
        let cy = shape_box.y + shape_box.h / 2.0;
        let hw = shape_box.w / 2.0;
        let hh = shape_box.h / 2.0;
        let corners = [(c.x, c.y, u0, v0, tx0, ty0), (c.r(), c.y, u1, v0, tx1, ty0), (c.x, c.b(), u0, v1, tx0, ty1), (c.r(), c.b(), u1, v1, tx1, ty1)];
        for (x, y, u, v, tx, ty) in corners {
            let k = col(tx, ty);
            self.v.extend_from_slice(&[
                x.to_bits(),
                y.to_bits(),
                u.to_bits(),
                v.to_bits(),
                cx.to_bits(),
                cy.to_bits(),
                hw.to_bits(),
                hh.to_bits(),
                s.r.to_bits(),
                s.f.to_bits(),
                s.ring.to_bits(),
                s.mode.to_bits(),
                k,
            ]);
        }
    }

    pub fn fill(&mut self, r: Rect, c: Rgba) {
        self.quad(r, [0.0; 4], [c; 4], r, FLAT, PLAIN, 0);
    }
    pub fn round(&mut self, r: Rect, radius: f32, c: Rgba) {
        self.quad(r, [0.0; 4], [c; 4], r, Shape { r: radius, f: 0.0, ring: 0.0, mode: 0.0 }, PLAIN, 0);
    }
    /// A pill: fully rounded ends.
    pub fn pill(&mut self, r: Rect, c: Rgba) {
        self.round(r, r.h / 2.0, c);
    }
    pub fn round_v(&mut self, r: Rect, radius: f32, top: Rgba, bottom: Rgba) {
        self.quad(r, [0.0; 4], [top, top, bottom, bottom], r, Shape { r: radius, f: 0.0, ring: 0.0, mode: 0.0 }, PLAIN, 0);
    }
    pub fn round_diag(&mut self, r: Rect, radius: f32, from: Rgba, to: Rgba) {
        let mid = from.mix(to, 0.5);
        self.quad(r, [0.0; 4], [from, mid, mid, to], r, Shape { r: radius, f: 0.0, ring: 0.0, mode: 0.0 }, PLAIN, 0);
    }
    /// A ring of `width` just inside `r` (a border, or a focus outline when `r` is grown around a box).
    pub fn ring(&mut self, r: Rect, radius: f32, width: f32, c: Rgba) {
        self.quad(r, [0.0; 4], [c; 4], r, Shape { r: radius, f: 0.0, ring: width, mode: 0.0 }, PLAIN, 0);
    }
    /// A soft shadow or glow around `r`, `blur` px wide on each side of its edge.
    pub fn glow(&mut self, r: Rect, radius: f32, blur: f32, c: Rgba) {
        let f = (blur * 0.55).max(1.0);
        self.quad(r.grow(f), [0.0; 4], [c; 4], r, Shape { r: radius, f, ring: 0.0, mode: 0.0 }, PLAIN, 0);
    }
    /// Light in an ellipse: c in the middle, nothing at the edge of `r`.
    pub fn light(&mut self, r: Rect, c: Rgba) {
        self.quad(r, [0.0; 4], [c; 4], r, Shape { r: 0.0, f: 0.0, ring: 0.0, mode: 2.0 }, PLAIN, 0);
    }
    /// Left-to-right gradient through (position 0..1, colour) stops.
    pub fn hgrad(&mut self, r: Rect, stops: &[(f32, Rgba)]) {
        for w in stops.windows(2) {
            let (p0, c0) = w[0];
            let (p1, c1) = w[1];
            let seg = rect(r.x + r.w * p0, r.y, r.w * (p1 - p0), r.h);
            self.quad(seg, [0.0; 4], [c0, c1, c0, c1], seg, FLAT, PLAIN, 0);
        }
    }
    /// Top-to-bottom gradient.
    pub fn vgrad(&mut self, r: Rect, stops: &[(f32, Rgba)]) {
        for w in stops.windows(2) {
            let (p0, c0) = w[0];
            let (p1, c1) = w[1];
            let seg = rect(r.x, r.y + r.h * p0, r.w, r.h * (p1 - p0));
            self.quad(seg, [0.0; 4], [c0, c0, c1, c1], seg, FLAT, PLAIN, 0);
        }
    }
    /// A picture (texture `id` from host.js), `uv` its crop, clipped to a rounded box.
    pub fn image(&mut self, id: u32, r: Rect, uv: [f32; 4], radius: f32, tint: Rgba) {
        self.quad(r, uv, [tint; 4], r, Shape { r: radius, f: 0.0, ring: 0.0, mode: 1.0 }, IMAGE, id as i32);
    }
    /// A picture whose opacity follows `alpha(x, y)` (0..1 across the box), as a grid of nx × ny boxes, so it
    /// can melt into whatever is under it.
    #[allow(clippy::too_many_arguments)]
    pub fn image_fade(&mut self, id: u32, r: Rect, uv: [f32; 4], tint: Rgba, nx: usize, ny: usize, alpha: &dyn Fn(f32, f32) -> f32) {
        for j in 0..ny {
            for i in 0..nx {
                let (x0, x1) = (i as f32 / nx as f32, (i + 1) as f32 / nx as f32);
                let (y0, y1) = (j as f32 / ny as f32, (j + 1) as f32 / ny as f32);
                let a = [alpha(x0, y0), alpha(x1, y0), alpha(x0, y1), alpha(x1, y1)];
                if a.iter().all(|v| *v <= 0.002) {
                    continue;
                }
                let cell = rect(r.x + r.w * x0, r.y + r.h * y0, r.w * (x1 - x0), r.h * (y1 - y0));
                let cuv = [uv[0] + (uv[2] - uv[0]) * x0, uv[1] + (uv[3] - uv[1]) * y0, uv[0] + (uv[2] - uv[0]) * x1, uv[1] + (uv[3] - uv[1]) * y1];
                let cols = [tint.alpha(a[0]), tint.alpha(a[1]), tint.alpha(a[2]), tint.alpha(a[3])];
                self.quad(cell, cuv, cols, cell, Shape { r: 0.0, f: 0.0, ring: 0.0, mode: 1.0 }, IMAGE, id as i32);
            }
        }
    }
    pub fn glyphs(&mut self, page: u32, r: Rect, uv: [f32; 4], tint: Rgba) {
        self.quad(r, uv, [tint; 4], r, Shape { r: 0.0, f: 0.0, ring: 0.0, mode: 1.0 }, TEXT, page as i32);
    }
}
