//! Text: each (font, string) is rasterised once by host.js into an atlas texture and then drawn as one box.
//! Measuring, ellipsis and word wrapping happen here, with caches, so a frame costs no browser layout at all.
use crate::gfx::{rect, Gfx, Rgba};
use crate::host;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

#[derive(Clone, Copy, PartialEq)]
pub enum Face {
    Display,
    Body,
}
#[derive(Clone, Copy, PartialEq)]
pub enum Shade {
    None,
    /// A glow in the text's own colour (the wordmark, lit numbers).
    Glow,
    /// A black outline-ish shadow (subtitles).
    Dark,
}

#[derive(Clone, Copy, PartialEq)]
pub struct Font {
    pub face: Face,
    pub weight: u16,
    pub size: f32,
    pub shade: Shade,
}
pub const fn body(size: f32, weight: u16) -> Font {
    Font { face: Face::Body, weight, size, shade: Shade::None }
}
pub const fn display(size: f32, weight: u16) -> Font {
    Font { face: Face::Display, weight, size, shade: Shade::None }
}
impl Font {
    pub const fn glow(mut self) -> Font {
        self.shade = Shade::Glow;
        self
    }
    pub const fn dark(mut self) -> Font {
        self.shade = Shade::Dark;
        self
    }
    pub fn line(&self) -> f32 {
        libm::ceilf(self.size * 1.3)
    }
}

struct Run {
    page: u32,
    uv: [f32; 4],
    w: f32,
    h: f32,
    pad: f32,
    adv: f32,
}

pub struct Text {
    fonts: Vec<Font>,
    runs: BTreeMap<u64, Run>,
    widths: BTreeMap<u64, f32>,
    wraps: BTreeMap<u64, Vec<String>>,
    /// The atlas filled up mid-frame and was emptied: the frame must be drawn again.
    pub redo: bool,
}

