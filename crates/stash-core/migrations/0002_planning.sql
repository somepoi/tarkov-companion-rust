CREATE TABLE planning_preferences (
    profile_id TEXT PRIMARY KEY NOT NULL REFERENCES profiles(id),
    revision INTEGER NOT NULL CHECK(revision > 0),
    preferences_json TEXT NOT NULL
);
PRAGMA user_version = 2;
