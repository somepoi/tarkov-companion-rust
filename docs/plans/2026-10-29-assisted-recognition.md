# Session-scoped assisted recognition

Implement Phase C without changing accepted inventory or automatically confirming facts.

1. Retain the last successful, manually initiated crop/grid in this page session only. Bind it to scan session, visible dimensions and screenshot dimensions.
2. Offer an explicit checkbox explaining that subsequent imported, pasted, dropped or captured images replace current editor suggestions. Saved source views remain separate.
3. Independently discover the grid on each new image in the retained crop. Require matching dimensions and all four grid boundaries within 1.5 pixels before recognition can replace draft rows. This geometry check is not proof of container identity; users must keep the same container open.
4. Leave the newly archived screenshot available for manual selection on geometry failure. Retain existing draft rows and disable assistance until a new manual scan and opt-in.
5. Keep one active operation, reject busy inputs visibly, skip the last successfully prepared identical image, reset assistance on session/view changes and leave identity/quantity/FIR/coverage unconfirmed.
6. Verify compilation, lint, both UI builds, embedded native build and read-only source review. Do not create or run tests or use real screenshots, per user instructions. Runtime alignment and recognition accuracy remain unverified.

Rollback: turn off the session checkbox; manual registration remains available. No schema or persistent preference change is required.

Implementation checkpoint: all four image input routes share serialized admission and the explicit staged-image recognition path. Manual scans replace the retained calibration; assisted scans retain that original calibration and only update the last prepared hash. Session/resume/visible-grid/source-view editing or composition changes reset assistance. Independent grid discovery runs in the existing worker, before matching and before editor replacement. Geometry agreement is only a guard: opening a different container in an identical position cannot be distinguished by this feature.

TypeScript, lint, both frontend builds, embedded native development build and whitespace checks passed. The UI source detector returned no findings; separate read-only review found no concrete P1/P2 issue. No tests, screenshots, runtime capture/paste/drop flows or recognition measurements were used. The 1.5-pixel tolerance is a conservative implementation threshold, not an empirically validated acceptance budget. Phase D changed-region reuse remains deferred until pixel/recognition reuse can be validated.