fn fnv(seed: u64, s: &str) -> u64 {
    let mut h = seed ^ 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

const ATLAS: f32 = 2048.0;

impl Text {
    pub fn new() -> Text {
        Text { fonts: Vec::new(), runs: BTreeMap::new(), widths: BTreeMap::new(), wraps: BTreeMap::new(), redo: false }
    }
    fn id(&mut self, f: Font) -> u32 {
        if let Some(i) = self.fonts.iter().position(|x| *x == f) {
            return i as u32;
        }
        let i = self.fonts.len() as u32;
        let family = match f.face {
            Face::Display => "\"Bricolage Grotesque\", \"SamsungOne\", \"Tizen Sans\", sans-serif",
            Face::Body => "\"SamsungOne\", \"Tizen Sans\", \"Segoe UI\", \"Noto Sans\", sans-serif",
        };
        let css = alloc::format!("{} {}px {}", f.weight, f.size, family);
        let (blur, rgba, dy) = match f.shade {
            Shade::None => (0.0, 0, 0.0),
            Shade::Glow => (f.size * 0.4, 0xFFFF_FF70, 0.0),
            Shade::Dark => (6.0, 0x0000_00FF, 2.0),
        };
        host::define_font(i, &css, f.line(), blur, rgba, dy);
        self.fonts.push(f);
        i
    }
    pub fn width(&mut self, f: Font, s: &str) -> f32 {
        if s.is_empty() {
            return 0.0;
        }
        let id = self.id(f);
        let k = fnv(id as u64 * 7919 + 1, s);
        if let Some(w) = self.widths.get(&k) {
            return *w;
        }
        let w = host::measure(id, s);
        if self.widths.len() > 6000 {
            self.widths.clear();
        }
        self.widths.insert(k, w);
        w
    }
    /// `s` cut to fit `max` px, ending in "…" when it had to be cut.
    pub fn fit(&mut self, f: Font, s: &str, max: f32) -> String {
        if self.width(f, s) <= max {
            return String::from(s);
        }
        let chars: Vec<(usize, char)> = s.char_indices().collect();
        let (mut lo, mut hi) = (0usize, chars.len());
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            let end = if mid < chars.len() { chars[mid].0 } else { s.len() };
            let mut t = String::from(s[..end].trim_end());
            t.push('…');
            if self.width(f, &t) <= max {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        let end = if lo < chars.len() { chars[lo].0 } else { s.len() };
        let mut t = String::from(s[..end].trim_end());
        t.push('…');
        t
    }
    /// Word-wrapped into at most `lines` lines of `max` px (the last one cut with "…").
    pub fn wrap(&mut self, f: Font, s: &str, max: f32, lines: usize) -> Vec<String> {
        let id = self.id(f);
        let k = fnv(((id as u64) << 32) ^ ((max as u64) << 8) ^ lines as u64, s);
        if let Some(v) = self.wraps.get(&k) {
            return v.clone();
        }
        let mut out: Vec<String> = Vec::new();
        for para in s.split('\n') {
            let mut line = String::new();
            for word in para.split(' ').filter(|w| !w.is_empty()) {
                let try_line = if line.is_empty() { String::from(word) } else { alloc::format!("{} {}", line, word) };
                if line.is_empty() || self.width(f, &try_line) <= max {
                    line = try_line;
                } else {
                    out.push(core::mem::take(&mut line));
                    line = String::from(word);
                }
            }
            out.push(line);
        }
        if out.len() > lines {
            let rest = out[lines - 1..].join(" ");
            out.truncate(lines - 1);
            out.push(self.fit(f, &rest, max));
        } else if let Some(last) = out.last_mut() {
            if self.width(f, last) > max {
                *last = self.fit(f, last, max);
            }
        }
        while out.last().map(|l| l.is_empty()).unwrap_or(false) && out.len() > 1 {
            out.pop();
        }
        if self.wraps.len() > 600 {
            self.wraps.clear();
        }
        self.wraps.insert(k, out.clone());
        out
    }

    /// Draws one line with its line box's top-left at (x, y). Returns the advance width.
    pub fn draw(&mut self, g: &mut Gfx, f: Font, s: &str, x: f32, y: f32, c: Rgba) -> f32 {
        if s.is_empty() {
            return 0.0;
        }
        let id = self.id(f);
        let k = fnv(id as u64 * 104_729 + 3, s);
        if !self.runs.contains_key(&k) {
            let r = match host::raster(id, s) {
                Some(r) => r,
                None => {
                    // The atlas is full: empty it and draw the frame again.
                    host::atlas_reset();
                    self.runs.clear();
                    self.redo = true;
                    match host::raster(id, s) {
                        Some(r) => r,
                        None => return 0.0,
                    }
                }
            };
            let [page, ax, ay, w, h, pad, adv] = r;
            self.runs.insert(k, Run { page: page as u32, uv: [ax / ATLAS, ay / ATLAS, (ax + w) / ATLAS, (ay + h) / ATLAS], w, h, pad, adv });
        }
        let run = &self.runs[&k];
        let x = libm::roundf(x);
        let y = libm::roundf(y);
        g.glyphs(run.page, rect(x - run.pad, y - run.pad, run.w, run.h), run.uv, c);
        run.adv
    }
    pub fn draw_fit(&mut self, g: &mut Gfx, f: Font, s: &str, x: f32, y: f32, max: f32, c: Rgba) -> f32 {
        let t = self.fit(f, s, max);
        self.draw(g, f, &t, x, y, c)
    }
    pub fn draw_center(&mut self, g: &mut Gfx, f: Font, s: &str, cx: f32, y: f32, c: Rgba) {
        let w = self.width(f, s);
        self.draw(g, f, s, cx - w / 2.0, y, c);
    }
    pub fn draw_right(&mut self, g: &mut Gfx, f: Font, s: &str, rx: f32, y: f32, c: Rgba) {
        let w = self.width(f, s);
        self.draw(g, f, s, rx - w, y, c);
    }
    /// Wrapped paragraph; returns the height used.
    #[allow(clippy::too_many_arguments)]
    pub fn para(&mut self, g: &mut Gfx, f: Font, s: &str, x: f32, y: f32, max: f32, lines: usize, lh: f32, c: Rgba) -> f32 {
        let ls = self.wrap(f, s, max, lines);
        for (i, l) in ls.iter().enumerate() {
            self.draw(g, f, l, x, y + i as f32 * lh, c);
        }
        ls.len() as f32 * lh
    }
}
