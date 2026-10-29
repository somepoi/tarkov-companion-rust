use crate::model::*;
use crate::planning::{CalculatePlan, PlanningPreferences, PlanningState};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path, time::Duration};
use thiserror::Error;
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 5;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("stored data is invalid: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("{0} was not found")]
    NotFound(&'static str),
    #[error("container changed: expected revision {expected}, current revision {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error(
        "planning preferences changed: expected revision {expected}, current revision {actual}"
    )]
    PlanRevisionConflict { expected: u64, actual: u64 },
    #[error("allocation failed: {0}")]
    Planner(#[from] crate::planner::PlannerError),
    #[error("idempotency key was already used for a different request")]
    IdempotencyConflict,
    #[error("database schema {0} is newer than this application supports")]
    NewerSchema(u32),
    #[error("backup destination must be a new file: {0}")]
    Backup(#[from] std::io::Error),
}

/// A single owner of user facts. Transactions are serialized by this connection;
/// callers should also serialize requests on their dedicated blocking worker.
pub struct Repository {
    connection: Connection,
}

impl Repository {
    /// Checks a supplied backup without migrating or writing to the source.
    pub fn verify_file(path: impl AsRef<Path>) -> Result<BTreeSet<String>, StorageError> {
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        connection.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;")?;
        let version: u32 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(StorageError::NewerSchema(version));
        }
        if version == 0 {
            return Err(StorageError::Invalid(
                "backup has no supported inventory schema".into(),
            ));
        }
        let result: String = connection.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if result != "ok" {
            return Err(StorageError::Invalid(format!(
                "SQLite integrity check failed: {result}"
            )));
        }
        let violation = connection.prepare("PRAGMA foreign_key_check")?.exists([])?;
        if violation {
            return Err(StorageError::Invalid(
                "backup contains broken database references".into(),
            ));
        }
        let repository = Self { connection };
        repository.list_profiles()?;
        let mut hashes = BTreeSet::new();
        let mut stacks = repository
            .connection
            .prepare("SELECT payload_json FROM snapshot_stacks")?;
        for json in stacks.query_map([], |r| r.get::<_, String>(0))? {
            let stack: Stack = serde_json::from_str(&json?)?;
            if let Some(hash) = stack.provenance.screenshot_hash {
                digest(&hash)?;
                hashes.insert(hash);
            }
        }
        let mut drafts = repository
            .connection
            .prepare("SELECT draft_json FROM scan_sessions WHERE draft_json IS NOT NULL")?;
        for json in drafts.query_map([], |r| r.get::<_, String>(0))? {
            let draft: ScanDraft = serde_json::from_str(&json?)?;
            for hash in draft
                .stacks
                .into_iter()
                .filter_map(|s| s.provenance.screenshot_hash)
                .chain(draft.observations.into_iter().map(|o| o.screenshot_hash))
            {
                digest(&hash)?;
                hashes.insert(hash);
            }
        }
        if version >= 5 {
            let mut compositions = repository
                .connection
                .prepare("SELECT payload_json FROM scan_compositions")?;
            for json in compositions.query_map([], |r| r.get::<_, String>(0))? {
                let request: crate::composition::Composition = serde_json::from_str(&json?)?;
                for view in request.views {
                    digest(&view.screenshot_hash)?;
                    hashes.insert(view.screenshot_hash);
                }
            }
        }
        Ok(hashes)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let path = path.as_ref();
        let connection = Connection::open(path)?;
        let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 0 && version < SCHEMA_VERSION {
            // SQLite backup includes committed WAL pages; do not copy the live file.
            let destination =
                path.with_extension(format!("before-v{SCHEMA_VERSION}-{}.sqlite", new_id()));
            backup_connection(&connection, &destination)?;
        }
        Self::initialize(connection)
    }

    pub fn open_in_memory() -> Result<Self, StorageError> {
        Self::initialize(Connection::open_in_memory()?)
    }

    fn initialize(mut connection: Connection) -> Result<Self, StorageError> {
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;")?;
        let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(StorageError::NewerSchema(version));
        }
        if version == 0 {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(include_str!("../migrations/0001_user.sql"))?;
            tx.commit()?;
        }
        if version < 2 {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(include_str!("../migrations/0002_planning.sql"))?;
            tx.commit()?;
        }
        if version < 3 {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(include_str!("../migrations/0003_scan_evidence.sql"))?;
            tx.commit()?;
        }
        if version < 4 {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(include_str!("../migrations/0004_quantity_evidence.sql"))?;
            tx.commit()?;
        }
        if version < 5 {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(include_str!("../migrations/0005_scan_compositions.sql"))?;
            tx.commit()?;
        }
        Ok(Self { connection })
    }

    pub fn create_profile(&mut self, mode: GameMode, name: &str) -> Result<Profile, StorageError> {
        text(name, "profile name")?;
        let profile = Profile {
            id: new_id(),
            mode,
            name: name.to_owned(),
        };
        self.connection.execute(
            "INSERT INTO profiles(id,mode,name) VALUES (?1,?2,?3)",
            params![profile.id, mode.as_str(), name],
        )?;
        Ok(profile)
    }

    pub fn list_profiles(&self) -> Result<Vec<Profile>, StorageError> {
        let mut query = self
            .connection
            .prepare("SELECT id,mode,name FROM profiles ORDER BY id")?;
        Ok(query
            .query_map([], profile_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn planning_state(&self, profile_id: &str) -> Result<PlanningState, StorageError> {
        profile(&self.connection, profile_id)?;
        let row: Option<(u64, String)> = self
            .connection
            .query_row(
                "SELECT revision,preferences_json FROM planning_preferences WHERE profile_id=?1",
                [profile_id],
                |row| Ok((read_revision(row, 0)?, row.get(1)?)),
            )
            .optional()?;
        let (revision, preferences) = match row {
            Some((revision, json)) => (revision, serde_json::from_str(&json)?),
            None => (0, PlanningPreferences::default()),
        };
        crate::planning::validate(&preferences)?;
        Ok(PlanningState {
            profile_id: profile_id.to_owned(),
            revision,
            preferences,
        })
    }

    pub fn save_planning_state(
        &mut self,
        profile_id: &str,
        expected_revision: u64,
        preferences: PlanningPreferences,
    ) -> Result<PlanningState, StorageError> {
        crate::planning::validate(&preferences)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        profile(&tx, profile_id)?;
        let actual: u64 = tx
            .query_row(
                "SELECT revision FROM planning_preferences WHERE profile_id=?1",
                [profile_id],
                |row| read_revision(row, 0),
            )
            .optional()?
            .unwrap_or(0);
        if actual != expected_revision {
            return Err(StorageError::PlanRevisionConflict {
                expected: expected_revision,
                actual,
            });
        }
        let revision = actual
            .checked_add(1)
            .ok_or_else(|| StorageError::Invalid("plan revision overflow".into()))?;
        tx.execute("INSERT INTO planning_preferences(profile_id,revision,preferences_json) VALUES (?1,?2,?3) ON CONFLICT(profile_id) DO UPDATE SET revision=excluded.revision,preferences_json=excluded.preferences_json",
            params![profile_id, sql_revision(revision)?, serde_json::to_string(&preferences)?])?;
        tx.commit()?;
        Ok(PlanningState {
            profile_id: profile_id.to_owned(),
            revision,
            preferences,
        })
    }

    pub fn calculate_plan(&mut self, request: CalculatePlan) -> Result<crate::Plan, StorageError> {
        let saved = self.planning_state(&request.profile_id)?;
        if saved.revision != request.expected_plan_revision {
            return Err(StorageError::PlanRevisionConflict {
                expected: request.expected_plan_revision,
                actual: saved.revision,
            });
        }
        let inventory = self.inventory(&request.profile_id)?;
        let revisions = inventory
            .containers
            .iter()
            .map(|e| (e.container.id.clone(), e.container.revision))
            .collect::<std::collections::BTreeMap<_, _>>();
        if revisions != request.expected_container_revisions {
            return Err(StorageError::Invalid(
                "inventory changed; reload before calculating recommendations".into(),
            ));
        }
        Ok(crate::plan(&crate::PlannerInput {
            inventory,
            catalog_version: request.catalog_version,
            progression_revision: request.progression_revision,
            plan_revision: saved.revision.to_string(),
            horizon: crate::planning::HORIZON.into(),
            inventory_confirmed_current: request.inventory_confirmed_current,
            requirements_complete: request.requirements_complete,
            coverage_gaps: request.coverage_gaps,
            requirements: request.requirements,
            reserves: saved.preferences.reserves,
        })?)
    }

    pub fn create_container(
        &mut self,
        profile_id: &str,
        name: &str,
        kind: &str,
        columns: u32,
        rows: u32,
    ) -> Result<Container, StorageError> {
        text(name, "container name")?;
        text(kind, "container kind")?;
        if !(1..=256).contains(&columns) || !(1..=256).contains(&rows) {
            return Err(StorageError::Invalid(
                "container dimensions must be between 1 and 256 cells".into(),
            ));
        }
        profile(&self.connection, profile_id)?;
        let id = new_id();
        self.connection.execute("INSERT INTO containers(id,profile_id,name,kind,columns,rows) VALUES (?1,?2,?3,?4,?5,?6)", params![id, profile_id, name, kind, columns, rows])?;
        container(&self.connection, &id)
    }

    pub fn list_containers(&self, profile_id: &str) -> Result<Vec<Container>, StorageError> {
        profile(&self.connection, profile_id)?;
        let mut query = self.connection.prepare("SELECT id,profile_id,name,kind,columns,rows,revision,current_snapshot_id FROM containers WHERE profile_id=?1 ORDER BY id")?;
        Ok(query
            .query_map([profile_id], container_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// Reads a consistent profile snapshot; legacy figures are returned separately.
    pub fn inventory(&mut self, profile_id: &str) -> Result<Inventory, StorageError> {
        let tx = self.connection.transaction()?;
        let player = profile(&tx, profile_id)?;
        let containers = {
            let mut query = tx.prepare("SELECT id,profile_id,name,kind,columns,rows,revision,current_snapshot_id FROM containers WHERE profile_id=?1 ORDER BY id")?;
            let rows = query
                .query_map([profile_id], container_row)?
                .collect::<Result<Vec<_>, _>>()?;
            rows.into_iter()
                .map(|container| {
                    let snapshot = container
                        .current_snapshot_id
                        .as_deref()
                        .map(|id| snapshot(&tx, id))
                        .transpose()?;
                    Ok(ContainerInventory {
                        container,
                        snapshot,
                    })
                })
                .collect::<Result<Vec<_>, StorageError>>()?
        };
        let legacy = legacy(&tx, profile_id)?;
        tx.commit()?;
        Ok(Inventory {
            profile: player,
            containers,
            legacy,
        })
    }

    pub fn begin_scan(
        &mut self,
        container_id: &str,
        scope: ScanScope,
    ) -> Result<ScanSession, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = container(&tx, container_id)?;
        let id = new_id();
        let scope_name = if scope == ScanScope::Full {
            "full"
        } else {
            "partial"
        };
        tx.execute("INSERT INTO scan_sessions(id,container_id,base_revision,scope,status) VALUES (?1,?2,?3,?4,'draft')", params![id, container_id, sql_revision(current.revision)?, scope_name])?;
        let session = session(&tx, &id)?;
        tx.commit()?;
        Ok(session)
    }

    pub fn compose_views(
        &self,
        session_id: &str,
        request: &crate::composition::Composition,
    ) -> Result<crate::composition::CompositionPreview, StorageError> {
        let scan = session(&self.connection, session_id)?;
        let owner = container(&self.connection, &scan.container_id)?;
        check_revision(&owner, scan.base_revision)?;
        crate::composition::compose(&owner, request)
    }
    pub fn save_composition(
        &mut self,
        session_id: &str,
        request: crate::composition::Composition,
    ) -> Result<crate::composition::CompositionPreview, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let scan = session(&tx, session_id)?;
        if scan.status != ScanStatus::Draft {
            return Err(StorageError::Invalid(
                "Composition requires an editable scan".into(),
            ));
        }
        let owner = container(&tx, &scan.container_id)?;
        check_revision(&owner, scan.base_revision)?;
        let preview = crate::composition::compose(&owner, &request)?;
        let payload = serde_json::to_string(&request)?;
        if payload.len() > 8 * 1024 * 1024 {
            return Err(StorageError::Invalid("Composition exceeds 8 MiB".into()));
        }
        tx.execute("INSERT INTO scan_compositions(session_id,payload_json) VALUES (?1,?2) ON CONFLICT(session_id) DO UPDATE SET payload_json=excluded.payload_json", params![session_id, payload])?;
        tx.commit()?;
        Ok(preview)
    }
    pub fn get_composition(
        &self,
        session_id: &str,
    ) -> Result<Option<crate::composition::Composition>, StorageError> {
        session(&self.connection, session_id)?;
        let json: Option<String> = self
            .connection
            .query_row(
                "SELECT payload_json FROM scan_compositions WHERE session_id=?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(json.map(|value| serde_json::from_str(&value)).transpose()?)
    }

    pub fn get_scan(&self, session_id: &str) -> Result<ScanSession, StorageError> {
        session(&self.connection, session_id)
    }

    pub fn list_scans(&self, container_id: &str) -> Result<Vec<ScanSession>, StorageError> {
        container(&self.connection, container_id)?;
        let mut query = self.connection.prepare("SELECT id FROM scan_sessions WHERE container_id=?1 ORDER BY created_at DESC,id DESC LIMIT 64")?;
        let ids = query
            .query_map([container_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter().map(|id| session(&self.connection, id)).collect()
    }

    /// Saving a draft never changes the accepted inventory. Drafts survive restarts.
    pub fn save_scan_draft(
        &mut self,
        session_id: &str,
        mut draft: ScanDraft,
    ) -> Result<ScanSession, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = session(&tx, session_id)?;
        if current.status != ScanStatus::Draft {
            return Err(StorageError::Invalid(
                "only a draft scan can be edited".into(),
            ));
        }
        let owner = container(&tx, &current.container_id)?;
        validate_draft(&draft, &owner)?;
        // Canonical ordering makes retries independent of view sorting.
        draft.stacks.sort_by(|a, b| a.id.cmp(&b.id));
        draft.observations.sort_by(|a, b| a.id.cmp(&b.id));
        let json = serde_json::to_string(&draft)?;
        tx.execute(
            "UPDATE scan_sessions SET draft_json=?1,draft_hash=?2 WHERE id=?3",
            params![json, hash(json.as_bytes()), session_id],
        )?;
        tx.execute(
            "DELETE FROM scan_observations WHERE session_id=?1",
            [session_id],
        )?;
        for observation in &draft.observations {
            tx.execute(
                "INSERT INTO scan_observations(session_id,id,payload_json) VALUES (?1,?2,?3)",
                params![
                    session_id,
                    observation.id,
                    serde_json::to_string(observation)?
                ],
            )?;
        }
        let saved = session(&tx, session_id)?;
        tx.commit()?;
        Ok(saved)
    }

    pub fn abandon_scan(&mut self, session_id: &str) -> Result<(), StorageError> {
        let count = self.connection.execute(
            "UPDATE scan_sessions SET status='abandoned' WHERE id=?1 AND status='draft'",
            [session_id],
        )?;
        if count == 0 {
            return Err(StorageError::Invalid(
                "scan is missing or no longer a draft".into(),
            ));
        }
        Ok(())
    }

    /// Idempotency is checked before revision/state checks, and is bound to both
    /// profile/container and the exact immutable draft/request hash.
    pub fn commit_scan(&mut self, request: CommitScan) -> Result<CommitResult, StorageError> {
        self.commit_scan_checked(request, |_| Ok(()))
    }

    /// The host validates external evidence only for a genuinely new commit,
    /// after replay resolution and before facts become authoritative.
    pub fn commit_scan_checked(
        &mut self,
        request: CommitScan,
        validate_evidence: impl FnOnce(&ScanDraft) -> Result<(), StorageError>,
    ) -> Result<CommitResult, StorageError> {
        text(&request.idempotency_key, "idempotency key")?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let scan = session(&tx, &request.session_id)?;
        let current = container(&tx, &scan.container_id)?;
        let draft = scan
            .draft
            .as_ref()
            .ok_or_else(|| StorageError::Invalid("scan has no saved draft".into()))?;
        let request_hash = hash(&serde_json::to_vec(&(&request, draft))?);
        let replay: Option<(String, String)> = tx.query_row(
            "SELECT request_hash,result_json FROM scan_commits WHERE profile_id=?1 AND container_id=?2 AND idempotency_key=?3",
            params![current.profile_id, current.id, request.idempotency_key], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        if let Some((previous_hash, json)) = replay {
            if request_hash != previous_hash {
                return Err(StorageError::IdempotencyConflict);
            }
            return Ok(serde_json::from_str(&json)?);
        }
        check_revision(&current, request.expected_revision)?;
        if scan.status != ScanStatus::Draft || scan.base_revision != request.expected_revision {
            return Err(StorageError::Invalid(
                "scan is not an editable draft for the expected container revision".into(),
            ));
        }
        if scan.scope != ScanScope::Full
            || !draft.full_coverage_confirmed
            || !draft.review_confirmed
        {
            return Err(StorageError::Invalid("only a reviewed, explicitly full-coverage scan can replace a container; partial merge is not supported".into()));
        }
        validate_draft(draft, &current)?;
        validate_evidence(draft)?;
        let result = write_snapshot(&tx, &current, Some(&scan.id), draft)?;
        tx.execute(
            "UPDATE scan_sessions SET status='committed' WHERE id=?1",
            [&scan.id],
        )?;
        tx.execute("INSERT INTO scan_commits(profile_id,container_id,idempotency_key,request_hash,result_json) VALUES (?1,?2,?3,?4,?5)", params![current.profile_id, current.id, request.idempotency_key, request_hash, serde_json::to_string(&result)?])?;
        tx.commit()?;
        Ok(result)
    }

    /// Undo writes a new snapshot. An intervening commit prevents restoration;
    /// old snapshots and the evidence behind the undone commit are retained.
    pub fn undo_commit(
        &mut self,
        container_id: &str,
        committed_snapshot_id: &str,
        expected_revision: u64,
    ) -> Result<CommitResult, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = container(&tx, container_id)?;
        check_revision(&current, expected_revision)?;
        if current.current_snapshot_id.as_deref() != Some(committed_snapshot_id) {
            return Err(StorageError::Invalid(
                "the requested commit is no longer the current snapshot".into(),
            ));
        }
        let previous: Option<String> = tx.query_row(
            "SELECT previous_snapshot_id FROM snapshots WHERE id=?1 AND container_id=?2",
            params![committed_snapshot_id, container_id],
            |row| row.get(0),
        )?;
        let restored = previous
            .as_deref()
            .map(|id| snapshot(&tx, id))
            .transpose()?;
        // Undoing the very first scan restores an unscanned container, not a
        // verified empty inventory. Coverage remains false in that snapshot.
        let draft = match restored {
            Some(old) => ScanDraft {
                full_coverage_confirmed: old.full_coverage_confirmed,
                review_confirmed: true,
                captured_at: old.captured_at,
                algorithm_version: old.algorithm_version,
                catalog_version: old.catalog_version,
                stacks: old.stacks,
                observations: vec![],
            },
            None => ScanDraft {
                full_coverage_confirmed: false,
                review_confirmed: true,
                captured_at: "unknown".into(),
                algorithm_version: "undo-unscanned".into(),
                catalog_version: "unknown".into(),
                stacks: vec![],
                observations: vec![],
            },
        };
        let result = write_snapshot(&tx, &current, None, &draft)?;
        tx.commit()?;
        Ok(result)
    }

    /// A new legacy import replaces the separate unlocated checklist. Replays
    /// never add counts, overwrite physical scans or silently establish FIR.
    pub fn import_legacy_counts(
        &mut self,
        imported: LegacyChecklist,
    ) -> Result<LegacyChecklist, StorageError> {
        digest(&imported.source_hash)?;
        for (item, quantity) in &imported.counts {
            text(item, "legacy item ID")?;
            if *quantity == 0 {
                return Err(StorageError::Invalid(
                    "legacy counts must be positive; omit zero entries".into(),
                ));
            }
        }
        let json = serde_json::to_string(&imported.counts)?;
        let payload_hash = hash(json.as_bytes());
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        profile(&tx, &imported.profile_id)?;
        let prior: Option<String> = tx
            .query_row(
                "SELECT payload_hash FROM legacy_imports WHERE profile_id=?1 AND source_hash=?2",
                params![imported.profile_id, imported.source_hash],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(prior) = prior {
            if prior != payload_hash {
                return Err(StorageError::IdempotencyConflict);
            }
            return legacy(&tx, &imported.profile_id)?.ok_or_else(|| {
                StorageError::Invalid("legacy import receipt has no checklist".into())
            });
        }
        tx.execute("INSERT INTO legacy_checklists(profile_id,source_hash,counts_json) VALUES (?1,?2,?3) ON CONFLICT(profile_id) DO UPDATE SET source_hash=excluded.source_hash,counts_json=excluded.counts_json", params![imported.profile_id, imported.source_hash, json])?;
        tx.execute(
            "INSERT INTO legacy_imports(profile_id,source_hash,payload_hash) VALUES (?1,?2,?3)",
            params![imported.profile_id, imported.source_hash, payload_hash],
        )?;
        tx.commit()?;
        Ok(imported)
    }

    /// SQLite's online backup includes committed WAL data. The caller supplies
    /// a fresh destination and backs up image blobs/settings separately.
    pub fn backup_to(&self, destination: impl AsRef<Path>) -> Result<(), StorageError> {
        backup_connection(&self.connection, destination.as_ref())
    }
}

fn backup_connection(connection: &Connection, destination: &Path) -> Result<(), StorageError> {
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let mut target = Connection::open(destination)?;
    let backup = rusqlite::backup::Backup::new(connection, &mut target)?;
    backup.run_to_completion(64, Duration::from_millis(10), None)?;
    Ok(())
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn text(value: &str, field: &str) -> Result<(), StorageError> {
    if value.trim().is_empty() || value.len() > 512 || value.contains('\0') {
        return Err(StorageError::Invalid(format!(
            "{field} must contain 1-512 non-NUL bytes"
        )));
    }
    Ok(())
}

fn digest(value: &str) -> Result<(), StorageError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(StorageError::Invalid(
            "screenshot/source hash must be lowercase SHA-256 hex".into(),
        ));
    }
    Ok(())
}

fn check_revision(current: &Container, expected: u64) -> Result<(), StorageError> {
    if current.revision != expected {
        return Err(StorageError::RevisionConflict {
            expected,
            actual: current.revision,
        });
    }
    if expected >= i64::MAX as u64 {
        return Err(StorageError::Invalid(
            "container revision limit reached".into(),
        ));
    }
    Ok(())
}

fn validate_box(location: CellBox, owner: &Container) -> Result<(), StorageError> {
    if location.width == 0
        || location.height == 0
        || u64::from(location.column) + u64::from(location.width) > u64::from(owner.columns)
        || u64::from(location.row) + u64::from(location.height) > u64::from(owner.rows)
    {
        return Err(StorageError::Invalid(
            "stack/observation is outside the container grid".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_draft(draft: &ScanDraft, owner: &Container) -> Result<(), StorageError> {
    text(&draft.captured_at, "capture time")?;
    text(&draft.algorithm_version, "algorithm version")?;
    text(&draft.catalog_version, "catalog version")?;
    if draft.stacks.len() > 65_536 || draft.observations.len() > 65_536 {
        return Err(StorageError::Invalid(
            "scan contains too many records".into(),
        ));
    }
    let mut observations = BTreeSet::new();
    for observation in &draft.observations {
        text(&observation.id, "observation ID")?;
        digest(&observation.screenshot_hash)?;
        validate_box(observation.location, owner)?;
        if let Some(grid) = &observation.source_grid
            && (!grid.pitch.is_finite()
                || !(1.0..=8192.0).contains(&grid.pitch)
                || !grid.ox.is_finite()
                || !grid.oy.is_finite()
                || grid.ox.abs() > 65_536.0
                || grid.oy.abs() > 65_536.0
                || !(1..=256).contains(&grid.cols)
                || !(1..=256).contains(&grid.rows))
        {
            return Err(StorageError::Invalid(
                "invalid screenshot grid registration".into(),
            ));
        }
        if observation.quantity == Some(0) || !observations.insert(&observation.id) {
            return Err(StorageError::Invalid(
                "observation IDs must be unique and quantities positive or unknown".into(),
            ));
        }
        if let Some(evidence) = &observation.quantity_evidence {
            text(&evidence.item_id, "quantity evidence item ID")?;
            let crop = evidence.crop;
            if evidence.method != "bottom-strip-v1"
                || evidence.text.len() > 1024
                || evidence.max_quantity <= 1
                || crop.w == 0
                || crop.h == 0
                || u64::from(crop.x) + u64::from(crop.w) > 65_536
                || u64::from(crop.y) + u64::from(crop.h) > 65_536
                || u64::from(crop.w) * u64::from(crop.h) > 40_000_000
                || evidence
                    .confidence
                    .is_some_and(|score| !score.is_finite() || !(0.0..=100.0).contains(&score))
                || observation
                    .quantity
                    .is_some_and(|amount| amount > evidence.max_quantity)
                || matches!(evidence.status, QuantityStatus::Candidate)
                    != observation.quantity.is_some()
                || matches!(evidence.status, QuantityStatus::Candidate)
                    && (evidence.text.trim().is_empty()
                        || !evidence.confidence.is_some_and(|score| score >= 85.0))
                || observation.source_grid.is_none()
            {
                return Err(StorageError::Invalid(
                    "invalid stack quantity evidence".into(),
                ));
            }
        }
        for candidate in &observation.candidates {
            text(&candidate.item_id, "candidate item ID")?;
            if !candidate.error.is_finite() {
                return Err(StorageError::Invalid(
                    "candidate error must be finite".into(),
                ));
            }
        }
    }
    let mut ids = BTreeSet::new();
    let mut occupied = BTreeSet::new();
    for stack in &draft.stacks {
        text(&stack.id, "stack ID")?;
        if let Some(item) = &stack.item_id {
            text(item, "item ID")?;
        }
        if !ids.insert(&stack.id) || stack.quantity == Some(0) {
            return Err(StorageError::Invalid(
                "stack IDs must be unique and quantities positive or unknown".into(),
            ));
        }
        if stack.provenance.identity_confirmed && stack.item_id.is_none()
            || stack.provenance.quantity_confirmed && stack.quantity.is_none()
        {
            return Err(StorageError::Invalid(
                "unknown identity/quantity cannot be confirmed".into(),
            ));
        }
        text(&stack.provenance.method, "recognition method")?;
        if let Some(hash) = &stack.provenance.screenshot_hash {
            digest(hash)?;
        }
        if let Some(id) = &stack.provenance.observation_id
            && !observations.contains(id)
        {
            return Err(StorageError::Invalid(
                "stack references a missing observation".into(),
            ));
        }
        validate_box(stack.location, owner)?;
        for row in stack.location.row..stack.location.row + stack.location.height {
            for column in stack.location.column..stack.location.column + stack.location.width {
                if !occupied.insert((column, row)) {
                    return Err(StorageError::Invalid(
                        "committed stacks cannot overlap occupied cells".into(),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn profile_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Profile> {
    let mode = match row.get::<_, String>(1)?.as_str() {
        "pve" => GameMode::Pve,
        "regular" => GameMode::Regular,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(Profile {
        id: row.get(0)?,
        mode,
        name: row.get(2)?,
    })
}

fn profile(connection: &Connection, id: &str) -> Result<Profile, StorageError> {
    connection
        .query_row(
            "SELECT id,mode,name FROM profiles WHERE id=?1",
            [id],
            profile_row,
        )
        .optional()?
        .ok_or(StorageError::NotFound("profile"))
}

fn container_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Container> {
    Ok(Container {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        name: row.get(2)?,
        kind: row.get(3)?,
        columns: row.get(4)?,
        rows: row.get(5)?,
        revision: read_revision(row, 6)?,
        current_snapshot_id: row.get(7)?,
    })
}

fn container(connection: &Connection, id: &str) -> Result<Container, StorageError> {
    connection.query_row("SELECT id,profile_id,name,kind,columns,rows,revision,current_snapshot_id FROM containers WHERE id=?1", [id], container_row).optional()?.ok_or(StorageError::NotFound("container"))
}

fn session(connection: &Connection, id: &str) -> Result<ScanSession, StorageError> {
    let row: Option<(String, u64, String, String, Option<String>)> = connection.query_row("SELECT container_id,base_revision,scope,status,draft_json FROM scan_sessions WHERE id=?1", [id], |row| Ok((row.get(0)?, read_revision(row, 1)?, row.get(2)?, row.get(3)?, row.get(4)?))).optional()?;
    let (container_id, base_revision, scope, status, draft) =
        row.ok_or(StorageError::NotFound("scan session"))?;
    let scope = match scope.as_str() {
        "full" => ScanScope::Full,
        "partial" => ScanScope::Partial,
        _ => return Err(StorageError::Invalid("invalid stored scan scope".into())),
    };
    let status = match status.as_str() {
        "draft" => ScanStatus::Draft,
        "committed" => ScanStatus::Committed,
        "abandoned" => ScanStatus::Abandoned,
        _ => return Err(StorageError::Invalid("invalid stored scan status".into())),
    };
    Ok(ScanSession {
        id: id.to_owned(),
        container_id,
        base_revision,
        scope,
        status,
        draft: draft.map(|json| serde_json::from_str(&json)).transpose()?,
    })
}

fn snapshot(connection: &Connection, id: &str) -> Result<InventorySnapshot, StorageError> {
    let mut result = connection.query_row("SELECT revision,captured_at,algorithm_version,catalog_version,full_coverage_confirmed FROM snapshots WHERE id=?1", [id], |row| Ok(InventorySnapshot { id: id.to_owned(), revision: read_revision(row, 0)?, captured_at: row.get(1)?, algorithm_version: row.get(2)?, catalog_version: row.get(3)?, full_coverage_confirmed: row.get(4)?, stacks: vec![] })).optional()?.ok_or(StorageError::NotFound("snapshot"))?;
    let mut query = connection
        .prepare("SELECT payload_json FROM snapshot_stacks WHERE snapshot_id=?1 ORDER BY id")?;
    let rows = query.query_map([id], |row| row.get::<_, String>(0))?;
    for row in rows {
        result.stacks.push(serde_json::from_str(&row?)?);
    }
    Ok(result)
}

fn write_snapshot(
    connection: &Connection,
    current: &Container,
    session_id: Option<&str>,
    draft: &ScanDraft,
) -> Result<CommitResult, StorageError> {
    let revision = current
        .revision
        .checked_add(1)
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or_else(|| StorageError::Invalid("revision overflow".into()))?;
    let snapshot_id = new_id();
    connection.execute("INSERT INTO snapshots(id,container_id,revision,previous_snapshot_id,session_id,captured_at,algorithm_version,catalog_version,full_coverage_confirmed) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![snapshot_id, current.id, sql_revision(revision)?, current.current_snapshot_id, session_id, draft.captured_at, draft.algorithm_version, draft.catalog_version, draft.full_coverage_confirmed])?;
    for stack in &draft.stacks {
        let fir = match stack.fir {
            Fir::Yes => "yes",
            Fir::No => "no",
            Fir::Unknown => "unknown",
        };
        connection.execute("INSERT INTO snapshot_stacks(snapshot_id,id,item_id,quantity,fir,column_no,row_no,width,height,payload_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![snapshot_id, stack.id, stack.item_id, stack.quantity, fir, stack.location.column, stack.location.row, stack.location.width, stack.location.height, serde_json::to_string(stack)?])?;
    }
    let changed = connection.execute(
        "UPDATE containers SET current_snapshot_id=?1,revision=?2 WHERE id=?3 AND revision=?4",
        params![
            snapshot_id,
            sql_revision(revision)?,
            current.id,
            sql_revision(current.revision)?
        ],
    )?;
    if changed != 1 {
        return Err(StorageError::RevisionConflict {
            expected: current.revision,
            actual: container(connection, &current.id)?.revision,
        });
    }
    Ok(CommitResult {
        container_id: current.id.clone(),
        snapshot_id,
        revision,
        session_id: session_id.map(str::to_owned),
        previous_snapshot_id: current.current_snapshot_id.clone(),
    })
}

fn legacy(
    connection: &Connection,
    profile_id: &str,
) -> Result<Option<LegacyChecklist>, StorageError> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT source_hash,counts_json FROM legacy_checklists WHERE profile_id=?1",
            [profile_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    row.map(|(source_hash, json)| {
        Ok(LegacyChecklist {
            profile_id: profile_id.to_owned(),
            source_hash,
            counts: serde_json::from_str(&json)?,
        })
    })
    .transpose()
}

fn sql_revision(value: u64) -> Result<i64, StorageError> {
    i64::try_from(value)
        .map_err(|_| StorageError::Invalid("revision exceeds SQLite integer range".into()))
}

fn read_revision(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}
