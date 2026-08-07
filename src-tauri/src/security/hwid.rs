// Composite hardware-ID fingerprint used to bind a license lease to a
// device.
//
// Raw machine identifiers (machine-id, IOPlatformUUID, MachineGuid, MAC
// address) never leave the device — only the SHA-256 digest of them plus a
// build-time salt is sent to the license server.
//
// Composes a primary OS identifier with the primary-NIC MAC. Each source
// degrades to an empty component rather than panicking when unavailable.
// `compose_hwid_hash` is a pure function of its inputs, unit-tested
// directly.

use sha2::{Digest, Sha256};

/// Build-time salt mixed into the composite fingerprint before hashing.
///
/// This is NOT a secret (it ships in the binary) — its only job is to
/// domain-separate ProcMix's HWID hash from any other product that might
/// hash the same machine identifiers, and to make the hash meaningless
/// outside this app. The authoritative anti-abuse guarantees come from the
/// server (HWID uniqueness for trials, seat counts), not from this salt.
const HWID_SALT: &str = "procmix.hwid.v1";

/// Compute the salted SHA-256 composite-HWID hash from already-collected
/// raw identifier components.
///
/// Pure and deterministic: identical `components` always yield the same
/// lowercase-hex digest. Components are joined with a separator that cannot
/// appear inside an identifier so two different splits can never collide
/// (e.g. `["a", "bc"]` vs `["ab", "c"]`).
fn compose_hwid_hash(components: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(HWID_SALT.as_bytes());
    for component in components {
        // The unit separator (0x1F) is a control char that never appears in
        // a machine-id / UUID / MAC, so it is an unambiguous delimiter.
        hasher.update([0x1f]);
        hasher.update(component.as_bytes());
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        // Writing to a String never fails; the Result is consumed to satisfy
        // clippy without an unwrap.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Collect the composite HWID hash for the current device.
///
/// Never panics and never errors: every collector degrades to an empty
/// string when its source is unavailable, so the function always returns a
/// deterministic hash. This is the only value that crosses the wire to the
/// license server.
pub fn current_hwid_hash() -> String {
    let primary = primary_machine_id();
    let mac = primary_mac();
    compose_hwid_hash(&[primary.as_str(), mac.as_str()])
}

/// Primary OS-level machine identifier, normalized to a trimmed,
/// lowercase string (empty when unavailable).
fn primary_machine_id() -> String {
    let raw = read_primary_machine_id_raw();
    normalize(&raw)
}

/// Primary network-interface MAC address, normalized (empty when
/// unavailable). A secondary signal: combined with the machine id it
/// hardens the fingerprint without being load-bearing on its own.
fn primary_mac() -> String {
    let raw = read_primary_mac_raw();
    normalize(&raw)
}

/// Trim surrounding whitespace and lowercase, so trivial formatting
/// differences (a trailing newline from a file read, upper- vs lower-case
/// hex) never change the resulting hash.
fn normalize(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

// ----------------------------------------------------------------------
// Linux
// ----------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn read_primary_machine_id_raw() -> String {
    // `/etc/machine-id` is the canonical systemd machine id; the dbus path
    // is the historical fallback. Either is stable across reboots.
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(contents) = std::fs::read_to_string(path) {
            let trimmed = contents.trim();
            if !trimmed.is_empty() {
                return trimmed.to_owned();
            }
        }
    }
    String::new()
}

#[cfg(target_os = "linux")]
fn read_primary_mac_raw() -> String {
    // Read the first non-loopback interface's permanent MAC from sysfs. We
    // sort interface names for determinism (directory iteration order is not
    // guaranteed) and skip `lo` and all-zero addresses.
    let entries = match std::fs::read_dir("/sys/class/net") {
        Ok(entries) => entries,
        Err(_) => return String::new(),
    };

    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| name != "lo")
        .collect();
    names.sort();

    for name in names {
        let path = format!("/sys/class/net/{name}/address");
        if let Ok(contents) = std::fs::read_to_string(&path) {
            let mac = contents.trim();
            if !mac.is_empty() && mac != "00:00:00:00:00:00" {
                return mac.to_owned();
            }
        }
    }
    String::new()
}

// ----------------------------------------------------------------------
// macOS
// ----------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn read_primary_machine_id_raw() -> String {
    // `ioreg -rd1 -c IOPlatformExpertDevice` prints the IOPlatformUUID. We
    // spawn it with a fixed argument array (NEVER via a shell) and parse the
    // `"IOPlatformUUID" = "<uuid>"` line. A spawn failure degrades to "".
    let output = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output();
    let Ok(output) = output else {
        return String::new();
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(idx) = line.find("IOPlatformUUID") {
            // Take the quoted value after the '=' on this line.
            if let Some(eq) = line[idx..].find('=') {
                let after = &line[idx + eq + 1..];
                if let Some(start) = after.find('"') {
                    if let Some(end) = after[start + 1..].find('"') {
                        return after[start + 1..start + 1 + end].to_owned();
                    }
                }
            }
        }
    }
    String::new()
}

#[cfg(target_os = "macos")]
fn read_primary_mac_raw() -> String {
    // `networksetup` / `ifconfig` parsing is brittle; the IOPlatformUUID
    // above is already a strong stable id on macOS, so the MAC is optional.
    // We read en0's MAC via `ifconfig en0` (fixed args, no shell). Absence
    // degrades to "".
    let output = std::process::Command::new("/sbin/ifconfig")
        .arg("en0")
        .output();
    let Ok(output) = output else {
        return String::new();
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("ether ") {
            return rest.trim().to_owned();
        }
    }
    String::new()
}

