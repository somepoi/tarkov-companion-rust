//! Explicit cell ownership for multiple registered views. Icons never establish identity.
use crate::{CellBox, Container, ScanDraft, StorageError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisteredView {
    pub id: String,
    pub screenshot_hash: String,
    pub column: u32,
    pub row: u32,
    pub columns: u32,
    pub rows: u32,
    pub coverage_confirmed: bool,
    pub draft: ScanDraft,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CellChoice {
    pub column: u32,
    pub row: u32,
    pub view_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Composition {
    pub stable_layout_confirmed: bool,
    pub views: Vec<RegisteredView>,
    pub choices: Vec<CellChoice>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellConflict {
    pub column: u32,
    pub row: u32,
    pub view_ids: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompositionPreview {
    pub covered_cells: usize,
    pub total_cells: usize,
    pub unresolved_cells: usize,
    /// At most 1024 examples; the count above includes the complete unresolved region.
    pub conflicts: Vec<CellConflict>,
    pub split_stacks: Vec<String>,
    pub draft: Option<ScanDraft>,
}
fn invalid(message: &str) -> StorageError {
    StorageError::Invalid(message.into())
}
fn shifted(mut location: CellBox, view: &RegisteredView) -> CellBox {
    location.column += view.column;
    location.row += view.row;
    location
}
fn id(view: &str, local: &str) -> String {
    format!("{view}:{local}")
}
pub fn compose(
    owner: &Container,
    request: &Composition,
) -> Result<CompositionPreview, StorageError> {
    if request.views.is_empty()
        || request.views.len() > 32
        || request.choices.len() > 65_536
        || !(1..=256).contains(&owner.columns)
        || !(1..=256).contains(&owner.rows)
    {
        return Err(invalid("Composition exceeds supported view/grid limits"));
    }
    let total = (owner.columns * owner.rows) as usize;
    let mut cells: Vec<Vec<usize>> = vec![Vec::new(); total];
    let mut protected = vec![false; total];
    let mut names = BTreeMap::new();
    let mut records = 0;
    let mut visits = 0_u64;
    for (index, view) in request.views.iter().enumerate() {
        if view.id.is_empty()
            || view.id.len() > 64
            || !view
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || names.insert(view.id.clone(), index).is_some()
            || !view.coverage_confirmed
            || view.columns == 0
            || view.rows == 0
            || u64::from(view.column) + u64::from(view.columns) > u64::from(owner.columns)
            || u64::from(view.row) + u64::from(view.rows) > u64::from(owner.rows)
            || view.screenshot_hash.len() != 64
            || !view.screenshot_hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(invalid(
                "Invalid view identity, visible coverage or registration",
            ));
        }
        visits += u64::from(view.columns) * u64::from(view.rows);
        records += view.draft.stacks.len() + view.draft.observations.len();
        if visits > 1_000_000 || records > 65_536 {
            return Err(invalid("Composition exceeds its cell/evidence budget"));
        }
        let mut local = owner.clone();
        local.columns = view.columns;
        local.rows = view.rows;
        crate::repository::validate_draft(&view.draft, &local)?;
        if view.draft.stacks.iter().any(|s| {
            s.id.len() > 128
                || s.provenance.screenshot_hash.as_deref() != Some(&view.screenshot_hash)
        }) || view.draft.observations.iter().any(|o| {
            o.id.len() > 128
                || o.screenshot_hash != view.screenshot_hash
                || o.source_grid
                    .as_ref()
                    .is_some_and(|grid| grid.cols != view.columns || grid.rows != view.rows)
        }) {
            return Err(invalid(
                "Every view stack and observation must reference its archived screenshot",
            ));
        }
        for row in view.row..view.row + view.rows {
            for col in view.column..view.column + view.columns {
                cells[(row * owner.columns + col) as usize].push(index);
            }
        }
        for stack in view.draft.stacks.iter().filter(|stack| stack.never_sell) {
            let location = shifted(stack.location, view);
            for row in location.row..location.row + location.height {
                for col in location.column..location.column + location.width {
                    protected[(row * owner.columns + col) as usize] = true;
                }
            }
        }
    }
    let mut choices = BTreeMap::new();
    for choice in &request.choices {
        let view = *names
            .get(&choice.view_id)
            .ok_or_else(|| invalid("Choice references a missing view"))?;
        if choice.column >= owner.columns || choice.row >= owner.rows {
            return Err(invalid("Choice is outside the container"));
        }
        let at = (choice.row * owner.columns + choice.column) as usize;
        if !cells[at].contains(&view) || choices.insert(at, view).is_some() {
            return Err(invalid("Choice is duplicated or outside its view"));
        }
    }
    let mut preview = CompositionPreview {
        covered_cells: 0,
        total_cells: total,
        unresolved_cells: 0,
        conflicts: Vec::new(),
        split_stacks: Vec::new(),
        draft: None,
    };
    let mut selected = vec![None; total];
    for (at, sources) in cells.iter().enumerate() {
        if sources.is_empty() {
            continue;
        }
        preview.covered_cells += 1;
        selected[at] = choices
            .get(&at)
            .copied()
            .or_else(|| (sources.len() == 1).then(|| sources[0]));
        if selected[at].is_none() {
            preview.unresolved_cells += 1;
            if preview.conflicts.len() < 1024 {
                preview.conflicts.push(CellConflict {
                    column: at as u32 % owner.columns,
                    row: at as u32 / owner.columns,
                    view_ids: sources
                        .iter()
                        .map(|i| request.views[*i].id.clone())
                        .collect(),
                });
            }
        }
    }
    if preview.unresolved_cells > 0 {
        return Ok(preview);
    }
    let mut draft = request.views[0].draft.clone();
    draft.stacks.clear();
    draft.observations.clear();
    draft.full_coverage_confirmed = preview.covered_cells == total;
    draft.review_confirmed =
        request.stable_layout_confirmed && request.views.iter().all(|v| v.draft.review_confirmed);
    draft.algorithm_version = "registered-views-v1".into();
    let versions: BTreeSet<_> = request
        .views
        .iter()
        .map(|v| v.draft.catalog_version.as_str())
        .collect();
    if versions.len() != 1 {
        return Err(invalid(
            "Views use different catalog versions; review against one catalog",
        ));
    }
    for (index, view) in request.views.iter().enumerate() {
        for observation in &view.draft.observations {
            let mut next = observation.clone();
            next.id = id(&view.id, &next.id);
            next.location = shifted(next.location, view);
            if let Some(grid) = &mut next.source_grid {
                grid.ox -= f64::from(view.column) * grid.pitch;
                grid.oy -= f64::from(view.row) * grid.pitch;
                grid.cols = owner.columns;
                grid.rows = owner.rows;
            }
            draft.observations.push(next);
        }
        for stack in &view.draft.stacks {
            let location = shifted(stack.location, view);
            let mut chosen = 0;
            for row in location.row..location.row + location.height {
                for col in location.column..location.column + location.width {
                    if selected[(row * owner.columns + col) as usize] == Some(index) {
                        chosen += 1;
                    }
                }
            }
            if chosen == 0 {
                continue;
            }
            if chosen != location.width * location.height {
                preview.split_stacks.push(id(&view.id, &stack.id));
                continue;
            }
            let mut next = stack.clone();
            next.id = id(&view.id, &next.id);
            next.location = location;
            for row in location.row..location.row + location.height {
                for col in location.column..location.column + location.width {
                    next.never_sell |= protected[(row * owner.columns + col) as usize];
                }
            }
            next.provenance.observation_id = next
                .provenance
                .observation_id
                .map(|local| id(&view.id, &local));
            draft.stacks.push(next);
        }
    }
    if preview.split_stacks.is_empty() {
        crate::repository::validate_draft(&draft, owner)?;
        preview.draft = Some(draft);
    }
    Ok(preview)
}
