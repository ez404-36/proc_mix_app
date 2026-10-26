//! OS-keychain storage for assistant provider API keys.
//!
//! Each provider instance has a separate keychain account. Values cross IPC
//! only on save, never return in settings, and are read in-process by the
//! provider client.

use keyring::Entry;
use thiserror::Error;

const SERVICE: &str = "app.procmix.desktop";
const ACCOUNT_PREFIX: &str = "assistant-api-key:";

#[derive(Debug, Error)]
pub enum AssistantApiKeyError {
    /// Keyring errors never include the secret itself.
    #[error("keychain backend error: {0}")]
    Backend(String),
}

fn account(provider_id: &str) -> Result<String, AssistantApiKeyError> {
    let id = provider_id.trim();
    if id.is_empty() || id.len() > 128 || id.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AssistantApiKeyError::Backend(
            "invalid provider id".to_string(),
        ));
    }
    Ok(format!("{ACCOUNT_PREFIX}{id}"))
}

fn entry(provider_id: &str) -> Result<Entry, AssistantApiKeyError> {
    Entry::new(SERVICE, &account(provider_id)?)
        .map_err(|error| AssistantApiKeyError::Backend(error.to_string()))
}

pub fn get_for_provider(provider_id: &str) -> Result<Option<String>, AssistantApiKeyError> {
    match entry(provider_id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(AssistantApiKeyError::Backend(error.to_string())),
    }
}

pub fn set_for_provider(provider_id: &str, value: &str) -> Result<(), AssistantApiKeyError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AssistantApiKeyError::Backend(
            "API key cannot be empty".to_string(),
        ));
    }
    entry(provider_id)?
        .set_password(value)
        .map_err(|error| AssistantApiKeyError::Backend(error.to_string()))
}

pub fn clear_for_provider(provider_id: &str) -> Result<(), AssistantApiKeyError> {
    match entry(provider_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(AssistantApiKeyError::Backend(error.to_string())),
    }
}

pub fn has_for_provider(provider_id: &str) -> Result<bool, AssistantApiKeyError> {
    Ok(get_for_provider(provider_id)?.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_rejects_empty_key_before_keychain_access() {
        let error = set_for_provider("provider-1", "   ").unwrap_err();
        assert!(
            matches!(error, AssistantApiKeyError::Backend(message) if message.contains("empty"))
        );
    }

    #[test]
    fn provider_ids_are_sanity_checked() {
        assert!(account("provider-1").is_ok());
        assert!(account("").is_err());
        assert!(account("bad id").is_err());
        assert!(account("very-long-id".repeat(20).as_str()).is_err());
    }
}
