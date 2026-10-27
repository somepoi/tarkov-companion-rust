-- Observation JSON may now include sourceGrid for reviewing archived pixels.
-- Older drafts remain valid without it; older binaries must not open this DB.
PRAGMA user_version = 3;
