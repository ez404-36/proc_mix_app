//! Linux shell-integration backend: **file-manager scripts** for Nautilus
//! (GNOME Files) and Nemo (Cinnamon).
//!
//! ## Why scripts, not `.desktop` actions
//!
//! Nautilus and Nemo do NOT surface freedesktop `[Desktop Action]` entries in
//! their right-click menu (that mechanism only reliably appears in Dolphin's
//! service menus). What they DO support is "scripts": executable files dropped
//! into a per-user `scripts/` directory that automatically appear under the
//! right-click **Scripts** submenu, for both files and folders. So this backend
//! writes one small executable launcher per favorite.
//!
//! We place them in a `ProcMix/` SUBDIRECTORY of each manager's scripts dir, so
//! they group under **Scripts → ProcMix → <favorite>** and we can clean up our
//! own entries (remove the whole subdirectory) without touching the user's
//! other scripts.
//!
//! ## How a script passes the path
//!
//! When the manager runs a script it exports the selection in environment
//! variables (`NAUTILUS_SCRIPT_SELECTED_FILE_PATHS` / `NEMO_…`, newline-
//! separated; `*_CURRENT_URI` for the folder background). Each launcher reads
//! the first selected path (or decodes the current-folder URI when nothing is
//! selected) and execs `procmix --run-favorite <kind>:<id> --path "<path>"`.
//! The path is the only untrusted value; it is passed as a separate argv
//! element (never concatenated into a shell command) and re-validated on
//! receipt by `core::launch::is_safe_selected_path`.
//!
//! Enabling writes the launchers; disabling removes the `ProcMix/` subdir.
//! `is_registered` is the subdir's existence. After writing/removing we
//! best-effort restart the managers (`nautilus -q` / `nemo -q`) so the change
//! shows up without the user restarting them by hand.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;

use super::{current_exe_path, ShellFavorite, ShellIntegration};

/// Subdirectory (under each manager's `scripts/` dir) that holds ProcMix's
/// launchers. Grouping under one folder gives a "ProcMix" submenu and makes
/// cleanup a single `remove_dir_all`.
const SUBDIR: &str = "ProcMix";

/// The supported script-based file managers and their per-user scripts roots /
/// quit commands. Each entry is `(scripts_dir_components, quit_binary)`.
struct ScriptManager {
    /// Path under `$XDG_DATA_HOME` (or `~/.local/share`) to the scripts dir.
    rel_dir: &'static [&'static str],
    /// Binary used to restart the manager so new scripts are picked up.
    quit_bin: &'static str,
    /// The env var the manager exports with the newline-separated selected
    /// paths — embedded into the generated launcher.
    selected_paths_var: &'static str,
    /// The env var with the current folder URI (used for the background case).
    current_uri_var: &'static str,
}

const MANAGERS: &[ScriptManager] = &[
    ScriptManager {
        rel_dir: &["nautilus", "scripts"],
        quit_bin: "nautilus",
        selected_paths_var: "NAUTILUS_SCRIPT_SELECTED_FILE_PATHS",
        current_uri_var: "NAUTILUS_SCRIPT_CURRENT_URI",
    },
    ScriptManager {
        rel_dir: &["nemo", "scripts"],
        quit_bin: "nemo",
        selected_paths_var: "NEMO_SCRIPT_SELECTED_FILE_PATHS",
        current_uri_var: "NEMO_SCRIPT_CURRENT_URI",
    },
];

pub struct LinuxShellIntegration;

impl LinuxShellIntegration {
    pub fn new() -> Self {
        Self
    }
}

impl ShellIntegration for LinuxShellIntegration {
    fn is_registered(&self) -> Result<bool, String> {
        // Registered if our ProcMix subdir exists in ANY supported manager.
        for mgr in MANAGERS {
            if procmix_dir(mgr)?.is_dir() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn register(&self, favorites: &[ShellFavorite]) -> Result<(), String> {
        let exe = current_exe_path()?;
        let exe_str = exe
            .to_str()
            .ok_or_else(|| "ProcMix executable path is not valid UTF-8".to_string())?;

        // Remove the legacy `.desktop`-actions launcher from older builds (it
        // was invisible in Nautilus/Nemo anyway). Harmless if absent.
        remove_legacy_desktop_file();

        for mgr in MANAGERS {
            // Only install for a manager whose base scripts dir is plausible —
            // i.e. the manager is present. We detect by the `quit_bin` being on
            // PATH; if it isn't, skip (writing into a non-existent manager's
            // dir would be harmless but pointless).
            if !binary_on_path(mgr.quit_bin) {
                continue;
            }
            write_manager_scripts(mgr, exe_str, favorites)?;
            restart_manager(mgr);
        }
        Ok(())
    }

    fn unregister(&self) -> Result<(), String> {
        // Also clear the legacy `.desktop` launcher if a previous build left it.
        remove_legacy_desktop_file();
        for mgr in MANAGERS {
            let dir = procmix_dir(mgr)?;
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => restart_manager(mgr),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("remove {}: {e}", dir.display())),
            }
        }
        Ok(())
    }
}

