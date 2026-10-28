# Native filename positions and opt-in screenshot recycling

The native service preserves the `PlayerPosition` seam used by the existing map UI. It reads screenshot names and filesystem attributes only; it never opens image pixels, reads game memory or sends game input. No game folder, screenshot, watcher or Shell cleanup was exercised during implementation. No tests were created or run.

## Public integration seam

`src-tauri/src/position.rs` exports:

- `Positions::default()` creates inert state, with no filesystem access or thread.
- `configure(&AppHandle, &Value, PathBuf) -> Result<Value, String>` applies native settings and the native-resolved Documents screenshot root. It must not receive arbitrary renderer paths. The root must end in `Escape from Tarkov/Screenshots`. Recognized settings are the existing `trackPosition`, `clearPositionShots`, `paused` and `logsPath`.
- `latest() -> Result<Option<PlayerPosition>, String>` reads bounded filename/metadata state and returns the newest position within 30 minutes, including a recent emitted position whose screenshot was recycled. The host should run it on its blocking command worker.
- `note_game_event(&Value) -> Result<(), String>` accepts parsed events through a main-window-only host command. Forward context events (`sessionMode`, `profile`, `gameVersion`) and live raid events as well as their original `id`, `at`, `mode`, `historical` fields. The service ignores unrelated kinds and historical events. Unknown/stale live contexts revoke cleanup eligibility rather than inheriting an earlier raid.
- `status() -> Result<Value, String>` returns tracking/cleanup/watch state, missing-root state and the most recent error.
- `parse_screenshot_name(&str, u64) -> Option<PlayerPosition>` preserves decimal coordinate parsing and quaternion yaw around Unity's vertical Y axis. Yaw remains signed, as in Electron.

The service emits native `position-new` payloads (logical desktop channel `position:new`) (`x`, `y`, `z`, `yaw`, `at`, `file`) and a native `position-error` string event (logical desktop channel `position:error`). The adapter can retain its existing position subscription and add visible error reporting. Host shutdown/drop signals cancellation; it does not block the UI by joining a potentially stalled filesystem/Shell call.

## Host integration

The native host now owns the service and exposes main-only `position:connect`, `position:event` and `position:reset` commands, plus latest-position reads for the app/searchbar. The renderer never supplies the screenshot root. Benchmark connect bypasses Documents resolution and starts no worker. Configuration/connect/live-event authorization serialize against the settings mutex. Ordinary opt-in cleanup now persists; general update cleanup remains gated separately; native searchbar integration is documented in the later searchbar plan. Startup recovery issues force screenshot cleanup off, and full-backup restore writes cleanup=false only into the verified recovery copy before activation, leaving the source backup unchanged.

Failed settings application/save attempts restore the previous tracking and integration policies. If restoring tracking cannot start another worker, the host synchronously applies track=false/cleanup=false, which cancels the worker without the two-worker admission gate, and reports rollback failure. No failed enable request silently leaves cleanup active.

The shared log bridge forwards relevant live raid/context events before renderer consumers. Transport reconfiguration, folder replacement, parser failure and departure from watching revoke the previous cleanup lease. Historical events never authorize cleanup. Position-context boundaries apply independently of cleanup eligibility: all relevant live context/raid events clear cached positions and establish a timestamp floor; late latest reads recheck generation, context time and raid epoch before publishing.

The map listener subscribes before reading recent position, cancels late results after cleanup/boundary/newer events and clears on mode/profile/raid/log-root or disabled tracking changes. Its timestamp floor lives in the nonpersistent position store, so refreshing mode-specific map data cannot restore a previous mode's position. Errors are dismissible in the incumbent app banner layout. Existing position/map APIs remain shared with Electron.

Add a direct `windows = "0.62"` dependency under the Windows target with `Win32_Foundation`, `Win32_Storage_FileSystem`, `Win32_System_Com` and `Win32_UI_Shell` features. The implementation uses the already-locked 0.62.2 API and existing `notify`/`serde`/`tauri` dependencies. Threading features are not required by this module's current code.

