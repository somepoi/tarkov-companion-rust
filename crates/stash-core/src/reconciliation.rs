//! Explicit manual reconciliation; fragments never donate counts or confirmations.
use crate::{
    CellBox, Container, JoinedSource, ScanDraft, Stack, StorageError, composition::Composition,
};
use std::collections::{BTreeMap, BTreeSet};

fn invalid(message: &str) -> StorageError {
    StorageError::Invalid(message.into())
}
type Consumed<'a> = BTreeSet<(usize, &'a str)>;

pub(crate) fn resolve<'a>(
    owner: &Container,
    request: &'a Composition,
    selected: &[Option<usize>],
    protected: &[bool],
) -> Result<(Vec<Stack>, Consumed<'a>), StorageError> {
    if request.joins.is_empty() {
        return Ok((Vec::new(), BTreeSet::new()));
    }
    let views: BTreeMap<_, _> = request
        .views
        .iter()
        .enumerate()
        .map(|(index, view)| (view.id.as_str(), index))
        .collect();
    let stacks: BTreeMap<_, _> = request
        .views
        .iter()
        .enumerate()
        .flat_map(|(index, view)| {
            view.draft
                .stacks
                .iter()
                .map(move |stack| ((index, stack.id.as_str()), stack))
        })
        .collect();
    let observations: BTreeMap<_, _> = request
        .views
        .iter()
        .enumerate()
        .flat_map(|(index, view)| {
            view.draft
                .observations
                .iter()
                .map(move |observation| ((index, observation.id.as_str()), observation))
        })
        .collect();
    let mut consumed = BTreeSet::new();
    let mut ids = BTreeSet::new();
    let mut result = Vec::new();
    let mut visits = 0_u64;
    let mut occupied = vec![false; selected.len()];
    for join in &request.joins {
        if join.id.is_empty()
            || join.id.len() > 64
            || !join
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || !ids.insert(&join.id)
            || !(2..=32).contains(&join.parts.len())
            || !join.output.joined_sources.is_empty()
        {
            return Err(invalid("Invalid or recursive footprint reconciliation"));
        }
        let mut members = Vec::new();
        let mut distinct_views = BTreeSet::new();
        let (mut left, mut top, mut right, mut bottom) = (owner.columns, owner.rows, 0, 0);
        for part in &join.parts {
            let index = *views
                .get(part.view_id.as_str())
                .ok_or_else(|| invalid("Reconciliation references a missing view"))?;
            if !distinct_views.insert(index) || !consumed.insert((index, part.stack_id.as_str())) {
                return Err(invalid(
                    "A fragment can be used once, with one fragment per source view",
                ));
            }
            let stack = *stacks
                .get(&(index, part.stack_id.as_str()))
                .ok_or_else(|| invalid("Reconciliation references a missing stack"))?;
            if !stack.joined_sources.is_empty() {
                return Err(invalid(
                    "Use direct original fragments rather than recursively joining evidence",
                ));
            }
            let view = &request.views[index];
            let local = stack.location;
            if local.column > 0
                && local.row > 0
                && local.column + local.width < view.columns
                && local.row + local.height < view.rows
            {
                return Err(invalid("Only view-boundary fragments can be reconciled"));
            }
            let location = CellBox {
                column: local.column + view.column,
                row: local.row + view.row,
                ..local
            };
            left = left.min(location.column);
            top = top.min(location.row);
            right = right.max(location.column + location.width);
            bottom = bottom.max(location.row + location.height);
            members.push((index, stack, location));
        }
        let footprint = CellBox {
            column: left,
            row: top,
            width: right - left,
            height: bottom - top,
            rotated: join.output.location.rotated,
        };
        if join.output.location != footprint {
            return Err(invalid(
                "The reviewed output footprint must equal the complete fragment bounds",
            ));
        }
        visits += u64::from(footprint.width) * u64::from(footprint.height);
        if visits > 1_000_000 {
            return Err(invalid("Reconciled footprints exceed the cell budget"));
        }
        let mut allowed = vec![0_u32; selected.len()];
        let mut evidence = Vec::new();
        for (index, stack, location) in members {
            let view = &request.views[index];
            let visible_left = left.max(view.column);
            let visible_top = top.max(view.row);
            let visible_right = right.min(view.column + view.columns);
            let visible_bottom = bottom.min(view.row + view.rows);
            if location.column != visible_left
                || location.row != visible_top
                || location.column + location.width != visible_right
                || location.row + location.height != visible_bottom
            {
                return Err(invalid(
                    "Each fragment must show the complete intersection of its view and the reconciled footprint",
                ));
            }
            if left >= view.column
                && top >= view.row
                && right <= view.column + view.columns
                && bottom <= view.row + view.rows
            {
                return Err(invalid(
                    "A complete footprint visible in one source must use ordinary source authority",
                ));
            }
            for row in location.row..location.row + location.height {
                for column in location.column..location.column + location.width {
                    allowed[(row * owner.columns + column) as usize] |= 1_u32 << index;
                }
            }
            let observation = stack
                .provenance
                .observation_id
                .as_ref()
                .and_then(|id| observations.get(&(index, id.as_str())));
            evidence.push(JoinedSource {
                view_id: view.id.clone(),
                stack_id: stack.id.clone(),
                screenshot_hash: view.screenshot_hash.clone(),
                view_column: view.column,
                view_row: view.row,
                columns: view.columns,
                rows: view.rows,
                location: stack.location,
                source_grid: observation.and_then(|value| value.source_grid.clone()),
            });
        }
        let mut output = join.output.clone();
        for row in top..bottom {
            for column in left..right {
                let at = (row * owner.columns + column) as usize;
                if allowed[at] == 0
                    || selected[at].is_some_and(|index| allowed[at] & (1_u32 << index) == 0)
                {
                    return Err(invalid(
                        "Joined footprint has holes or cell authority outside its declared fragments",
                    ));
                }
                if occupied[at] {
                    return Err(invalid("Reconciled physical footprints overlap"));
                }
                occupied[at] = true;
                output.never_sell |= protected[at];
            }
        }
        output.id = format!("joined:{}", join.id);
        output.provenance.method = format!("joined-views:{}", join.id);
        output.provenance.screenshot_hash = evidence
            .first()
            .map(|source| source.screenshot_hash.clone());
        output.provenance.observation_id = None;
        output.provenance.corrected = true;
        output.joined_sources = evidence;
        // Validate independent manual facts without borrowing fragment confirmations.
        let source = &request.views[0].draft;
        let validation = ScanDraft {
            stacks: vec![output.clone()],
            observations: vec![],
            full_coverage_confirmed: false,
            review_confirmed: false,
            captured_at: source.captured_at.clone(),
            algorithm_version: source.algorithm_version.clone(),
            catalog_version: source.catalog_version.clone(),
        };
        crate::repository::validate_draft(&validation, owner)?;
        result.push(output);
    }
    Ok((result, consumed))
}
