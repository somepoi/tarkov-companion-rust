ALTER TABLE snapshots ADD COLUMN stale_reason TEXT;
CREATE TABLE inventory_invalidations (
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY(profile_id, idempotency_key)
);
PRAGMA user_version = 9;