/// Delete the legacy `~/.local/share/applications/procmix-shell-integration.desktop`
/// written by pre-scripts builds. Best-effort: missing / unreadable is ignored.
fn remove_legacy_desktop_file() {
    let Ok(base) = data_home() else {
        return;
    };
    let legacy = base
        .join("applications")
        .join("procmix-shell-integration.desktop");
    let _ = std::fs::remove_file(legacy);
}

/// `$XDG_DATA_HOME` (or `~/.local/share`).
fn data_home() -> Result<PathBuf, String> {
    match std::env::var_os("XDG_DATA_HOME") {
        Some(v) if !v.is_empty() => Ok(PathBuf::from(v)),
        _ => {
            let home =
                dirs::home_dir().ok_or_else(|| "cannot resolve home directory".to_string())?;
            Ok(home.join(".local").join("share"))
        }
    }
}

/// The `ProcMix/` launcher directory inside a manager's scripts dir.
fn procmix_dir(mgr: &ScriptManager) -> Result<PathBuf, String> {
    let mut dir = data_home()?;
    for comp in mgr.rel_dir {
        dir.push(comp);
    }
    dir.push(SUBDIR);
    Ok(dir)
}

/// (Re)write all launcher scripts for one manager: clear our old subdir, then
/// write one executable launcher per favorite with a collision-safe name.
fn write_manager_scripts(
    mgr: &ScriptManager,
    exe: &str,
    favorites: &[ShellFavorite],
) -> Result<(), String> {
    let dir = procmix_dir(mgr)?;

    // Replace any previous launchers so a removed favorite never lingers.
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("clear {}: {e}", dir.display())),
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    for fav in favorites {
        let file_name = unique_script_name(&sanitize_file_name(&fav.name), &mut used);
        let path = dir.join(&file_name);
        let contents = render_launcher(mgr, exe, fav);
        std::fs::write(&path, contents).map_err(|e| format!("write {}: {e}", path.display()))?;
        // Scripts must be executable to appear in the Scripts menu.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Render one launcher script. POSIX `sh`: take the first selected path, or —
/// when nothing is selected (the folder background) — decode the current-folder
/// `file://` URI, then exec ProcMix with the favorite + path.
///
/// Security: `<kind>:<id>` come from the trusted DB and are written as a single
/// shell-quoted argv element; the PATH is taken from an env var into a shell
/// variable and passed as a separate `"$target"` argument — never interpolated
/// into a command string — and is re-validated by the receiving process.
fn render_launcher(mgr: &ScriptManager, exe: &str, fav: &ShellFavorite) -> String {
    let entity = format!("{}:{}", fav.kind, fav.id);
    format!(
        "#!/bin/sh\n\
         # procmix-shell-integration — auto-generated launcher. Do not edit.\n\
         # Runs the ProcMix favorite \"{name_comment}\" on the selected file/folder.\n\
         set -eu\n\
         \n\
         # First selected path (newline-separated list); empty on a background\n\
         # right-click, where we fall back to the current folder.\n\
         target=$(printf '%s' \"${{{sel}:-}}\" | head -n 1)\n\
         if [ -z \"$target\" ]; then\n\
         \turi=\"${{{cur}:-}}\"\n\
         \tcase \"$uri\" in\n\
         \t\tfile://*)\n\
         \t\t\t# Strip scheme and percent-decode via printf.\n\
         \t\t\ttarget=$(printf '%b' \"$(printf '%s' \"${{uri#file://}}\" | sed 's/+/ /g; s/%/\\\\x/g')\")\n\
         \t\t\t;;\n\
         \tesac\n\
         fi\n\
         \n\
         exec {exe_q} --run-favorite {entity_q} --path \"$target\"\n",
        name_comment = comment_sanitize(&fav.name),
        sel = mgr.selected_paths_var,
        cur = mgr.current_uri_var,
        exe_q = sh_quote(exe),
        entity_q = sh_quote(&entity),
    )
}

/// Single-quote a value for POSIX `sh`, escaping embedded single quotes. Keeps
/// a path / entity ref with spaces or shell metacharacters as one literal word.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Sanitize a favorite name into a safe script FILE NAME: strip path separators
/// and control characters, collapse whitespace, trim, and bound the length.
/// Never empty (falls back to "favorite"). The name is what the Scripts submenu
/// shows, so we keep it human-readable.
fn sanitize_file_name(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        match ch {
            // Path separators / NUL would escape the directory or break the FS.
            '/' | '\\' | '\0' => out.push('_'),
            // Other control chars: drop.
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    let trimmed = out.trim();
    let bounded: String = trimmed.chars().take(80).collect();
    let final_name = bounded.trim().to_string();
    if final_name.is_empty() {
        "favorite".to_string()
    } else {
        final_name
    }
}

/// Make a script name unique within the set, appending " (2)", " (3)", … on a
/// collision (case-sensitive, matching how the FS / menu distinguish them).
fn unique_script_name(base: &str, used: &mut std::collections::HashSet<String>) -> String {
    if used.insert(base.to_string()) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base} ({n})");
        if used.insert(candidate.clone()) {
            return candidate;
        }
        n += 1;
    }
}

