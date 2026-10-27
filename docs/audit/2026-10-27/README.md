# Audit evidence — 2026-10-27

Reference commit: `29006730e750cb40ad714da4abd0cdd13e37962c`. Date labels use Europe/Moscow; API request timestamps are UTC. This directory contains evidence for the technical audit, not production code or an established performance budget.

| File | Contents |
| --- | --- |
| `verification.json` | Commands/outcomes observed during the audit, lockfile versions, host description, smoke summary and unmeasured metrics |
| `npm-audit.json` | Captured `npm audit --json`; exit code 1 with four high and one moderate vulnerable package entries |
| `api-responses.json` | Public API request metadata/hashes and selected exact response shapes; no personal game data |
| `api-extra.json` | Additional public requests, including a maps timeout and successful PvE price history/trader/translation requests |
| `runtime.json` | Raw metrics from one isolated hidden unpackaged Electron smoke run; includes all processes returned by app.getAppMetrics |
| `runtime-harness.cjs` | The temporary harness used for that run, preserved for inspection |

## Verification scope

`npm test` passed 186 tests in 29 files. Lint, web build and desktop build exited 0. Scanner corrections check had zero fixtures. The distribution installer was not built or installed. No real-game OCR or screenshot-recognition corpus was available. The initial checkout lacked generated scanner fingerprints, OCR assets and Lighthouse tiles.

The shell had Node 24.15.0/npm 12.0.2. The Electron runtime embeds its own versions, recorded separately in runtime.json. The release workflow specifies Node 22; do not confuse the shell runtime, embedded Electron Node and intended CI runtime.

## Smoke methodology and limits

The harness was launched with the checkout's Electron executable through a hidden Start-Process invocation, using the checkout as working directory. It loads the existing built desktop main module; the application was not patched on disk.

Before loading the main module it sets an isolated temporary userData directory, redirects appData/environment game-location paths, supplies an empty screenshot/log directory, suppresses login-item writes and seeds settings with watcher paused, position tracking/cleanup/searchbar/hotkeys/updater off. It does not run either inherited destructive installed-app test script. The run self-terminated; no application process was intentionally left running.

Startup is the interval from requiring built main to detecting React `<main>`, checked every 100 ms. It is not OS process creation to visible UI, nor time to fully loaded game data. The first-run dialog remained visible in DOM over the dashboard; the window itself stayed hidden. After 8 seconds of settling, app.getAppMetrics was primed and sampled 20 times approximately one second apart.

Memory fields are reported by Electron in KB, converted by division by 1024 for MiB. Working sets may count shared memory more than once; private bytes are kept separately. CPU values are the sum of Electron's per-process percentCPUUsage, not calibrated Task Manager readings. Hidden throttling, paused integrations and uncontrolled network/cache state make these results unsuitable for comparing Electron to Tauri or predicting game-running impact. Peak scan memory, GPU utilization and latency percentiles were not measured.

## Repeating the experiment

Review the harness before reuse. Its preserved output/profile path is a fixed temporary audit directory; a second run would reuse that profile and overwrite its temporary results. For a fresh run, change `out` to a new uniquely created temporary directory and leave earlier evidence intact. Do not replace its isolated userData with a real application profile.

1. Work from the repository root and run `npm ci`. If the Electron binary is absent, use `node node_modules/electron/install.js`.
2. Run `npm run build:desktop`. A later plain web build replaces dist with web asset paths; rebuild desktop before repeating the runtime smoke.
3. Inspect/adapt the saved harness's fresh output path and launch it with `node_modules/electron/dist/electron.exe`, using Start-Process with `-WindowStyle Hidden` and the repository working directory. The Electron executable, not ordinary Node, runs this file.
4. Read its runtime.json or runtime-error.txt after it exits. Keep all limitations and per-process/sample methodology when reporting results.

For a real comparison, use the protocol in the technical audit: release builds, controlled assets/profiles, multiple launches/scans, representative labeled inputs and all child processes. This single smoke is not that protocol.

Full public API response bodies were kept only in the temporary audit directory to avoid adding a large live-data snapshot to Git. api-responses.json retains source URLs, request timestamps, byte lengths, HTTP metadata and SHA-256 hashes for the primary responses, plus small shape samples. Remote content can change; successful requests do not guarantee complete or fresh game data.
