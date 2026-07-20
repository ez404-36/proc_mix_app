pub mod capture_filter;
pub mod env_files;
pub mod env_sources;
pub mod executor;
pub mod extractor;
pub mod flag_parser;
pub mod http_server;
pub mod js_parser;
pub mod launch;
pub mod parser;
pub mod proc_ext;
pub mod redact;
pub mod scheduler;
pub mod scope_tracker;
// Sound notifications. The id/path resolver (`sound::resolve`) compiles
// everywhere; the `rodio` playback is desktop-only (native audio backends;
// meaningless on mobile) and stubbed to a no-op on mobile so the commands and
// run-completion triggers stay platform-agnostic.
pub mod sftp;
pub mod shells;
pub mod sound;
pub mod ssh;
pub mod terminal;
pub mod utility_help;
pub mod workflow;
pub mod workflow_condition;
