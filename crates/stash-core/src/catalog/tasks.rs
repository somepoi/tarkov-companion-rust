//! Quest/objective adaptation. Preserve existing condition and alternative gaps.
use super::canonical::objective_definition;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

#[derive(Default)]
struct Budget {
    rows: usize,
    bytes: usize,
}
impl Budget {
    fn rows<'a>(&mut self, v: &'a Value) -> Result<&'a [Value], String> {
        let rows = if v.is_null() {
            &[][..]
        } else {
            v.as_array().ok_or("Invalid quest list")?.as_slice()
        };
        self.rows += rows.len();
        if rows.len() > 16_384 || self.rows > 1_048_576 {
            return Err("Quest catalog exceeds supported workload".into());
        }
        Ok(rows)
    }
    fn account(&mut self, v: &Value) -> Result<(), String> {
        self.bytes += serde_json::to_vec(v).map_err(|e| e.to_string())?.len();
        if self.bytes > 64 * 1024 * 1024 {
            return Err("Normalized quest catalog exceeds 64 MiB".into());
        }
        Ok(())
    }
    fn translated(&mut self, dict: &Value, key: &Value, fallback: &str) -> Result<String, String> {
        let s = key
            .as_str()
            .filter(|s| !s.is_empty())
            .and_then(|s| dict.get(s))
            .and_then(Value::as_str)
            .filter(|s| !s.trim_matches(js_space).is_empty())
            .unwrap_or(fallback);
        if s.len() > 65_536 || s.contains('\0') {
            return Err("Invalid quest translation".into());
        }
        self.bytes += s.len() * 6 + 2;
        if self.bytes > 64 * 1024 * 1024 {
            return Err("Quest translated output exceeds supported workload".into());
        }
        Ok(s.to_owned())
    }
    fn emit(&mut self, rows: &mut Vec<Value>, v: Value) -> Result<(), String> {
        self.account(&v)?;
        rows.push(v);
        Ok(())
    }
}
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\u{b}'
            | '\u{c}'
            | ' '
            | '\u{a0}'
            | '\u{feff}'
            | '\n'
            | '\r'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}'
    )
}
fn valid_id(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        !s.trim_matches(js_space).is_empty()
            && s.encode_utf16().count() <= 512
            && !s.contains('\0')
            && !matches!(s, "__proto__" | "constructor" | "prototype")
    })
}
fn id(v: &Value) -> Result<String, String> {
    if valid_id(v) {
        Ok(v.as_str().unwrap_or_default().to_owned())
    } else {
        Err("Invalid quest identifier".into())
    }
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}
fn default(v: &Value, fallback: Value) -> Value {
    if v.is_null() { fallback } else { v.clone() }
}
fn integer(v: &Value, max: f64) -> Option<f64> {
    v.as_f64()
        .filter(|n| *n >= 0.0 && *n <= max && n.fract() == 0.0)
}
fn lookup<'a>(map: &'a Map<String, Value>, key: &Value) -> Option<&'a Value> {
    key.as_str().and_then(|key| map.get(key))
}
fn id_of(v: &Value) -> Option<&str> {
    if let Some(s) = v.as_str() {
        Some(s)
    } else {
        v["id"].as_str()
    }
    .filter(|s| !s.is_empty())
}
fn display(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => ryu_js::Buffer::new()
            .format(n.as_f64().unwrap_or_default())
            .to_owned(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    display(Some(v))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => "[object Object]".into(),
    }
}
fn groups(v: &Value, budget: &mut Budget, ids: bool) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for row in budget.rows(v)? {
        let members = if let Some(a) = row.as_array() {
            a.as_slice()
        } else {
            std::slice::from_ref(row)
        };
        let values = if ids {
            members
                .iter()
                .filter_map(id_of)
                .map(|s| json!(s))
                .collect::<Vec<_>>()
        } else {
            members.iter().filter(|v| truthy(v)).cloned().collect()
        };
        if !ids || !values.is_empty() {
            budget.emit(&mut out, json!(values))?;
        }
    }
    Ok(out)
}
fn build(raw: &Value, budget: &mut Budget) -> Result<Value, String> {
    if raw["type"] != "buildWeapon" {
        return Ok(Value::Null);
    }
    let mut limits = Vec::new();
    if !raw["buildAttributes"].is_null() {
        for (stat, v) in raw["buildAttributes"]
            .as_object()
            .ok_or("Invalid weapon build attributes")?
        {
            let Some(value) = v["value"].as_f64() else {
                continue;
            };
            let compare = match v["compareMethod"].as_str() {
                Some("<=") => "<=",
                Some("=" | "==") => "=",
                _ => ">=",
            };
            if compare == ">=" && value == 0.0 {
                continue;
            }
            budget.emit(
                &mut limits,
                json!({"stat": stat, "compare": compare, "value": value}),
            )?;
        }
    }
    Ok(
        json!({"weaponId": raw["item"], "partIds": budget.rows(&raw["containsAll"])?, "categoryIds": budget.rows(&raw["containsCategory"])?, "limits": limits}),
    )
}
fn objective(
    raw: &Value,
    dict: &Value,
    maps: &Map<String, Value>,
    quest_items: &Map<String, Value>,
    budget: &mut Budget,
) -> Result<Value, String> {
    if !raw.is_object() {
        return Err("Invalid quest objective".into());
    }
    let kind = id(&raw["type"])?;
    let mut gaps = Vec::<String>::new();
    let mut minimum_dogtag = None;
    if !raw["dogTagLevel"].is_null() {
        match integer(&raw["dogTagLevel"], 1000.0) {
            Some(n) if n > 0.0 => minimum_dogtag = Some(n),
            Some(_) => {}
            None => gaps.push("Invalid dogtag level requires review".into()),
        }
    }
    let mut durability = None;
    if !raw["minDurability"].is_null() || !raw["maxDurability"].is_null() {
        match (
            integer(&raw["minDurability"], 100.0),
            integer(&raw["maxDurability"], 100.0),
        ) {
            (Some(min), Some(max)) if min <= max => {
                if min > 0.0 || max < 100.0 {
                    durability = Some(json!({"minimum": min, "maximum": max}));
                }
            }
            _ => gaps.push("Invalid or incomplete item durability range requires review".into()),
        }
    }
    let source_ids = if kind == "useItem" && raw.get("useAny").is_some() {
        raw["useAny"].clone()
    } else if raw["items"].as_array().is_some_and(|a| !a.is_empty())
        || raw["items"].as_str().is_some_and(|s| !s.is_empty())
        || raw["items"]["length"].as_f64().is_some_and(|n| n > 0.0)
    {
        raw["items"].clone()
    } else if truthy(&raw["item"]) {
        json!([raw["item"]])
    } else {
        json!([])
    };
    let mut item_ids = Vec::new();
    let mut seen = BTreeSet::new();
    if let Some(ids) = source_ids.as_array() {
        for value in ids.iter().filter(|v| valid_id(v)) {
            if seen.insert(value.as_str().unwrap_or_default()) && item_ids.len() < 256 {
                item_ids.push(value.clone());
            }
        }
    }
    if !source_ids
        .as_array()
        .is_some_and(|a| a.len() <= 256 && a.iter().all(valid_id))
    {
        gaps.push(
            "Accepted item alternatives are missing, malformed or exceed the supported bound"
                .into(),
        );
    }
    if kind == "useItem" && raw.get("useAny").is_none() {
        gaps.push("Use-item alternatives need review against the current source definition".into());
    }
    let mut map_list = Vec::new();
    for key in budget.rows(&raw["maps"])? {
        if let Some(map) = lookup(maps, key) {
            budget.emit(&mut map_list, map.clone())?;
        }
    }
    let mut targets = Vec::new();
    for key in budget.rows(&raw["targetNames"])? {
        let name = budget.translated(dict, key, key.as_str().unwrap_or(""))?;
        budget.emit(&mut targets, json!(name))?;
    }
    let mut locations = Vec::new();
    for zone in budget.rows(&raw["zones"])? {
        if !truthy(&zone["map"]) || !truthy(&zone["position"]) {
            continue;
        }
        let outline = if zone["outline"].as_array().is_some_and(|a| a.len() > 2) {
            zone["outline"].clone()
        } else {
            Value::Null
        };
        budget.emit(&mut locations, json!({"mapId": zone["map"], "positions": [zone["position"]], "outline": outline, "zoneId": zone["id"]}))?;
    }
    for loc in budget.rows(&raw["possibleLocations"])? {
        if !truthy(&loc["map"]) || !loc["positions"].as_array().is_some_and(|a| !a.is_empty()) {
            continue;
        }
        budget.emit(&mut locations, json!({"mapId": loc["map"], "positions": loc["positions"], "outline": null, "zoneId": null}))?;
    }
    let using_weapons = budget
        .rows(&raw["usingWeapon"])?
        .iter()
        .filter_map(id_of)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let body_parts = budget
        .rows(&raw["bodyParts"])?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let distance = raw["distance"]["value"].as_f64().filter(|n| *n > 0.0).map(|n| json!({"compare": if raw["distance"]["compareMethod"] == "<=" { "<=" } else { ">=" }, "value": n}));
    let hours = raw["timeFromHour"]
        .as_f64()
        .zip(raw["timeUntilHour"].as_f64())
        .filter(|(a, b)| a != b)
        .map(|(from, until)| json!({"from": from, "until": until}));
    let description = budget.translated(dict, &raw["description"], &kind)?;
    let exit = if truthy(&raw["exitName"]) {
        Some(budget.translated(
            dict,
            &raw["exitName"],
            raw["exitName"].as_str().unwrap_or(""),
        )?)
    } else {
        None
    };
    let mut out = json!({"id": id(&raw["id"])?, "type": kind, "description": description, "optional": truthy(&raw["optional"]),
        "maps": map_list, "count": raw["count"].as_f64(), "planningGaps": gaps, "itemIds": item_ids,
        "questItem": lookup(quest_items, &raw["questItem"]), "foundInRaid": raw["foundInRaid"].as_bool(),
        "targetNames": targets, "locations": locations, "requiredKeys": groups(&raw["requiredKeys"], budget, false)?, "exitName": exit,
        "build": build(raw, budget)?, "markerItemId": raw["markerItem"], "usingWeaponIds": using_weapons,
        "usingWeaponModIds": groups(&raw["usingWeaponMods"], budget, true)?,
        "shotType": raw["shotType"].as_str().filter(|s| matches!(*s, "kill" | "hit")), "bodyParts": body_parts,
        "distance": distance, "hours": hours, "wearingIds": groups(&raw["wearing"], budget, true)?});
    if let Some(n) = minimum_dogtag {
        out["minimumDogtagLevel"] = json!(n);
    }
    if let Some(range) = durability {
        out["durability"] = range;
    }
    if matches!(
        kind.as_str(),
        "giveItem" | "plantItem" | "sellItem" | "mark" | "haveItem" | "useItem"
    ) {
        out["planningDefinition"] = json!(objective_definition(raw)?);
    }
    Ok(out)
}
fn trader_name(traders: &Map<String, Value>, key: &Value) -> String {
    lookup(traders, key)
        .and_then(|t| t["name"].as_str())
        .unwrap_or("a trader")
        .to_owned()
}
fn other_requirements(
    raw: &Value,
    traders: &Map<String, Value>,
    budget: &mut Budget,
) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for r in budget.rows(&raw["traderRequirements"])? {
        let compare = if r["compareMethod"] == ">=" {
            String::new()
        } else {
            format!("{} ", display(r.get("compareMethod")))
        };
        let requirement = match r["requirementType"].as_str() {
            Some("level") => "loyalty level".to_owned(),
            Some("reputation") => "reputation".into(),
            _ => display(r.get("requirementType")),
        };
        let value = format!(
            "{} {requirement} {compare}{}",
            trader_name(traders, &r["trader"]),
            display(r.get("value"))
        );
        budget.account(&json!(value))?;
        out.push(value);
    }
    for r in budget.rows(&raw["otherRequirements"])? {
        let text = match r["type"].as_str() {
            Some("dialogue") => {
                let mut names = Vec::new();
                for key in budget.rows(&r["traders"])? {
                    let name = trader_name(traders, key);
                    budget.account(&json!(name))?;
                    names.push(name);
                }
                let names = names.join(", ");
                if names.is_empty() {
                    "Trader dialogue".into()
                } else {
                    format!("Talk to {names}")
                }
            }
            Some("globalVariable") => format!(
                "Story progression (stage {} {})",
                display(Some(&default(&r["compareMethod"], json!(">=")))),
                display(Some(&default(&r["value"], json!("?"))))
            ),
            _ => format!("Other: {}", display(r.get("type"))),
        };
        budget.account(&json!(text))?;
        out.push(text);
    }
    Ok(out)
}

