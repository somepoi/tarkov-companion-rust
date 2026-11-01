# Cancel Stash Manager recognition

Goal: close the audit's missing cancellation path for long image preparation, while preserving accepted inventory and existing draft rows.

Each recognition attempt owns an AbortController. Manual cancellation or page/profile unmount aborts name OCR, matching and quantity OCR; generation and signal checks gate all editor replacement. Cancellation disables session assistance/calibration and retains the imported image for a later manual retry. Cancel is offered only while preparing recognition, never during database commit, import archival, backup or other storage writes.

Shared OCR remains serial and bounded to one running/one waiting read. Cancelled queued reads keep their admission slot until the preceding job finishes, then fail before decoding. Cancellation interrupts an active Tesseract read, clears only its own engine promise and observes late rejection without clearing a newer engine. Waiting for shared initialization is cancellable without destroying initialization used by other callers.

The matching wrapper accepts an optional AbortSignal. It checks before decode/registration, releases a decoded bitmap on cancellation before transfer, removes its listener on every result/error/abort and discards cancelled result IDs. When it is the sole admitted scan and no identify request is waiting, terminate/reset the worker to stop synchronous matching. With other admitted requests, reject this caller but retain shared computation for the others. Shared asset/model initialization and browser image decoding may finish in the background; this is not a claim of universal instantaneous CPU release. Synchronous image preprocessing cannot receive a click until it yields to the browser event loop.

No recognition algorithm, confidence threshold, database schema or automatic confirmation changed. Full draft replacement still happens only at the existing final gated point. No changed-region reuse or speed/accuracy improvement is claimed.

Verification on 2026-11-01: oxlint, TypeScript, Tauri frontend production build, Electron frontend/main/preload production build, embedded native custom-protocol development build (23.10s) and whitespace checks exited 0. Source review traced abort during shared initialization, queued/active OCR, matching, quantity read, final editor replacement, assisted-input callbacks and unmount. No tests, fixtures or screenshot workflows were created or run; runtime cancellation, concurrent calls and restart behavior remain unverified. No installer artifacts were refreshed.
