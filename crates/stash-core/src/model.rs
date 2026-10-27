use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GameMode {
    Pve,
    Regular,
}

impl GameMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pve => "pve",
            Self::Regular => "regular",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Fir {
    Yes,
    No,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub mode: GameMode,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Container {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    pub kind: String,
    pub columns: u32,
    pub rows: u32,
    pub revision: u64,
    pub current_snapshot_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CellBox {
    pub column: u32,
    pub row: u32,
    pub width: u32,
    pub height: u32,
    pub rotated: bool,
}

impl CellBox {
    pub fn overlaps(self, other: Self) -> bool {
        u64::from(self.column) < u64::from(other.column) + u64::from(other.width)
            && u64::from(other.column) < u64::from(self.column) + u64::from(self.width)
            && u64::from(self.row) < u64::from(other.row) + u64::from(other.height)
            && u64::from(other.row) < u64::from(self.row) + u64::from(self.height)
    }
}

/// Identity, quantity and FIR are independent facts. A chosen icon does not
/// confirm quantity or establish Found in Raid status.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provenance {
    pub identity_confirmed: bool,
    pub quantity_confirmed: bool,
    pub method: String,
    pub screenshot_hash: Option<String>,
    pub observation_id: Option<String>,
    pub corrected: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stack {
    pub id: String,
    pub item_id: Option<String>,
    /// None means unknown, never one inferred from a detected rectangle.
    pub quantity: Option<u32>,
    pub fir: Fir,
    pub location: CellBox,
    pub provenance: Provenance,
    pub never_sell: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub id: String,
    pub screenshot_hash: String,
    pub location: CellBox,
    pub candidates: Vec<RecognitionCandidate>,
    pub quantity: Option<u32>,
    pub fir: Fir,
    pub reviewed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecognitionCandidate {
    pub item_id: String,
    /// Heuristic score, not a calibrated probability.
    pub error: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanScope {
    Full,
    Partial,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanStatus {
    Draft,
    Committed,
    Abandoned,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanDraft {
    pub full_coverage_confirmed: bool,
    pub review_confirmed: bool,
    pub captured_at: String,
    pub algorithm_version: String,
    pub catalog_version: String,
    pub stacks: Vec<Stack>,
    pub observations: Vec<Observation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanSession {
    pub id: String,
    pub container_id: String,
    pub base_revision: u64,
    pub scope: ScanScope,
    pub status: ScanStatus,
    pub draft: Option<ScanDraft>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitScan {
    pub session_id: String,
    pub expected_revision: u64,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitResult {
    pub container_id: String,
    pub snapshot_id: String,
    pub revision: u64,
    pub session_id: Option<String>,
    pub previous_snapshot_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContainerInventory {
    pub container: Container,
    pub snapshot: Option<InventorySnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InventorySnapshot {
    pub id: String,
    pub revision: u64,
    pub captured_at: String,
    pub algorithm_version: String,
    pub catalog_version: String,
    pub full_coverage_confirmed: bool,
    pub stacks: Vec<Stack>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyChecklist {
    pub profile_id: String,
    pub source_hash: String,
    /// Unlocated legacy figures are not added to physical inventory or used by
    /// the planner to authorize surplus. Reconcile them explicitly in the UI.
    pub counts: BTreeMap<String, u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Inventory {
    pub profile: Profile,
    pub containers: Vec<ContainerInventory>,
    pub legacy: Option<LegacyChecklist>,
}
