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
// DEFENCE IN DEPTH (base64): a command frequently base64-encodes a secret
// before printing it (e.g. `printf %s "$TOKEN" | base64`, building an HTTP
// `Authorization: Basic` header, embedding it in JSON/YAML). Verbatim masking
// alone would leak that. So in addition to the literal value we also derive and
// mask the secret's base64 encodings — standard and URL-safe, each with and
// without `=` padding (some tools strip it). These derived strings are added to
// the same mask set and replaced with the same `REDACTED` token.
//
// LIMITATION (documented honestly): this still only masks values that appear
// *verbatim* OR base64-encoded in the output. It cannot mask a value the
// command transforms some other way before printing (a hash, encryption, a
// partial echo, a different encoding). `sensitive` is therefore best-effort
// defence in depth, not a guarantee — the authoritative protection is not
// passing secrets to commands that echo them.

use std::collections::BTreeMap;

use base64::Engine;

use crate::storage::commands::VariableSpec;

/// Minimum length a *derived* (base64) mask string must have before we add it to
/// the redaction set. A very short encoding (e.g. the 4-char base64 of a 1–2
/// byte secret) could collide with unrelated output and corrupt it, so we skip
/// it — the verbatim pass still covers the literal value. Four base64 chars
/// encode three secret bytes, which is the smallest input worth defending here.
const MIN_BASE64_MASK_LEN: usize = 8;

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
                // Defence in depth: also mask the base64 encodings of the
                // secret (see module docs), so a command that encodes it before
                // printing still gets redacted. Derived from the raw value so
                // the byte content is preserved exactly.
                for encoded in base64_variants(&value) {
                    secrets.push(encoded);
                }
                secrets.push(value);
            }
        }
    }
    // Redact longer secrets first: if one secret is a substring of another,
    // replacing the longer one first avoids leaving a partial tail behind. This
    // also matters for the derived base64 strings, which are typically longer
    // than (and may contain) the verbatim value.
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    secrets.dedup();
    secrets
}

/// Derive the base64 encodings of `value` worth masking: standard and URL-safe
/// alphabets, each padded and unpadded. Returns only encodings at least
/// [`MIN_BASE64_MASK_LEN`] chars long (skips trivially short ones that could
/// corrupt unrelated output), de-duplicated (short ASCII secrets can encode the
/// same string across alphabets). The verbatim value is added by the caller.
fn base64_variants(value: &str) -> Vec<String> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};

    let bytes = value.as_bytes();
    let mut variants = Vec::with_capacity(4);
    for engine in [&STANDARD, &STANDARD_NO_PAD, &URL_SAFE, &URL_SAFE_NO_PAD] {
        let encoded = engine.encode(bytes);
        if encoded.len() >= MIN_BASE64_MASK_LEN && !variants.contains(&encoded) {
            variants.push(encoded);
        }
    }
    variants
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
        // The verbatim sensitive value is collected; the non-sensitive value is
        // not. (Base64 variants of the secret are also present — see the
        // dedicated base64 tests.)
        assert!(secrets.contains(&"s3cr3t".to_string()));
        assert!(!secrets.contains(&"alice".to_string()));
    }

    #[test]
    fn falls_back_to_sensitive_default_when_run_value_absent() {
        let vars = [spec("token", Some("default-secret"), true)];
        let secrets = collect_sensitive_values(&vars, &BTreeMap::new());
        assert!(secrets.contains(&"default-secret".to_string()));
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

    #[test]
    fn masks_base64_encoding_of_secret() {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;

        let vars = [spec("token", Some("super-secret-token"), true)];
        let secrets = collect_sensitive_values(&vars, &BTreeMap::new());

        // A command that base64-encodes the secret before printing it.
        let encoded = STANDARD.encode("super-secret-token");
        let output = format!("Authorization: Basic {encoded}");
        let red = redact_secrets(&output, &secrets);

        assert!(!red.contains(&encoded), "padded base64 must be masked");
        assert!(red.contains("***"));
    }

    #[test]
    fn masks_unpadded_base64_encoding_of_secret() {
        use base64::engine::general_purpose::STANDARD_NO_PAD;
        use base64::Engine;

        let vars = [spec("token", Some("super-secret-token"), true)];
        let secrets = collect_sensitive_values(&vars, &BTreeMap::new());

        // Some tools strip the `=` padding from the encoding.
        let encoded = STANDARD_NO_PAD.encode("super-secret-token");
        let red = redact_secrets(&format!("tok={encoded}"), &secrets);

        assert!(!red.contains(&encoded), "unpadded base64 must be masked");
        assert_eq!(red, "tok=***");
    }

    #[test]
    fn masks_url_safe_base64_encoding_of_secret() {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;

        // A value whose standard base64 contains `+`/`/` so the URL-safe
        // alphabet produces a *different* string (covers the url-safe variant).
        let secret = "secret>>>???value___payload";
        let vars = [spec("token", Some(secret), true)];
        let secrets = collect_sensitive_values(&vars, &BTreeMap::new());

        let encoded = URL_SAFE_NO_PAD.encode(secret);
        let red = redact_secrets(&format!("data {encoded} end"), &secrets);

        assert!(!red.contains(&encoded), "url-safe base64 must be masked");
        assert_eq!(red, "data *** end");
    }

    #[test]
    fn verbatim_still_masked_alongside_base64() {
        // The additive base64 masking must not regress verbatim masking: a
        // secret printed literally is still redacted.
        let vars = [spec("token", Some("super-secret-token"), true)];
        let secrets = collect_sensitive_values(&vars, &BTreeMap::new());
        let red = redact_secrets("login with super-secret-token now", &secrets);
        assert_eq!(red, "login with *** now");
    }

    #[test]
    fn short_secret_does_not_over_mask_via_base64() {
        // A 1-char secret "Z" has a 4-char base64 encoding ("Wg==") that is
        // below MIN_BASE64_MASK_LEN, so it must NOT be added to the mask set and
        // must NOT corrupt unrelated output that happens to contain that string.
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;

        let vars = [spec("token", Some("Z"), true)];
        let secrets = collect_sensitive_values(&vars, &BTreeMap::new());

        let short_b64 = STANDARD.encode("Z"); // "Wg=="
        assert!(short_b64.len() < MIN_BASE64_MASK_LEN);
        assert!(
            !secrets.contains(&short_b64),
            "trivially short base64 must not be a mask string"
        );

        // Unrelated output containing the short encoding stays intact — the
        // base64 form was never registered as a mask string.
        let red = redact_secrets(&format!("payload={short_b64} ok"), &secrets);
        assert_eq!(red, "payload=Wg== ok");
    }

    #[test]
    fn empty_secret_yields_no_base64_masks() {
        // base64_variants of "" is empty, and a blank secret is never collected,
        // so nothing is masked and output is untouched.
        assert!(base64_variants("").is_empty());
        let vars = [spec("token", Some(""), true)];
        let secrets = collect_sensitive_values(&vars, &BTreeMap::new());
        assert!(secrets.is_empty());
        assert_eq!(redact_secrets("YQ== nothing", &secrets), "YQ== nothing");
    }
}
