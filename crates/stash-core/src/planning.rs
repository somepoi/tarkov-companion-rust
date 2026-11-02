//! Persisted intent is separate from derived recommendations and physical stock.
use crate::{StorageError, planner::UserReserve};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const HORIZON: &str = "All unfinished faction quests; target hideout levels including dependencies; selected craft and barter batches";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningPreferences {
    /// Missing station means all known levels. Zero explicitly excludes it,
    /// unless another selected upgrade requires it as a dependency.
    pub hideout_targets: BTreeMap<String, u32>,
    pub craft_batches: BTreeMap<String, u32>,
    pub barter_batches: BTreeMap<String, u32>,
    pub reserves: BTreeMap<String, UserReserve>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningState {
    pub profile_id: String,
    pub revision: u64,
    pub preferences: PlanningPreferences,
}

/// The frontend supplies catalog/progression facts; Rust derives demand using
/// saved native preferences and reads physical inventory in the same actor job.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalculatePlan {
    pub profile_id: String,
    pub expected_plan_revision: u64,
    pub expected_container_revisions: BTreeMap<String, u64>,
    pub catalog_version: String,
    pub progression_revision: String,
    pub inventory_confirmed_current: bool,
    pub requirements_complete: bool,
    pub coverage_gaps: Vec<String>,
    pub normalization_input: Box<crate::requirements::Input>,
}

pub(crate) fn validate(preferences: &PlanningPreferences) -> Result<(), StorageError> {
    for map in [
        &preferences.hideout_targets,
        &preferences.craft_batches,
        &preferences.barter_batches,
    ] {
        if map.len() > 8192 || map.iter().any(|(id, n)| !valid_id(id) || *n > 1_000_000) {
            return Err(StorageError::Invalid(
                "planning entries exceed supported bounds".into(),
            ));
        }
    }
    if preferences.hideout_targets.values().any(|n| *n > 256)
        || preferences.reserves.len() > 8192
        || preferences.reserves.keys().any(|id| !valid_id(id))
    {
        return Err(StorageError::Invalid(
            "invalid hideout targets or reserve IDs".into(),
        ));
    }
    Ok(())
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.trim().is_empty() && id.len() <= 512 && !id.contains('\0')
}
