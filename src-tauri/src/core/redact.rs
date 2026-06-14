// Secret redaction shared by the executor's `Debug` impl (H2) and its
// stdout/stderr + history redaction (M1).
//
// Two concerns live here:
//   - `REDACTED` — the single placeholder string used everywhere a secret is
//     hidden, so logs/events/history are visually consistent and a test can
//     assert on one constant.
//   - `redact_secrets` — replace every verbatim occurrence of a set of secret
//     values in a piece of text with `REDACTED`.
//
// LIMITATION (documented honestly): this masks values that appear *verbatim*
// in the output. It cannot mask a value the command transforms before printing
// (base64, a hash, partial echoes). `sensitive` is therefore best-effort
// defence in depth, not a guarantee — the authoritative protection is not
// passing secrets to commands that echo them.

use std::collections::BTreeMap;

use crate::storage::commands::VariableSpec;

/// Placeholder shown in place of any redacted secret. A single ASCII token so
/// tests can assert on it and a future message-wrapping pass cannot mutate it.
pub const REDACTED: &str = "***";

/// Collect the set of secret values to redact from a run: the resolved value of
/// every variable whose spec is marked `sensitive`.
///
/// Empty / whitespace-only values are skipped — redacting `""` would replace
/// every empty span in the output (i.e. corrupt it), and a blank secret carries
/// nothing to protect. The caller passes the already-resolved per-run values
/// (`variable_values` merged with spec defaults is not needed here: a sensitive
/// default that the user never overrode is still secret, so we fall back to the
/// spec's `default_value` when the run map has no entry).
pub fn collect_sensitive_values(
    variables: &[VariableSpec],
    values: &BTreeMap<String, String>,
) -> Vec<String> {
    let mut secrets = Vec::new();
    for spec in variables {
        if !spec.sensitive {
            continue;
        }
        let resolved = values
            .get(&spec.name)
            .cloned()
            .or_else(|| spec.default_value.clone());
        if let Some(value) = resolved {
            if !value.trim().is_empty() {
                secrets.push(value);
            }
        }
    }
    // Redact longer secrets first: if one secret is a substring of another,
    // replacing the longer one first avoids leaving a partial tail behind.
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    secrets
}

/// Replace every verbatim occurrence of each secret in `text` with [`REDACTED`].
/// Returns `text` unchanged (no allocation churn beyond the replace) when there
/// are no secrets.
pub fn redact_secrets(text: &str, secrets: &[String]) -> String {
    if secrets.is_empty() {
        return text.to_owned();
    }
    let mut out = text.to_owned();
    for secret in secrets {
        if secret.is_empty() {
            continue;
        }
        if out.contains(secret.as_str()) {
            out = out.replace(secret.as_str(), REDACTED);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, default: Option<&str>, sensitive: bool) -> VariableSpec {
        VariableSpec {
            name: name.to_string(),
            default_value: default.map(str::to_string),
            prompt_at_runtime: false,
            description: None,
            sensitive,
        }
    }

    #[test]
    fn collects_only_sensitive_values() {
        let vars = [spec("token", None, true), spec("name", None, false)];
        let mut values = BTreeMap::new();
        values.insert("token".to_string(), "s3cr3t".to_string());
        values.insert("name".to_string(), "alice".to_string());
        let secrets = collect_sensitive_values(&vars, &values);
        assert_eq!(secrets, vec!["s3cr3t".to_string()]);
    }

    #[test]
    fn falls_back_to_sensitive_default_when_run_value_absent() {
        let vars = [spec("token", Some("default-secret"), true)];
        let secrets = collect_sensitive_values(&vars, &BTreeMap::new());
        assert_eq!(secrets, vec!["default-secret".to_string()]);
    }

    #[test]
    fn skips_empty_sensitive_values() {
        let vars = [spec("token", Some("   "), true)];
        let secrets = collect_sensitive_values(&vars, &BTreeMap::new());
        assert!(secrets.is_empty(), "blank secret must not be collected");
    }

    #[test]
    fn redacts_verbatim_occurrences() {
        let secrets = vec!["s3cr3t".to_string()];
        let red = redact_secrets("login with s3cr3t now", &secrets);
        assert_eq!(red, "login with *** now");
        assert!(!red.contains("s3cr3t"));
    }

    #[test]
    fn redacts_all_occurrences() {
        let secrets = vec!["pw".to_string()];
        assert_eq!(redact_secrets("pw and pw", &secrets), "*** and ***");
    }

    #[test]
    fn longer_secret_redacted_first() {
        // "abcd" contains "ab"; sorting longest-first means the full token is
        // replaced before the shorter substring, so no partial tail leaks.
        let secrets = collect_sensitive_values(
            &[spec("a", Some("ab"), true), spec("b", Some("abcd"), true)],
            &BTreeMap::new(),
        );
        let red = redact_secrets("value=abcd", &secrets);
        assert_eq!(red, "value=***");
    }

    #[test]
    fn no_secrets_returns_input_unchanged() {
        assert_eq!(redact_secrets("nothing here", &[]), "nothing here");
    }
}
