# Catalog milestone observations

Observed on 2026-10-30; documented after resuming work on 2026-11-01. Source base: `ee20c36` plus the catalog instrumentation changes committed with this report. These are instrumentation observations, not a release performance comparison. No tests or screenshot corpus were used.

The existing sampler launched sequential fresh isolated profiles, Electron first, then Tauri, with 30 seconds settling and 60 seconds sampling requested at 1-second target intervals. Game integrations, autostart writes, updates and cleanup were disabled. Both used the default `regular` (PvP) mode. No compiler ran during observations. Network, OS caches and background machine activity were uncontrolled. Environment details are in the parent [preliminary report](../README.md); free physical RAM observed during this work was 2,805,988 KiB.

Electron used the production frontend through the installed Electron 44.9.3 executable and worktree package entry point, without a development server. Tauri used the embedded production frontend in an **unoptimized development-profile** native build. Resource samples in the raw outputs must not be used to claim an architectural performance advantage. These observations do not establish a PvE baseline.

| Observed milestone / count | Electron | Tauri development |
| --- | ---: | ---: |
| React layout observed, ms | 1179.86 | 1721.35 |
| Catalog snapshot observed, ms | 3203.37 | 3732.83 |
| Tasks | 503 | 503 |
| Items | 5498 | 5498 |
| Hideout stations | 26 | 26 |
| Retained sampling observations | 60 | 60 |
| Unavailable process observations | 0 | 0 |

Times include polling delay and catalog serialization/hashing overhead. They do not measure first paint, input latency or startup distributions. Catalog readiness means three existing active queries were successful and idle at the captured snapshot; it does not promise their contents stayed unchanged throughout the observation.

All three adapted JSON fingerprints matched across these two launches:

| Query | SHA-256 |
| --- | --- |
| gameData | 7bbf7708b3be4452a5ea82f0d17ab49566b94749178ceab63e7aaea7f27d009c |
| items | 5b6b7ecbc6211aa6be12e60af111bac7a3dd3cd8e3c9d3aefeb1d0dbe1067627 |
| hideout | d9ff0034d2b3dc8c53e817b6a275ddcad1f3ba855a721d1fc731e47a6f3a88fe |

These fingerprints omit only top-level local fetchedAt. They describe the exact adapted JSON representations, not canonical source documents or complete application/browser state. Equal fingerprints support data equivalence for these snapshots only.

Raw outputs are preserved unchanged as [electron-hidden.json](electron-hidden.json) and [tauri-development-hidden.json](tauri-development-hidden.json), including executable hashes, paths, per-process samples and both milestone payloads. SHA-256 of the copied outputs matched the original temporary files:

- Electron: `26CFBCC07DEE2B39E0B4B5A3ABB14208941EAD9B9348E01529C33CD6826EBFD4`.
- Tauri: `B73816FD6381CBFC0F3E932004D4259758BF971600B261D04FC9A638BF5A79E7`.

Only isolated roots verified by their profile command lines and descendants verified by creation time were stopped. One native child exited during shutdown before its stop operation; a follow-up inspection found no remaining sampled PIDs. Temporary profiles were retained. No broad process-name termination or user profile deletion occurred.

Next: rebuild the optimized native executable with this instrumentation, establish explicit comparable release workloads and repeat launches. Full desktop parity, real-use responsiveness, installation/recovery and representative optimization gates remain open.