/// Strip newlines/control chars from a name before embedding it in a shell
/// COMMENT line, so a crafted name cannot break out of the comment.
fn comment_sanitize(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect::<String>()
}

/// Whether a binary is resolvable on `$PATH` (used to detect installed managers).
fn binary_on_path(bin: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| {
        let candidate = dir.join(bin);
        candidate.is_file()
            && std::fs::metadata(&candidate)
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
    })
}

/// Best-effort restart of a file manager so freshly written scripts appear in
/// its menu. `nautilus -q` / `nemo -q` ask the running instance to quit; it
/// respawns on next use. A missing binary / non-zero exit is non-fatal.
fn restart_manager(mgr: &ScriptManager) {
    match Command::new(mgr.quit_bin).arg("-q").output() {
        Ok(out) if !out.status.success() => {
            tracing::debug!("{} -q exited with {:?}", mgr.quit_bin, out.status.code());
        }
        Ok(_) => {}
        Err(e) => tracing::debug!("{} -q unavailable: {e}", mgr.quit_bin),
    }
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

    fn nautilus() -> &'static ScriptManager {
        &MANAGERS[0]
    }

    #[test]
    fn launcher_has_shebang_exec_and_argv() {
        let f = fav("command", "c1", "Build");
        let out = render_launcher(nautilus(), "/usr/bin/procmix", &f);
        assert!(out.starts_with("#!/bin/sh\n"));
        // Exec line with quoted exe + entity ref + path argument.
        assert!(
            out.contains("exec '/usr/bin/procmix' --run-favorite 'command:c1' --path \"$target\"")
        );
        // Reads the Nautilus selection var and the current-folder URI fallback.
        assert!(out.contains("NAUTILUS_SCRIPT_SELECTED_FILE_PATHS"));
        assert!(out.contains("NAUTILUS_SCRIPT_CURRENT_URI"));
    }

    #[test]
    fn launcher_uses_manager_specific_vars() {
        let f = fav("workflow", "w1", "Deploy");
        let nemo = &MANAGERS[1];
        let out = render_launcher(nemo, "/usr/bin/procmix", &f);
        assert!(out.contains("NEMO_SCRIPT_SELECTED_FILE_PATHS"));
        assert!(out.contains("NEMO_SCRIPT_CURRENT_URI"));
        assert!(out.contains("'workflow:w1'"));
    }

    #[test]
    fn sh_quote_escapes_single_quotes() {
        assert_eq!(sh_quote("/usr/bin/procmix"), "'/usr/bin/procmix'");
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn entity_with_metachars_stays_one_quoted_word() {
        // An id can never legitimately contain these, but quoting must be safe
        // regardless — a `$()`/backtick must not be interpretable.
        let f = fav("command", "a$(rm -rf ~)`x`", "X");
        let out = render_launcher(nautilus(), "/usr/bin/procmix", &f);
        assert!(out.contains("'command:a$(rm -rf ~)`x`'"));
        // No unquoted injection of the metacharacters on the exec line.
        assert!(!out.contains("--run-favorite command:a$("));
    }

    #[test]
    fn sanitize_file_name_strips_separators_and_controls() {
        assert_eq!(sanitize_file_name("a/b\\c"), "a_b_c");
        assert_eq!(sanitize_file_name("clean name"), "clean name");
        assert_eq!(sanitize_file_name("with\nnewline"), "withnewline");
        assert_eq!(sanitize_file_name(""), "favorite");
        assert_eq!(sanitize_file_name("   "), "favorite");
        // NUL becomes underscore (it is matched explicitly before is_control).
        assert_eq!(sanitize_file_name("a\0b"), "a_b");
    }

    #[test]
    fn unique_script_name_suffixes_collisions() {
        let mut used = std::collections::HashSet::new();
        assert_eq!(unique_script_name("echo", &mut used), "echo");
        assert_eq!(unique_script_name("echo", &mut used), "echo (2)");
        assert_eq!(unique_script_name("echo", &mut used), "echo (3)");
        assert_eq!(unique_script_name("other", &mut used), "other");
    }

    #[test]
    fn comment_sanitize_removes_control_chars() {
        assert_eq!(comment_sanitize("a\nb\tc"), "abc");
        assert_eq!(comment_sanitize("normal"), "normal");
    }
}
