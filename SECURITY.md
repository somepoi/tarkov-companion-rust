# Security

## Reporting a problem

Report vulnerabilities to the maintainer of [this fork](https://github.com/somepoi/tarkov-companion-rust), rather than the original application. Use GitHub's **Security → Report a vulnerability** if private reporting is available. Otherwise arrange private contact before sharing exploit details or personal files. This fork does not promise a response deadline or automatic delivery of fixes.

## Native application boundaries

Tauri hosts the React interface in Windows WebView2, without a permanent Node sidecar. The retained Electron reference has separate runtime protections.

| Boundary | Current implementation |
| --- | --- |
| Native commands | Fixed commands validate calling window, operation, arguments and scoped paths. Main-only operations are refused from the searchbar. Frontend capabilities do not grant general filesystem, shell or updater access. See `src-tauri/src/desktop.rs` and `src-tauri/capabilities/main.json`. |
| Navigation | Both native windows restrict top-level navigation to the embedded app origin; the configured development origin is accepted only in development mode. External links use the validated system-browser route. See `src-tauri/src/navigation.rs`. |
| Content policy | `src-tauri/tauri.conf.json` restricts scripts, workers, images and connections, with explicit blob/WASM allowances for local workers/OCR. Renderer CSP does not govern native HTTP clients; those have separate checks. |
| Resources | Native resource routes validate paths. Packs have expected checksums and scoped extraction. Checksums detect mismatches; they do not establish redistribution rights or protect against a compromised build source. |
| Remote content | SVG maps and wiki HTML use existing allow-list sanitizers (`src/lib/sanitizeSvg.ts`, `src/api/storyWiki.ts`). |
| Saved inventory | SQLite migrations, revisions and commit replay checks protect saved facts. Screenshot writes are separate from database transactions. Recovery verifies retained evidence and prepares a separate profile while retaining the source. |
| Imports/backups | Progress, corrections and recovery bundles are bounded and validated. Keep independent backups; in-process rollback does not prove power-loss safety. |
| Updates/identity | Default update routes are disabled. Experimental signed updates require explicit build configuration, signature/version checks and recovery preparation before permitted installation. Fork identifiers are separate from the original. |
| Manual cleanup | Only the main window can preview/confirm cleanup. Native-owned previews expire, bind target identities/metadata and scope, and are checked again before recycle-only Shell operations. Pack installation is excluded during cleanup. Backups, stash evidence, prepared updates and active resources are outside the target set. |

Integrations use ordinary local game logs, screenshot filenames and user-triggered Windows capture. No game-memory access, injection, traffic interception, gameplay input or automatic selling is implemented. The optional searchbar is a separate always-on-top window. These choices do not establish game-policy or anti-cheat approval.

## Distribution and limits

- Current local native installers are unsigned. No certificate, SignPath arrangement, published channel or release guarantees from the original are inherited.
- The manually dispatched staging workflow builds artifacts without publishing releases. Successful compilation does not prove signed distribution or update/recovery safety.
- Installation/uninstallation, interrupted update/recovery, Windows 10/11, mixed DPI and full feature parity retain open gates in the [feature inventory](docs/performance/feature-parity.md) and [execution ledger](docs/plans/2026-10-27-implementation-progress.md).
- Profiles/backups are not app-encrypted. Another process with the same user's filesystem permissions can access or alter them.
- Electron's reference build retains preload isolation, request validation and packaging fuses. Those Electron mechanisms are not claims about WebView2. The web reference uses the browser's security model.

See [PRIVACY.md](PRIVACY.md) for storage, remote requests and explicitly shared information.
