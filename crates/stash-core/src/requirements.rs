//! Normalize declared objectives into conservative planner demand, without IO.
use crate::{
    catalog::canonical::objective_definition, planner::Requirement, planning::PlanningPreferences,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub tasks: Vec<Value>,
    pub profile: Profile,
    pub stations: Vec<Value>,
    pub station_levels: BTreeMap<String, Value>,
    pub preferences: PlanningPreferences,
    pub recipes: Option<Value>,
    pub items: BTreeMap<String, Value>,
    pub traders: Vec<Value>,
    pub trader_loyalty: BTreeMap<String, Value>,
    pub barter_availability: BTreeMap<String, Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    faction: String,
    completed_task_ids: BTreeSet<String>,
    active_task_ids: BTreeSet<String>,
    failed_task_ids: BTreeSet<String>,
    objective_progress: BTreeMap<String, BTreeMap<String, Value>>,
    objective_progress_needs_review: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Normalized {
    pub requirements: Vec<Requirement>,
    pub coverage_gaps: Vec<String>,
    pub effective_hideout_targets: BTreeMap<String, f64>,
}
const ANY_DOGTAG: &str = "customdogtags12345678910";
fn count(v: &Value) -> Option<u32> {
    v.as_f64()
        .filter(|n| *n >= 0.0 && *n <= f64::from(u32::MAX) && n.fract() == 0.0)
        .map(|n| n as u32)
}
fn num(n: f64) -> String {
    ryu_js::Buffer::new().format_finite(n).to_owned()
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn rows(v: &Value) -> Result<&[Value], String> {
    if v.is_null() {
        Ok(&[])
    } else {
        v.as_array()
            .map(Vec::as_slice)
            .ok_or_else(|| "Invalid requirement source list".into())
    }
}
fn consume(kind: &str) -> bool {
    matches!(kind, "giveItem" | "plantItem" | "sellItem" | "mark")
}
fn fir(v: &Value) -> &'static str {
    match v.as_bool() {
        Some(true) => "required",
        Some(false) => "any",
        None => "unknown",
    }
}
struct Builder<'a> {
    input: &'a Input,
    requirements: Vec<Requirement>,
    gaps: Vec<String>,
    visits: usize,
    seen_gaps: BTreeSet<String>,
}
impl Builder<'_> {
    fn gap(&mut self, gap: String) -> Result<(), String> {
        if self.seen_gaps.contains(&gap) {
            return Ok(());
        }
        if gap.len() > 4096 || self.gaps.len() >= 8192 {
            return Err("Requirement coverage exceeds supported workload".into());
        }
        self.seen_gaps.insert(gap.clone());
        self.gaps.push(gap);
        Ok(())
    }
    fn visit(&mut self) -> Result<(), String> {
        self.visits += 1;
        if self.visits > 1_048_576 {
            Err("Requirement expansion exceeds supported workload".into())
        } else {
            Ok(())
        }
    }
    fn add(&mut self, mut value: Value) -> Result<(), String> {
        let source = text(&value["source"]).to_owned();
        if source.len() > 4096 || !crate::planning::valid_id(text(&value["id"])) {
            return Err("Requirement identity or source exceeds planner bounds".into());
        }
        let mut alternatives = Vec::new();
        let mut seen = BTreeSet::new();
        for raw in rows(&value["alternatives"])? {
            let id = raw.as_str().ok_or("Invalid requirement item identifier")?;
            let ids = if id != ANY_DOGTAG {
                vec![id.to_owned()]
            } else {
                let group = self
                    .input
                    .items
                    .get(id)
                    .and_then(|v| v["dogtagAlternatives"].as_array());
                let valid = group.is_some_and(|ids| {
                    !ids.is_empty()
                        && ids.len() <= 256
                        && ids.iter().all(|id| {
                            let Some(id) = id.as_str().filter(|id| {
                                !id.is_empty() && id.len() <= 512 && *id != ANY_DOGTAG
                            }) else {
                                return false;
                            };
                            self.input.items.get(id).is_some_and(|v| {
                                v["types"]
                                    .as_array()
                                    .is_some_and(|t| !t.iter().any(|v| v == "preset"))
                            })
                        })
                        && ids.iter().map(text).collect::<BTreeSet<_>>().len() == ids.len()
                });
                if !valid {
                    self.gap(format!("{source}: Any-dogtag membership is unavailable or invalid; refresh the item catalog"))?;
                    vec![]
                } else {
                    group
                        .into_iter()
                        .flatten()
                        .map(|v| text(v).to_owned())
                        .collect()
                }
            };
            for id in ids {
                if seen.insert(id.clone()) {
                    alternatives.push(id);
                }
            }
        }
        if alternatives.len() > 256 {
            self.gap(format!("{source}: too many accepted item alternatives"))?;
            alternatives.clear();
        }
        if value["quantity"].is_null() || value["fir"] == "unknown" || alternatives.is_empty() {
            self.gap(format!("{source}: unknown quantity, FIR or accepted items"))?;
        }
        if alternatives
            .iter()
            .any(|id| !self.input.items.contains_key(id))
        {
            self.gap(format!("{source}: item missing from the catalog"))?;
        }
        if alternatives.iter().any(|id| {
            self.input.items.get(id).is_some_and(|v| {
                v["types"]
                    .as_array()
                    .is_some_and(|t| t.iter().any(|v| v == "preset"))
            })
        }) {
            self.gap(format!(
                "{source}: fitted preset contents require physical build review"
            ))?;
        }
        value["alternatives"] = json!(alternatives);
        if self.requirements.len() >= 8192 {
            return Err("Requirement count exceeds 8192".into());
        }
        self.requirements.push(
            serde_json::from_value(value)
                .map_err(|e| format!("Invalid normalized requirement: {e}"))?,
        );
        Ok(())
    }
}
fn definition(task_id: &str, o: &Value) -> Result<String, String> {
    let raw = if let Some(definition) = o["planningDefinition"].as_str() {
        json!(definition)
    } else {
        let mut ids = rows(&o["itemIds"])?.to_vec();
        ids.sort_by(|a, b| text(a).encode_utf16().cmp(text(b).encode_utf16()));
        let mut fallback = Map::new();
        for key in [
            "id",
            "type",
            "count",
            "markerItemId",
            "foundInRaid",
            "minimumDogtagLevel",
            "durability",
            "optional",
        ] {
            if let Some(v) = o.get(key) {
                fallback.insert(key.into(), v.clone());
            }
        }
        fallback.insert("itemIds".into(), json!(ids));
        fallback.insert("planningGaps".into(), json!(rows(&o["planningGaps"])?));
        Value::Object(fallback)
    };
    objective_definition(&json!({"taskId": task_id, "raw": raw}))
}
fn remaining(input: &Input, task: &Value, o: &Value) -> Result<(Option<u32>, u32, bool), String> {
    let total = count(&o["count"]).filter(|n| *n <= 1_000_000);
    let tid = text(&task["id"]);
    let oid = text(&o["id"]);
    let fact = input
        .profile
        .objective_progress
        .get(tid)
        .and_then(|p| p.get(oid));
    let Some(fact) = fact else {
        return Ok((total, 0, false));
    };
    let completed = count(&fact["completed"]).filter(|n| *n <= 1_000_000);
    let valid = total
        .zip(completed)
        .is_some_and(|(total, done)| done <= total && count(&fact["total"]) == Some(total))
        && fact["definition"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 8192)
        && fact["confirmedAt"]
            .as_f64()
            .is_some_and(|n| (0.0..=8_640_000_000_000_000.0).contains(&n) && n.fract() == 0.0)
        && fact["status"] == "current"
        && input.profile.active_task_ids.contains(tid)
        && !input.profile.failed_task_ids.contains(tid)
        && fact["definition"] == definition(tid, o)?;
    if valid {
        Ok((
            total.zip(completed).map(|(n, d)| n - d),
            completed.unwrap_or_default(),
            false,
        ))
    } else {
        Ok((total, 0, true))
    }
}

