# Repeated Tauri release startup and idle observations

Two sequential measurements used the same optimized Tauri executable from `5bc3b58`. The executable contains the production frontend and was built by the Windows NSIS packaging command. Each launch used a new, empty benchmark profile and a hidden window with live integrations disabled. Both runs reached the React layout and the regular-mode catalog milestone. The temporary profiles were retained, and each measurement process was stopped after verifying its executable, start time and profile argument.

The first attempt exited before startup because Node used `D:\TEMP` while the native host validated against Windows' `D:\TMP`. Redirected stderr identified the profile guard as the cause. The successful runs used the corrected sampler, which asks Windows for the temporary path before creating the measurement profile. No app changes were needed for that mismatch.

Windows 10 build 19045, Ryzen 7 7800X3D (16 logical processors), 31.62 GiB physical RAM, Balanced power plan and WebView2 157.0.4341.42. The GPU was an NVIDIA GeForce RTX 5080 with driver 32.0.16.1692, and Windows reported 1920 × 1080. DPI, HDR and background activity were uncontrolled. No compilation overlapped sampling. Neither a fresh profile nor two sequential runs control OS or network caching.

The sampler requested 30 seconds of settling and 60 seconds of sampling at one-second intervals. The table uses samples between 30 and 80 seconds after catalog readiness was observed, following the [November 1 method](../2026-11-01/README.md). CPU deltas exclude the interval crossing the selection boundary. Percentiles use nearest rank.

| Observation | Launch 1 | Launch 2 |
| --- | ---: | ---: |
| React layout observed, ms | 1094.78 | 1079.63 |
| Catalog snapshot observed, ms | 4125.86 | 5112.36 |
| Selected memory samples | 50 | 50 |
| Selected CPU deltas | 49 | 49 |
| Private bytes p50 | 286158848 | 281530368 |
| Private bytes p95 | 286699520 | 290476032 |
| Private bytes sampled maximum | 286945280 | 290476032 |
| Aggregate working set p50, bytes | 431824896 | 432115712 |
| CPU p50, % of logical capacity | 0 | 0 |
| CPU p95, % of logical capacity | 0 | 0.09677 |
| Observed processes per selected sample | 7 | 7 |
| Unavailable process observations in full run | 0 | 0 |

Both launches observed the same adapted catalog fingerprints and counts.

- Game data, 503 tasks. `265cc55e4668d0fc2092ba230c590b7405d8861e8a10b6b2ec86d2b1bb34745a`
- Items, 5,498 records. `a826f3f4c1da201d3741d1ebaa90e6843fc544733f788b43c79db49646eea2c5`
- Hideout, 26 stations. `37adf8c699f9fa076cb2c0835f7742f60300c923b57c973908841946a47b4834`

The November 1 observations used different catalog fingerprints and a different memory-pressure environment. These results establish current hidden-window observations. They cannot establish a speedup, a startup distribution, installed-app coexistence or gameplay performance. Readiness times include polling and catalog hashing. CPU zero means no observed counter increment at the sampler's resolution, and summed working sets can double-count shared pages. No tests or screenshot corpus were run.

The archives decompress to the original sampler JSON bytes. The executable SHA-256 is `277e63ea02b4aec673d73992cc69302c669efb646d13611e7b41ddca30130774`. Lockfile hashes are `f7b57e1af9c37c27840c899239dfae6045455d98d05a7fa8ad40d84c4cf16164` for npm and `095b58131367fee91861186d12a8205cecb3b5a754990ae6ded1ae56a74c7c97` for Cargo.

- [Launch 1 sampler JSON, gzip](tauri-hidden-01.json.gz). Uncompressed SHA-256 `7f74ea06fb6992fe96e6afa0d1b32e2f0f518ac1543ede58a4bfb06932bfac97`.
- [Launch 2 sampler JSON, gzip](tauri-hidden-02.json.gz). Uncompressed SHA-256 `6dc1b9660f5be7e1ebb9210a5f05ba9a6ab0a1fc889e1af376fb5301de4b2556`.
