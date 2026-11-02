//! Native hideout adapter. Display translation never changes material facts.
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Station {
    id: String,
    name: String,
    normalized_name: String,
    image_link: Option<String>,
    levels: Vec<Level>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Level {
    id: String,
    level: u32,
    construction_time: f64,
    trader_requirements: Vec<TraderGate>,
    station_level_requirements: Vec<StationGate>,
    item_requirements: Vec<ItemInput>,
    skill_requirements: Vec<SkillGate>,
    bonuses: Vec<Bonus>,
    description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TraderGate {
    trader_id: String,
    level: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StationGate {
    station_id: String,
    level: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemInput {
    item_id: String,
    count: Option<u64>,
    found_in_raid: Option<bool>,
}
#[derive(Serialize)]
struct SkillGate {
    skill: String,
    level: f64,
}
#[derive(Serialize)]
struct Bonus {
    r#type: String,
    name: String,
    value: Option<f64>,
    skill: Option<String>,
}

fn text(value: &Value, limit: usize) -> Result<String, String> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= limit && !s.contains('\0'))
        .map(str::to_owned)
        .ok_or_else(|| "Invalid hideout text or identifier".into())
}
fn number(value: &Value) -> Result<f64, String> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .ok_or_else(|| "Invalid hideout numeric requirement".into())
}
fn level_number(value: &Value) -> Result<u32, String> {
    super::count(value).ok_or_else(|| "Invalid hideout level".into())
}
fn rows<'a>(raw: &'a Value, key: &str, budget: &mut usize) -> Result<&'a [Value], String> {
    let values = if raw[key].is_null() {
        &[][..]
    } else {
        raw[key]
            .as_array()
            .ok_or_else(|| format!("Invalid hideout {key}"))?
            .as_slice()
    };
    *budget += values.len();
    if values.len() > 4096 || *budget > 65_536 {
        return Err("Hideout requirements exceed the supported workload".into());
    }
    Ok(values)
}
fn translated(dict: &Value, key: &Value, fallback: &str) -> Result<String, String> {
    let result = key
        .as_str()
        .filter(|s| !s.is_empty())
        .and_then(|s| dict.get(s))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(fallback);
    if result.len() > 65_536 || result.contains('\0') {
        return Err("Hideout translation exceeds supported text limits".into());
    }
    Ok(result.to_owned())
}

pub fn adapt(document: &Value, english: &Value) -> Result<Vec<Station>, String> {
    let data = document["data"]
        .as_object()
        .ok_or("Invalid hideout catalog")?;
    let dict = &english["data"];
    if !dict.is_null() && !dict.is_object() {
        return Err("Invalid hideout English dictionary".into());
    }
    if data.len() > 512 {
        return Err("Hideout catalog exceeds 512 stations".into());
    }
    let mut ids = BTreeSet::new();
    let mut budget = 0;
    data.values()
        .map(|raw| {
            let id = text(&raw["id"], 512)?;
            if !ids.insert(id.clone()) {
                return Err("Duplicate hideout station identifier".into());
            }
            let normalized_name = text(&raw["normalizedName"], 512)?;
            let source_levels = raw["levels"].as_array().ok_or("Missing hideout levels")?;
            if source_levels.len() > 256 {
                return Err("Hideout station exceeds 256 levels".into());
            }
            let mut level_ids = BTreeSet::new();
            let mut level_numbers = BTreeSet::new();
            let mut levels = source_levels
                .iter()
                .map(|raw| {
                    let id = text(&raw["id"], 512)?;
                    let level = level_number(&raw["level"])?;
                    if !level_ids.insert(id.clone()) || !level_numbers.insert(level) {
                        return Err("Duplicate hideout level".into());
                    }
                    let trader_requirements = rows(raw, "traderRequirements", &mut budget)?
                        .iter()
                        .map(|r| {
                            Ok(TraderGate {
                                trader_id: text(&r["trader"], 512)?,
                                level: number(&r["value"])?,
                            })
                        })
                        .collect::<Result<_, String>>()?;
                    let station_level_requirements =
                        rows(raw, "stationLevelRequirements", &mut budget)?
                            .iter()
                            .map(|r| {
                                Ok(StationGate {
                                    station_id: text(&r["station"], 512)?,
                                    level: level_number(&r["level"])?,
                                })
                            })
                            .collect::<Result<_, String>>()?;
                    let item_requirements = rows(raw, "itemRequirements", &mut budget)?
                        .iter()
                        .map(|r| {
                            let count = r["count"]
                                .as_f64()
                                .filter(|n| {
                                    n.is_finite()
                                        && *n >= 0.0
                                        && *n <= 9_007_199_254_740_991.0
                                        && n.fract() == 0.0
                                })
                                .map(|n| n as u64);
                            Ok(ItemInput {
                                item_id: text(&r["item"], 512)?,
                                count,
                                found_in_raid: r["attributes"]["foundInRaid"].as_bool(),
                            })
                        })
                        .collect::<Result<_, String>>()?;
                    let skill_requirements = rows(raw, "skillRequirements", &mut budget)?
                        .iter()
                        .map(|r| {
                            let key = text(&r["skill"], 512)?;
                            Ok(SkillGate {
                                skill: translated(dict, &r["skill"], &key)?,
                                level: number(&r["level"])?,
                            })
                        })
                        .collect::<Result<_, String>>()?;
                    let bonuses = rows(raw, "bonuses", &mut budget)?
                        .iter()
                        .map(|b| {
                            let kind = text(&b["type"], 512)?;
                            let skill = if b["skill"].is_null() || b["skill"].as_str() == Some("") {
                                None
                            } else {
                                let key = text(&b["skill"], 512)?;
                                Some(translated(dict, &b["skill"], &key)?)
                            };
                            Ok(Bonus {
                                name: translated(dict, &b["name"], &kind)?,
                                r#type: kind,
                                value: b["value"].as_f64(),
                                skill,
                            })
                        })
                        .collect::<Result<_, String>>()?;
                    Ok(Level {
                        id,
                        level,
                        construction_time: if raw["constructionTime"].is_null() {
                            0.0
                        } else {
                            number(&raw["constructionTime"])?
                        },
                        trader_requirements,
                        station_level_requirements,
                        item_requirements,
                        skill_requirements,
                        bonuses,
                        description: translated(dict, &raw["description"], "")?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            levels.sort_by_key(|l| l.level);
            let image_link = if raw["imageLink"].is_null() {
                None
            } else {
                Some(
                    raw["imageLink"]
                        .as_str()
                        .filter(|s| s.len() <= 4096 && !s.contains('\0'))
                        .ok_or("Invalid hideout image link")?
                        .to_owned(),
                )
            };
            Ok(Station {
                id,
                name: translated(dict, &raw["name"], &normalized_name)?,
                normalized_name,
                image_link,
                levels,
            })
        })
        .collect()
}
