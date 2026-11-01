# Reproducible desktop and scanner measurements

Status: measurement tooling prepared. Preliminary observations are recorded in [2026-10-30/README.md](2026-10-30/README.md), and a fresh release pair with matching catalog snapshots is recorded in [2026-11-01/README.md](2026-11-01/README.md). Repeated controlled-workload acceptance remains open. No tests or accuracy suite were run, and no performance target or speedup is claimed. These commands are opt-in developer operations, not CI checks.

## Environment record

Record the application commit, dependency lock hash, release/debug mode, Windows build, CPU/logical cores, power plan, RAM, GPU/driver, monitor resolution/DPI/HDR, WebView2 version, app settings, catalog/asset hashes and scenario. Compare release builds with identical workload and copied data. Separate foreground, minimized, hidden and searchbar scenarios. Keep original-user data and the original application's installation untouched.

Use a clean run directory for every sample. The supplied desktop runner creates its own unique temporary directory and a new empty profile; it never accepts an existing profile, recursively deletes a directory, or terminates the measured app. Outputs stay in that directory. Close the launched companion normally after measurement and before launching the next sample. Do not put tokens or personal information in command arguments or the isolation-contract description; these are recorded in launch.json.

## Host isolation contract

The executable must explicitly support the requested profile override **before** acquiring a single-instance lock or performing startup side effects. An arbitrary Chromium `--user-data-dir` argument is not proof that Electron userData moved. The fork's Electron host reads that switch explicitly; Tauri should support its own `--profile-dir` override.

The host must honor `TC_BENCH_DISABLE_INTEGRATIONS=1` by suppressing real-game discovery/readers, position tracking/screenshot changes, hotkeys, autostart writes, automatic cleanup, update checks/downloads/installation and first-run backfill. This is a benchmark mode, not a normal user setting. A supplied `--isolation-contract` records the operator's understanding; the sampler cannot verify host compliance. Do not launch unmodified upstream binaries or a real-game executable with this tool.

The runner sets `TC_BENCH_READY_FILE` to a fresh path. An instrumented host may write a JSON readiness milestone there (for example, main React mount plus its precise semantics). Absence is reported as null. File observation time is an upper bound with polling delay; it is not automatically first paint or usable game data. `launchRequestToProcessHandleMs` only measures returning a process handle. Do not call that startup latency.

The fork can additionally publish `catalog-ready.json` in that same fresh directory. `catalogReadySignal` is independent of `readySignal`: three existing active mode-specific queries (`gameData`, `items`, `hideout`) had success/idle states after cache restoration. The summary contains task/item/station counts, query update times and SHA-256 fingerprints of adapted JSON, excluding top-level local `fetchedAt`. Source ordering, prices and translations can change these fingerprints; they are not hashes of canonical raw API documents. The renderer rechecks current cache/query/data identities after hashing and discards superseded work. Missing, failed, paused or inactive queries produce no milestone.

Catalog instrumentation runs only in the main isolated benchmark host. It subscribes to existing query events without initiating requests or intervals, serializes/hashes one document at a time (16 million UTF-16 code-unit limit per representation), then unsubscribes. Serialization and hashing are measurement overhead, including temporary allocations, and readiness latency includes that work. Normal production windows do not mount this observer. Both hosts publish a complete bounded summary once. The sampler's original settling/sampling windows do **not** automatically move to this signal; a short run may have no catalog-ready retained interval. Record absence, and explicitly select and document a later interval before claiming catalog-ready idle. This signal does not prove the complete UI is usable, unchanged afterward, or workload-equivalent across hosts.

## Windows desktop process-tree sampling

From the repository root, after separately building an isolated release executable:

```powershell
node scripts/bench/desktop-baseline.mjs --exe 'D:\Builds\TarkovCompanionRust.exe' --arg '--user-data-dir={profile}' --isolation-contract 'Fork host supports explicit userData isolation and TC_BENCH_DISABLE_INTEGRATIONS' --duration 300 --settle 30 --sample-ms 1000 --label hidden
```

For a Tauri host that implements the equivalent contract, replace the argument with `--profile-dir={profile}`. If a host instead supports a dedicated environment variable, use `--profile-env TC_HOST_PROFILE_DIR`; system environment variables are refused. Do not assume either interface is implemented merely because this document names it.

The helper starts the executable with `Start-Process -WindowStyle Hidden`. It labels but does not enforce foreground/minimized workload: for those scenarios, change the window state manually after launch and record the timing. It uses CIM only to discover parent relationships; process resource inspection is limited to the launched process and observed descendants. It never opens game memory, sends game input, captures the game automatically or inspects game traffic.

