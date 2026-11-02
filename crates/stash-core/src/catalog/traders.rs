//! Trader names and loyalty metadata, independent of desktop/UI APIs.
use chrono::DateTime;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trader {
    id: String,
    name: String,
    normalized_name: String,
    image_link: Option<String>,
    currency: String,
    reset_time: Option<i64>,
    max_level: usize,
    levels: Vec<Level>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Level {
    level: f64,
    player_level: f64,
    reputation: f64,
}

fn text(value: &Value, limit: usize) -> Result<String, String> {
    value
        .as_str()
        .filter(|s| s.len() <= limit && !s.contains('\0'))
        .map(str::to_owned)
        .ok_or_else(|| "Invalid trader text".into())
}
fn id(value: &Value) -> Result<String, String> {
    let id = text(value, 512)?;
    if id.is_empty() {
        return Err("Missing trader identifier".into());
    }
    Ok(id)
}
fn number_or_zero(value: &Value) -> Result<f64, String> {
    if value.is_null() {
        return Ok(0.0);
    }
    value
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or_else(|| "Invalid trader loyalty requirement".into())
}
fn reset_time(value: &Value) -> Option<i64> {
    let source = value.as_str().filter(|s| !s.is_empty() && s.len() <= 512)?;
    let date = DateTime::parse_from_rfc3339(source).ok()?;
    // Date.parse rejects leap seconds; never turn one into a plausible countdown.
    (date.timestamp_subsec_nanos() < 1_000_000_000).then(|| date.timestamp_millis())
}

pub fn adapt(document: &Value, english: &Value) -> Result<Vec<Trader>, String> {
    let source = document["data"]
        .as_object()
        .ok_or("Invalid trader catalog")?;
    let dictionary = &english["data"];
    if !dictionary.is_null() && !dictionary.is_object() {
        return Err("Invalid trader English dictionary".into());
    }
    if source.len() > 512 {
        return Err("Trader catalog exceeds 512 entries".into());
    }
    let mut ids = BTreeSet::new();
    let mut total_levels = 0;
    let mut output_bytes = 2;
    source
        .values()
        .map(|raw| {
            let id = id(&raw["id"])?;
            if !ids.insert(id.clone()) {
                return Err("Duplicate trader identifier".into());
            }
            let normalized_name = text(&raw["normalizedName"], 512)?;
            let name = raw["name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .and_then(|key| dictionary.get(key))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&normalized_name);
            let name = text(&Value::String(name.to_owned()), 65_536)?;
            let rows = if raw["levels"].is_null() {
                &[][..]
            } else {
                raw["levels"]
                    .as_array()
                    .ok_or("Invalid trader levels")?
                    .as_slice()
            };
            total_levels += rows.len();
            if rows.len() > 256 || total_levels > 16_384 {
                return Err("Trader levels exceed supported workload".into());
            }
            let mut levels = Vec::new();
            for row in rows {
                let Some(level) = row["level"].as_f64() else {
                    continue;
                };
                levels.push(Level {
                    level,
                    player_level: number_or_zero(&row["requiredPlayerLevel"])?,
                    reputation: number_or_zero(&row["requiredReputation"])?,
                });
            }
            levels.sort_by(|a, b| a.level.total_cmp(&b.level));
            let trader = Trader {
                id,
                name,
                normalized_name,
                image_link: if raw["imageLink"].is_null() {
                    None
                } else {
                    Some(text(&raw["imageLink"], 4096)?)
                },
                currency: if raw["currency"].is_null() {
                    "RUB".into()
                } else {
                    text(&raw["currency"], 512)?
                },
                reset_time: reset_time(&raw["resetTime"]),
                max_level: rows.len().max(1),
                levels,
            };
            output_bytes += serde_json::to_vec(&trader)
                .map_err(|e| e.to_string())?
                .len()
                + 1;
            if output_bytes > 8 * 1024 * 1024 {
                return Err("Normalized trader catalog exceeds 8 MiB".into());
            }
            Ok(trader)
        })
        .collect()
}
