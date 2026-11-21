//! A copy of `normalizeAgentAvatar` from `shared/agent-avatar.mjs`.
//! A Rust daemon needs its own copy of each shared rule like this one.

use serde_json::{json, Value};

const CHARACTERS: &[&str] = &[
    "orbit", "prism", "tide", "spark", "bloom", "beacon", "fern", "pip", "pebble", "moss", "wren",
    "ember", "cosmo", "nimbus", "comet", "lune", "ripple", "vesper",
];
const COLORS: &[&str] = &["sage", "blue", "lilac", "rose", "amber", "graphite", "pearl"];
const IMAGE_MAX_BYTES: usize = 32_768;
const IMAGE_MAX_DIMENSION: u32 = 96;
const PREFIX: &str = "data:image/png;base64,";

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut bits: u32 = 0;
    let mut count = 0;
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let trimmed = text.trim_end_matches('=');
    if text.len() - trimmed.len() > 2 {
        return None;
    }
    for byte in trimmed.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32;
        bits = (bits << 6) | value;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    // atob rejects a final group of one character.
    if trimmed.len() % 4 == 1 {
        return None;
    }
    Some(out)
}

fn valid_png(value: &str) -> bool {
    if value.len() > 43_714 || !value.starts_with(PREFIX) {
        return false;
    }
    let encoded = &value[PREFIX.len()..];
    let body = encoded.trim_end_matches('=');
    if body.is_empty() || encoded.len() - body.len() > 2 {
        return false;
    }
    if !body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/') {
        return false;
    }
    let Some(data) = base64_decode(encoded) else { return false };
    if data.len() > IMAGE_MAX_BYTES || !data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return false;
    }
    let uint = |offset: usize| -> u64 {
        u32::from_be_bytes([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]]) as u64
    };
    let mut offset = 8usize;
    let mut pixels = false;
    while offset + 12 <= data.len() {
        let length = uint(offset) as usize;
        let kind = &data[offset + 4..offset + 8];
        if offset + 12 + length > data.len() {
            return false;
        }
        if offset == 8 {
            if kind != b"IHDR" || length != 13 {
                return false;
            }
            let width = uint(offset + 8) as u32;
            let height = uint(offset + 12) as u32;
            if width < 1 || height < 1 || width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION {
                return false;
            }
        } else if matches!(kind, b"IHDR" | b"acTL" | b"fcTL" | b"fdAT") {
            return false;
        }
        if kind == b"IDAT" {
            pixels = true;
        }
        if kind == b"IEND" {
            return pixels && length == 0 && offset + 12 == data.len();
        }
        offset += 12 + length;
    }
    false
}

/// The avatar as the TypeScript store keeps it, or `None` (the key is dropped).
pub fn normalize(value: &Value) -> Option<Value> {
    let avatar = value.as_object()?;
    let kind = avatar.get("kind").and_then(Value::as_str);
    if kind == Some("image") {
        let data_url = avatar.get("dataUrl").and_then(Value::as_str)?;
        return valid_png(data_url).then(|| json!({ "kind": "image", "dataUrl": data_url }));
    }
    let color = avatar.get("color").and_then(Value::as_str).filter(|c| COLORS.contains(c))?;
    match kind {
        Some("initials") => Some(json!({ "kind": "initials", "color": color })),
        Some("character") => {
            let character = avatar.get("character").and_then(Value::as_str).filter(|c| CHARACTERS.contains(c))?;
            Some(json!({ "kind": "character", "character": character, "color": color }))
        }
        _ => None,
    }
}
