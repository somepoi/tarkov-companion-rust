# Privacy

Tarkov Companion Rust has no app accounts, advertising, analytics or telemetry. Normal workflows do not upload progress, game logs, screenshots or physical inventory. Remote requests and external links disclose information described below.

## Local data

Quests, level/faction, checklist counts, keys, hideout, drawings, story progress, raid history, settings and recognition corrections stay locally. Stash Manager additionally stores SQLite inventory, container snapshots, saved drafts and retained screenshot evidence. Pictures may contain account names or other personal information.

The native application uses the data directory associated with `io.github.somepoi.tarkov-companion-rust`; Stash Manager displays the active directory. Development uses the separate `.dev` identifier. The Electron reference has its own `Tarkov Companion Rust` user-data directory. The original application's directory is not migrated in place. Interface stores and cached catalogs also use the host's browser storage.

Settings progress exports/daily JSON backups cover interface progress stores. Stash Manager's full recovery bundles also include the database, retained evidence, settings and corrections. Unsaved edits are not saved-state backups. Exported copies remain in the chosen destination until you manage them. Profiles and backups are not encrypted by the app: treat them as personal files, especially on shared or cloud-synced disks.

Desktop integrations read ordinary game text logs and screenshot filenames for local quest/raid/position tracking. Imported screenshots and screenshots captured with the hotkey or search bar camera are processed locally. Search bar capture starts when you click the camera. Position-screenshot recycling is separate from stash evidence and remains opt-in. No game-memory access, injection, traffic interception or gameplay input is implemented.

## Remote requests

Remote services see ordinary request information, including IP address, requested URL and HTTP client headers. Their retention policies are outside this application's control.

| Service | Purpose |
| --- | --- |
| `json.tarkov.dev`, `assets.tarkov.dev` | Game catalogs, prices, maps and pictures |
| `escapefromtarkov.fandom.com`, `static.wikia.nocookie.net` | Wiki guides, story content and pictures |
| GitHub and its release/CDN infrastructure | Fork content packs when requested; links opened in your browser |

Normal in-app updates are disabled. Explicit experimental update-preview builds can contact their configured HTTPS channel and download a selected signed installer. This is separate from ordinary local builds; personal progress/screenshots are not attached. Fresh installations are not guaranteed to contain all offline game/map resources.

## Actions you choose

- Opening a public tarkov.dev player profile puts the account ID from local game logs in the browser URL, disclosing it to that destination.
- External links open in your browser, which has its own cookies, history and privacy settings.
- Sharing backups, screenshots or optional local benchmark reports discloses their contents. Inspect files before attaching them to an issue.

Questions about this fork belong in its [issue tracker](https://github.com/somepoi/tarkov-companion-rust/issues). Avoid posting personal files publicly.
