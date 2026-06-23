//! Read-only inventory of SSH connections discovered across multiple
//! sources.
//!
//! This module is built around an extensible *provider* model: each place
//! SSH connections can live is an [`provider::SshSourceProvider`]. A registry
//! (added in a follow-up step) aggregates the providers available on the
//! current OS into one deduplicated host list for the UI.
//!
//! ## Status
//!
//! Reading is fully implemented (OpenSSH provider + registry + reachability
//! check). Writing (create/edit/delete) is implemented for `OpenSshConfig`
//! via the separate [`provider::SshSourceWriter`] trait and the surgical
//! editor in `providers::openssh_edit`; the stub sources remain read-only.

pub mod check;
pub mod history;
pub mod provider;
pub mod providers;
pub mod registry;
pub mod types;
pub mod watch;

pub use check::{check_alias, is_safe_alias};
pub use provider::{SshSourceProvider, SshSourceWriter};
pub use providers::OpenSshProvider;
pub use registry::{load_inventory, writer_for, SshInventory, SshSourceStatus};
pub use types::{
    SshCheckResult, SshHost, SshHostDraft, SshHostId, SshSource, SshSourceError, SshWriteError,
};
pub use watch::{current_snapshot_map, spawn_ssh_config_watch, SshWatchState, SSH_CONFIG_CHANGED};
