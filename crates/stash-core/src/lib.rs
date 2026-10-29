//! Inventory facts and explainable allocation, independent of a desktop runtime.
//!
//! The repository owns one SQLite connection. Run it on a dedicated blocking
//! worker; do not share browser writes or execute these methods on a UI thread.
//! Recommendations never perform a sale or mutate inventory.

pub mod composition;
pub mod model;
pub mod planner;
pub mod planning;
mod reconciliation;
mod repository;

pub use model::*;
pub use planner::{Plan, PlannerInput, plan};
pub use repository::{Repository, StorageError};
