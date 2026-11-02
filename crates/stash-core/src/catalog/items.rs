//! Item normalization, preserving the frontend's price, scanner and equipment view.
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

const ANY_DOGTAG: &str = "customdogtags12345678910";
const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Default)]
struct Budget {
    rows: usize,
    output: usize,
}
impl Budget {
    fn rows<'a>(&mut self, value: &'a Value) -> Result<&'a [Value], String> {
        let rows = if value.is_null() {
            &[][..]
        } else {
            value
                .as_array()
                .ok_or("Invalid item catalog list")?
                .as_slice()
        };
        self.rows += rows.len();
        if rows.len() > 16_384 || self.rows > 1_048_576 {
            return Err("Item catalog lists exceed supported workload".into());
        }
        Ok(rows)
    }
    fn strings(&mut self, value: &Value) -> Result<Vec<String>, String> {
        self.rows(value)?.iter().map(identifier).collect()
    }
    fn output(&mut self, value: &Value) -> Result<(), String> {
        self.output += serde_json::to_vec(value).map_err(|e| e.to_string())?.len();
        if self.output > 64 * 1024 * 1024 {
            return Err("Normalized item catalog exceeds 64 MiB".into());
        }
        Ok(())
    }
}
fn identifier(value: &Value) -> Result<String, String> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 512 && !s.contains('\0'))
        .map(str::to_owned)
        .ok_or_else(|| "Invalid item catalog identifier".into())
}
fn optional_text(value: &Value) -> Result<Option<String>, String> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .filter(|s| s.len() <= 65_536 && !s.contains('\0'))
        .map(|s| Some(s.to_owned()))
        .ok_or_else(|| "Invalid item catalog text".into())
}
fn translated(dict: &Value, key: &Value, fallback: &str) -> Result<String, String> {
    let value = key
        .as_str()
        .filter(|s| !s.is_empty())
        .and_then(|s| dict.get(s))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(fallback);
    optional_text(&json!(value)).map(|s| s.unwrap_or_default())
}
fn picture(value: &Value) -> Result<Option<String>, String> {
    Ok(optional_text(value)?.filter(|s| !s.is_empty() && !s.contains("/unknown-item")))
}
fn number(value: &Value, fallback: f64) -> f64 {
    value.as_f64().filter(|n| n.is_finite()).unwrap_or(fallback)
}
fn integer(value: &Value, positive: bool) -> Value {
    value
        .as_f64()
        .filter(|n| {
            n.is_finite()
                && *n >= 0.0
                && (!positive || *n > 0.0)
                && *n <= SAFE_INTEGER
                && n.fract() == 0.0
        })
        .map_or(Value::Null, |n| json!(n))
}
fn rate(value: &Value) -> Value {
    value
        .as_f64()
        .filter(|n| *n >= 0.0 && *n <= 1.0)
        .map_or(Value::Null, |n| json!(n))
}

