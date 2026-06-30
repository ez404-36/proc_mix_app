//! Minimal semantic-version handling for plugin catalog versions.
//!
//! Catalog version folders are named `v<MAJOR>.<MINOR>.<PATCH>` (e.g.
//! `v1.2.0`). We only need to: parse such a folder name, order versions, and
//! pick the latest. That is far less than a full semver implementation (no
//! pre-release / build metadata), so a tiny internal type avoids pulling in the
//! `semver` crate. If richer needs appear later, swap this for the crate behind
//! the same `Version` API.

use std::cmp::Ordering;

/// A parsed `MAJOR.MINOR.PATCH` version. Comparison is field-wise, so
/// `1.10.0 > 1.2.0` (numeric, not lexicographic).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl Version {
    /// Parse a bare `MAJOR.MINOR.PATCH` string (no leading `v`). Returns `None`
    /// for any other shape so callers can reject malformed catalog folders.
    pub fn parse(s: &str) -> Option<Self> {
        let mut parts = s.split('.');
        let major = parts.next()?.parse::<u32>().ok()?;
        let minor = parts.next()?.parse::<u32>().ok()?;
        let patch = parts.next()?.parse::<u32>().ok()?;
        // Reject extra components (e.g. "1.2.3.4") — exactly three required.
        if parts.next().is_some() {
            return None;
        }
        Some(Version {
            major,
            minor,
            patch,
        })
    }

    /// Parse a catalog folder name `v<MAJOR>.<MINOR>.<PATCH>` (leading `v`
    /// required). Returns `None` for anything else.
    pub fn parse_folder(folder: &str) -> Option<Self> {
        let rest = folder.strip_prefix('v')?;
        Version::parse(rest)
    }

    /// Render back to the canonical folder name (`v1.2.0`).
    pub fn to_folder(self) -> String {
        format!("v{}.{}.{}", self.major, self.minor, self.patch)
    }

    /// Render the bare version (`1.2.0`) — matches a manifest's `version` field.
    pub fn to_bare(self) -> String {
        format!("{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.major
            .cmp(&other.major)
            .then(self.minor.cmp(&other.minor))
            .then(self.patch.cmp(&other.patch))
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Pick the highest version from a slice, if any. Used to resolve "latest".
pub fn latest(versions: &[Version]) -> Option<Version> {
    versions.iter().copied().max()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_and_folder() {
        assert_eq!(
            Version::parse("1.2.0"),
            Some(Version {
                major: 1,
                minor: 2,
                patch: 0
            })
        );
        assert_eq!(
            Version::parse_folder("v0.10.3"),
            Some(Version {
                major: 0,
                minor: 10,
                patch: 3
            })
        );
    }

    #[test]
    fn rejects_malformed() {
        assert_eq!(Version::parse(""), None);
        assert_eq!(Version::parse("1.2"), None);
        assert_eq!(Version::parse("1.2.3.4"), None);
        assert_eq!(Version::parse("1.x.0"), None);
        // parse_folder requires the leading v.
        assert_eq!(Version::parse_folder("1.2.0"), None);
        assert_eq!(Version::parse_folder("ver1.2.0"), None);
    }

    #[test]
    fn orders_numerically_not_lexically() {
        let a = Version::parse_folder("v0.2.0").unwrap();
        let b = Version::parse_folder("v0.10.0").unwrap();
        // 0.10.0 must be greater than 0.2.0 (numeric), not lexicographic.
        assert!(b > a);
    }

    #[test]
    fn orders_across_all_fields() {
        let v = |s: &str| Version::parse(s).unwrap();
        assert!(v("2.0.0") > v("1.9.9"));
        assert!(v("1.2.0") > v("1.1.9"));
        assert!(v("1.1.2") > v("1.1.1"));
        assert_eq!(v("1.1.1"), v("1.1.1"));
    }

    #[test]
    fn latest_picks_highest() {
        let vs = [
            Version::parse("1.0.0").unwrap(),
            Version::parse("1.2.0").unwrap(),
            Version::parse("1.1.0").unwrap(),
        ];
        assert_eq!(
            latest(&vs),
            Some(Version {
                major: 1,
                minor: 2,
                patch: 0
            })
        );
        assert_eq!(latest(&[]), None);
    }

    #[test]
    fn round_trips_folder_and_bare() {
        let v = Version::parse_folder("v1.2.0").unwrap();
        assert_eq!(v.to_folder(), "v1.2.0");
        assert_eq!(v.to_bare(), "1.2.0");
    }
}
