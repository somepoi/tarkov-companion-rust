# Weapon-build and item-state constraint coverage

Closes the "build/other item-state constraints" gap recorded for Phase 6 in the
execution ledger. A `buildWeapon` (Gunsmith) objective previously reserved only
its base weapon and explicit part IDs. Its required part **categories** and stat
**limits** were dropped before normalization even ran, so the planner could
claim full coverage while ignoring two real build restrictions.

## Defect

- `src/inventory/requirements.ts` projected `build` as `{weaponId, partIds}`,
  discarding `categoryIds` and `limits` before they reached Rust.
- `crates/stash-core/src/requirements.rs` therefore had no visibility into
  either field, and produced only the generic
  "weapon condition and fitted parts require manual review" gap.

Neither field can be turned into a physical reservation:

- A category ID names a part **class**, not an item. Expanding it into concrete
  items would invent demand the source never stated.
- A stat limit (`>=` / `<=` / `=`) is a property of a finished build. No
  per-stack fact in the model records weapon ergonomics, recoil and similar
  stats, so no stock can be proven to satisfy it.

Both are coverage facts, not allocatable demand.

## Implementation

- The frontend projection now forwards `categoryIds` and `limits` so Rust sees
  the same objective the reference builder sees.
- Native normalization emits one bounded gap per restriction class:
  unnamed required part categories, and unverifiable weapon stat limits. Each
  gap contains only a count, never item IDs it cannot resolve.
- A missing `build` object produces a "refresh the quest catalog" review gap
  rather than a hard rejection. Older offline catalogs stay readable and the
  rest of the plan is preserved; the plan still cannot claim saleable surplus
  because a coverage gap is present.
- `src/inventory/requirements.ts` keeps its existing role as the retained
  reference builder and mirrors the same two gaps, so the two implementations
  do not silently diverge.
- Explicit part IDs are still reserved individually with quantity 1 and no FIR
  restriction, unchanged from before.

## Boundaries

- No new requirement kind, database schema, persisted field or IPC shape
  changed. No catalog adapter version was bumped: an older cached quest catalog
  without a `build` object remains readable and is reported for review.
- Category and limit gaps block `SELL` via the existing
  `coverage_gaps`/`sale_decisions_complete` path; no new gating logic was added.
- Weapon condition, fitted-build identity, quest acceptance by the game and
  actual trade eligibility remain unverified and out of scope.

## Verification

`cargo check --workspace`, `cargo clippy --workspace --all-targets -- -D
warnings`, `cargo clippy --locked --workspace --all-targets -- -D warnings`,
`cargo check --locked --workspace --features staged-updates`,
`cargo fmt --all -- --check`, `npx tsc -b`, `npm run lint`,
`npm run build:tauri-ui` and `cargo build --locked -p tarkov-companion-rust
--features custom-protocol` all exited 0. No tests were created or run, per
instruction. No application launch, screenshot, live request or user-profile
operation was performed; runtime planning parity and the wider eligibility gates
remain open.
