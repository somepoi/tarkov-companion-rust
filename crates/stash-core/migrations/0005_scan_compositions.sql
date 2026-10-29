CREATE TABLE scan_compositions (
    session_id TEXT PRIMARY KEY REFERENCES scan_sessions(id),
    payload_json TEXT NOT NULL
);
PRAGMA user_version=5;
