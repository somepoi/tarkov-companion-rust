# Reproducible scanner and OCR assets

**Goal:** Prepare the missing local recognition assets and prevent distributing a package whose scanner silently lacks data/model files.

**Architecture:** Retain the RGB12 matcher, its version-1 header and existing English Tesseract model. Build reference images from the verified PvE/regular JSON endpoints, keeping mode-specific variants under stable item IDs. Cache source documents/images with checksums, bound download/decode concurrency and publish complete generated directories through a staging/retained-backup workflow. Generate integrity manifests consumed by build checks and the scanner loader.

**Tech stack:** Existing Node/TypeScript/sharp/Tesseract, native/frontend packaging scripts. No new dependencies, tests or game screenshot checks.

## Findings and decisions

- The current worktree has neither `public/scan` nor `public/ocr`; frontend and native compilation success does not establish scanner usability.
- The old fingerprint script fetches only regular-mode metadata, defaults missing dimensions to one, caches images indefinitely by ID, finishes parallel duplicate-ID variants in nondeterministic order and publishes files even after download failures. Preserve the sampling/matching algorithm while making data acquisition/outputs explicit and repeatable.
- [The official endpoint catalog](https://json.tarkov.dev/endpoints) currently provides both `pve` and `regular` item/translation documents. Build both reference sets, deduplicate identical references and retain distinct mode/icon variants. This is public game catalog data, not a player's stash.
- Cache by source URL plus content digest; retain catalog snapshots and image provenance. An offline option uses existing validated cache only. A refresh option explicitly reacquires cached images. Repeated offline builds from identical snapshots/references must have deterministic ordering and output digests.
- Download and image decode are bounded. Invalid IDs, dimensions, placeholder images, failed images and invalid shipped corrections are reported explicitly; missing dimensions never become invented one-cell references. Do not replace a previous valid generated directory after an incomplete build.
- Reference/correction admission reserves at most 100000 records and 256 MiB of fingerprint bytes, including in-flight mode variants, before allocating output. The header has the same 16-MiB ceiling in the builder, distribution checker and runtime loader. These are resource limits, not measured RAM/performance guarantees.
- OCR preparation validates the pinned English model hash before publication, copies the exact installed worker/engine assets and writes an integrity manifest. Corrupt cached data is retained for diagnosis rather than silently deleted.
- Distribution commands require complete manifests/files. Ordinary UI compile commands and CI compilation remain distinct from a content-complete package, so routine CI need not regenerate thousands of live catalog images. Native developer instructions name asset preparation explicitly. Runtime scanner initialization validates the header, offsets, byte length and checksums before transferring data to its worker.
- `npm run assets:check -- dist` and `npm run assets:check -- dist-tauri` additionally inspect copied build content and require its manifests to match current `public` assets. The known local build has 5309 unique image references, zero shipped corrections and 242 explicitly excluded missing/placeholder entries across both modes. Exclusions are not evidence of empty cells; both scanner review flows show a reminder to inspect unrecognized areas.

## Tasks and verification

1. Introduce bounded network/cache/publication helpers under `scripts/lib/`; validate every generated move remains within the repository and retain previous outputs outside `public`.
2. Harden `scripts/build-scan-fingerprints.ts` with mode union, deterministic ordering, bounded resource use, snapshots/offline mode, validated corrections and manifest publication.
3. Harden `scripts/fetch-ocr-assets.mjs`, then prepare the actual local model/worker files.
4. Add shared scanner asset validation and a content check command, connect distribution guards, documentation and scanner initialization. Run the actual asset build and inspect its provenance/integrity output; this is asset preparation, not screenshot/recognition verification.
5. Use type checking, lint, both frontend builds, strict Clippy/format checks as appropriate, embedded native build and read-only source review. Do not run tests, corpus benchmarks or real screenshots. Record generated artifact hashes/counts/failures and remaining runtime/pack gates. Commit source/docs only; generated images, models, caches and packs stay ignored.