pub fn build(input: &Input) -> Result<Normalized, String> {
    crate::planning::validate(&input.preferences).map_err(|e| e.to_string())?;
    if input.tasks.len() > 8192
        || input.stations.len() > 512
        || input.items.len() > 32_768
        || input.profile.objective_progress.len() > 8192
    {
        return Err("Requirement source exceeds supported workload".into());
    }
    if !matches!(input.profile.faction.as_str(), "USEC" | "BEAR") {
        return Err("Invalid planning faction".into());
    }
    // A missing catalog list cannot establish that no requirements exist.
    for task in &input.tasks {
        if !task["objectives"].is_array() {
            return Err("Quest objective coverage is malformed".into());
        }
        for objective in rows(&task["objectives"])? {
            if !objective["itemIds"].is_array() {
                return Err("Quest accepted-item coverage is malformed".into());
            }
        }
    }
    for item in input.items.values() {
        if !item["types"].is_array() {
            return Err("Item type coverage is malformed".into());
        }
    }
    for station in &input.stations {
        if !station["levels"].is_array() {
            return Err("Hideout level coverage is malformed".into());
        }
        for level in rows(&station["levels"])? {
            if count(&level["level"]).is_none()
                || !level["stationLevelRequirements"].is_array()
                || !level["itemRequirements"].is_array()
            {
                return Err("Hideout requirement coverage is malformed".into());
            }
        }
    }
    let mut b = Builder {
        input,
        requirements: vec![],
        gaps: vec![],
        visits: 0,
        seen_gaps: BTreeSet::new(),
    };
    if input.profile.objective_progress_needs_review {
        b.gap("Saved partial objective data needs review; unrecognized source data is retained in progress exports".into())?;
    }
    for (tid, entries) in &input.profile.objective_progress {
        if input.profile.completed_task_ids.contains(tid) {
            continue;
        }
        let task = input.tasks.iter().find(|t| text(&t["id"]) == tid);
        for oid in entries.keys() {
            b.visit()?;
            let exists = task
                .and_then(|t| t["objectives"].as_array())
                .is_some_and(|a| {
                    a.iter()
                        .any(|o| text(&o["id"]) == oid && consume(text(&o["type"])))
                });
            if !exists {
                b.gap(format!("Saved objective {tid}/{oid} is missing or no longer consumes items; review its counter"))?;
            }
        }
    }
    for task in &input.tasks {
        let tid = text(&task["id"]);
        let name = text(&task["name"]);
        if input.profile.completed_task_ids.contains(tid)
            || (task["factionName"] != "Any" && task["factionName"] != input.profile.faction)
        {
            continue;
        }
        if task["wiki"] == true {
            b.gap(format!(
                "{name}: wiki requirements contain unstructured conditions"
            ))?;
        }
        for o in rows(&task["objectives"])? {
            b.visit()?;
            let kind = text(&o["type"]);
            let progress = if consume(kind) {
                Some(remaining(input, task, o)?)
            } else {
                None
            };
            let mut source = format!("Quest: {name} · {}", text(&o["description"]));
            if let Some(level) = count(&o["minimumDogtagLevel"]).filter(|n| *n > 0) {
                source += &format!(" (dogtag level at least {level})");
            }
            if o.get("durability").is_some_and(|v| !v.is_null()) {
                source += &format!(
                    " (durability {}–{}%)",
                    text_number(&o["durability"]["minimum"]),
                    text_number(&o["durability"]["maximum"])
                );
            }
            if let Some((quantity, done, _)) = progress.filter(|(_, done, _)| *done > 0) {
                source += &format!(
                    " ({done} already completed; {} remaining)",
                    quantity.unwrap_or_default()
                );
            }
            if progress.is_some_and(|(_, _, gap)| gap) {
                b.gap(format!(
                    "{source}: Saved partial objective progress needs review; full demand retained"
                ))?;
            }
            if progress.is_some_and(|(n, _, gap)| n == Some(0) && !gap) {
                continue;
            }
            for gap in rows(&o["planningGaps"])? {
                b.gap(format!("{source}: {}", text(gap)))?;
            }
            let quantity = progress
                .and_then(|(n, _, _)| n)
                .or_else(|| count(&o["count"]));
            let rid = format!("quest:{tid}:{}", text(&o["id"]));
            if matches!(kind, "giveItem" | "plantItem" | "sellItem" | "haveItem") {
                let mut r = json!({"id": rid, "source": if kind == "haveItem" { format!("{source} (keep in possession; not a hand-in)") } else { source.clone() }, "kind": {"kind": if kind == "haveItem" { "hold" } else { "consume" }}, "alternatives": rows(&o["itemIds"])?, "quantity": quantity, "fir": fir(&o["foundInRaid"])});
                for key in ["minimumDogtagLevel", "durability"] {
                    if let Some(v) = o.get(key).filter(|v| !v.is_null()) {
                        r[key] = v.clone();
                    }
                }
                b.add(r)?;
            } else if kind == "useItem" {
                b.gap(format!("{source}: the objective counts uses; remaining charges and the number of physical items needed require review"))?;
                b.add(json!({"id": rid, "source": source, "kind": {"kind": "consume"}, "alternatives": rows(&o["itemIds"])?, "quantity": null, "fir": "unknown"}))?;
            } else if kind == "mark" {
                let ids = o["markerItemId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(|s| vec![s])
                    .unwrap_or_default();
                b.add(json!({"id": rid, "source": source, "kind": {"kind": "consume"}, "alternatives": ids, "quantity": quantity, "fir": "any"}))?;
            } else if kind == "buildWeapon" {
                b.gap(format!(
                    "{source}: weapon condition and fitted parts require manual review"
                ))?;
                let ids = o["build"]["weaponId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .into_iter()
                    .chain(
                        rows(&o["build"]["partIds"])?
                            .iter()
                            .filter_map(Value::as_str)
                            .filter(|s| !s.is_empty()),
                    );
                for (index, id) in ids.enumerate() {
                    b.add(json!({"id": format!("{rid}:{index}"), "source": source, "kind": {"kind": "consume"}, "alternatives": [id], "quantity": 1, "fir": "any"}))?;
                }
            } else if !rows(&o["itemIds"])?.is_empty() && kind != "findItem" {
                b.gap(format!("{source}: unsupported item objective {kind}"))?;
            }
        }
    }
    let stations = input
        .stations
        .iter()
        .map(|s| (text(&s["id"]).to_owned(), s))
        .collect::<BTreeMap<_, _>>();
    if stations.len() != input.stations.len() {
        return Err("Duplicate planning station identifier".into());
    }
    let mut targets = BTreeMap::new();
    for (id, s) in &stations {
        let max = rows(&s["levels"])?
            .iter()
            .filter_map(|l| l["level"].as_f64())
            .fold(0.0, f64::max);
        targets.insert(
            id.clone(),
            input
                .preferences
                .hideout_targets
                .get(id)
                .map(|n| f64::from(*n))
                .unwrap_or(max),
        );
    }
    let mut changed = true;
    while changed {
        changed = false;
        for (id, s) in &stations {
            let target = targets[id];
            let current = input
                .station_levels
                .get(id)
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            if input
                .station_levels
                .get(id)
                .is_some_and(|v| count(v).is_none())
            {
                b.gap(format!("{}: current level is invalid", text(&s["name"])))?;
            }
            let levels = rows(&s["levels"])?;
            let max = levels
                .iter()
                .filter_map(|l| l["level"].as_f64())
                .fold(0.0, f64::max);
            if target > max {
                b.gap(format!(
                    "{}: target level is missing from catalog",
                    text(&s["name"])
                ))?;
            }
            for l in levels.iter().filter(|l| {
                l["level"]
                    .as_f64()
                    .is_some_and(|n| n > current && n <= target)
            }) {
                for dep in rows(&l["stationLevelRequirements"])? {
                    b.visit()?;
                    let dep_id = text(&dep["stationId"]);
                    if !stations.contains_key(dep_id) || count(&dep["level"]).is_none() {
                        b.gap(format!("{}: unknown dependency", text(&s["name"])))?;
                        continue;
                    }
                    let level = dep["level"].as_f64().unwrap_or_default();
                    if targets.get(dep_id).copied().unwrap_or_default() < level {
                        targets.insert(dep_id.to_owned(), level);
                        changed = true;
                    }
                }
            }
        }
    }
    for s in &input.stations {
        let id = text(&s["id"]);
        let current = input
            .station_levels
            .get(id)
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let target = targets.get(id).copied().unwrap_or_default();
        for l in rows(&s["levels"])? {
            let level = l["level"].as_f64().unwrap_or_default();
            if level <= current || level > target {
                continue;
            }
            for (index, r) in rows(&l["itemRequirements"])?.iter().enumerate() {
                b.visit()?;
                b.add(json!({"id": format!("hideout:{}:{index}", text(&l["id"])), "source": format!("Hideout: {} level {}", text(&s["name"]), num(level)), "kind": {"kind": "consume"}, "alternatives": [r["itemId"]], "quantity": count(&r["count"]), "fir": fir(&r["foundInRaid"])}))?;
            }
        }
    }
    for (kind, selected) in [
        ("craft", &input.preferences.craft_batches),
        ("barter", &input.preferences.barter_batches),
    ] {
        for (id, batches) in selected.iter().filter(|(_, n)| **n > 0) {
            if input
                .recipes
                .as_ref()
                .is_none_or(|v| v["planningSchema"] != 2)
            {
                b.gap(
                    "Saved recipe input conditions need a catalog refresh before surplus decisions"
                        .into(),
                )?;
            }
            let recipe = input
                .recipes
                .as_ref()
                .and_then(|v| v[if kind == "craft" { "crafts" } else { "barters" }].as_array())
                .and_then(|r| r.iter().find(|r| text(&r["id"]) == id));
            let Some(recipe) = recipe else {
                b.gap(format!("Selected {kind} {id} is missing"))?;
                continue;
            };
            if !recipe["gaps"].is_array()
                || !recipe["inputs"].is_array()
                || (!recipe["taskUnlock"].is_null() && !recipe["taskUnlock"].is_string())
                || (!recipe["minimumTraderLevel"].is_null()
                    && !recipe["minimumTraderLevel"].is_number())
                || (!recipe["stationLevel"].is_null() && !recipe["stationLevel"].is_number())
            {
                return Err("Selected recipe condition coverage is malformed".into());
            }
            let output = text(&recipe["outputId"]);
            let name = input
                .items
                .get(output)
                .and_then(|v| v["name"].as_str())
                .unwrap_or(output);
            if let Some(unlock) = recipe["taskUnlock"].as_str().filter(|s| !s.is_empty()) {
                if let Some(task) = input.tasks.iter().find(|t| text(&t["id"]) == unlock) {
                    if !input.profile.completed_task_ids.contains(unlock) {
                        b.gap(format!(
                            "{kind}: {name} · complete {} to unlock this recipe",
                            text(&task["name"])
                        ))?;
                    }
                } else {
                    b.gap(format!(
                        "{kind}: {name} · unlock quest is missing from the catalog"
                    ))?;
                }
            }
            if kind == "barter" {
                let available = input.barter_availability.get(id);
                if available.is_none_or(|v| {
                    v["confirmed"] != true
                        || count(&v["batches"]).is_none_or(|n| n < *batches || n > 1_000_000)
                }) {
                    b.gap(format!("Barter: {name} · check that at least {batches} exchanges are available now; future ingredients remain reserved"))?;
                }
                let trader_id = text(&recipe["traderId"]);
                let trader = input.traders.iter().find(|t| text(&t["id"]) == trader_id);
                if trader.is_none_or(|t| count(&t["maxLevel"]).is_none_or(|n| n > 8)) {
                    b.gap(format!(
                        "Barter: {name} · trader metadata is unavailable or unsupported"
                    ))?;
                } else if let Some(minimum) =
                    recipe["minimumTraderLevel"].as_f64().filter(|n| *n > 0.0)
                {
                    let trader = trader.ok_or("Missing barter trader")?;
                    let fact = input.trader_loyalty.get(trader_id);
                    if fact.is_none_or(|v| {
                        v["confirmed"] != true
                            || count(&v["level"]).is_none()
                            || v["level"].as_f64().is_none_or(|n| {
                                n < minimum || n > trader["maxLevel"].as_f64().unwrap_or_default()
                            })
                    }) {
                        b.gap(format!("Barter: {name} · confirm {} loyalty {} or higher for the current character", text(&trader["name"]),num(minimum)))?;
                    }
                }
            }
            if kind == "craft"
                && recipe["stationId"].as_str().is_some_and(|s| !s.is_empty())
                && !recipe["stationLevel"].is_null()
                && input
                    .station_levels
                    .get(text(&recipe["stationId"]))
                    .and_then(Value::as_f64)
                    .unwrap_or_default()
                    < recipe["stationLevel"].as_f64().unwrap_or_default()
            {
                b.gap(format!(
                    "Craft: {name} requires a station level not yet built"
                ))?;
            }
            for gap in rows(&recipe["gaps"])? {
                b.gap(format!("{kind}: {name} · {}", text(gap)))?;
            }
            for (index, r) in rows(&recipe["inputs"])?.iter().enumerate() {
                b.visit()?;
                if !r["tool"].is_boolean()
                    || (!r["minimumDogtagLevel"].is_null()
                        && count(&r["minimumDogtagLevel"]).is_none())
                {
                    return Err("Recipe input condition coverage is malformed".into());
                }
                let tool = r["tool"] == true;
                let item = text(&r["itemId"]);
                let dogtag = count(&r["minimumDogtagLevel"]);
                let source = format!(
                    "{}: {name} × {batches}{}{}",
                    if kind == "craft" { "Craft" } else { "Barter" },
                    if tool { " (sequential tool)" } else { "" },
                    dogtag
                        .filter(|n| *n > 0)
                        .map(|n| format!(" (dogtag level at least {n})"))
                        .unwrap_or_default()
                );
                let quantity = r["quantity"]
                    .as_f64()
                    .and_then(|n| count(&json!(n * if tool { 1.0 } else { f64::from(*batches) })));
                let mut value = json!({"id": format!("{kind}:{id}:{index}"), "source": source, "kind": if tool { json!({"kind": "reusable", "group": format!("craft-tool:{item}")}) } else { json!({"kind": "consume"}) }, "alternatives": [item], "quantity": quantity, "fir": "any"});
                if let Some(n) = dogtag {
                    value["minimumDogtagLevel"] = json!(n);
                }
                b.add(value)?;
            }
        }
    }
    for id in input.preferences.hideout_targets.keys() {
        if !stations.contains_key(id) {
            b.gap(format!("Saved hideout target {id} is missing"))?;
        }
    }
    let mut seen = BTreeSet::new();
    b.gaps.retain(|g| seen.insert(g.clone()));
    Ok(Normalized {
        requirements: b.requirements,
        coverage_gaps: b.gaps,
        effective_hideout_targets: targets,
    })
}
fn text_number(v: &Value) -> String {
    v.as_f64().map(num).unwrap_or_else(|| "undefined".into())
}
