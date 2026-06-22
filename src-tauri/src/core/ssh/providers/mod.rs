//! Concrete [`super::provider::SshSourceProvider`] implementations, one per
//! SSH connection source.
//!
//! Implemented in this iteration: [`openssh`] (the user's `~/.ssh/config`).
//! The remaining sources are registered **stubs** — they compile and are
//! wired into [`super::registry`], but report `is_available() == false` and
//! return no hosts until their readers are implemented. Their `SshSource`
//! variants already exist so adding the real logic later needs no contract,
//! registry-shape, IPC, or UI changes.
//!
//! The stub structs are platform-agnostic (no OS-specific code yet), so the
//! modules are not `#[cfg]`-gated here; the *registration* in `registry` is
//! what decides which providers run on a given OS.

mod openssh_parse;

pub mod openssh;
pub mod openssh_edit;
pub mod putty;
pub mod system;
pub mod wsl;

pub use openssh::OpenSshProvider;
pub use putty::PuttyProvider;
pub use system::SystemConfigProvider;
pub use wsl::WslProvider;
