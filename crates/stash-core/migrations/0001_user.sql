CREATE TABLE profiles (
    id TEXT PRIMARY KEY NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('pve','regular')),
    name TEXT NOT NULL
);
CREATE TABLE containers (
    id TEXT PRIMARY KEY NOT NULL,
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    columns INTEGER NOT NULL CHECK(columns BETWEEN 1 AND 256),
    rows INTEGER NOT NULL CHECK(rows BETWEEN 1 AND 256),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    current_snapshot_id TEXT REFERENCES snapshots(id)
);
CREATE TABLE scan_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    container_id TEXT NOT NULL REFERENCES containers(id),
    base_revision INTEGER NOT NULL CHECK(base_revision >= 0),
    scope TEXT NOT NULL CHECK(scope IN ('full','partial')),
    status TEXT NOT NULL CHECK(status IN ('draft','committed','abandoned')),
    draft_json TEXT,
    draft_hash TEXT,
    created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE scan_observations (
    session_id TEXT NOT NULL REFERENCES scan_sessions(id),
    id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY(session_id,id)
);
CREATE TABLE snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    container_id TEXT NOT NULL REFERENCES containers(id),
    revision INTEGER NOT NULL CHECK(revision > 0),
    previous_snapshot_id TEXT REFERENCES snapshots(id),
    session_id TEXT REFERENCES scan_sessions(id),
    captured_at TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    catalog_version TEXT NOT NULL,
    full_coverage_confirmed INTEGER NOT NULL CHECK(full_coverage_confirmed IN (0,1)),
    created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(container_id,revision)
);
CREATE TABLE snapshot_stacks (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
    id TEXT NOT NULL,
    item_id TEXT,
    quantity INTEGER CHECK(quantity > 0),
    fir TEXT NOT NULL CHECK(fir IN ('yes','no','unknown')),
    column_no INTEGER NOT NULL CHECK(column_no >= 0),
    row_no INTEGER NOT NULL CHECK(row_no >= 0),
    width INTEGER NOT NULL CHECK(width > 0),
    height INTEGER NOT NULL CHECK(height > 0),
    payload_json TEXT NOT NULL,
    PRIMARY KEY(snapshot_id,id)
);
CREATE TABLE scan_commits (
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    container_id TEXT NOT NULL REFERENCES containers(id),
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY(profile_id,container_id,idempotency_key)
);
CREATE TABLE legacy_checklists (
    profile_id TEXT PRIMARY KEY NOT NULL REFERENCES profiles(id),
    source_hash TEXT NOT NULL,
    counts_json TEXT NOT NULL
);
CREATE TABLE legacy_imports (
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    source_hash TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    PRIMARY KEY(profile_id,source_hash)
);
CREATE INDEX containers_by_profile ON containers(profile_id);
CREATE INDEX sessions_by_container ON scan_sessions(container_id,status);
CREATE INDEX snapshots_by_container ON snapshots(container_id,revision);
PRAGMA user_version = 1;
