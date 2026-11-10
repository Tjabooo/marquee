//! Pictures: asked for while a frame is drawn (only what's on or near the screen), decoded by the browser off
//! the main thread, kept as textures within a memory budget, least recently drawn dropped first.
use crate::host;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

#[derive(PartialEq, Clone, Copy)]
enum St {
    Queued,
    Loading,
    Ready,
    Failed,
}
struct Pic {
    id: u32,
    url: String,
    st: St,
    w: f32,
    h: f32,
    ready_at: f64,
    used: u64,
}

pub struct Images {
    pics: BTreeMap<u64, Pic>,
    ids: BTreeMap<u32, u64>,
    queue: Vec<u64>,
    next: u32,
    pub frame: u64,
    inflight: u32,
    bytes: f64,
    /// A picture is still fading in: keep drawing frames.
    pub fading: bool,
}

pub struct Got {
    pub id: u32,
    pub w: f32,
    pub h: f32,
    pub fade: f32,
}

const MAX_INFLIGHT: u32 = 6;
const BUDGET: f64 = 110.0 * 1024.0 * 1024.0;
const FADE_MS: f64 = 260.0;

fn key(url: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in url.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

impl Images {
    pub fn new() -> Images {
        Images { pics: BTreeMap::new(), ids: BTreeMap::new(), queue: Vec::new(), next: 1, frame: 0, inflight: 0, bytes: 0.0, fading: false }
    }
    /// The picture if it's ready; otherwise it's asked for and None comes back for now.
    pub fn get(&mut self, url: &str, now: f64) -> Option<Got> {
        if url.is_empty() {
            return None;
        }
        let k = key(url);
        let frame = self.frame;
        match self.pics.get_mut(&k) {
            Some(p) => {
                p.used = frame;
                if p.st == St::Ready {
                    let fade = ((now - p.ready_at) / FADE_MS).clamp(0.0, 1.0) as f32;
                    if fade < 1.0 {
                        self.fading = true;
                    }
                    return Some(Got { id: p.id, w: p.w, h: p.h, fade });
                }
                None
            }
            None => {
                let id = self.next;
                self.next += 1;
                self.pics.insert(k, Pic { id, url: String::from(url), st: St::Queued, w: 0.0, h: 0.0, ready_at: 0.0, used: frame });
                self.ids.insert(id, k);
                self.queue.push(k);
                None
            }
        }
    }
    /// Is it known to be broken (so a placeholder can say so instead of waiting)?
    pub fn failed(&self, url: &str) -> bool {
        self.pics.get(&key(url)).map(|p| p.st == St::Failed).unwrap_or(false)
    }
    /// Asks for what was wanted this frame, newest wishes first; wishes nobody drew lately are dropped.
    pub fn pump(&mut self) {
        let frame = self.frame;
        let mut keep: Vec<u64> = Vec::new();
        while let Some(k) = self.queue.pop() {
            let stale = match self.pics.get(&k) {
                Some(p) => p.st != St::Queued || frame.saturating_sub(p.used) > 2,
                None => true,
            };
            if stale {
                if let Some(p) = self.pics.get(&k) {
                    if p.st == St::Queued {
                        let id = p.id;
                        self.pics.remove(&k);
                        self.ids.remove(&id);
                    }
                }
                continue;
            }
            if self.inflight < MAX_INFLIGHT {
                let p = self.pics.get_mut(&k).unwrap();
                p.st = St::Loading;
                self.inflight += 1;
                host::picture(p.id, &p.url);
            } else {
                keep.push(k);
            }
        }
        keep.reverse();
        self.queue = keep;
        self.evict();
    }
    pub fn done(&mut self, id: u32, ok: bool, w: f32, h: f32, now: f64) {
        self.inflight = self.inflight.saturating_sub(1);
        let Some(k) = self.ids.get(&id).copied() else { return };
        if let Some(p) = self.pics.get_mut(&k) {
            if ok {
                p.st = St::Ready;
                p.w = w;
                p.h = h;
                p.ready_at = now;
                self.bytes += (w * h * 4.0) as f64;
            } else {
                p.st = St::Failed;
            }
        }
    }
    fn evict(&mut self) {
        if self.bytes <= BUDGET {
            return;
        }
        let frame = self.frame;
        let mut ready: Vec<(u64, u64)> =
            self.pics.iter().filter(|(_, p)| p.st == St::Ready && p.used + 1 < frame).map(|(k, p)| (p.used, *k)).collect();
        ready.sort();
        for (_, k) in ready {
            if self.bytes <= BUDGET * 0.8 {
                break;
            }
            if let Some(p) = self.pics.remove(&k) {
                self.bytes -= (p.w * p.h * 4.0) as f64;
                self.ids.remove(&p.id);
                host::drop_picture(p.id);
            }
        }
    }
}

/// The crop of a w×h picture that covers a bw×bh box (centred), as texture coordinates.
pub fn cover(w: f32, h: f32, bw: f32, bh: f32) -> [f32; 4] {
    if w <= 0.0 || h <= 0.0 || bw <= 0.0 || bh <= 0.0 {
        return [0.0, 0.0, 1.0, 1.0];
    }
    let pic = w / h;
    let bx = bw / bh;
    if pic > bx {
        let keep = bx / pic;
        [(1.0 - keep) / 2.0, 0.0, (1.0 + keep) / 2.0, 1.0]
    } else {
        let keep = pic / bx;
        [0.0, (1.0 - keep) / 2.0, 1.0, (1.0 + keep) / 2.0]
    }
}
/// Same, anchored to the top (backdrops keep faces).
pub fn cover_top(w: f32, h: f32, bw: f32, bh: f32) -> [f32; 4] {
    let mut uv = cover(w, h, bw, bh);
    let dv = uv[1];
    uv[1] -= dv * 0.6;
    uv[3] -= dv * 0.6;
    uv
}