fn slots(value: &Value, budget: &mut Budget) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for slot in budget.rows(value)? {
        let (Some(id), Some(name)) = (slot["id"].as_str(), slot["nameId"].as_str()) else {
            continue;
        };
        if name.starts_with("camora") {
            continue;
        }
        let allowed = budget
            .rows(&slot["filters"]["allowedItems"])?
            .iter()
            .filter(|v| v.is_string())
            .map(identifier)
            .collect::<Result<Vec<_>, _>>()?;
        if allowed.is_empty() {
            continue;
        }
        out.push(json!({"id": id, "nameId": name, "required": slot["required"] == true, "allowed": allowed}));
    }
    Ok(out)
}
fn ammo(p: &Value) -> Option<Value> {
    if p["propertiesType"] != "ItemPropertiesAmmo"
        || !p["caliber"].as_str().is_some_and(|s| !s.is_empty())
    {
        return None;
    }
    Some(json!({
        "caliber": p["caliber"], "ammoType": p.get("ammoType").filter(|v| !v.is_null()).unwrap_or(&json!("bullet")),
        "damage": number(&p["damage"], 0.0), "projectileCount": number(&p["projectileCount"], 1.0).max(1.0),
        "penetrationPower": number(&p["penetrationPower"], 0.0), "armorDamage": number(&p["armorDamage"], 0.0),
        "fragmentationChance": number(&p["fragmentationChance"], 0.0), "ricochetChance": number(&p["ricochetChance"], 0.0),
        "initialSpeed": number(&p["initialSpeed"], 0.0), "tracer": p["tracer"] == true,
        "tracerColor": if p["tracer"] == true { p["tracerColor"].as_str().filter(|s| !s.is_empty()) } else { None },
        "accuracyModifier": number(&p["accuracyModifier"], 0.0), "recoilModifier": number(&p["recoilModifier"], 0.0),
        "lightBleedModifier": number(&p["lightBleedModifier"], 0.0), "heavyBleedModifier": number(&p["heavyBleedModifier"], 0.0)
    }))
}
fn equipment(raw: &Value, item: &mut Value, budget: &mut Budget) -> Result<(), String> {
    let p = &raw["properties"];
    if p.is_null() {
        return Ok(());
    }
    let conflicts = budget
        .rows(&raw["conflictingItems"])?
        .iter()
        .filter(|v| v.is_string())
        .map(identifier)
        .collect::<Result<Vec<_>, _>>()?;
    match p["propertiesType"].as_str() {
        Some("ItemPropertiesWeapon")
            if item["types"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == "gun")) =>
        {
            item["weapon"] = json!({
                "caliber": p["caliber"].as_str().unwrap_or(""), "ergonomics": number(&p["ergonomics"], 0.0),
                "recoilVertical": number(&p["recoilVertical"], 0.0), "recoilHorizontal": number(&p["recoilHorizontal"], 0.0),
                "fireRate": number(&p["fireRate"], 0.0), "effectiveDistance": number(&p["effectiveDistance"], 0.0),
                "fireModes": budget.strings(&p["fireModes"])?, "weight": number(&raw["weight"], 0.0),
                "slots": slots(&p["slots"], budget)?, "defaultPreset": optional_text(&p["defaultPreset"])?,
                "presets": budget.strings(&p["presets"])?, "conflicts": conflicts
            });
        }
        Some(
            "ItemPropertiesWeaponMod"
            | "ItemPropertiesScope"
            | "ItemPropertiesBarrel"
            | "ItemPropertiesMagazine",
        ) => {
            item["mod"] = json!({"ergonomics": number(&p["ergonomics"], 0.0), "recoilModifier": number(&p["recoilModifier"], 0.0),
                "accuracyModifier": number(&p["accuracyModifier"], 0.0), "weight": number(&raw["weight"], 0.0),
                "slots": slots(&p["slots"], budget)?, "conflicts": conflicts});
        }
        Some("ItemPropertiesPreset") if p["baseItem"].is_string() => {
            let base = identifier(&p["baseItem"])?;
            let parts = budget
                .rows(&raw["containsItems"])?
                .iter()
                .filter_map(|v| v["item"].as_str())
                .filter(|id| *id != base)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            item["preset"] = json!({"baseItem": base, "parts": parts, "ergonomics": number(&p["ergonomics"], 0.0),
                "recoilVertical": number(&p["recoilVertical"], 0.0), "recoilHorizontal": number(&p["recoilHorizontal"], 0.0), "isDefault": p["default"] == true});
        }
        _ => {}
    }
    if item.get("weapon").is_some() || item.get("mod").is_some() || item.get("preset").is_some() {
        if let Some(link) = picture(&raw["gridImageLink"])? {
            item["gridImageLink"] = json!(link);
        }
        if let Some(link) = picture(&raw["image512pxLink"])? {
            item["image512Link"] = json!(link);
        }
    }
    Ok(())
}
fn dogtags(raw: &Value, all: &Map<String, Value>) -> Value {
    let Some(members) = raw["containsItems"]
        .as_array()
        .filter(|m| !m.is_empty() && m.len() <= 256)
    else {
        return Value::Null;
    };
    let mut ids = BTreeSet::new();
    for member in members {
        let Some(id) = member["item"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 512)
        else {
            return Value::Null;
        };
        if id == ANY_DOGTAG
            || member["count"].as_f64() != Some(1.0)
            || !member["attributes"].as_object().is_some_and(Map::is_empty)
            || !ids.insert(id)
        {
            return Value::Null;
        }
        let Some(item) = all.get(id) else {
            return Value::Null;
        };
        if item["id"] != id
            || !item["types"].is_array()
            || item["types"]
                .as_array()
                .is_some_and(|types| types.iter().any(|v| v == "preset"))
            || !item["containsItems"].as_array().is_some_and(Vec::is_empty)
        {
            return Value::Null;
        }
    }
    json!(ids)
}
fn offers(value: &Value, buying: bool, budget: &mut Budget) -> Result<Vec<Value>, String> {
    let mut offers = Vec::new();
    for raw in budget.rows(value)? {
        let Some(price) = raw["priceRUB"].as_f64() else {
            continue;
        };
        let mut offer = json!({"traderId": identifier(&raw["trader"])?, "priceRUB": price});
        if buying {
            if let Some(level) = raw.get("minTraderLevel") {
                offer["minTraderLevel"] = level.clone();
            }
            if let Some(limit) = raw["buyLimit"].as_f64() {
                offer["buyLimit"] = json!(limit);
            }
            offer["taskUnlock"] = json!(optional_text(&raw["taskUnlock"])?);
        }
        offers.push(offer);
    }
    offers.sort_by(|a, b| {
        let order = a["priceRUB"]
            .as_f64()
            .unwrap_or_default()
            .total_cmp(&b["priceRUB"].as_f64().unwrap_or_default());
        if buying { order } else { order.reverse() }
    });
    Ok(offers)
}
fn plain_variant(name: &str) -> String {
    for (offset, _) in name.match_indices(" (") {
        if let Some(end) = name[offset + 2..].find(')') {
            let after = &name[offset + 3 + end..];
            if matches!(after, "" | " Default") {
                return format!("{}{after}", &name[..offset]);
            }
        }
    }
    name.to_owned()
}
fn borrow_pictures(items: &mut Map<String, Value>, budget: &mut Budget) -> Result<(), String> {
    let by_name: BTreeMap<_, _> = items
        .iter()
        .map(|(id, item)| {
            (
                item["name"].as_str().unwrap_or_default().to_owned(),
                id.clone(),
            )
        })
        .collect();
    let ids = items.keys().cloned().collect::<Vec<_>>();
    for id in ids {
        let item = &items[&id];
        if (item.get("weapon").is_none() && item.get("preset").is_none())
            || (!item["iconLink"].is_null() && !item["image512Link"].is_null())
        {
            continue;
        }
        let name = item["name"].as_str().unwrap_or_default();
        let plain = plain_variant(name);
        if plain == name {
            continue;
        }
        let Some(twin) = by_name
            .get(&plain)
            .and_then(|id| items.get(id))
            .filter(|twin| !twin["iconLink"].is_null())
        else {
            continue;
        };
        budget.output(&json!([
            plain,
            twin["iconLink"],
            twin["gridImageLink"],
            twin["image512Link"]
        ]))?;
        // Read the current twin, as the reference can borrow through an earlier variant.
        let (icon, grid, large) = (
            twin["iconLink"].clone(),
            twin["gridImageLink"].clone(),
            twin["image512Link"].clone(),
        );
        let Some(item) = items.get_mut(&id) else {
            continue;
        };
        if item["iconLink"].is_null() {
            item["iconLink"] = icon;
        }
        if item["gridImageLink"].is_null() && !grid.is_null() {
            item["gridImageLink"] = grid;
        }
        if item["image512Link"].is_null() && !large.is_null() {
            item["image512Link"] = large;
        }
        item["pictureOf"] = json!(plain);
    }
    Ok(())
}
pub fn adapt(
    document: &Value,
    english: &Value,
    mode: &str,
    fetched_at: u64,
) -> Result<Value, String> {
    let data = &document["data"];
    let source = data["items"].as_object().ok_or("Invalid item catalog")?;
    if source.len() > 32_768 {
        return Err("Item catalog exceeds supported item count".into());
    }
    let dict = &english["data"];
    if !dict.is_null() && !dict.is_object() {
        return Err("Invalid item English dictionary".into());
    }
    let mut budget = Budget::default();
    let mut items = Map::new();
    for raw in source.values() {
        let id = identifier(&raw["id"])?;
        if items.contains_key(&id) {
            return Err("Duplicate item identifier".into());
        }
        let normalized = identifier(&raw["normalizedName"])?;
        let width = if raw["width"].is_null() {
            1.0
        } else {
            raw["width"].as_f64().ok_or("Invalid item width")?
        };
        let height = if raw["height"].is_null() {
            1.0
        } else {
            raw["height"].as_f64().ok_or("Invalid item height")?
        };
        let mut item = json!({
            "id": id, "name": translated(dict, &raw["name"], &normalized)?, "shortName": translated(dict, &raw["shortName"], &normalized)?, "normalizedName": normalized,
            "iconLink": picture(&raw["iconLink"])?, "wikiLink": optional_text(&raw["wikiLink"])?,
            "avg24hPrice": raw["avg24hPrice"].as_f64(), "fleaLevel": integer(&raw["minLevelForFlea"], false),
            "lastLowPrice": raw["lastLowPrice"].as_f64(), "low24hPrice": raw["low24hPrice"].as_f64(), "high24hPrice": raw["high24hPrice"].as_f64(),
            "changeLast48hPercent": raw["changeLast48hPercent"].as_f64(), "basePrice": number(&raw["basePrice"], 0.0),
            "width": if width == 0.0 { 1.0 } else { width }, "height": if height == 0.0 { 1.0 } else { height },
            "stackMaxSize": integer(&raw["stackMaxSize"], true), "types": budget.strings(&raw["types"])?, "categories": budget.strings(&raw["categories"])?,
            "sellToTrader": offers(&raw["sellToTrader"], false, &mut budget)?, "buyFromTrader": offers(&raw["buyFromTrader"], true, &mut budget)?, "updated": optional_text(&raw["updated"])?
        });
        if id == ANY_DOGTAG {
            item["dogtagAlternatives"] = dogtags(raw, source);
        }
        if let Some(stats) = ammo(&raw["properties"]) {
            item["ammo"] = stats;
        }
        equipment(raw, &mut item, &mut budget)?;
        budget.output(&item)?;
        items.insert(id, item);
    }
    borrow_pictures(&mut items, &mut budget)?;
    let mut levels: Vec<Value> = budget
        .rows(&data["playerLevels"])?
        .iter()
        .filter(|l| l["level"].is_number() && l["exp"].is_number())
        .map(|l| json!({"level": l["level"], "exp": l["exp"]}))
        .collect();
    levels.sort_by(|a, b| number(&a["level"], 0.0).total_cmp(&number(&b["level"], 0.0)));
    let mut categories = Map::new();
    if !data["itemCategories"].is_null() {
        let rows = data["itemCategories"]
            .as_object()
            .ok_or("Invalid item category catalog")?;
        if rows.len() > 16_384 {
            return Err("Item category catalog exceeds supported workload".into());
        }
        for (key, value) in rows {
            if value["name"].as_str().is_some_and(|s| !s.is_empty()) {
                let id = value["id"].as_str().unwrap_or(key);
                let name = json!(translated(
                    dict,
                    &value["name"],
                    value["normalizedName"].as_str().unwrap_or(key)
                )?);
                let id = identifier(&json!(id))?;
                budget.output(&json!([id, name]))?;
                categories.insert(id, name);
            }
        }
    }
    let market = &data["fleaMarket"];
    let metadata = json!({"playerLevels": levels, "categoryNames": categories, "fleaMarket": {
        "enabled": market["enabled"].as_bool(), "minPlayerLevel": integer(&market["minPlayerLevel"], false),
        "foundInRaidRequired": market["foundInRaidRequired"].as_bool(), "sellOfferFeeRate": rate(&market["sellOfferFeeRate"]), "sellRequirementFeeRate": rate(&market["sellRequirementFeeRate"])
    }});
    budget.output(&metadata)?;
    Ok(
        json!({"planningSchema": 2, "items": items, "playerLevels": metadata["playerLevels"], "categoryNames": metadata["categoryNames"],
        "mode": mode, "fetchedAt": fetched_at, "fleaMarket": metadata["fleaMarket"]}),
    )
}
