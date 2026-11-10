//! The TV app's plain logic, the same rules as public/tv/logic.js (tests/tv-logic.test.mjs covers those).
use crate::t;
use crate::util::{arr, b, f, has, i, id, s, search_key};
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde_json::Value;

pub const AUTOPLAY_SECONDS: f64 = 10.0;
pub const AUTOPLAY_CHAIN: u32 = 3;
pub const DONE_SECONDS: f64 = 90.0;

fn pos_int(v: Option<i64>) -> bool {
    matches!(v, Some(n) if n > 0)
}
fn usable_episode(x: &Value) -> bool {
    has(x, "id") && !s(x, "show").is_empty() && pos_int(i(x, "season")) && pos_int(i(x, "episode")) && !b(x, "converting")
        && x.get("done").and_then(|d| d.as_bool()) != Some(false)
}
fn cmp_file(a: &Value, b: &Value) -> core::cmp::Ordering {
    s(a, "file").cmp(s(b, "file")).then_with(|| id(a, "id").cmp(&id(b, "id")))
}

/// The next episode in this person's library; the next season's first only when TMDB says this was the last.
pub fn next_episode<'a>(current_id: &str, library: &'a [Value], shows: &[Value]) -> Option<&'a Value> {
    let current = library.iter().find(|x| s(x, "id") == current_id)?;
    if !usable_episode(current) {
        return None;
    }
    let show = s(current, "show");
    let season = i(current, "season")?;
    let episode = i(current, "episode")?;
    let choose = |se: i64, ep: i64| -> Option<&'a Value> {
        let mut c: Vec<&Value> =
            library.iter().filter(|x| usable_episode(x) && s(x, "show") == show && i(x, "season") == Some(se) && i(x, "episode") == Some(ep)).collect();
        c.sort_by(|a, b| cmp_file(a, b));
        c.first().copied()
    };
    if let Some(n) = choose(season, episode + 1) {
        return Some(n);
    }
    let sh = shows.iter().find(|x| s(x, "id") == show)?;
    let total = arr(sh, "seasons").iter().find(|x| i(x, "number") == Some(season)).and_then(|x| i(x, "total"));
    if pos_int(total) && Some(episode) == total {
        choose(season + 1, 1)
    } else {
        None
    }
}

pub fn next_prompt_at(duration: f64, credits_at: Option<f64>) -> Option<f64> {
    if duration <= 0.0 {
        return None;
    }
    credits_at.filter(|c| *c > duration / 2.0 && *c < duration)
}
pub fn is_next_time(time: f64, duration: f64, credits_at: Option<f64>, ended: bool) -> bool {
    ended || next_prompt_at(duration, credits_at).map(|at| time >= at).unwrap_or(false)
}
pub fn intro_showing(time: f64, intro: Option<(f64, f64)>) -> bool {
    matches!(intro, Some((start, end)) if time >= start - 0.25 && time < end - 1.0)
}

pub fn pad2(n: i64) -> String {
    if n < 10 {
        alloc::format!("0{}", n)
    } else {
        n.to_string()
    }
}
pub fn fmt_time(sec: f64) -> String {
    let sec = libm::floor(sec.max(0.0)) as i64;
    let h = sec / 3600;
    let m = sec % 3600 / 60;
    let s = sec % 60;
    if h > 0 {
        alloc::format!("{}:{}:{}", h, pad2(m), pad2(s))
    } else {
        alloc::format!("{}:{}", m, pad2(s))
    }
}
pub fn episode_label(x: &Value) -> String {
    match (i(x, "season"), i(x, "episode")) {
        (Some(se), Some(ep)) => t!("S{0} E{1}", pad2(se), pad2(ep)),
        _ => String::new(),
    }
}
pub fn minutes_left(p: &Value) -> String {
    let left = (f(p, "duration").unwrap_or(0.0) - f(p, "time").unwrap_or(0.0)) / 60.0;
    t!("{0} min left", (libm::ceil(left).max(1.0) as i64).to_string())
}

pub fn progress_ref(x: &Value) -> String {
    let mk = s(x, "mediaKey");
    if mk.is_empty() {
        alloc::format!("l:{}", s(x, "id"))
    } else {
        alloc::format!("m:{}", mk)
    }
}
pub fn resumable(p: Option<&Value>) -> bool {
    match p {
        Some(p) => {
            let time = f(p, "time").unwrap_or(0.0);
            let dur = f(p, "duration").unwrap_or(0.0);
            time > 30.0 && dur > 0.0 && dur - time > DONE_SECONDS
        }
        None => false,
    }
}

pub fn title_key(x: &Value) -> Option<String> {
    let show = s(x, "show");
    if let Some(n) = show.strip_prefix("tv-") {
        if !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()) {
            return Some(alloc::format!("tv:{}", n));
        }
    }
    let tmdb = id(x, "tmdbId");
    if !tmdb.is_empty() && tmdb != "0" && !has(x, "season") {
        return Some(alloc::format!("movie:{}", tmdb));
    }
    None
}

