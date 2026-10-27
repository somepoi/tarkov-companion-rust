# Full-container screenshot registration implementation plan

**Goal:** Select and inspect one complete container grid inside an imported screenshot before replacing draft recognition rows.

**Architecture:** Reuse the incumbent TypeScript matcher and OCR. Stage an archived image independently of the durable draft, draw a crop on the screenshot, and optionally register an exact square-cell grid. Pass a full-image grid to the worker, translate it into crop coordinates there, and preserve the returned full-image registration in observations. Accepted SQLite snapshots change only through the existing reviewed commit action.

**Tech stack:** React/TypeScript, SVG image overlays, existing scan worker/OffscreenCanvas, existing native screenshot archive. No new dependencies, no tests or real screenshot checks per the user's instructions.

## Design decisions

- Automatic grid discovery remains the default; the user can restrict it to a drawn/numeric crop. An explicit grid overrides discovery when the inferred origin/pitch is wrong. Replacing the matcher or requiring an externally cropped file would not meet this workflow.
- Manual registration specifies first grid-line X/Y and square cell pitch; row/column counts come from the selected container. The overlay shows the resulting grid in source pixels. Scrolled or clipped containers do not become full coverage merely by selecting a rectangle.
- Staging/importing a new image does not change draft rows. Recognition that would replace existing rows requires an inline acknowledgement. Every new recognition clears full-container/review confirmation, keeps quantity/FIR unknown and retains original screenshot evidence.
- The worker rejects nonfinite, oversized/out-of-image crops and invalid/clipped explicit grids before allocating a canvas. The automatic path retains its algorithm. Explicit registration bypasses grid detection/refinement only, not matching.
- One job runs at a time. Mode changes/unmount invalidate late results; preview object URLs and transferred image bitmaps are released. Closing/replacing a staging image keeps the existing draft.

## Task 1: Validate and transport explicit registration

Modify `src/scan/scanner.ts` and `src/scan/scan.worker.ts`; add host-neutral geometry helpers under `src/scan/registration.ts`. Add an optional final grid argument to preserve current callers. Validate crop dimensions and grid bounds in the worker; close transferred bitmaps even on failure. Use the exact supplied grid after translating its origin by the crop offset. Return source coordinates as before.

## Task 2: Add inline screenshot selection

Create `src/inventory/ScreenshotRegistration.tsx`. Show a bounded source-image preview, pointer crop selection, keyboard-editable crop coordinates, auto/manual controls, manual origin/pitch and a grid overlay. Expose clear loading, invalid selection, replacement acknowledgement and recognition-in-progress states using incumbent tokens and buttons. Stage only one screenshot at a time.

## Task 3: Integrate draft import

Modify `src/pages/StashManagerPage.tsx` to archive/stage first and recognize only on request. Feed selected crop to both OCR and matcher. Clear coverage/review facts for every new result; prevent reentrant jobs. Retain unknown quantity/FIR and preserve the existing accepted snapshot until explicit commit. Clear staged image references when ending/switching sessions.

## Task 4: Verify and record

Use `npx tsc -b`, `npm run lint`, both frontend builds, strict Clippy/format checks if native inputs change, and an embedded native development build. Run the bounded design source detector and a read-only code review. Do not create/run tests, synthesize a recognition corpus or assert runtime/accuracy acceptance. Update the execution ledger and commit with the configured Git identity. Rollback reverts the UI/optional worker argument; saved observation registration already uses schema 3.