// ----------------------------------------------------------------------
// Windows
// ----------------------------------------------------------------------

/// Resolve a System32 tool to its ABSOLUTE path so a same-named binary
/// planted earlier on `PATH` cannot shadow the genuine system utility.
/// Uses `%SystemRoot%` when set (the OS always sets it) and falls back to
/// the conventional `C:\Windows` install root otherwise.
#[cfg(target_os = "windows")]
fn system32_tool(exe: &str) -> std::path::PathBuf {
    let system_root =
        std::env::var_os("SystemRoot").unwrap_or_else(|| std::ffi::OsString::from(r"C:\Windows"));
    std::path::Path::new(&system_root)
        .join("System32")
        .join(exe)
}

#[cfg(target_os = "windows")]
fn read_primary_machine_id_raw() -> String {
    // MachineGuid lives at HKLM\SOFTWARE\Microsoft\Cryptography. We query it
    // via `reg.exe query` with a fixed argument array (NEVER a shell string)
    // to avoid adding a registry crate. The output line looks like:
    //   MachineGuid    REG_SZ    <guid>
    //
    // Spawned by ABSOLUTE path (`%SystemRoot%\System32\reg.exe`) rather than
    // the bare name so a `reg.exe` planted earlier on `PATH` cannot shadow the
    // system tool.
    use crate::core::proc_ext::NoConsoleWindow;
    let output = std::process::Command::new(system32_tool("reg.exe"))
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        // Don't flash a console window for the HWID probe (runs at startup
        // during license verification). See `core::proc_ext`.
        .no_console_window()
        .output();
    let Ok(output) = output else {
        return String::new();
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(idx) = line.find("REG_SZ") {
            let value = line[idx + "REG_SZ".len()..].trim();
            if !value.is_empty() {
                return value.to_owned();
            }
        }
    }
    String::new()
}

#[cfg(target_os = "windows")]
fn read_primary_mac_raw() -> String {
    // `getmac` prints the physical adapters' MAC addresses. We take the
    // first token on the first data line that looks like a MAC. Fixed args,
    // no shell. Absence degrades to "". Spawned by ABSOLUTE path
    // (`%SystemRoot%\System32\getmac.exe`) so a planted `getmac.exe` earlier on
    // `PATH` cannot shadow the system tool.
    use crate::core::proc_ext::NoConsoleWindow;
    let output = std::process::Command::new(system32_tool("getmac.exe"))
        .arg("/fo")
        .arg("table")
        // Don't flash a console window for the HWID probe (runs at startup
        // during license verification). See `core::proc_ext`.
        .no_console_window()
        .output();
    let Ok(output) = output else {
        return String::new();
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let token = line.split_whitespace().next().unwrap_or("");
        // A MAC in `getmac` output uses hyphen groups, e.g. `AA-BB-CC-...`.
        if token.len() == 17 && token.matches('-').count() == 5 {
            return token.to_owned();
        }
    }
    String::new()
}

// ----------------------------------------------------------------------
// Fallback for any other target (keeps the crate portable).
// ----------------------------------------------------------------------

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn read_primary_machine_id_raw() -> String {
    String::new()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn read_primary_mac_raw() -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_is_deterministic() {
        let a = compose_hwid_hash(&["machine-123", "aa:bb:cc:dd:ee:ff"]);
        let b = compose_hwid_hash(&["machine-123", "aa:bb:cc:dd:ee:ff"]);
        assert_eq!(a, b, "same inputs must produce the same hash");
    }

    #[test]
    fn compose_is_sha256_hex() {
        let h = compose_hwid_hash(&["x"]);
        assert_eq!(h.len(), 64, "SHA-256 hex digest is 64 chars");
        assert!(
            h.chars().all(|c| c.is_ascii_hexdigit()),
            "digest must be lowercase hex"
        );
    }

    #[test]
    fn different_components_differ() {
        let a = compose_hwid_hash(&["machine-1", "mac-1"]);
        let b = compose_hwid_hash(&["machine-2", "mac-1"]);
        assert_ne!(a, b);
    }

    #[test]
    fn component_boundaries_are_unambiguous() {
        // The separator guarantees ["a","bc"] and ["ab","c"] cannot collide,
        // which a naive concatenation would allow.
        let a = compose_hwid_hash(&["a", "bc"]);
        let b = compose_hwid_hash(&["ab", "c"]);
        assert_ne!(a, b);
    }

    #[test]
    fn missing_sources_degrade_to_stable_hash() {
        // All-empty components (every source unavailable) must still yield a
        // deterministic, valid hash rather than panicking.
        let a = compose_hwid_hash(&["", ""]);
        let b = compose_hwid_hash(&["", ""]);
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn normalize_trims_and_lowercases() {
        assert_eq!(normalize("  AB:CD\n"), "ab:cd");
    }

    #[test]
    fn current_hwid_hash_is_stable_and_well_formed() {
        // On the test host the real collectors run; whatever they return,
        // the result must be a stable 64-char hex string across calls.
        let a = current_hwid_hash();
        let b = current_hwid_hash();
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