pub fn transfer_word(d: &Value) -> String {
    if b(d, "converting") {
        return t!("Preparing playback").into();
    }
    let st = s(d, "state");
    let w = match st {
        "missingFiles" => t!("Files missing"),
        "error" => t!("Needs attention"),
        _ if st.starts_with("paused") || st.starts_with("stopped") => t!("Paused"),
        _ if st.starts_with("checking") => t!("Checking files"),
        "stalledDL" => t!("Waiting for a source"),
        "metaDL" | "forcedMetaDL" => t!("Starting"),
        "queuedDL" => t!("In line"),
        _ if st == "moving" || f(d, "progress").unwrap_or(0.0) >= 1.0 => t!("Almost ready"),
        _ => t!("On its way"),
    };
    w.into()
}
fn pending_word(items: &[Value], finished: i64) -> String {
    if items.iter().any(|d| matches!(s(d, "state"), "error" | "missingFiles")) {
        return t!("Needs attention").into();
    }
    if items.len() == 1 && finished == 0 {
        return transfer_word(&items[0]);
    }
    if finished > 0 {
        return t!("{0} of {1} ready", finished.to_string(), (finished + items.len() as i64).to_string());
    }
    if items.iter().all(|d| s(d, "state").starts_with("paused") || s(d, "state").starts_with("stopped")) {
        return t!("Paused").into();
    }
    if items.iter().all(|d| has(d, "episode")) {
        t!("{0} episodes on their way", items.len().to_string())
    } else {
        t!("{0} downloads", items.len().to_string())
    }
}

/// A download that isn't ready yet: one per film or show.
#[derive(Clone)]
pub struct Pending {
    pub key: String,
    pub tv: bool,
    pub tmdb_id: String,
    pub show_id: String,
    pub title: String,
    pub poster: String,
    pub backdrop: String,
    pub year: String,
    pub items: Vec<Value>,
    pub added: f64,
    pub progress: Option<f64>,
    pub word: String,
}

pub fn pending_titles(downloads: &[Value]) -> Vec<Pending> {
    let mut order: Vec<Pending> = Vec::new();
    let mut by: BTreeMap<String, usize> = BTreeMap::new();
    for d in downloads {
        if d.get("mine").and_then(|x| x.as_bool()) == Some(false) {
            continue;
        }
        let trouble = matches!(s(d, "state"), "error" | "missingFiles");
        let linked = !arr(d, "libraryIds").is_empty();
        let done = d.get("done").and_then(|x| x.as_bool()).unwrap_or(false);
        let has_video = d.get("hasVideo").and_then(|x| x.as_bool()) != Some(false);
        if !(!done || b(d, "converting") || trouble || (has_video && !b(d, "ready") && !linked)) {
            continue;
        }
        let show_id = s(d, "showId");
        let is_show = s(d, "mediaType") == "tv" || !show_id.is_empty();
        let tmdb = id(d, "tmdbId");
        let key = if is_show {
            let x = if !show_id.is_empty() { String::from(show_id) } else if !tmdb.is_empty() { tmdb.clone() } else { String::from(s(d, "hash")) };
            alloc::format!("tv:{}", x)
        } else if !tmdb.is_empty() {
            alloc::format!("movie:{}", tmdb)
        } else {
            alloc::format!("hash:{}", s(d, "hash"))
        };
        let at = match by.get(&key) {
            Some(n) => *n,
            None => {
                let title = [s(d, "canonicalTitle"), s(d, "title"), s(d, "name")].into_iter().find(|x| !x.is_empty()).unwrap_or("");
                order.push(Pending {
                    key: key.clone(),
                    tv: is_show,
                    tmdb_id: tmdb.clone(),
                    show_id: String::from(show_id),
                    title: String::from(title),
                    poster: String::from(s(d, "poster")),
                    backdrop: String::from(s(d, "backdrop")),
                    year: crate::util::year(d),
                    items: Vec::new(),
                    added: 0.0,
                    progress: None,
                    word: String::new(),
                });
                by.insert(key, order.len() - 1);
                order.len() - 1
            }
        };
        let e = &mut order[at];
        e.items.push(d.clone());
        e.added = e.added.max(f(d, "added").unwrap_or(0.0));
    }
    for e in order.iter_mut() {
        let count = e.items.len() as f64;
        let known = e.items.iter().all(|d| f(d, "size").unwrap_or(0.0) > 0.0 && f(d, "progress").is_some());
        let total: f64 = if known { e.items.iter().map(|d| f(d, "size").unwrap_or(0.0)).sum() } else { 0.0 };
        let mut part = if known && total > 0.0 {
            Some(e.items.iter().map(|d| f(d, "size").unwrap_or(0.0) * f(d, "progress").unwrap_or(0.0).clamp(0.0, 1.0)).sum::<f64>() / total)
        } else {
            None
        };
        let preparing: Vec<f64> = e.items.iter().filter(|d| b(d, "converting")).filter_map(|d| f(d, "convertPercent")).collect();
        if preparing.len() == e.items.len() {
            part = Some(preparing.iter().sum::<f64>() / count / 100.0);
        }
        let finished = e.items.iter().map(|d| i(d, "batchDone").unwrap_or(0)).max().unwrap_or(0);
        e.progress = part.map(|p| (finished as f64 + p * count) / (finished as f64 + count));
        e.word = pending_word(&e.items, finished);
    }
    order.sort_by(|a, b| b.added.partial_cmp(&a.added).unwrap_or(core::cmp::Ordering::Equal));
    order
}

