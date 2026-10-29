# Inventory fact export

Expose JSON and CSV downloads for the explicitly selected local profile. Read one fresh SQLite inventory transaction at click time rather than exporting the renderer's cached rows. Include mode/profile/container/snapshot/revision, coverage, physical coordinates, independent quantity/identity/FIR facts, protection and screenshot/observation references. Preserve legacy checklist counts as separately labeled unlocated records, never physical totals.

JSON is a versioned reporting document, not a recovery format; native full backup remains the restore path with screenshots/progress/drafts/preferences. CSV uses explicit record types for container/physical-stack/legacy-count, RFC-style quoting/CRLF, UTF-8 BOM and spreadsheet formula neutralization for text. Unknown quantities remain empty with independent confirmation fields. No recommendations/prices are exported because they have separate freshness/progression requirements.

Bound generated files to 20 MiB, clean up download URLs, serialize with the current stash action lock and discard a late result after mode/profile component cleanup. Reuse the existing local download flow from Settings. No external sharing, filesystem deletion, game access or automatic sales. Verify through source review/typecheck/lint/builds; no tests or fixtures.

Implemented export builders and a collapsible stash control. A short-lived worker builds JSON/CSV after the fresh inventory read, checks output size, and terminates on completion/errors/cleanup. Both before and after worker processing, the component verifies current game mode and lifetime; a late result does not download after leaving the profile. Click failures revoke the URL immediately; successful requests retain it for at most 60 seconds or component cleanup. The UI reports a download request rather than claiming the file was actually saved.

CSV container rows preserve empty/unscanned container metadata; physical rows retain unknown quantities as blank and separate confirmation flags. Legacy counts use an explicit unlocated record type. Reporting files exclude recommendations and prices to avoid exporting stale SELL instructions. Full backups remain the recovery path. Read-only source review found no P1/P2 issue after inspecting mode guards, formula neutralization, column alignment and worker/URL lifecycle. No tests, fixtures, actual download or recovery exercise were performed.

Verification completed: TypeScript, clean lint, both frontend builds, embedded native build and whitespace checks passed. Source UI detector reported no findings. Runtime file delivery remains unverified.

Schema-6 follow-up: CSV now includes `dogtag_level` and `dogtag_level_confirmed`, yielding 28 columns; container and legacy rows remain aligned. JSON retains the optional physical dogtag fact with the saved stack. Missing levels are blank/absent, never inferred from identity.

Schema-7 follow-up: `durability_percent` and `durability_confirmed` extend CSV to 30 columns. Unknown state remains blank/absent with false confirmation; a known zero percent is preserved as zero. JSON/full backups retain the optional manual fact independently of identity, quantity and FIR review.
