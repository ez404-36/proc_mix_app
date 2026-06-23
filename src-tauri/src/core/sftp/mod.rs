//! SFTP file transfer for the dual-pane file manager.
//!
//! Built on the same security model as `core::ssh` and the SSH remote-execution
//! transport: the system `sftp` binary is spawned with a fixed argv — never
//! through a shell — and authenticates via the OS `ssh` client (keys/agent) or
//! the bundled `procmix-askpass` helper for password hosts (Unix-only). No
//! `russh`/`ssh2` crate is involved.
//!
//! ## Layering
//!
//! - [`types`] — IPC DTOs, error sentinels, and remote-path validation.
//! - [`batch`] — pure builders for the `sftp -b -` batch script and the fixed
//!   argv.
//! - [`client`] — spawns `sftp`, wires the askpass env, and parses listings.

pub mod batch;
pub mod client;
pub mod types;

pub use batch::{build_sftp_argv, SftpAuth, SftpOp};
pub use client::{download, list_dir, mkdir, remove, rename, upload};
pub use types::{
    is_safe_remote_path, LocalEntry, LocalListing, SftpEntry, SftpEntryKind, SftpError,
    SftpListing, ERR_INVALID_REMOTE_PATH, ERR_INVALID_SFTP_TARGET,
};

/// The destination-alias safety check, shared with the reachability probe and
/// remote execution. Re-exported so SFTP callers validate the alias with the
/// exact same allow-list before it reaches the `sftp` argv.
pub use crate::core::ssh::is_safe_alias;
