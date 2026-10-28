# Native content packs and streaming preparation

This implements the content-pack service seam from migration phase 3. It preserves the existing TCPK1 archive format used by Electron: `TCPK1\n`, a four-byte big-endian JSON header length, `{ files: [{ path, size }] }`, then the concatenated file bodies in header order. It prepares/consumes data only; it neither publishes a release nor installs an updater.

## Native service

`src-tauri/src/packs.rs` exposes:

- `Packs::new(data_dir: PathBuf, manifest_json: &str, version: &str) -> Result<Packs, String>`. Pass the canonical native profile's active data directory and trusted compiled manifest text. `"null"` supports development/bundled-only builds. Construction validates metadata and resolves the supplied profile, but creates no pack directory, performs no download and reads no game folder.
- `enabled()` / `contains(name)` identify whether this build describes a downloadable pack.
- `ensure(name, progress) -> Result<(), String>` is **blocking**; invoke it from a bounded blocking host job, never an async/UI runtime thread. One installation runs at a time. Duplicate requests wait and recheck the completed result; at most four active/waiting requests are admitted. A missing compiled descriptor is a no-op so the caller can use bundled/dev assets.
- `read_resource(relative) -> Result<Option<Vec<u8>>, String>` reads only a described, completed pack entry, with its expected size/hash. `None` means the caller should try its separately scoped bundled/dev resolver. It does not start a download. Missing/corrupt requested files invalidate the in-process installed cache; a subsequent `ensure` installs a fresh directory and retains the old one.

The progress callback receives serializable `name`, `label`, `received`, `total`, and `state` (`downloading`, `installing`, `done`), matching the current frontend `PackProgress` shape. The host should emit `pack:progress` and return a binary IPC/protocol body for resource reads.

Use the already locked reqwest 0.13.5 through a direct native dependency:

```toml
reqwest = { version = "0.13", default-features = false, features = ["blocking", "native-tls", "system-proxy"] }
```

The Windows TLS backend uses the OS certificate trust store; no AWS-LC build is required by this choice. Cargo/lockfile integration belongs to the main implementation, not this isolated module change.

## Installation and trust boundaries

The descriptor binds the exact filename, SHA-256, archive byte length and file count. Official downloads start only at `https://github.com/somepoi/tarkov-companion-rust/releases/download/v<version>/...`. HTTPS redirects are limited to the fork release path on GitHub or GitHub's known asset CDN hosts, with at most eight hops. Username/password, URL fragments and unexpected ports/origins are rejected. The explicit `TC_PACKS_BASE_URL` staging override permits the fork's release directory or HTTP/HTTPS loopback; no override is read from renderer input. Base queries are refused, and reqwest errors are stripped of URLs so CDN signed query strings are not surfaced.

The request has a 15-second connect limit and 180-second request limit, asks for identity transfer encoding and rejects response/body lengths differing from the compiled descriptor. Downloads use a 64-KiB buffer and stream to a uniquely created job archive while calculating SHA-256. Extraction uses another 64-KiB buffer, bounded JSON header and a second rolling archive hash over the exact bytes copied to files, before activation. No all-pack buffer is allocated.

Limits are 300 MiB per pack, 256 MiB per file, 50000 files, 8 MiB per header, 16 MiB per completed index, 240 ASCII characters per relative path and 32 path components. Entries must remain in `scan/` (JSON/binary only) or `tiles/lighthouse-re3mr/` (raster images/JSON/text attribution). OCR JavaScript/WASM stays bundled and cannot come from a pack. Path traversal, backslashes, alternate streams, Windows device names, trailing dots, case-insensitive duplicate paths, and file/directory collisions are rejected. Required scanner manifests/data or the Lighthouse root tile must be present. Native extraction consistently lowercases the permitted ASCII paths, matching Windows lookup behavior and the service's index.

Jobs are rooted in the supplied native profile's `packs` folder. Existing redirected cache roots and out-of-scope pointers/resources are rejected. A unique `.partial-*` directory holds the downloaded archive and extraction tree. Each extracted file and its per-file checksum index are flushed before the content directory is renamed to a new version/hash/job directory. The service atomically replaces a small completed pointer only after publication succeeds. Incomplete jobs and unadvertised output remain available for diagnosis; old installed versions are never deleted or opened as writable data. Only the successful current job's now-redundant download file may be removed, after its resolved path is checked. No directory or game screenshot is deleted.

An installed index is loaded lazily and checks required entries/file sizes once. Each requested resource subsequently checks canonical scope, exact byte count and SHA-256. The current cache is reused without polling or idle work. These are source-level controls, not measured startup/idle/throughput guarantees.

## Streaming builder

`scripts/build-packs.mjs` now walks/validates both input trees before writing new output, refuses links and unsafe/non-data entries, bounds all file/header/total sizes and streams input bodies into a new output file while hashing. File metadata/size changes during preparation abort the job. Sorted path order and the incumbent header shape preserve deterministic TCPK1 bytes for unchanged inputs. There is no recursive delete.

The previous `electron/packs.generated.json` remains until every pack is flushed and promoted. Existing pack files are retained. An identical filename is reused only after a bounded full hash comparison; a collision preserves the existing file and fails. Only this job's verified redundant temporary file is unlinked. All promotion paths are checked within the repository output root; failed temporaries are retained outside the advertised `*.tcpack` names. The generated manifest is replaced through the existing atomic-write helper after all packs succeed.

## Remaining integration and verification

The host now embeds the trusted optional descriptor at build time, owns the fallible service without blocking recovery, installs through main-window-only IPC, emits progress and reads pack bytes over bounded binary IPC. Benchmark installation is rejected. Binary reads admit at most two jobs and 64 MiB per resource. The adapter prefers bundled assets and falls back to installed packs, including missing/HTML dev-server fallbacks.

`resources.rs` registers the asynchronous `tcres` protocol using the locked [Tauri API](https://docs.rs/tauri/2.12.5/tauri/struct.Builder.html#method.register_asynchronous_uri_scheme_protocol). It accepts GET/HEAD from main/searchbar, decodes UTF-8 paths and serves only raster files under `tiles/lighthouse-re3mr/`. Installed bytes are capped at 8 MiB before allocation; embedded assets use exact-key membership to avoid the SPA fallback. Development files are scoped to the repository's canonical public directory. Scripts/private profile files are excluded. Eight blocking readers execute behind a bounded 128-request admission queue; ordinary viewport bursts wait asynchronously instead of losing tiles at the eight-reader boundary. Exhaustion beyond the total bound returns 503. CSP grants the protocol only image/connect access; map templates append placeholders after native URL conversion.

Read-only review found the original immediate eight-job rejection could leave blank Leaflet tiles; the queue addresses that finding. No other P1/P2 findings were reported. This does not verify actual WebView tile delivery, network failure/retry or release packaging.

Integration is source-complete; Windows runtime/offline/interrupted-download acceptance and a published fork pack release remain open. No publishing is authorized by this implementation.

Only `rustfmt` syntax formatting, `node --check scripts/build-packs.mjs`, whitespace review and source inspection were performed for this isolated task. No tests, fixtures, game screenshots, pack/map downloads, app launch or installation were performed. Root compilation/integration and Windows/offline/interrupted-download acceptance remain required; source implementation is not a passing native parity checklist.

Root integration checkpoint: both frontend builds, lint, formatting, strict custom-protocol Clippy, embedded native development build and built content integrity passed. Native notices regenerated for the new locked graph (314 crates, 193 license texts). No runtime download, WebView tile exercise, installer or tests were run. The isolated-task compilation gap above is resolved; runtime acceptance remains open.
