# Stack quantity OCR implementation plan

**Goal:** Suggest visible stack quantities in full-container scans while preserving independent user confirmation and durable screenshot evidence.

**Architecture:** Keep the incumbent item matcher and offline English Tesseract engine. Extract a separate bottom strip from each fully visible, catalog-stackable detection. Arrange bounded strips in one temporary atlas, run a separate OCR pass without a digit whitelist, and interpret each strip independently. Persist raw text/heuristic confidence/crop/catalog maximum beside the observation; proposed stack amounts remain unconfirmed. Provide a per-stack retry from archived evidence.

**Tech stack:** Existing TypeScript/OffscreenCanvas/Tesseract, React review UI, Rust/SQLite schema 4. No new dependencies. User instructions prohibit creating/running tests or verifying real game screenshots.

## Decisions and boundaries

- Only a known safe-integer `stackMaxSize > 1` and a complete footprint matching the catalog dimensions qualify. Unknown/nonstackable items get no inferred quantity, including no invented one when the overlay is absent.
- The separate crop spans the complete footprint's bottom strip, retaining punctuation and other symbols. Do not restrict OCR to digits: suppressing `/` could turn durability or charges into a false count.
- The parser accepts a positive integer or strictly grouped thousands, rejects fractions/decimals/units/ambiguous tokens and out-of-range values, and requires every word score to be at least 85/100. The score is not a calibrated probability. Any result is merely a suggestion until the user confirms it. The crop uses the bottom 34% of one cell's height across the complete item width, with outer borders excluded; this is an unverified layout heuristic, not an accuracy guarantee.
- Bound automatic processing to 64 regions, a 2-million-pixel atlas, maximum width 4096 and maximum height 8192. Strips are enlarged 4× below a 100-pixel cell pitch and 2× otherwise, before one separate OCR pass at scale 1. Skipped/read-failed regions stay unknown and are counted in the visible report. Retry operates on one chosen stack through the same crop/parser, not a second algorithm.
- OCR calls share a bounded serial queue so quantity work cannot interleave engine state with name/quest OCR. Existing quest-list multi-image input admits one image and both of its threshold passes at a time, with a 64-image / 256-MiB pending bound and explicit rejection/retry messages; closing/changing mode cancels obsolete reads. Existing name preprocessing defaults remain unchanged. Explicit atlas scale avoids an unnecessary second enlargement. ImageBitmap/canvas bounds and finally cleanup apply on all paths.
- Source quantity evidence is immutable recognition output. Identity/footprint edits invalidate quantity confirmation. Original evidence remains labeled as original if the selected identity changes. New recognition never changes accepted stock without the existing reviewed commit.

## Tasks

1. Add `src/scan/quantity.ts`: eligibility, source strip geometry, bounded atlas, word assignment, strict integer parser and per-region result/reason. Preserve rejected text where available; cancellation checks prevent starting further work after the caller becomes obsolete.
2. Extend `src/scan/ocr.ts` with a bounded serial job queue, checked crop/finally bitmap cleanup and an explicit scale option used only by the quantity atlas. Keep the incumbent offline model/assets and language behavior.
3. Add optional `quantityEvidence` (including the source item ID) to Rust/TypeScript observations and schema 4. Bound strings, confidence/crop/maximum and candidate ranges. Existing drafts remain readable; the existing SQLite API backup precedes migration, and older binaries reject schema 4.
4. Integrate one automatic quantity pass after valid image matching in `StashManagerPage.tsx`. Persist proposals/evidence, keep all confirmations false and show counts/errors/limits. Add archived-evidence retry and raw output in `StackIdentityReview.tsx`; reject stale retry results after edits and block impossible catalog amounts from confirmation.
5. Use type checking, lint, both frontend builds, Rust formatting/strict Clippy, embedded native build, design detector and read-only source review. Do not create/run tests or claim recognition accuracy. Update the execution ledger and commit with the existing Git identity. Rollback restores a full pre-schema-4 backup and the prior application; never open a newer DB with an older binary.