Output contains per-process private bytes, working sets, cumulative CPU seconds, aggregate tree values, and sample acquisition duration. CPU percentage is a delta of observed cumulative process CPU divided by elapsed wall time and the sampler's logical processor count. The first delta is null. Exited process totals keep their last observation. PID plus creation time avoids attributing an unrelated reused PID. Very short-lived children, already-reparented processes, external shared services or launches handed to an existing instance can be missed. Working-set sums may double-count shared pages. CIM itself adds overhead; compare identical samplers and record intervals.

Keep settling samples separate. Calculate nearest-rank p50/p95 for retained sampling intervals and sampled maxima for memory; do not describe sampled peaks as allocation high-water marks. Repeat at least ten independent cold/warm launches if reporting startup distribution; document OS-cache control rather than claiming a fresh profile clears OS caches. GPU engine utilization and input latency are not collected by this runner; report unavailable or supply separately documented OS counters. Game-running impact is a separate manually controlled experiment, never an implicit result of idle sampling.

The sampler deliberately disables live integrations. Measure watcher cost separately using a fixture log directory and a host-supported fixture-only mode, once available; never relabel this isolated mode as a normal fully active idle baseline.

## Offline scan measurements

Provide a real corpus and generated fingerprints externally; this change adds no fake screenshots or expected answers. Run with the installed local `tsx`, `sharp` and OCR dependencies; no asset generation or live API request is performed by the runner.

```powershell
npx --no-install tsx scripts/bench/scan-baseline.ts --manifest 'D:\ScanCorpus\manifest.json' --assets 'D:\ScanAssets\fingerprints' --repeats 10 --ocr on
```

`--ocr on` uses the existing `scripts/ocr-node.ts` helper and requires `public/ocr/eng.traineddata.gz` relative to the repository working directory. It measures helper initialization/preprocessing/recognition together. `--ocr off` measures visual matching without OCR. `--ocr supplied` requires each entry's `wordsFile`, so only downstream matching is timed. None of these modes is interchangeable when comparing results.

Manifest format (schema description; no example data is claimed to be a real corpus):

```text
schemaVersion: 1
description: operator-authored source and labeling notes
entries: nonempty array of
  id: unique string
  image: relative screenshot filename inside the manifest directory
  sha256: exact screenshot-byte SHA-256
  stratum: resolution/DPI/layout/category label
  wordsFile: optional relative JSON file containing OcrWord[]
  expected: optional object
    complete: whether all visible expected detections are labeled
    detections: array of { itemId, col, row, w, h, rotated? }
```

Inputs must already be cropped as desired. Geometry is relative to the grid selected for that image. Keep screenshot source/crop notes, permission/privacy decisions and review provenance with the private corpus. Hashes detect changed files; they do not validate human labels. A `wordsFile` contains `{text,conf,x0,y0,x1,y1}` objects in image-pixel coordinates. Relative paths and symlinks escaping the corpus directory are refused. `--max-pixels` defaults to 40 million decoded pixels; choose a smaller bound for constrained hosts, remembering OCR can enlarge images.

Each image gets a new descriptor index and OCR worker before its first `cold-worker` scan, followed by the requested number of `warm-worker` scans. This is worker/model lifecycle coldness, **not** a fresh OS cache, freshly launched process or uncached disk. Descriptor initialization is recorded separately. Stages are image decode, OCR helper, grid choice and matching; total excludes descriptor init, capture, browser transfer, UI review and inventory commit. The Node OCR helper uses sharp preprocessing rather than the renderer's bicubic implementation, so browser end-to-end latency/accuracy remains a separate measurement.

JSON outputs go to a new temporary directory. Results retain every attempted scan and error. Summaries group by stratum/worker phase with success-only nearest-rank p50/p95 **and failure counts**, preventing failures from disappearing from reports. Increase real input count/repeats for a meaningful p95; do not generalize one screenshot repeated 100 times to all junk boxes.

When supplied, labels produce descriptive one-to-one exact item/box agreement, recall, and precision only for completely labeled images. There is no pass/fail assertion or accuracy threshold. Missing labels produce no invented accuracy. Current detections do not expose stack quantity or FIR; neither is inferred or scored. Node process memory snapshots are not whole-app or peak-memory observations. For final decisions compare high-confidence wrong matches, unknown/omitted occupied regions and real container workflows separately using explicitly supplied evidence.

## Reporting and preservation

Publish raw JSON, methodology, hashes, sample counts, failures, strata, warm/cold definitions and measurement omissions together. Keep screenshots outside Git unless the owner has reviewed them. Do not publish personal paths or images accidentally. Record deviations between Electron and Tauri hosts; do not claim parity or a Rust/Tauri resource win from an unrun script, debug build or changed workload.
