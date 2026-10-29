//! Pure, deterministic stock allocation. Prices never influence protection.
//!
//! A minimum-cost integral flow handles competing item alternatives and FIR
//! constraints globally. Consumptive demands sum; explicitly sequential reusable
//! groups reserve their maximum. Floors overlap existing reserves, buffers add.

use crate::model::*;
use serde::{Deserialize, Serialize};
use std::{
    cmp::Reverse,
    collections::{BTreeMap, BTreeSet, BinaryHeap},
};
use thiserror::Error;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FirConstraint {
    Any,
    Required,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum RequirementKind {
    Consume,
    /// The caller explicitly asserts this group is sequential, not concurrent.
    /// Different concurrent tools must use different group IDs.
    Reusable {
        group: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurabilityRange {
    pub minimum: u32,
    pub maximum: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Requirement {
    pub id: String,
    pub source: String,
    pub kind: RequirementKind,
    pub alternatives: Vec<String>,
    pub quantity: Option<u32>,
    pub fir: FirConstraint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_dogtag_level: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub durability: Option<DurabilityRange>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserReserve {
    pub extra_buffer: u32,
    pub minimum_total: u32,
    pub never_sell: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlannerInput {
    pub inventory: Inventory,
    pub catalog_version: String,
    pub progression_revision: String,
    pub plan_revision: String,
    pub horizon: String,
    /// False after unrecorded transfers/consumption or when scan age is unknown.
    pub inventory_confirmed_current: bool,
    /// Must include all selected quest/hideout/craft/barter/branch requirements.
    /// HTTP success alone is not proof of complete coverage.
    pub requirements_complete: bool,
    pub coverage_gaps: Vec<String>,
    pub requirements: Vec<Requirement>,
    pub reserves: BTreeMap<String, UserReserve>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Recommendation {
    Keep,
    Sell,
    Review,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Allocation {
    pub container_id: String,
    pub snapshot_id: String,
    pub stack_id: String,
    pub item_id: String,
    pub quantity: u32,
    pub requirement_ids: Vec<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Portion {
    pub recommendation: Recommendation,
    pub quantity: Option<u32>,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackPlan {
    pub container_id: String,
    pub snapshot_id: String,
    pub stack_id: String,
    pub item_id: Option<String>,
    pub location: CellBox,
    pub portions: Vec<Portion>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unfulfilled {
    pub requirement_ids: Vec<String>,
    pub alternatives: Vec<String>,
    pub quantity: Option<u32>,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSummary {
    pub item_id: String,
    pub confirmed_owned: u64,
    pub keep: u64,
    pub sell: u64,
    pub review_known_quantity: u64,
    pub unknown_stacks: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub profile_id: String,
    pub mode: GameMode,
    pub catalog_version: String,
    pub progression_revision: String,
    pub plan_revision: String,
    pub horizon: String,
    pub container_revisions: BTreeMap<String, u64>,
    pub sale_decisions_complete: bool,
    pub coverage_gaps: Vec<String>,
    pub allocations: Vec<Allocation>,
    pub stacks: Vec<StackPlan>,
    pub items: Vec<ItemSummary>,
    pub unfulfilled: Vec<Unfulfilled>,
}

#[derive(Debug, Error)]
pub enum PlannerError {
    #[error("invalid planner input: {0}")]
    Invalid(String),
    #[error("allocation exceeds the bounded local workload: {0}")]
    Workload(String),
}

struct Stock<'a> {
    container: &'a Container,
    snapshot: &'a InventorySnapshot,
    stack: &'a Stack,
    trusted: bool,
    protected: bool,
}
struct Demand {
    ids: Vec<String>,
    alternatives: Vec<String>,
    count: u32,
    fir: FirConstraint,
    minimum_dogtag_level: Option<u32>,
    durability: Option<DurabilityRange>,
    reason: String,
}

/// Results are advice over exactly these input revisions. The caller must check
/// revisions again before presenting them as current after an inventory change.
pub fn plan(input: &PlannerInput) -> Result<Plan, PlannerError> {
    if input.requirements.len() > 8192
        || input.reserves.len() > 8192
        || input.coverage_gaps.len() > 8192
        || input
            .requirements
            .iter()
            .any(|r| r.alternatives.len() > 256)
    {
        return Err(PlannerError::Workload(
            "too many requirements, alternatives or coverage gaps".into(),
        ));
    }
    if input.coverage_gaps.iter().any(|g| g.len() > 4096)
        || [
            &input.horizon,
            &input.catalog_version,
            &input.plan_revision,
            &input.progression_revision,
        ]
        .iter()
        .any(|s| s.len() > 4096)
        || input.requirements.iter().any(|r| {
            !crate::planning::valid_id(&r.id)
                || r.source.len() > 4096
                || r.alternatives
                    .iter()
                    .any(|id| !crate::planning::valid_id(id))
        })
    {
        return Err(PlannerError::Invalid(
            "planner metadata exceeds supported bounds".into(),
        ));
    }
    if input.horizon.trim().is_empty() || input.catalog_version.trim().is_empty() {
        return Err(PlannerError::Invalid(
            "an explicit plan horizon and catalog version are required".into(),
        ));
    }
    let mut gaps = input.coverage_gaps.clone();
    if !input.requirements_complete {
        gaps.push("Selected requirements are incomplete or contain unsupported conditions.".into());
    }
    if !input.inventory_confirmed_current {
        gaps.push("Inventory freshness/transfers have not been confirmed.".into());
    }
    if input.inventory.legacy.is_some() {
        gaps.push(
            "Unlocated legacy checklist counts require reconciliation and are not physical stock."
                .into(),
        );
    }

    let mut containers = input.inventory.containers.iter().collect::<Vec<_>>();
    containers.sort_by(|a, b| a.container.id.cmp(&b.container.id));
    let mut stock = Vec::new();
    let mut container_ids = BTreeSet::new();
    let mut stack_ids = BTreeSet::new();
    let mut revisions = BTreeMap::new();
    for entry in containers {
        let container = &entry.container;
        if container.profile_id != input.inventory.profile.id
            || !container_ids.insert(&container.id)
        {
            return Err(PlannerError::Invalid(
                "containers must be unique and belong to the selected profile".into(),
            ));
        }
        revisions.insert(container.id.clone(), container.revision);
        let Some(snapshot) = &entry.snapshot else {
            gaps.push(format!(
                "Container {} has not been scanned.",
                container.name
            ));
            continue;
        };
        if snapshot.revision != container.revision
            || container.current_snapshot_id.as_deref() != Some(&snapshot.id)
        {
            return Err(PlannerError::Invalid(
                "snapshot does not match the current container revision".into(),
            ));
        }
        if !snapshot.full_coverage_confirmed {
            gaps.push(format!(
                "Container {} lacks confirmed full coverage.",
                container.name
            ));
        }
        let mut ordered = snapshot.stacks.iter().collect::<Vec<_>>();
        ordered.sort_by(|a, b| a.id.cmp(&b.id));
        let mut occupied = BTreeSet::new();
        for stack in ordered {
            if stack.id.trim().is_empty() || !stack_ids.insert(&stack.id) {
                return Err(PlannerError::Invalid(
                    "physical stack IDs must be globally unique within the profile".into(),
                ));
            }
            if stack.quantity == Some(0)
                || stack.location.width == 0
                || stack.location.height == 0
                || u64::from(stack.location.column) + u64::from(stack.location.width)
                    > u64::from(container.columns)
                || u64::from(stack.location.row) + u64::from(stack.location.height)
                    > u64::from(container.rows)
            {
                return Err(PlannerError::Invalid(
                    "stack quantity or grid footprint is invalid".into(),
                ));
            }
            for row in stack.location.row..stack.location.row + stack.location.height {
                for column in stack.location.column..stack.location.column + stack.location.width {
                    if !occupied.insert((column, row)) {
                        return Err(PlannerError::Invalid(
                            "physical stack footprints overlap".into(),
                        ));
                    }
                }
            }
            if !stack.valid_item_state() {
                return Err(PlannerError::Invalid(
                    "invalid physical item state fact".into(),
                ));
            }
            let trusted = stack
                .item_id
                .as_ref()
                .is_some_and(|id| !id.trim().is_empty())
                && stack.quantity.is_some()
                && stack.provenance.identity_confirmed
                && stack.provenance.quantity_confirmed
                && stack.fir != Fir::Unknown;
            if !trusted {
                gaps.push(format!(
                    "Stack {} has unconfirmed identity, quantity or FIR.",
                    stack.id
                ));
            }
            let protected = stack.never_sell
                || stack
                    .item_id
                    .as_ref()
                    .and_then(|id| input.reserves.get(id))
                    .is_some_and(|r| r.never_sell);
            stock.push(Stock {
                container,
                snapshot,
                stack,
                trusted,
                protected,
            });
        }
    }
    if stock.len() > 8192 || input.requirements.len() > 8192 || input.reserves.len() > 8192 {
        return Err(PlannerError::Workload(
            "at most 8192 stacks, requirements and reserve rules per plan".into(),
        ));
    }
    let (mut demands, mut unfulfilled) = normalize_requirements(input, &mut gaps)?;
    for (item_id, reserve) in &input.reserves {
        if item_id.trim().is_empty() {
            return Err(PlannerError::Invalid(
                "reserve item ID cannot be empty".into(),
            ));
        }
        if reserve.extra_buffer > 0 {
            demands.push(Demand {
                ids: vec![format!("buffer:{item_id}")],
                alternatives: vec![item_id.clone()],
                count: reserve.extra_buffer,
                fir: FirConstraint::Any,
                minimum_dogtag_level: None,
                durability: None,
                reason: "Additional user buffer".into(),
            });
        }
    }
    demands.sort_by(|a, b| a.ids.cmp(&b.ids));
    let requested = demands.iter().map(|d| u64::from(d.count)).sum::<u64>();
    // Primary objective: minimize extra reserved stock beyond floors/protection.
    // Secondary objective: prefer non-FIR stock for unconstrained requirements.
    let reserve_cost = i64::try_from(requested + 1)
        .map_err(|_| PlannerError::Workload("requirement total overflow".into()))?;
    let mut item_stock: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, s) in stock.iter().enumerate().filter(|(_, s)| s.trusted) {
        item_stock
            .entry(s.stack.item_id.clone().unwrap_or_default())
            .or_default()
            .push(i);
    }
    let source = 0;
    let item_offset = 1;
    let stack_offset = item_offset + item_stock.len();
    let demand_offset = stack_offset + stock.len();
    let sink = demand_offset + demands.len();
    let mut graph = Flow::new(sink + 1);
    for (item_index, (item, indices)) in item_stock.iter().enumerate() {
        let node = item_offset + item_index;
        let protected = indices
            .iter()
            .filter(|i| stock[**i].protected)
            .map(|i| u64::from(stock[*i].stack.quantity.unwrap_or(0)))
            .sum::<u64>();
        let available = indices
            .iter()
            .filter(|i| !stock[**i].protected)
            .map(|i| u64::from(stock[*i].stack.quantity.unwrap_or(0)))
            .sum::<u64>();
        let floor_remaining = u64::from(input.reserves.get(item).map_or(0, |r| r.minimum_total))
            .saturating_sub(protected)
            .min(available);
        graph.add(source, node, floor_remaining, 0);
        graph.add(source, node, available - floor_remaining, reserve_cost);
        for &index in indices {
            let s = &stock[index];
            graph.add(
                if s.protected { source } else { node },
                stack_offset + index,
                u64::from(s.stack.quantity.unwrap_or(0)),
                0,
            );
        }
    }
    let mut allocation_edges = Vec::new();
    let mut demand_edges = Vec::new();
    let mut unknown_dogtag_stacks = BTreeSet::new();
    let mut unknown_durability_stacks = BTreeSet::new();
    for (demand_index, demand) in demands.iter().enumerate() {
        let node = demand_offset + demand_index;
        demand_edges.push(graph.add(node, sink, u64::from(demand.count), 0));
        for item in &demand.alternatives {
            for &index in item_stock.get(item).into_iter().flatten() {
                let s = &stock[index];
                if demand.fir == FirConstraint::Required && s.stack.fir != Fir::Yes {
                    continue;
                }
                if let Some(minimum) = demand.minimum_dogtag_level {
                    match &s.stack.dogtag {
                        Some(fact) if fact.confirmed && fact.level >= minimum => {}
                        Some(fact) if fact.confirmed => continue,
                        _ => {
                            if unknown_dogtag_stacks.insert(&s.stack.id) {
                                gaps.push(format!("Stack {} needs a confirmed dogtag level before constrained surplus decisions.", s.stack.id));
                            }
                            continue;
                        }
                    }
                }
                if let Some(range) = demand.durability {
                    match &s.stack.durability {
                        Some(fact)
                            if fact.confirmed
                                && fact.percent >= f64::from(range.minimum)
                                && fact.percent <= f64::from(range.maximum) => {}
                        Some(fact) if fact.confirmed => continue,
                        _ => {
                            if unknown_durability_stacks.insert(&s.stack.id) {
                                gaps.push(format!("Stack {} needs confirmed durability before constrained surplus decisions.", s.stack.id));
                            }
                            continue;
                        }
                    }
                }
                let cost = i64::from(demand.fir == FirConstraint::Any && s.stack.fir == Fir::Yes);
                let edge = graph.add(
                    stack_offset + index,
                    node,
                    u64::from(demand.count).min(u64::from(s.stack.quantity.unwrap_or(0))),
                    cost,
                );
                allocation_edges.push((index, demand_index, edge));
                if allocation_edges.len() > 250_000 {
                    return Err(PlannerError::Workload("more than 250000 eligible stack/requirement pairs; narrow the plan horizon".into()));
                }
            }
        }
    }
    graph.max_flow_min_cost(source, sink);
    let mut allocations = Vec::new();
    let mut reserved = vec![0_u32; stock.len()];
    for (stock_index, demand_index, edge) in allocation_edges {
        let used = graph.used(edge) as u32;
        if used == 0 {
            continue;
        }
        let s = &stock[stock_index];
        let d = &demands[demand_index];
        reserved[stock_index] = reserved[stock_index]
            .checked_add(used)
            .ok_or_else(|| PlannerError::Invalid("allocation quantity overflow".into()))?;
        allocations.push(allocation(s, used, d.ids.clone(), d.reason.clone()));
    }
    for (i, edge) in demand_edges.into_iter().enumerate() {
        let d = &demands[i];
        let missing = u64::from(d.count) - graph.used(edge);
        if missing > 0 {
            unfulfilled.push(Unfulfilled { requirement_ids: d.ids.clone(), alternatives: d.alternatives.clone(), quantity: Some(missing as u32), reason: "Insufficient confirmed eligible stock; unknown FIR/quantity does not satisfy this requirement.".into() });
        }
    }
    for (i, s) in stock.iter().enumerate() {
        if s.trusted && s.protected {
            reserved[i] = s.stack.quantity.unwrap_or(0);
        }
    }
    // Floors overlap all existing reservations, rather than being added twice.
    for (item_id, reserve) in &input.reserves {
        let indices = item_stock.get(item_id).cloned().unwrap_or_default();
        let already = indices.iter().map(|i| u64::from(reserved[*i])).sum::<u64>();
        let mut missing = u64::from(reserve.minimum_total).saturating_sub(already);
        for index in indices {
            let free = stock[index].stack.quantity.unwrap_or(0) - reserved[index];
            let take = u64::from(free).min(missing) as u32;
            if take > 0 {
                reserved[index] += take;
                missing -= u64::from(take);
                allocations.push(allocation(
                    &stock[index],
                    take,
                    vec![format!("minimum:{item_id}")],
                    "Minimum total user reserve".into(),
                ));
            }
        }
        if missing > 0 {
            unfulfilled.push(Unfulfilled {
                requirement_ids: vec![format!("minimum:{item_id}")],
                alternatives: vec![item_id.clone()],
                quantity: Some(missing as u32),
                reason: "Minimum user reserve exceeds confirmed stock.".into(),
            });
        }
    }
    gaps.sort();
    gaps.dedup();
    let complete = gaps.is_empty();
    let mut affected = BTreeSet::new();
    for missing in &unfulfilled {
        affected.extend(missing.alternatives.iter().cloned());
    }
    let mut plans = Vec::new();
    let mut summaries = BTreeMap::<String, ItemSummary>::new();
    for (index, s) in stock.iter().enumerate() {
        let mut portions = Vec::new();
        let count = s.stack.quantity;
        if !s.trusted {
            portions.push(Portion {
                recommendation: Recommendation::Review,
                quantity: if s.stack.provenance.quantity_confirmed {
                    count
                } else {
                    None
                },
                reason: if s.protected {
                    "Never-sell protection applies; verify unknown identity, quantity or FIR."
                } else {
                    "Verify unknown identity, quantity or FIR; this stock cannot authorize a sale."
                }
                .into(),
            });
        } else {
            let kept = reserved[index];
            if kept > 0 {
                portions.push(Portion {
                    recommendation: Recommendation::Keep,
                    quantity: Some(kept),
                    reason: if s.protected {
                        "Never-sell protection"
                    } else {
                        "Reserved for requirements, tools or user reserves; see allocations"
                    }
                    .into(),
                });
            }
            let free = count.unwrap_or(0) - kept;
            if free > 0 {
                let can_sell =
                    complete && !affected.contains(s.stack.item_id.as_deref().unwrap_or_default());
                portions.push(Portion { recommendation: if can_sell { Recommendation::Sell } else { Recommendation::Review }, quantity: Some(free), reason: if can_sell { "Confirmed unallocated surplus after all selected requirements and reserves" } else { "Incomplete evidence or unmet competing requirements prevent a reliable surplus decision" }.into() });
            }
        }
        if let Some(item) = &s.stack.item_id {
            let summary = summaries
                .entry(item.clone())
                .or_insert_with(|| ItemSummary {
                    item_id: item.clone(),
                    ..ItemSummary::default()
                });
            if s.trusted {
                summary.confirmed_owned += u64::from(count.unwrap_or(0));
            } else {
                summary.unknown_stacks += 1;
            }
            for portion in &portions {
                if let Some(amount) = portion.quantity {
                    match portion.recommendation {
                        Recommendation::Keep => summary.keep += u64::from(amount),
                        Recommendation::Sell => summary.sell += u64::from(amount),
                        Recommendation::Review => {
                            summary.review_known_quantity += u64::from(amount)
                        }
                    }
                }
            }
        }
        plans.push(StackPlan {
            container_id: s.container.id.clone(),
            snapshot_id: s.snapshot.id.clone(),
            stack_id: s.stack.id.clone(),
            item_id: s.stack.item_id.clone(),
            location: s.stack.location,
            portions,
        });
    }
    Ok(Plan {
        profile_id: input.inventory.profile.id.clone(),
        mode: input.inventory.profile.mode,
        catalog_version: input.catalog_version.clone(),
        progression_revision: input.progression_revision.clone(),
        plan_revision: input.plan_revision.clone(),
        horizon: input.horizon.clone(),
        container_revisions: revisions,
        sale_decisions_complete: complete,
        coverage_gaps: gaps,
        allocations,
        stacks: plans,
        items: summaries.into_values().collect(),
        unfulfilled,
    })
}

fn normalize_requirements(
    input: &PlannerInput,
    gaps: &mut Vec<String>,
) -> Result<(Vec<Demand>, Vec<Unfulfilled>), PlannerError> {
    let mut ids = BTreeSet::new();
    let mut reusable = BTreeMap::<String, Demand>::new();
    let mut demands = Vec::new();
    let mut unfulfilled = Vec::new();
    let mut ordered = input.requirements.iter().collect::<Vec<_>>();
    ordered.sort_by(|a, b| a.id.cmp(&b.id));
    for requirement in ordered {
        if requirement
            .durability
            .is_some_and(|range| range.minimum > range.maximum || range.maximum > 100)
        {
            return Err(PlannerError::Invalid(
                "durability range must be ordered within 0..100 percent".into(),
            ));
        }
        if requirement
            .minimum_dogtag_level
            .is_some_and(|level| level == 0 || level > 1000)
        {
            return Err(PlannerError::Invalid(
                "minimum dogtag level must be 1..1000 or absent".into(),
            ));
        }
        if requirement.id.trim().is_empty() || !ids.insert(&requirement.id) {
            return Err(PlannerError::Invalid(
                "requirement IDs must be nonempty and unique".into(),
            ));
        }
        let mut alternatives = requirement.alternatives.clone();
        alternatives.sort();
        alternatives.dedup();
        if alternatives.iter().any(|id| id.trim().is_empty()) {
            return Err(PlannerError::Invalid(
                "alternative item IDs must be nonempty".into(),
            ));
        }
        let Some(count) = requirement
            .quantity
            .filter(|_| requirement.fir != FirConstraint::Unknown && !alternatives.is_empty())
        else {
            gaps.push(format!(
                "Requirement {} has unknown quantity, FIR condition or accepted items.",
                requirement.id
            ));
            unfulfilled.push(Unfulfilled {
                requirement_ids: vec![requirement.id.clone()],
                alternatives,
                quantity: requirement.quantity,
                reason: "Requirement details require manual review.".into(),
            });
            continue;
        };
        if count == 0 {
            continue;
        }
        let demand = Demand {
            ids: vec![requirement.id.clone()],
            alternatives,
            count,
            fir: requirement.fir,
            minimum_dogtag_level: requirement.minimum_dogtag_level,
            // A complete percentage range imposes no physical state restriction.
            durability: requirement
                .durability
                .filter(|range| range.minimum > 0 || range.maximum < 100),
            reason: requirement.source.clone(),
        };
        match &requirement.kind {
            RequirementKind::Consume => demands.push(demand),
            RequirementKind::Reusable { group } => {
                if group.trim().is_empty() {
                    return Err(PlannerError::Invalid(
                        "sequential reusable group must have an ID".into(),
                    ));
                }
                if let Some(existing) = reusable.get_mut(group) {
                    if existing.alternatives != demand.alternatives
                        || existing.fir != demand.fir
                        || existing.minimum_dogtag_level != demand.minimum_dogtag_level
                        || existing.durability != demand.durability
                    {
                        return Err(PlannerError::Invalid(format!(
                            "reusable group {group} has incompatible item/FIR/state constraints; split into explicit groups"
                        )));
                    }
                    existing.count = existing.count.max(count);
                    existing.ids.extend(demand.ids);
                    existing.reason.push_str("; ");
                    existing.reason.push_str(&demand.reason);
                } else {
                    reusable.insert(group.clone(), demand);
                }
            }
        }
    }
    demands.extend(reusable.into_values());
    Ok((demands, unfulfilled))
}

fn allocation(
    stock: &Stock<'_>,
    quantity: u32,
    requirement_ids: Vec<String>,
    reason: String,
) -> Allocation {
    Allocation {
        container_id: stock.container.id.clone(),
        snapshot_id: stock.snapshot.id.clone(),
        stack_id: stock.stack.id.clone(),
        item_id: stock.stack.item_id.clone().unwrap_or_default(),
        quantity,
        requirement_ids,
        reason,
    }
}

#[derive(Clone, Copy)]
struct Edge {
    to: usize,
    reverse: usize,
    capacity: u64,
    original: u64,
    cost: i64,
}
#[derive(Clone, Copy)]
struct EdgeRef {
    from: usize,
    index: usize,
}
struct Flow {
    edges: Vec<Vec<Edge>>,
}

impl Flow {
    fn new(nodes: usize) -> Self {
        Self {
            edges: vec![vec![]; nodes],
        }
    }
    fn add(&mut self, from: usize, to: usize, capacity: u64, cost: i64) -> EdgeRef {
        let forward = self.edges[from].len();
        let reverse = self.edges[to].len();
        self.edges[from].push(Edge {
            to,
            reverse,
            capacity,
            original: capacity,
            cost,
        });
        self.edges[to].push(Edge {
            to: from,
            reverse: forward,
            capacity: 0,
            original: 0,
            cost: -cost,
        });
        EdgeRef {
            from,
            index: forward,
        }
    }
    fn used(&self, edge: EdgeRef) -> u64 {
        let edge = self.edges[edge.from][edge.index];
        edge.original - edge.capacity
    }
    fn max_flow_min_cost(&mut self, source: usize, sink: usize) {
        let nodes = self.edges.len();
        let mut potential = vec![0_i64; nodes];
        loop {
            let mut distance = vec![i64::MAX; nodes];
            let mut previous = vec![None::<EdgeRef>; nodes];
            let mut heap = BinaryHeap::new();
            distance[source] = 0;
            heap.push(Reverse((0_i64, source)));
            while let Some(Reverse((cost, from))) = heap.pop() {
                if cost != distance[from] {
                    continue;
                }
                for (index, edge) in self.edges[from].iter().enumerate() {
                    if edge.capacity == 0 {
                        continue;
                    }
                    let next = cost + edge.cost + potential[from] - potential[edge.to];
                    if next < distance[edge.to] {
                        distance[edge.to] = next;
                        previous[edge.to] = Some(EdgeRef { from, index });
                        heap.push(Reverse((next, edge.to)));
                    }
                }
            }
            if previous[sink].is_none() {
                break;
            }
            for node in 0..nodes {
                if distance[node] != i64::MAX {
                    potential[node] += distance[node];
                }
            }
            let mut amount = u64::MAX;
            let mut node = sink;
            while let Some(link) = previous[node] {
                amount = amount.min(self.edges[link.from][link.index].capacity);
                node = link.from;
            }
            node = sink;
            while let Some(link) = previous[node] {
                let edge = self.edges[link.from][link.index];
                self.edges[link.from][link.index].capacity -= amount;
                self.edges[node][edge.reverse].capacity += amount;
                node = link.from;
            }
        }
    }
}
