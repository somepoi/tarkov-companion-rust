# Catalog-qualified hidden release observations

Source commit `85f1cbc`, clean worktree during builds/launches. Native optimized custom-protocol release build exited 0 in 4m27s. The production Electron frontend and main process were the existing outputs from the same source commit, with no development server. Electron ran unpackaged through locked Electron 44.9.3; Tauri ran `target/release/tarkov-companion-rust.exe` with its embedded production frontend. This is one pair of observations, not a startup distribution, optimization result or completed release acceptance.

## Environment and procedure

Windows 10 Enterprise 10.0.19045, Ryzen 7 7800X3D (8 cores / 16 logical processors), 33,150,516 KiB visible RAM, Balanced power plan. Same machine as the [October observations](../2026-10-30/README.md). Free physical RAM observed during native sampling was 1,846,288 KiB and during Electron sampling 1,876,660 KiB; substantial memory pressure and other machine activity were uncontrolled. No compiler ran during either interval. GPU utilization, current DPI/HDR and exact loaded WebView2 version were not measured.

The existing sampler ran Tauri first, then Electron, with a different fresh empty isolated profile each time: hidden main window, integrations disabled, 30 seconds initial settling, 60 seconds requested sampling, 1-second target intervals. Both profiles used default `regular` (PvP), so this is not a PvE baseline. Network/OS cache state was uncontrolled. Snapshot counts were 503 tasks, 5498 items and 26 hideout stations in both hosts.

To compare a consistent interval, the table uses observations within `[catalogReadySignal.observedAtMs + 30000, catalogReadySignal.observedAtMs + 80000]`, a 50-second requested window after 30 additional seconds of catalog settling. CPU deltas are included only when the preceding observation also lies inside this window. Quantiles use nearest rank. Counts differ because sampling intervals include acquisition overhead. This post-selection does not change the raw sampler phases.

| Observation | Electron | Tauri release |
| --- | ---: | ---: |
| React layout observed, ms | 1180.62 | 1435.77 |
| Catalog snapshot observed, ms | 3222.80 | 3465.81 |
| Selected memory samples | 50 | 49 |
| Selected CPU deltas | 49 | 48 |
| Private bytes p50 | 287711232 | 306114560 |
| Private bytes p95 | 288354304 | 306622464 |
| Private bytes sampled maximum | 288354304 | 306622464 |
| Aggregate working set p50, bytes | 402075648 | 459108352 |
| CPU p50, % total logical capacity | 0 | 0 |
| CPU p95, % total logical capacity | 0.09752 | 0.09658 |
| Observed processes per selected sample | 4 | 7 |
| Unavailable process observations in full run | 0 | 0 |

No private-memory reduction was observed for Tauri in this pair. This does not attribute the difference to any module or establish a general architectural result. Summed working sets can double-count shared pages; private memory maxima are sampled, not allocation high-water marks. CPU zeros mean no observed counter increment at this resolution. Readiness includes polling and catalog fingerprint overhead; it does not measure first paint, responsiveness or a startup distribution.

## Data equivalence and preservation

All three adapted JSON fingerprints matched between this pair:

- gameData: `69dc2f49474e98ffb3096b0d046371b02bb8c0af86519146c0cf2ee6e05791a1`.
- items: `c0852e724cd873853a36b1912c25014a18efbb94be2aca9c61b87ba109e53ed9`.
- hideout: `d9ff0034d2b3dc8c53e817b6a275ddcad1f3ba855a721d1fc731e47a6f3a88fe`.

These are exact adapted JSON fingerprints excluding top-level fetchedAt, not canonical raw-source hashes. They establish matching captured catalog representations only; they do not prove unchanged data across the entire sampling interval, equal browser state, network cost or complete desktop parity. Game/item fingerprints differ from October, so those runs cannot be treated as the same workload.

Raw unmodified outputs: [electron-hidden.json](electron-hidden.json), [tauri-hidden.json](tauri-hidden.json). Executable hashes and launch contracts are retained there. Native executable SHA-256: `EBD8EAB3667E81CA807E30D3B056D32DCDE95C59EDEB0B42E680314CCE45D5B2`. Dependency locks remained unchanged: package-lock `F2A13A212D92AAD26B39812A77DB1C0C7687778AEC29483A24C5AEB56410A09F`, Cargo.lock `52190A4CD1667FD6217F50F08E337577301839D47DEFAA8047BF580992E508FD`.

After each completed run, isolated root ownership was verified against the exact profile argument; only current descendants with matching PID/creation times were stopped. Profiles were retained. No tests, fixtures, screenshots, game integrations, installer changes or user data deletion occurred. Remaining gates include repeated controlled release/PvE scenarios, foreground/minimized/searchbar observations, bottleneck attribution and real-use responsiveness. No optimization or speedup is claimed.