pub fn adapt(
    document: &Value,
    english: &Value,
    map_view: &Value,
    trader_view: &Value,
) -> Result<Vec<Value>, String> {
    let data = &document["data"];
    let source = data["tasks"].as_object().ok_or("Invalid quest catalog")?;
    if source.len() > 8192 {
        return Err("Quest catalog exceeds 8192 tasks".into());
    }
    let dict = &english["data"];
    if !dict.is_null() && !dict.is_object() {
        return Err("Invalid quest English dictionary".into());
    }
    let mut maps = Map::new();
    for map in map_view["maps"]
        .as_array()
        .ok_or("Missing normalized quest maps")?
    {
        maps.insert(id(&map["id"])?, map.clone());
    }
    let mut traders = Map::new();
    for trader in trader_view
        .as_array()
        .ok_or("Missing normalized quest traders")?
    {
        traders.insert(id(&trader["id"])?, trader.clone());
    }
    let mut budget = Budget::default();
    let mut quest_items = Map::new();
    if !data["questItems"].is_null() {
        let items = data["questItems"]
            .as_object()
            .ok_or("Invalid quest-item catalog")?;
        if items.len() > 16_384 {
            return Err("Quest-item catalog exceeds supported workload".into());
        }
        for raw in items.values() {
            let key = id(&raw["id"])?;
            let item = json!({"id": key, "name": budget.translated(dict, &raw["name"], &key)?, "shortName": budget.translated(dict, &raw["shortName"], "")?, "iconLink": raw["iconLink"]});
            budget.account(&item)?;
            quest_items.insert(key, item);
        }
    }
    let mut tasks = Vec::new();
    let mut seen = BTreeSet::new();
    for raw in source.values() {
        let key = id(&raw["id"])?;
        if !seen.insert(key.clone()) {
            return Err("Duplicate quest identifier".into());
        }
        let mut requirements = Vec::new();
        for r in budget.rows(&raw["taskRequirements"])? {
            let status = budget.rows(&r["status"])?;
            budget.emit(
                &mut requirements,
                json!({"taskId": r["task"], "status": status}),
            )?;
        }
        let mut stories = Vec::new();
        let mut dialogue = Vec::new();
        for r in budget.rows(&raw["otherRequirements"])? {
            if r["type"] == "globalVariable" && truthy(&r["variableId"]) {
                budget.emit(&mut stories, json!({"variableId": r["variableId"], "compare": default(&r["compareMethod"], json!(">=")), "value": default(&r["value"], json!(0))}))?;
            }
            if r["type"] == "dialogue" {
                for key in budget.rows(&r["traders"])? {
                    dialogue.push(key.clone());
                }
            }
        }
        let mut keys = Vec::new();
        for k in budget.rows(&raw["neededKeys"])? {
            if truthy(&k["map"]) && k["keys"].is_array() {
                let key_ids = budget.rows(&k["keys"])?;
                budget.emit(&mut keys, json!({"mapId": k["map"], "keyIds": key_ids}))?;
            }
        }
        let mut objectives = Vec::new();
        let mut objective_ids = BTreeSet::new();
        for o in budget.rows(&raw["objectives"])? {
            let value = objective(o, dict, &maps, &quest_items, &mut budget)?;
            if !objective_ids.insert(id(&value["id"])?) {
                return Err("Duplicate objective identifier".into());
            }
            budget.emit(&mut objectives, value)?;
        }
        let mut trader_requirements = Vec::new();
        for r in budget.rows(&raw["traderRequirements"])? {
            if truthy(&r["trader"]) && r["value"].is_number() {
                budget.emit(&mut trader_requirements, json!({"traderId": r["trader"], "type": r["requirementType"], "compare": default(&r["compareMethod"], json!(">=")), "value": r["value"]}))?;
            }
        }
        let mut standing = Vec::new();
        for s in budget.rows(&raw["finishRewards"]["traderStanding"])? {
            if truthy(&s["trader"]) && s["standing"].is_number() {
                budget.emit(
                    &mut standing,
                    json!({"traderId": s["trader"], "standing": s["standing"]}),
                )?;
            }
        }
        let trader = lookup(&traders, &raw["trader"]).cloned().unwrap_or_else(|| json!({"id": raw["trader"], "name": "Unknown trader", "normalizedName": "unknown", "imageLink": null, "currency": "RUB", "resetTime": null, "maxLevel": 1, "levels": []}));
        let delay = raw["availableDelaySecondsMax"].as_f64().filter(|n| *n > 0.0).map(|_| json!({"minS": default(&raw["availableDelaySecondsMin"], json!(0)), "maxS": default(&raw["availableDelaySecondsMax"], json!(0))}));
        let task = json!({"id": key, "name": budget.translated(dict, &raw["name"], raw["normalizedName"].as_str().unwrap_or(""))?, "normalizedName": raw["normalizedName"],
            "trader": trader, "map": lookup(&maps, &raw["map"]), "minPlayerLevel": default(&raw["minPlayerLevel"], json!(1)), "experience": default(&raw["experience"], json!(0)),
            "factionName": raw["factionName"].as_str().filter(|s| matches!(*s, "USEC" | "BEAR")).unwrap_or("Any"), "kappaRequired": truthy(&raw["kappaRequired"]), "lightkeeperRequired": truthy(&raw["lightkeeperRequired"]),
            "wikiLink": raw["wikiLink"], "taskImageLink": raw["taskImageLink"], "taskRequirements": requirements, "otherRequirements": other_requirements(raw, &traders, &mut budget)?,
            "availableDelay": delay, "storyGates": stories, "dialogueTraderIds": dialogue, "neededKeys": keys, "objectives": objectives, "traderRequirements": trader_requirements, "standing": standing});
        budget.emit(&mut tasks, task)?;
    }
    Ok(tasks)
}
