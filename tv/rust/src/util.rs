//! Small helpers for the server's JSON and for text.
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde_json::Value;

pub static EMPTY: Vec<Value> = Vec::new();

pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}
pub fn f(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64())
}
pub fn i(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(|x| x.as_f64()).map(|n| n as i64)
}
pub fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(false)
}
pub fn has(v: &Value, k: &str) -> bool {
    v.get(k).map(|x| !x.is_null()).unwrap_or(false)
}
pub fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(|x| x.as_array()).map(|a| a.as_slice()).unwrap_or(&EMPTY)
}
/// An ID that may be a number or a string, as text ("" when missing).
pub fn id(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => match n.as_i64() {
            Some(i) => i.to_string(),
            None => n.to_string(),
        },
        _ => String::new(),
    }
}
pub fn year(v: &Value) -> String {
    match i(v, "year") {
        Some(y) if y > 0 => y.to_string(),
        _ => String::new(),
    }
}

pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(char::from_digit((b >> 4) as u32, 16).unwrap().to_ascii_uppercase());
            out.push(char::from_digit((b & 15) as u32, 16).unwrap().to_ascii_uppercase());
        }
    }
    out
}

pub fn join(parts: &[&str], sep: &str) -> String {
    let v: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    v.join(sep)
}

pub fn floor(x: f64) -> f64 {
    libm::floor(x)
}
pub fn ceil(x: f64) -> f64 {
    libm::ceil(x)
}

/// Lower case, accents and punctuation gone: "Spider-Man: Amélie" → "spidermanamelie".
pub fn search_key(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let c = fold(c);
        for l in c.to_lowercase() {
            if l.is_ascii_alphanumeric() {
                out.push(l);
            }
        }
    }
    out
}
fn fold(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' => 'a',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'È' | 'É' | 'Ê' | 'Ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'Ì' | 'Í' | 'Î' | 'Ï' => 'i',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'Ù' | 'Ú' | 'Û' | 'Ü' => 'u',
        'ý' | 'ÿ' | 'Ý' => 'y',
        'ñ' | 'Ñ' => 'n',
        'ç' | 'Ç' => 'c',
        'š' | 'Š' => 's',
        'ž' | 'Ž' => 'z',
        _ => c,
    }
}

pub fn lower(s: &str) -> String {
    s.chars().flat_map(|c| c.to_lowercase()).collect()
}
