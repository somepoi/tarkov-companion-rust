//! One bounded actor owns the user database. No renderer or async runtime thread runs SQL.
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use stash_core::{CommitScan, GameMode, LegacyChecklist, Repository, ScanDraft, ScanScope};
use std::{path::PathBuf, sync::mpsc};

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    ListProfiles,
    CreateProfile {
        mode: GameMode,
        name: String,
    },
    ListContainers {
        profile_id: String,
    },
    CreateContainer {
        profile_id: String,
        name: String,
        kind: String,
        columns: u32,
        rows: u32,
    },
    Inventory {
        profile_id: String,
    },
    BeginScan {
        container_id: String,
        scope: ScanScope,
    },
    GetScan {
        session_id: String,
    },
    ListScans {
        container_id: String,
    },
    SaveDraft {
        session_id: String,
        draft: ScanDraft,
    },
    AbandonScan {
        session_id: String,
    },
    CommitScan {
        request: CommitScan,
    },
    UndoCommit {
        container_id: String,
        snapshot_id: String,
        expected_revision: u64,
    },
    ImportLegacy {
        checklist: LegacyChecklist,
    },
}

struct Job {
    operation: Operation,
    response: mpsc::Sender<Result<Value, String>>,
}
pub struct InventoryService {
    sender: mpsc::SyncSender<Job>,
}

impl InventoryService {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let (sender, requests) = mpsc::sync_channel::<Job>(16);
        let (ready_tx, ready_rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("inventory-db".into())
            .spawn(move || {
                let evidence_dir = path
                    .parent()
                    .unwrap_or(std::path::Path::new("."))
                    .join("screenshots");
                let mut repository = match Repository::open(path) {
                    Ok(repository) => {
                        let _ = ready_tx.send(Ok(()));
                        repository
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error.to_string()));
                        return;
                    }
                };
                while let Ok(job) = requests.recv() {
                    let _ =
                        job.response
                            .send(execute(&mut repository, job.operation, &evidence_dir));
                }
            })
            .map_err(|error| error.to_string())?;
        ready_rx.recv().map_err(|error| error.to_string())??;
        Ok(Self { sender })
    }

    pub fn call(&self, operation: Operation) -> Result<Value, String> {
        let (response, received) = mpsc::channel();
        self.sender
            .try_send(Job {
                operation,
                response,
            })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => {
                    "Inventory is busy; retry after the current operation finishes".to_owned()
                }
                mpsc::TrySendError::Disconnected(_) => "Inventory worker stopped".to_owned(),
            })?;
        received
            .recv()
            .map_err(|_| "Inventory worker did not return a result".to_owned())?
    }
}

fn execute(
    repository: &mut Repository,
    operation: Operation,
    evidence_dir: &std::path::Path,
) -> Result<Value, String> {
    fn value<T: serde::Serialize>(
        result: Result<T, stash_core::StorageError>,
    ) -> Result<Value, String> {
        serde_json::to_value(result.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    }
    match operation {
        Operation::ListProfiles => value(repository.list_profiles()),
        Operation::CreateProfile { mode, name } => value(repository.create_profile(mode, &name)),
        Operation::ListContainers { profile_id } => value(repository.list_containers(&profile_id)),
        Operation::CreateContainer {
            profile_id,
            name,
            kind,
            columns,
            rows,
        } => value(repository.create_container(&profile_id, &name, &kind, columns, rows)),
        Operation::Inventory { profile_id } => value(repository.inventory(&profile_id)),
        Operation::BeginScan {
            container_id,
            scope,
        } => value(repository.begin_scan(&container_id, scope)),
        Operation::GetScan { session_id } => value(repository.get_scan(&session_id)),
        Operation::ListScans { container_id } => value(repository.list_scans(&container_id)),
        Operation::SaveDraft { session_id, draft } => {
            value(repository.save_scan_draft(&session_id, draft))
        }
        Operation::AbandonScan { session_id } => value(repository.abandon_scan(&session_id)),
        Operation::CommitScan { request } => {
            value(repository.commit_scan_checked(request, |draft| {
                validate_evidence(draft, evidence_dir).map_err(stash_core::StorageError::Invalid)
            }))
        }
        Operation::UndoCommit {
            container_id,
            snapshot_id,
            expected_revision,
        } => value(repository.undo_commit(&container_id, &snapshot_id, expected_revision)),
        Operation::ImportLegacy { checklist } => value(repository.import_legacy_counts(checklist)),
    }
}

#[tauri::command]
pub async fn inventory_call(
    state: tauri::State<'_, std::sync::Arc<crate::desktop::HostState>>,
    operation: Value,
) -> Result<Value, String> {
    let operation = serde_json::from_value(operation)
        .map_err(|error| format!("Invalid inventory request: {error}"))?;
    let state = std::sync::Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.inventory.call(operation))
        .await
        .map_err(|error| error.to_string())?
}

fn validate_evidence(draft: &ScanDraft, evidence_dir: &std::path::Path) -> Result<(), String> {
    let hashes = draft
        .stacks
        .iter()
        .filter_map(|s| s.provenance.screenshot_hash.as_ref())
        .chain(draft.observations.iter().map(|o| &o.screenshot_hash))
        .collect::<std::collections::BTreeSet<_>>();
    for hash in hashes {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid screenshot hash".into());
        }
        let file = evidence_dir.join(hash);
        if std::fs::metadata(&file)
            .map_err(|e| format!("Screenshot evidence is missing: {e}"))?
            .len()
            > 64 * 1024 * 1024
        {
            return Err("Archived screenshot exceeds the memory budget".into());
        }
        let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
        if format!("{:x}", Sha256::digest(bytes)) != *hash {
            return Err("Screenshot evidence is corrupt; review before committing".into());
        }
    }
    Ok(())
}
