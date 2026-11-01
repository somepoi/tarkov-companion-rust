//! Native IO admission. A preparation lease excludes admitted writes/captures.
static GATE: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

pub fn enter() -> Result<tokio::sync::RwLockReadGuard<'static, ()>, &'static str> {
    GATE.try_read()
        .map_err(|_| "Update preparation is in progress; retry after it finishes")
}
#[cfg(feature = "staged-updates")]
pub fn exclusive() -> Result<tokio::sync::RwLockWriteGuard<'static, ()>, &'static str> {
    GATE.try_write()
        .map_err(|_| "Native operations are running; let them finish and retry update preparation")
}