The root host owns settings restoration policy: enabling the ordinary `clearPositionShots` setting is a distinct action from trusting an imported/restored profile's destructive preferences. Keep restore-time cleanup disabled unless that policy is explicitly reviewed. Remove the current unconditional native migration error for ordinary opt-in only once the service is wired.

## Watching, lifetime and bounds

The service uses nonrecursive watches on the known Documents directory, its `Escape from Tarkov` child and `Screenshots` where each exists. It reacts only to those directory lifecycle events and immediate screenshot children. This allows the game/screenshot folder to appear or be recreated without an idle polling loop and without recursively watching unrelated document trees. A deleted/unavailable Documents anchor or watcher permission error is explicit and may require reconnecting the setting.

One coalesced notification slot triggers bounded metadata rescans. At most 10000 directory entries, 10000 seen file identities, 256 event IDs and 32 pending cleanup candidates are retained. Cleanup settling uses a deadline only while work exists, not an idle timer. Three asynchronous watcher faults within a minute stop that worker with an explicit reconnect error; same-configuration `configure` can restart an exited worker. A directory exceeding the entry bound is an error; it is not silently treated as complete. A full cleanup queue leaves additional screenshots in place.

Configuration and log-root/pause changes replace a generation and revoke raid eligibility. At most two current/stopping service workers may coexist; another change is rejected while old OS work is still stopping. Initial/recovered directory contents can seed the recent-position result, but are not retroactively selected for cleanup. New position events retain actual file modification times rather than pretending that old copied files were captured now.

## Cleanup policy

`clearPositionShots` remains off by default. Tracking works read-only while logs are paused, but cleanup does not. A cleanup lease requires a fresh, known-mode, nonhistorical `mapLoading`, `raidMatched`, `raidStarting` or `raidStarted` event. Supported known modes are `pve`, `regular` and `seasonal`. Source events older/further in the future than two minutes, context changes, raid end/abort, pause, reconfiguration and shutdown revoke the lease. A raid lease expires after 75 minutes using monotonic time.

Only a newly observed, position-bearing `.png`, `.jpg`, `.jpeg` or `.bmp` in that exact known screenshot directory is considered. Its modification time must be after both the configuration and raid lease began. Files are checked every 1.5 seconds for at most 10 rounds and need two consecutive unchanged, nonzero observations. Windows attribute handles establish volume/file ID, creation time, modification time, size and link count. Reparse points/directories and multi-link files are not cleanup candidates.

Immediately before the Shell operation, the service rechecks canonical root plus directory creation time, immediate-parent/name scope, file identity, settled attributes, generation and raid lease. These checks are repeated after Shell initialization immediately before `PerformOperations`, so disabling or changing context during Shell setup cancels declared work.

Windows `IFileOperation` uses `FOFX_RECYCLEONDELETE`, undo recording, silent/error-free UI flags and early failure. There is no permanent-delete API and no permanent-delete fallback. Failure reports direct the user to inspect the original folder and Recycle Bin. This follows Microsoft's [operation flag contract](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-setoperationflags) and [declare-then-perform contract](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-deleteitem).

## Remaining runtime boundaries

Integration verification: TypeScript, lint, both frontend production builds, Rust formatting and strict Clippy with custom-protocol passed. Source UI detector returned no findings. Read-only review found settings rollback could leave cleanup enabled and that raid/mode boundaries could be lost by a cache read/effect remount; failed rollback now stops tracking and reports failure, while persistent-in-memory context floors and native read guards retain those boundaries. Follow-up review reported no remaining P1/P2 findings. No tests, screenshot recognition, real folder watching, game log reading or recycling were exercised.

Source implementation is not hands-on Windows parity evidence. Actual notification delivery/recreation, mixed filesystem/OneDrive/UNC behavior, locked writes, Shell cancellation/undo/recycling, mode boundaries and application shutdown remain unverified. Shell path operations and the preceding identity checks are not one atomic filesystem transaction; work already accepted by `PerformOperations` cannot be withdrawn by a later setting change. No stronger adversarial replacement/power-loss guarantee is claimed. Native stash screenshots live in the separate profile evidence archive, which this service never receives as a root or scans.
