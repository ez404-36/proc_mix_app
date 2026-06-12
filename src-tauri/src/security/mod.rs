// OS-keychain-backed credential storage.
//
// The only secret this app stores today is the user's sudo password,
// used by the "Run as administrator" feature on Unix. The Windows
// elevation path goes through UAC and never touches this module, but
// the crate still compiles there (with the `windows-native` keyring
// backend) so the module's public surface is portable.

pub mod admin_password;
pub mod schedule_secrets;
