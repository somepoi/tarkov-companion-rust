//! Public map layers and names. Preserve source coordinates, never infer positions.
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

#[derive(Default)]
struct Budget {
    rows: usize,
    bytes: usize,
}
impl Budget {
    fn rows<'a>(&mut self, value: &'a Value) -> Result<&'a [Value], String> {
        let rows = if value.is_null() {
            &[][..]
        } else {
            value
                .as_array()
                .ok_or("Invalid map catalog list")?
                .as_slice()
        };
        self.rows += rows.len();
        if rows.len() > 262_144 || self.rows > 1_048_576 {
            return Err("Map layers exceed supported workload".into());
        }
        Ok(rows)
    }
    fn output(&mut self, value: &Value) -> Result<(), String> {
        self.bytes += serde_json::to_vec(value).map_err(|e| e.to_string())?.len();
        if self.bytes > 64 * 1024 * 1024 {
            return Err("Normalized map catalog exceeds 64 MiB".into());
        }
        Ok(())
    }
}
fn id(value: &Value) -> Result<String, String> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 512 && !s.contains('\0'))
        .map(str::to_owned)
        .ok_or_else(|| "Invalid map identifier".into())
}
fn emit(rows: &mut Vec<Value>, value: Value, budget: &mut Budget) -> Result<(), String> {
    budget.output(&value)?;
    rows.push(value);
    Ok(())
}
fn translated(dict: &Value, key: &Value, fallback: &str) -> Result<String, String> {
    let text = key
        .as_str()
        .filter(|s| !s.is_empty())
        .and_then(|s| dict.get(s))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(fallback);
    if text.len() > 65_536 || text.contains('\0') {
        return Err("Invalid map translation text".into());
    }
    Ok(text.to_owned())
}
fn default(value: &Value, fallback: Value) -> Value {
    if value.is_null() {
        fallback
    } else {
        value.clone()
    }
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}
fn point(value: &Value) -> Result<Value, String> {
    if !value.is_object() {
        return Err("Missing or invalid map position".into());
    }
    Ok(value.clone())
}
fn switch_name(name: &str) -> &'static str {
    let name = name.to_ascii_lowercase();
    for (words, label) in [
        (&["exfil", "start_exfiltration"][..], "Extract switch"),
        (&["d2_lever"], "D-2 extract lever"),
        (&["power"], "Power switch"),
        (&["call_button"], "Elevator call button"),
        (&["floor_button"], "Elevator floor button"),
        (&["alarm"], "Alarm console"),
        (
            &["gatebutton", "gate_button", "gatesbutton", "gates_button"],
            "Gate button",
        ),
        (&["pump"], "Pump button"),
        (&["water"], "Water switch"),
        (&["lever"], "Lever"),
        (&["console"], "Console"),
        (&["urinal"], "Hidden switch (urinal)"),
        (&["button"], "Button"),
    ] {
        if words.iter().any(|word| name.contains(word)) {
            return label;
        }
    }
    "Switch"
}
fn dictionary<'a>(value: &'a Value, label: &str) -> Result<Option<&'a Map<String, Value>>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let rows = value
        .as_object()
        .ok_or_else(|| format!("Invalid map {label} dictionary"))?;
    if rows.len() > 16_384 {
        return Err(format!("Map {label} dictionary exceeds supported workload"));
    }
    Ok(Some(rows))
}
fn layer(
    raw: &Value,
    dict: &Value,
    names: &Map<String, Value>,
    normalized: &Map<String, Value>,
    budget: &mut Budget,
) -> Result<Value, String> {
    let mut extracts = Vec::new();
    for row in budget.rows(&raw["extracts"])? {
        let faction = row["faction"]
            .as_str()
            .filter(|s| matches!(*s, "pmc" | "scav"))
            .unwrap_or("shared");
        emit(
            &mut extracts,
            json!({"id": id(&row["id"])?, "name": translated(dict, &row["name"], row["name"].as_str().unwrap_or(""))?,
            "faction": faction, "position": point(&row["position"])?, "outline": budget.rows(&row["outline"])?}),
            budget,
        )?;
    }
    let mut transits = Vec::new();
    for row in budget.rows(&raw["transits"])? {
        emit(
            &mut transits,
            json!({"id": id(&row["id"])?, "name": translated(dict, &row["description"], "Transit")?,
            "targetMapId": row["map"], "position": point(&row["position"])?, "outline": budget.rows(&row["outline"])?}),
            budget,
        )?;
    }
    let mut spawns = Vec::new();
    for row in budget.rows(&raw["spawns"])? {
        emit(
            &mut spawns,
            json!({"position": point(&row["position"])?, "sides": budget.rows(&row["sides"])?,
            "categories": budget.rows(&row["categories"])?, "zoneName": default(&row["zoneName"], json!(""))}),
            budget,
        )?;
    }
    let mut bosses = Vec::new();
    for row in budget.rows(&raw["bosses"])? {
        if !row.is_object() {
            return Err("Invalid boss spawn record".into());
        }
        let mob = row["mob"].as_str().unwrap_or("");
        let name = names
            .get(mob)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("Boss");
        let normalized = normalized
            .get(mob)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(if mob.is_empty() { "boss" } else { mob });
        let mut locations = Vec::new();
        for loc in budget.rows(&row["spawnLocations"])? {
            if !loc.is_object() {
                return Err("Invalid boss location record".into());
            }
            emit(
                &mut locations,
                json!({"name": translated(dict, &loc["name"], loc["name"].as_str().unwrap_or(""))?,
                "chance": default(&loc["chance"], json!(0)), "positions": budget.rows(&loc["positions"])?}),
                budget,
            )?;
        }
        let mut escorts = Vec::new();
        for escort in budget.rows(&row["escorts"])? {
            if !truthy(&escort["mob"]) {
                continue;
            }
            let mob = id(&escort["mob"])?;
            let mut counts: Vec<f64> = budget
                .rows(&escort["amount"])?
                .iter()
                .filter_map(|a| a["count"].as_f64())
                .filter(|n| *n > 0.0)
                .collect();
            counts.sort_by(f64::total_cmp);
            counts.dedup();
            emit(
                &mut escorts,
                json!({"mobId": mob, "name": names.get(&mob).cloned().unwrap_or(json!(mob)), "counts": counts}),
                budget,
            )?;
        }
        emit(
            &mut bosses,
            json!({"mobId": row["mob"], "name": name, "normalizedName": normalized, "spawnChance": default(&row["spawnChance"], json!(0)),
            "locations": locations, "escorts": escorts, "spawnTime": row["spawnTime"].as_f64().unwrap_or(-1.0),
            "spawnTimeRandom": truthy(&row["spawnTimeRandom"]), "trigger": row["spawnTrigger"]}),
            budget,
        )?;
    }
    let mut containers = Vec::new();
    for row in budget.rows(&raw["lootContainers"])? {
        emit(
            &mut containers,
            json!({"containerId": id(&row["lootContainer"])?, "position": point(&row["position"])?}),
            budget,
        )?;
    }
    let mut loose = Vec::new();
    for row in budget.rows(&raw["lootLoose"])? {
        if !truthy(&row["position"]) {
            continue;
        }
        let items = if row["items"].is_array() {
            budget.rows(&row["items"])?
        } else {
            &[]
        };
        emit(
            &mut loose,
            json!({"position": point(&row["position"])?, "itemIds": items}),
            budget,
        )?;
    }
    let mut locks = Vec::new();
    for row in budget.rows(&raw["locks"])? {
        emit(
            &mut locks,
            json!({"id": id(&row["id"])?, "lockType": row["lockType"], "keyId": id(&row["key"])?, "needsPower": truthy(&row["needsPower"]), "position": point(&row["position"])?}),
            budget,
        )?;
    }
    let mut hazards = Vec::new();
    for row in budget.rows(&raw["hazards"])? {
        emit(
            &mut hazards,
            json!({"id": id(&row["id"])?, "type": row["hazardType"], "name": translated(dict, &row["name"], row["hazardType"].as_str().unwrap_or(""))?, "position": point(&row["position"])?, "outline": budget.rows(&row["outline"])?}),
            budget,
        )?;
    }
    let mut switches = Vec::new();
    for row in budget.rows(&raw["switches"])? {
        if !truthy(&row["id"]) || !truthy(&row["position"]) {
            continue;
        }
        emit(
            &mut switches,
            json!({"id": id(&row["id"])?, "name": translated(dict, &row["name"], switch_name(row["name"].as_str().unwrap_or("")))?, "switchType": default(&row["switchType"], json!("")), "position": point(&row["position"])?}),
            budget,
        )?;
    }
    let mut weapons = Vec::new();
    for row in budget.rows(&raw["stationaryWeapons"])? {
        if !truthy(&row["stationaryWeapon"]) || !truthy(&row["position"]) {
            continue;
        }
        emit(
            &mut weapons,
            json!({"itemId": id(&row["stationaryWeapon"])?, "position": point(&row["position"])?}),
            budget,
        )?;
    }
    let mut btr = Vec::new();
    for row in budget.rows(&raw["btrStops"])? {
        let (Some(x), Some(z)) = (row["x"].as_f64(), row["z"].as_f64()) else {
            continue;
        };
        emit(
            &mut btr,
            json!({"name": translated(dict, &row["name"], "BTR stop")?, "position": {"x": x, "y": default(&row["y"], json!(0)), "z": z}}),
            budget,
        )?;
    }
    Ok(
        json!({"extracts": extracts, "transits": transits, "spawns": spawns, "bosses": bosses, "lootContainers": containers,
        "lootLoose": loose, "locks": locks, "hazards": hazards, "switches": switches, "stationaryWeapons": weapons, "btrStops": btr}),
    )
}

