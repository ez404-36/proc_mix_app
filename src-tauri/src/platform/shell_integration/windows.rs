//! Windows shell-integration backend: a cascading "ProcMix" submenu in the
//! file-manager right-click menu, written under `HKCU\Software\Classes`
//! (per-user — NO administrator rights required).
//!
//! ## Contexts
//!
//! Three registry roots cover the three right-click cases the user asked for:
//!   - `*\shell\ProcMix`                 — right-click a FILE (`%1` = file path)
//!   - `Directory\shell\ProcMix`         — right-click a FOLDER (`%1` = folder)
//!   - `Directory\Background\shell\ProcMix` — right-click empty space inside a
//!     folder, i.e. the CURRENT folder (`%V` = the open directory)
//!
//! ## Cascade shape
//!
//! Each root key uses the documented static-verb cascade: the `ProcMix` key
//! carries `MUIVerb = "ProcMix"` and an empty `SubCommands` value, which tells
//! Explorer to read child verbs from `ProcMix\shell\<favN>`. Each child verb's
//! default value is the favorite's display name and its `command` subkey's
//! default value is the launch command line:
//! `"<exe>" --run-favorite <kind>:<id> --path "<placeholder>"`.
//!
//! Enabling writes the three roots; disabling deletes them. `is_registered` is
//! the presence of the file-context root.

use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

use super::{current_exe_path, launch_args, ShellFavorite, ShellIntegration};

/// The three context root key paths under `HKCU\Software\Classes`. Each gets an
/// identical `ProcMix` cascade; only the path placeholder differs (handled in
/// [`command_line`]).
const FILE_ROOT: &str = r"Software\Classes\*\shell\ProcMix";
const DIR_ROOT: &str = r"Software\Classes\Directory\shell\ProcMix";
const BACKGROUND_ROOT: &str = r"Software\Classes\Directory\Background\shell\ProcMix";

/// Path placeholder Explorer substitutes per context. A clicked file / folder
/// arrives as `%1`; the background (current folder) as `%V`.
const PLACEHOLDER_SELECTION: &str = "%1";
const PLACEHOLDER_BACKGROUND: &str = "%V";

pub struct WindowsShellIntegration;

impl WindowsShellIntegration {
    pub fn new() -> Self {
        Self
    }
}

impl ShellIntegration for WindowsShellIntegration {
    fn is_registered(&self) -> Result<bool, String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        match hkcu.open_subkey(FILE_ROOT) {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(format!("probe {FILE_ROOT}: {e}")),
        }
    }

    fn register(&self, favorites: &[ShellFavorite]) -> Result<(), String> {
        let exe = current_exe_path()?;
        let exe_str = exe
            .to_str()
            .ok_or_else(|| "ProcMix executable path is not valid UTF-8".to_string())?;

        // Replace any previous registration so a removed favorite never lingers.
        self.unregister()?;

        write_cascade(FILE_ROOT, exe_str, favorites, PLACEHOLDER_SELECTION)?;
        write_cascade(DIR_ROOT, exe_str, favorites, PLACEHOLDER_SELECTION)?;
        write_cascade(BACKGROUND_ROOT, exe_str, favorites, PLACEHOLDER_BACKGROUND)?;
        Ok(())
    }

    fn unregister(&self) -> Result<(), String> {
        for root in [FILE_ROOT, DIR_ROOT, BACKGROUND_ROOT] {
            delete_tree(root)?;
        }
        Ok(())
    }
}

/// Write one context's `ProcMix` cascade: the parent verb (`MUIVerb` +
/// `SubCommands`) and one child verb per favorite.
fn write_cascade(
    root: &str,
    exe: &str,
    favorites: &[ShellFavorite],
    placeholder: &str,
) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    let (parent, _) = hkcu
        .create_subkey(root)
        .map_err(|e| format!("create {root}: {e}"))?;
    parent
        .set_value("MUIVerb", &"ProcMix")
        .map_err(|e| format!("set MUIVerb on {root}: {e}"))?;
    // Empty `SubCommands` switches Explorer to the static `shell\…` child-verb
    // model (vs a COM handler). Required for the cascade to appear.
    parent
        .set_value("SubCommands", &"")
        .map_err(|e| format!("set SubCommands on {root}: {e}"))?;

    for (idx, fav) in favorites.iter().enumerate() {
        let verb_path = format!(r"{root}\shell\fav{idx}");
        let (verb, _) = hkcu
            .create_subkey(&verb_path)
            .map_err(|e| format!("create {verb_path}: {e}"))?;
        // The verb's default value is the visible label.
        verb.set_value("", &fav.name)
            .map_err(|e| format!("set label on {verb_path}: {e}"))?;

        let cmd_path = format!(r"{verb_path}\command");
        let (cmd, _) = hkcu
            .create_subkey(&cmd_path)
            .map_err(|e| format!("create {cmd_path}: {e}"))?;
        cmd.set_value("", &command_line(exe, fav, placeholder))
            .map_err(|e| format!("set command on {cmd_path}: {e}"))?;
    }

    Ok(())
}

/// Delete a registry subtree if present. Missing is a successful no-op so
/// `unregister` is idempotent.
fn delete_tree(path: &str) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.delete_subkey_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {path}: {e}")),
    }
}

/// Build the Explorer `command` value: the quoted exe followed by the launch
/// argv, with the path placeholder quoted so a path containing spaces arrives
/// as one argument. The `<kind>:<id>` token is trusted (from the DB); the
/// placeholder is an Explorer token, expanded by Explorer — ProcMix validates
/// the resulting path on receipt (Stage 3) and never builds a shell string.
fn command_line(exe: &str, fav: &ShellFavorite, placeholder: &str) -> String {
    let mut parts = vec![quote_arg(exe)];
    for arg in launch_args(fav, placeholder) {
        if arg == placeholder {
            // Quote the placeholder so Explorer substitutes a spaced path as a
            // single argument: "%1" / "%V".
            parts.push(format!("\"{placeholder}\""));
        } else {
            parts.push(quote_arg(&arg));
        }
    }
    parts.join(" ")
}

/// Quote a single command-line argument for the registry `command` value.
/// Wraps in double quotes and escapes embedded quotes per the Windows
/// command-line convention, keeping a path / id with spaces as one argument.
fn quote_arg(arg: &str) -> String {
    format!("\"{}\"", arg.replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fav(kind: &str, id: &str, name: &str) -> ShellFavorite {
        ShellFavorite {
            kind: kind.into(),
            id: id.into(),
            name: name.into(),
        }
    }

    #[test]
    fn command_line_quotes_exe_args_and_placeholder() {
        let f = fav("command", "c1", "Build");
        let line = command_line(
            r"C:\Program Files\ProcMix\procmix.exe",
            &f,
            PLACEHOLDER_SELECTION,
        );
        assert_eq!(
            line,
            r#""C:\Program Files\ProcMix\procmix.exe" "--run-favorite" "command:c1" "--path" "%1""#
        );
    }

    #[test]
    fn command_line_uses_background_placeholder() {
        let f = fav("workflow", "w1", "Deploy");
        let line = command_line(r"C:\app\procmix.exe", &f, PLACEHOLDER_BACKGROUND);
        assert!(line.ends_with(r#""--path" "%V""#));
        assert!(line.contains(r#""workflow:w1""#));
    }

    #[test]
    fn quote_arg_escapes_embedded_quotes() {
        assert_eq!(quote_arg(r#"a"b"#), r#""a\"b""#);
        assert_eq!(quote_arg("plain"), r#""plain""#);
    }
}
