# Preliminary hidden desktop observations

These are two actual isolated launches at source commit `2278c9c`, not a performance improvement claim or completed Phase 1/8 acceptance. No tests, screenshot corpus, recognition, game interaction, sales or installation exercises were run.

## Builds and environment

- Tauri: `node scripts/native.mjs cargo build --locked --release -p tarkov-companion-rust --features custom-protocol`, exit 0, optimized release profile (thin LTO, one codegen unit, stripped). Embedded `dist-tauri` production UI; binary SHA-256 is in the raw result.
- Electron: installed locked Electron 44.9.3, running the fork's previously built `dist-electron/main.cjs` and production `dist` through the worktree package entry point. This is an unpackaged reference launch, not an installer/package measurement. No development server was configured; `ELECTRON_RUN_AS_NODE` was unset.
- Windows 10 Enterprise 10.0.19045; Ryzen 7 7800X3D, 8 cores / 16 logical processors; 33,150,516 KiB visible RAM; Balanced power plan.
- RTX 5080, driver 32.0.16.1692, reported 1920 × 1080. DPI/HDR and GPU utilization were not measured. Installed WebView2 application directory: 156.0.4314.50; exact loaded runtime version was not independently queried.
- RAM pressure was substantial: free physical RAM was 1,336,320 KiB during the Electron observation and 836,276 KiB after the Tauri observation. Other machine activity was uncontrolled. No compiler ran during either sampling interval.

SHA-256 inputs:

| Input | Hash |
| --- | --- |
| package-lock.json | F2A13A212D92AAD26B39812A77DB1C0C7687778AEC29483A24C5AEB56410A09F |
| Cargo.lock | 52190A4CD1667FD6217F50F08E337577301839D47DEFAA8047BF580992E508FD |
| public/scan/manifest.json | C77C45D127D5C3940FB86F920F0EADC77E9C89D789FC8192A1B688C04FCABF9E |
| scripts/bench/desktop-baseline.mjs | 5DE6C29165F43FA59C3180C6639253FA13580EA7723281446E8146A5E67A44B1 |
| scripts/bench/measure-desktop.ps1 | 5285E8171E45B53D10154EE97E0B655D1948DA43B06D7E6983CD89842B76A822 |
| dist/index.html | D16BC491CAE3E09D848F479ACFEBF610653BF4DEB59C6E599A2A53D76A9294CB |
| dist-tauri/index.html | 94D851B5A8DFD29982CBC90786426F146D60608545EE13E42BC480B80BCABBE2 |
| dist-electron/main.cjs | 683D7FA5A15E35FCD2B32725C4FC080D46CFF88CE1930E27EA336C1FB9C59C88 |

## Procedure and limits

The existing `desktop-baseline.mjs` / `measure-desktop.ps1` sampler ran sequentially, Electron then Tauri, with a fresh empty temporary profile for each, 30 seconds settling, 60 seconds requested sampling and 1,000 ms target intervals. Both hosts explicitly honor isolated profile overrides and `TC_BENCH_DISABLE_INTEGRATIONS=1`; game readers, hotkeys, login writes, updates and automatic cleanup stay disabled. Source default main-window size is 1360 × 860 in both hosts. Windows remain hidden through the hosts' benchmark startup settings; visibility was not independently inspected.

The default application route may fetch public data. Network responses, catalog completion, OS caches and current background activity were **not controlled**. Fresh profiles do not imply cold OS caches. Different hosts may have loaded different amounts of data; these are preliminary launch/settling observations, not equivalent catalog-ready idle workloads. Native SQLite services and different browser engines also differ. No fixtures or seeded catalog were introduced.

Raw, unmodified sampler outputs are [electron-hidden.json](electron-hidden.json) and [tauri-hidden.json](tauri-hidden.json). They include launch arguments, isolated paths, executable hashes and per-process samples. Temporary profiles and readiness files remain outside Git. After each completed observation, the root command line was checked for its exact isolated profile, current descendants were collected, and only matching PID/creation-time processes were stopped. No general process-name termination or profile deletion was used.

## Observed values

Quantiles are nearest-rank over retained sampling-phase observations. CPU is normalized over 16 logical processors. Zero means no observed CPU-time increment at the sampler's resolution, not proof of no work. Memory includes observed descendants; summed working sets can double-count shared pages. Maxima are sampled values, not allocation high-water marks.

| Observation | Electron | Tauri release |
| --- | ---: | ---: |
| Retained samples | 60 | 59 |
| Observed processes per retained sample | 4 | 7 |
| React layout readiness observed, ms | 1199.50 | 1383.16 |
| Private bytes p50 | 266223616 | 279285760 |
| Private bytes p95 | 273842176 | 281784320 |
| Private bytes sampled maximum | 333783040 | 337387520 |
| Aggregate working set p50, bytes | 396480512 | 453849088 |
| Aggregate working set sampled maximum, bytes | 462311424 | 510283776 |
| CPU p50, % of total logical capacity | 0 | 0 |
| CPU p95, % of total logical capacity | 0 | 0.09667 |
| CPU sampled maximum, % | 0.09827 | 0.48868 |
| Sample acquisition p50 / p95, ms | 70.34 / 78.74 | 94.14 / 108.55 |
| Unavailable-process observations | 0 | 0 |

Readiness is the first polling observation of `react-layout-mounted`, including polling delay. It does not measure first paint, input responsiveness or usable catalog. One launch per host cannot support a startup distribution. There was no observed private-memory reduction in this pair; it provides no causal conclusion about architecture because the workload and environment are not sufficiently controlled.

Remaining work: controlled catalog/network readiness, repeated release launches, foreground/minimized/searchbar scenarios, representative real-use responsiveness, GPU observations where available, and bottleneck attribution before optimization. Real screenshot verification remains waived by the user; no scanner latency or accuracy result is inferred here. Windows installation/update/recovery and full desktop parity remain separate open gates.