pub fn adapt(document: &Value, english: &Value) -> Result<Value, String> {
    let data = &document["data"];
    let source = data["maps"].as_object().ok_or("Invalid maps catalog")?;
    if source.len() > 512 {
        return Err("Map catalog exceeds 512 maps".into());
    }
    let dict = &english["data"];
    if !dict.is_null() && !dict.is_object() {
        return Err("Invalid map English dictionary".into());
    }
    let mut budget = Budget::default();
    let mut loot_names = Map::new();
    for row in dictionary(&data["lootContainers"], "container")?
        .into_iter()
        .flat_map(Map::values)
    {
        let key = id(&row["id"])?;
        let name = translated(
            dict,
            &row["name"],
            row["normalizedName"].as_str().unwrap_or(""),
        )?;
        budget.output(&json!([key, name]))?;
        loot_names.insert(key, json!(name));
    }
    let mut names = Map::new();
    let mut normalized = Map::new();
    let mut portraits = Map::new();
    for row in dictionary(&data["mobs"], "mob")?
        .into_iter()
        .flat_map(Map::values)
    {
        let key = id(&row["id"])?;
        let name = translated(
            dict,
            &row["name"],
            row["normalizedName"].as_str().unwrap_or(""),
        )?;
        budget.output(&json!([
            key,
            name,
            row["normalizedName"],
            row["imagePortraitLink"]
        ]))?;
        names.insert(key.clone(), json!(name));
        normalized.insert(key.clone(), row["normalizedName"].clone());
        if truthy(&row["imagePortraitLink"]) {
            portraits.insert(key, row["imagePortraitLink"].clone());
        }
    }
    let mut maps = Vec::new();
    let mut details = Map::new();
    for raw in source.values() {
        let key = id(&raw["id"])?;
        if details.contains_key(&key) {
            return Err("Duplicate map identifier".into());
        }
        let map = json!({"id": key, "name": translated(dict, &raw["name"], raw["normalizedName"].as_str().unwrap_or(""))?,
            "normalizedName": raw["normalizedName"], "scenePath": raw["scenePath"], "nameId": raw["nameId"], "raidDuration": raw["raidDuration"].as_f64().unwrap_or(0.0)});
        let detail = layer(raw, dict, &names, &normalized, &mut budget)?;
        budget.output(&map)?;
        budget.output(&detail)?;
        maps.push(map);
        details.insert(key, detail);
    }
    let mut trunks = BTreeMap::<String, usize>::new();
    for detail in details.values() {
        for lock in detail["locks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|l| l["lockType"] == "trunk")
        {
            *trunks
                .entry(lock["keyId"].as_str().unwrap_or_default().to_owned())
                .or_default() += 1;
        }
    }
    for detail in details.values_mut() {
        if let Some(locks) = detail["locks"].as_array_mut() {
            locks.retain(|l| {
                l["lockType"] != "trunk"
                    || trunks
                        .get(l["keyId"].as_str().unwrap_or_default())
                        .copied()
                        .unwrap_or_default()
                        <= 3
            });
        }
    }
    let mut reports = Vec::new();
    for report in budget.rows(&data["goonReports"])? {
        if !report.is_object() {
            return Err("Invalid goon report record".into());
        }
        let time = match report.get("timestamp") {
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::String(s)) => {
                if s.trim().is_empty() {
                    Some(0.0)
                } else {
                    s.trim().parse::<f64>().ok()
                }
            }
            Some(Value::Null) => Some(0.0),
            Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
            _ => None,
        };
        if let Some(at) = time.filter(|n| n.is_finite())
            && truthy(&report["map"])
        {
            reports.push(json!({"mapId": report["map"], "at": at}));
        }
    }
    reports.sort_by(|a, b| {
        b["at"]
            .as_f64()
            .unwrap_or_default()
            .total_cmp(&a["at"].as_f64().unwrap_or_default())
    });
    let report = reports.first().cloned().unwrap_or(Value::Null);
    budget.output(&report)?;
    Ok(
        json!({"maps": maps, "mapDetails": details, "lootContainerNames": loot_names, "mobNames": names, "mobPortraits": portraits, "goonReport": report}),
    )
}
