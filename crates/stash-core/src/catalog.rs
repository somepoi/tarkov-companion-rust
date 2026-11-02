//! Validated recipe planning view of the existing static JSON catalog.
//! Unknown conditions remain visible gaps, never invented ingredient amounts.
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub mod hideout;
pub mod items;
pub mod maps;

pub const RECIPE_PLANNING_SCHEMA: u32 = 2;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeCatalog {
    pub planning_schema: u32,
    pub crafts: Vec<Recipe>,
    pub barters: Vec<Recipe>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    id: String,
    output_id: String,
    station_id: Option<String>,
    station_level: Option<u32>,
    trader_id: Option<String>,
    minimum_trader_level: Option<u32>,
    task_unlock: Option<String>,
    inputs: Vec<Ingredient>,
    gaps: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ingredient {
    item_id: String,
    quantity: Option<u32>,
    tool: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    minimum_dogtag_level: Option<u32>,
}

#[derive(Clone, Copy)]
pub enum RecipeKind {
    Craft,
    Barter,
}

fn id(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 512 && !s.contains('\0'))
        .map(str::to_owned)
}

fn count(value: &Value) -> Option<u32> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= f64::from(u32::MAX) && n.fract() == 0.0)
        .map(|n| n as u32)
}

pub fn recipes(document: &Value, kind: RecipeKind) -> Result<Vec<Recipe>, String> {
    let craft = matches!(kind, RecipeKind::Craft);
    let label = if craft { "craft" } else { "barter" };
    let list: Vec<&Value> = match &document["data"] {
        Value::Array(rows) => rows.iter().collect(),
        Value::Object(rows) => rows.values().collect(),
        _ => return Err(format!("Invalid {label} catalog")),
    };
    if list.len() > 10_000 {
        return Err(format!("{label} catalog exceeds the supported size"));
    }
    let mut ids = BTreeSet::new();
    let mut input_total = 0usize;
    list.into_iter()
        .map(|raw| {
            let recipe_id = id(&raw["id"]).ok_or_else(|| format!("Invalid {label} identifier"))?;
            let output_id = id(&raw[if craft { "productItem" } else { "offeredItem" }]["item"])
                .ok_or_else(|| format!("Invalid {label} output identifier"))?;
            if !ids.insert(recipe_id.clone()) {
                return Err(format!("Duplicate {label} identifier"));
            }
            let mut gaps = Vec::new();
            let task_unlock = id(&raw["taskUnlock"]);
            if !raw["taskUnlock"].is_null() && task_unlock.is_none() {
                gaps.push("Invalid quest unlock condition".into());
            }
            if !craft && raw.get("taskUnlock").is_none() {
                gaps.push("Quest unlock coverage is unknown".into());
            }
            if craft && !raw["gameEditions"].as_array().is_some_and(Vec::is_empty) {
                gaps.push("Game edition access is unknown or restricted".into());
            }
            let trader_id = if craft { None } else { id(&raw["trader"]) };
            let minimum_trader_level = if craft {
                None
            } else {
                count(&raw["minTraderLevel"])
            };
            if !craft && (trader_id.is_none() || minimum_trader_level.is_none_or(|level| level > 8))
            {
                gaps.push("Trader loyalty requirement is unknown or unsupported".into());
            }
            let required = raw["requiredItems"]
                .as_array()
                .ok_or_else(|| format!("Missing {label} inputs"))?;
            input_total += required.len();
            if required.len() > 256 || input_total > 65_536 {
                return Err(format!("{label} inputs exceed the supported workload"));
            }
            let mut inputs = Vec::new();
            let mut tools = BTreeMap::<String, Ingredient>::new();
            for input in required {
                let item_id =
                    id(&input["item"]).ok_or_else(|| format!("Missing {label} input item"))?;
                let quantity = count(&input["count"]);
                if quantity.is_none() {
                    gaps.push("Unknown or fractional input quantity".into());
                }
                let attributes = &input["attributes"];
                if !attributes.is_null() && !attributes.is_object() {
                    gaps.push("Malformed input attributes".into());
                }
                let unsupported: Vec<&str> = attributes
                    .as_object()
                    .into_iter()
                    .flat_map(|a| a.keys())
                    .map(String::as_str)
                    .filter(|k| !((craft && *k == "tool") || (!craft && *k == "minLevel")))
                    .collect();
                if !unsupported.is_empty() {
                    gaps.push(format!(
                        "Unsupported input conditions: {}",
                        unsupported.join(", ")
                    ));
                }
                if attributes.get("tool").is_some() && !attributes["tool"].is_boolean() {
                    gaps.push("Unknown tool condition".into());
                }
                let minimum_dogtag_level = if !craft && attributes.get("minLevel").is_some() {
                    match count(&attributes["minLevel"]) {
                        Some(0) => None,
                        Some(level) if level <= 1000 => Some(level),
                        _ => {
                            gaps.push("Invalid minimum dogtag level".into());
                            None
                        }
                    }
                } else {
                    None
                };
                let mut ingredient = Ingredient {
                    item_id,
                    quantity,
                    tool: craft && attributes["tool"] == true,
                    minimum_dogtag_level,
                };
                if ingredient.tool {
                    if let Some(previous) = tools.get(&ingredient.item_id) {
                        ingredient.quantity = previous
                            .quantity
                            .zip(ingredient.quantity)
                            .and_then(|(a, b)| a.checked_add(b));
                    }
                    tools.insert(ingredient.item_id.clone(), ingredient);
                } else {
                    inputs.push(ingredient);
                }
            }
            if craft {
                match raw["requiredQuestItems"].as_array() {
                    Some(items) if !items.is_empty() => {
                        gaps.push("Quest-item craft inputs require review".into())
                    }
                    None => gaps.push("Quest-item input coverage is unknown".into()),
                    _ => {}
                }
            }
            let station_id = if craft { id(&raw["station"]) } else { None };
            let station_level = if craft { count(&raw["level"]) } else { None };
            if craft && (station_id.is_none() || station_level.is_none()) {
                gaps.push("Craft station requirement is unknown".into());
            }
            inputs.extend(tools.into_values());
            Ok(Recipe {
                id: recipe_id,
                output_id,
                station_id,
                station_level,
                trader_id,
                minimum_trader_level,
                task_unlock,
                inputs,
                gaps,
            })
        })
        .collect()
}
