//! Object-scoped AI assistant contracts.
//!
//! This module intentionally contains only safe wire contracts and validation.
//! There is no execution capability here: a model response can propose a
//! constrained patch or request a user action, nothing more.

pub mod contract;
pub mod prompt;
pub mod provider;
pub mod providers;
pub mod state;
pub mod types;
