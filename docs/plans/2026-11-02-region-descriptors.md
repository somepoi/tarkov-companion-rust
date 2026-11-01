# Experimental unchanged-region descriptor reuse

The roadmap calls for cached descriptors/changed-region work with an A/B fallback, without reducing recognition or review correctness. This step caches intermediate area-averaged RGB samples, not detections, identities, quantities, OCR results, overlap decisions or confirmed facts. It is a bounded Phase D/8 foundation, not measured optimization acceptance or complete incremental recognition.

## Behavior

An explicit experimental checkbox appears only while assisted recognition is enabled. It starts off, is not persisted and resets whenever assistance is disabled or its session/manual calibration is replaced. Manual scans, legacy scans and normal assisted scans retain the default sampling path. The first opted-in assisted scan warms one frame; later opted-in scans may reuse descriptors.

Each new screenshot still goes through independent grid discovery and the existing expected-grid guard. Reuse additionally requires the same session scope, cropped-image dimensions and exact discovered grid geometry. A 32-pixel tile map compares RGBA values between the previous and current image. Any changed byte marks that whole tile dirty, including text/count/FIR strips and borders. Exact sampling parameters identify a cached Float32 descriptor. Reuse is allowed only when every tile touched by its source-pixel interval is unchanged. Bounds mirror the sampler's last-interval arithmetic, with conservative guard pixels. Changed geometry/regions, missing entries and resource limits fall back to the existing sampler.

The worker retains at most 4096 descriptors/8 MiB of Float32 payload for its current frame; keys/map overhead are additional. Previous and current frames can coexist during a scan. Their image reference shares the worker's existing last-scan RGBA storage, rather than creating a second persistent copy. No frame chain is retained. Worker error drops descriptor state; non-opted-in scans replace it, and existing cancellation/60-second idle release terminates the worker where applicable. The small dirty-tile array is temporary.

Grid/empty-cell discovery, all candidate scores and global overlap selection, current learned references, name/quantity OCR paths and independent review still run. Existing exact-prepared-text OCR caching is separate. Every new draft observation uses its current screenshot evidence and new unconfirmed facts. No SQLite/schema or accepted inventory changes are introduced. Optional returned reuse/computation counters support later measurement; the product does not display them as a speed guarantee.

## Verification and remaining evidence

Independent source-only review found no P1/P2 issue in sampling bounds, pixel equality, mutable descriptor consumers, scope/budgets or opt-in/reset/cancellation. The source argument is deterministic sampling of the same pixel values with identical numeric arguments; no approximate/perceptual equality is accepted. Runtime output equivalence and before/after cost are unverified, so the optimization remains explicitly experimental and off by default. The unmodified sampling path is the immediate fallback.

Clean lint, TypeScript/native frontend, Electron frontend/main/preload, embedded native development build (26.45s) and whitespace passed. An initial React effect warning was corrected by resetting the opt-in in the existing assistance-disable actions instead of adding a render-triggering effect.

No tests, generated image fixtures, screenshots, application launches or recognition/benchmark operations were run. Broader OCR changed-region reuse, end-to-end performance, runtime alignment/accuracy and Windows/recovery/parity gates remain open. The release installer is not refreshed by this source/UI task.