fn added(x: &Value) -> f64 {
    f(x, "addedAt").filter(|v| *v > 0.0).or_else(|| f(x, "added")).unwrap_or(0.0)
}

pub struct HomeRows<'a> {
    pub cont: Vec<&'a Value>,
    pub shows: Vec<&'a Value>,
    pub films: Vec<&'a Value>,
}
pub fn home_rows<'a>(library: &'a [Value], shows: &'a [Value], progress: &Value) -> HomeRows<'a> {
    let prog = |x: &Value| progress.get(progress_ref(x));
    let mut cont: Vec<&Value> = library.iter().filter(|x| resumable(prog(x)) && !b(x, "converting")).collect();
    cont.sort_by(|a, b| {
        let at = |x: &Value| prog(x).and_then(|p| f(p, "at")).unwrap_or(0.0);
        at(b).partial_cmp(&at(a)).unwrap_or(core::cmp::Ordering::Equal)
    });
    cont.truncate(20);
    let mut ids: BTreeMap<&str, f64> = BTreeMap::new();
    for x in library {
        let sh = s(x, "show");
        if !sh.is_empty() {
            let e = ids.entry(sh).or_insert(0.0);
            *e = e.max(added(x));
        }
    }
    let with_seasons: BTreeSet<&str> = library.iter().filter(|x| has(x, "season")).map(|x| s(x, "show")).filter(|x| !x.is_empty()).collect();
    let mut show_list: Vec<&Value> = shows.iter().filter(|x| with_seasons.contains(s(x, "id"))).collect();
    show_list.sort_by(|a, b| {
        let la = ids.get(s(a, "id")).copied().unwrap_or(0.0);
        let lb = ids.get(s(b, "id")).copied().unwrap_or(0.0);
        lb.partial_cmp(&la).unwrap_or(core::cmp::Ordering::Equal)
    });
    let mut films: Vec<&Value> = library.iter().filter(|x| !has(x, "season")).collect();
    films.sort_by(|a, b| added(b).partial_cmp(&added(a)).unwrap_or(core::cmp::Ordering::Equal));
    HomeRows { cont, shows: show_list, films }
}

pub enum GenreTitle<'a> {
    Show(&'a Value),
    Film(&'a Value),
}
pub struct GenreRow<'a> {
    pub name: String,
    pub titles: Vec<GenreTitle<'a>>,
}
fn has_genre(x: &Value, g: Option<i64>) -> bool {
    match g {
        Some(g) if g != 0 => arr(x, "genres").iter().any(|v| v.as_i64() == Some(g)),
        _ => false,
    }
}
pub fn genre_rows<'a>(library: &'a [Value], shows: &'a [Value], genres: &[Value]) -> Vec<GenreRow<'a>> {
    let mut show_added: BTreeMap<&str, f64> = BTreeMap::new();
    let mut films: Vec<&Value> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for x in library {
        let sh = s(x, "show");
        if !sh.is_empty() && has(x, "season") {
            let e = show_added.entry(sh).or_insert(0.0);
            *e = e.max(added(x));
        }
        if has(x, "season") || arr(x, "genres").is_empty() {
            continue;
        }
        let tmdb = id(x, "tmdbId");
        let k = if !tmdb.is_empty() && tmdb != "0" { alloc::format!("m{}", tmdb) } else { String::from(s(x, "id")) };
        if seen.insert(k) {
            films.push(x);
        }
    }
    let mut rows: Vec<(GenreRow, Vec<f64>)> = Vec::new();
    for g in genres {
        let mut titles: Vec<(f64, GenreTitle)> = Vec::new();
        for sh in shows {
            if let Some(a) = show_added.get(s(sh, "id")) {
                if has_genre(sh, i(g, "tv")) {
                    titles.push((*a, GenreTitle::Show(sh)));
                }
            }
        }
        for x in &films {
            if has_genre(x, i(g, "movie")) {
                titles.push((added(x), GenreTitle::Film(x)));
            }
        }
        if !titles.is_empty() {
            titles.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(core::cmp::Ordering::Equal));
            let ats = titles.iter().map(|t| t.0).collect();
            rows.push((GenreRow { name: String::from(s(g, "name")), titles: titles.into_iter().map(|t| t.1).collect() }, ats));
        }
    }
    let mut rows: Vec<GenreRow> = rows.into_iter().map(|r| r.0).collect();
    rows.sort_by(|a, b| b.titles.len().cmp(&a.titles.len()).then_with(|| a.name.cmp(&b.name)));
    rows
}

