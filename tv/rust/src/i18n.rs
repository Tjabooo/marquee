//! Swedish lines from public/tv/sv.js (built in by build.rs), keyed by the English line; English when missing.
use alloc::string::String;

include!(concat!(env!("OUT_DIR"), "/sv.rs"));

pub fn tr(en: &'static str) -> &'static str {
    match SV.binary_search_by(|(k, _)| (*k).cmp(en)) {
        Ok(i) => SV[i].1,
        Err(_) => en,
    }
}

/// The line with {0}, {1}… filled in.
pub fn trf(en: &'static str, args: &[&str]) -> String {
    let t = tr(en);
    let mut out = String::with_capacity(t.len() + 16);
    let mut rest = t;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('}') {
            Some(j) => match after[..j].parse::<usize>() {
                Ok(n) => {
                    out.push_str(args.get(n).copied().unwrap_or(""));
                    rest = &after[j + 1..];
                }
                Err(_) => {
                    out.push('{');
                    rest = after;
                }
            },
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[macro_export]
macro_rules! t {
    ($s:literal) => {
        $crate::i18n::tr($s)
    };
    ($s:literal, $($a:expr),+) => {
        $crate::i18n::trf($s, &[$(&*$a),+])
    };
}