pub struct Season<'a> {
    pub number: i64,
    pub episodes: Vec<&'a Value>,
}
pub fn show_seasons<'a>(library: &'a [Value], show_id: &str) -> Vec<Season<'a>> {
    let mut by: BTreeMap<i64, Vec<&Value>> = BTreeMap::new();
    for x in library {
        if s(x, "show") != show_id {
            continue;
        }
        if let Some(se) = i(x, "season") {
            by.entry(se).or_default().push(x);
        }
    }
    by.into_iter()
        .map(|(n, mut eps)| {
            eps.sort_by(|a, b| i(a, "episode").unwrap_or(0).cmp(&i(b, "episode").unwrap_or(0)).then_with(|| s(a, "file").cmp(s(b, "file"))));
            Season { number: n, episodes: eps }
        })
        .collect()
}
/// (season index, episode index) to start on: in progress, else after the last finished, else the first.
pub fn start_episode(seasons: &[Season], progress: &Value, watched: &Value) -> (usize, usize) {
    let all: Vec<(usize, usize, &Value)> =
        seasons.iter().enumerate().flat_map(|(si, s)| s.episodes.iter().enumerate().map(move |(ei, e)| (si, ei, *e))).collect();
    for (si, ei, e) in &all {
        if resumable(progress.get(progress_ref(e))) {
            return (*si, *ei);
        }
    }
    let mut last: isize = -1;
    for (n, (_, _, e)) in all.iter().enumerate() {
        if watched.get(progress_ref(e)).is_some() {
            last = n as isize;
        }
    }
    if all.is_empty() {
        return (0, 0);
    }
    let n = ((last + 1) as usize).min(all.len() - 1);
    (all[n].0, all[n].1)
}

pub struct Cue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}
fn parse_ts(s: &str) -> Option<f64> {
    // [h:]mm:ss.mmm
    let s = s.trim();
    let (main, ms) = s.rsplit_once(['.', ','])?;
    let parts: Vec<&str> = main.split(':').collect();
    let nums: Option<Vec<f64>> = parts.iter().map(|p| p.trim().parse::<f64>().ok()).collect();
    let nums = nums?;
    let ms: f64 = ms.trim().get(..3).unwrap_or(ms.trim()).parse().ok()?;
    let secs = match nums.len() {
        3 => nums[0] * 3600.0 + nums[1] * 60.0 + nums[2],
        2 => nums[0] * 60.0 + nums[1],
        _ => return None,
    };
    Some(secs + ms / 1000.0)
}
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = false;
    for c in s.chars() {
        match c {
            '<' => depth = true,
            '>' if depth => depth = false,
            _ if !depth => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ")
}
pub fn parse_vtt(text: &str) -> Vec<Cue> {
    let text = text.replace('\r', "");
    let mut cues = Vec::new();
    let lines: Vec<&str> = text.split('\n').collect();
    let mut n = 0;
    while n < lines.len() {
        let line = lines[n];
        if let Some((a, b)) = line.split_once("-->") {
            let b = b.split_whitespace().next().unwrap_or("");
            if let (Some(start), Some(end)) = (parse_ts(a), parse_ts(b)) {
                let mut body: Vec<&str> = Vec::new();
                n += 1;
                while n < lines.len() && !lines[n].trim().is_empty() {
                    body.push(lines[n]);
                    n += 1;
                }
                let t = String::from(strip_tags(&body.join("\n")).trim());
                if !t.is_empty() && end > start {
                    cues.push(Cue { start, end, text: t });
                }
                continue;
            }
        }
        n += 1;
    }
    cues.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(core::cmp::Ordering::Equal));
    cues
}
pub fn cue_text(cues: &[Cue], t: f64) -> String {
    let (mut lo, mut hi) = (0usize, cues.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        if cues[mid].start <= t {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let mut out: Vec<&str> = Vec::new();
    let mut k = lo;
    while k > 0 && k + 8 > lo {
        k -= 1;
        if cues[k].end > t {
            out.insert(0, &cues[k].text);
        }
    }
    out.join("\n")
}

pub fn same_title(a: &str, b: &str) -> bool {
    search_key(a) == search_key(b)
}
