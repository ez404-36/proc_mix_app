//! Assistant provider presets and endpoint boundary helpers.
//!
//! Every preset is OpenAI-compatible for chat completion. `custom` is a
//! user-entered base URL; the remaining kinds provide a well-known URL so the
//! user only enters a name and (when required) an API key.

use serde::{Deserialize, Serialize};

use super::provider::ProviderError;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssistantProviderKind {
    Custom,
    LmStudio,
    Ollama,
    Openai,
    Openrouter,
    Minimax,
    Groq,
    Deepseek,
    Mistral,
    Together,
    Cerebras,
    Perplexity,
    Xai,
    Zhipu,
    ZhipuCoding,
    ZaiResponses,
    Codex,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantProviderPreset {
    pub kind: AssistantProviderKind,
    pub label: String,
    pub default_base_url: String,
    pub requires_api_key: bool,
    pub is_local: bool,
}

impl AssistantProviderKind {
    pub fn from_stored(value: &str) -> Option<Self> {
        match value {
            "custom" => Some(Self::Custom),
            "lm-studio" => Some(Self::LmStudio),
            "ollama" => Some(Self::Ollama),
            "openai" => Some(Self::Openai),
            "openrouter" => Some(Self::Openrouter),
            "minimax" => Some(Self::Minimax),
            "groq" => Some(Self::Groq),
            "deepseek" => Some(Self::Deepseek),
            "mistral" => Some(Self::Mistral),
            "together" => Some(Self::Together),
            "cerebras" => Some(Self::Cerebras),
            "perplexity" => Some(Self::Perplexity),
            "xai" => Some(Self::Xai),
            "zhipu" => Some(Self::Zhipu),
            "zhipu-coding" => Some(Self::ZhipuCoding),
            "zai-responses" => Some(Self::ZaiResponses),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    pub fn preset(self) -> AssistantProviderPreset {
        let (label, url, key, local) = match self {
            Self::Custom => ("OpenAI-compatible", None, false, false),
            Self::LmStudio => ("LM Studio", Some("http://127.0.0.1:1234/v1"), false, true),
            Self::Ollama => ("Ollama", Some("http://127.0.0.1:11434/v1"), false, true),
            Self::Openai => ("OpenAI", Some("https://api.openai.com/v1"), true, false),
            Self::Openrouter => (
                "OpenRouter",
                Some("https://openrouter.ai/api/v1"),
                true,
                false,
            ),
            Self::Minimax => ("MiniMax", Some("https://api.minimax.io/v1"), true, false),
            Self::Groq => ("Groq", Some("https://api.groq.com/openai/v1"), true, false),
            Self::Deepseek => ("DeepSeek", Some("https://api.deepseek.com/v1"), true, false),
            Self::Mistral => ("Mistral", Some("https://api.mistral.ai/v1"), true, false),
            Self::Together => (
                "Together AI",
                Some("https://api.together.xyz/v1"),
                true,
                false,
            ),
            Self::Cerebras => ("Cerebras", Some("https://api.cerebras.ai/v1"), true, false),
            Self::Perplexity => ("Perplexity", Some("https://api.perplexity.ai"), true, false),
            Self::Xai => ("xAI (Grok)", Some("https://api.x.ai/v1"), true, false),
            Self::Zhipu => (
                "Zhipu AI (GLM)",
                Some("https://open.bigmodel.cn/api/paas/v4"),
                true,
                false,
            ),
            Self::ZhipuCoding => (
                "Zhipu AI (GLM Coding Plan)",
                Some("https://api.z.ai/api/coding/paas/v4"),
                true,
                false,
            ),
            Self::ZaiResponses => (
                "Z.AI Responses (BB/Codex)",
                Some("https://api.z.ai/api/v1"),
                true,
                false,
            ),
            Self::Codex => ("Codex (local config)", None, false, false),
        };
        AssistantProviderPreset {
            kind: self,
            label: label.to_string(),
            default_base_url: url.unwrap_or_default().to_string(),
            requires_api_key: key,
            is_local: local,
        }
    }
}

pub fn provider_presets() -> Vec<AssistantProviderPreset> {
    [
        AssistantProviderKind::Custom,
        AssistantProviderKind::LmStudio,
        AssistantProviderKind::Ollama,
        AssistantProviderKind::Openai,
        AssistantProviderKind::Openrouter,
        AssistantProviderKind::Minimax,
        AssistantProviderKind::Groq,
        AssistantProviderKind::Deepseek,
        AssistantProviderKind::Mistral,
        AssistantProviderKind::Together,
        AssistantProviderKind::Cerebras,
        AssistantProviderKind::Perplexity,
        AssistantProviderKind::Xai,
        AssistantProviderKind::Zhipu,
        AssistantProviderKind::ZhipuCoding,
        AssistantProviderKind::ZaiResponses,
        AssistantProviderKind::Codex,
    ]
    .into_iter()
    .map(AssistantProviderKind::preset)
    .collect()
}

/// Persisted provider cards need a readable label even when the add-provider
/// form is submitted with an intentionally empty name field.
#[must_use]
pub fn default_provider_name(kind: AssistantProviderKind) -> String {
    kind.preset().label
}

/// Whether a stored instance cannot call this provider without a key.
#[must_use]
pub fn requires_api_key(kind: AssistantProviderKind) -> bool {
    kind.preset().requires_api_key
}

fn is_local_base_url(base_url: &str) -> bool {
    let authority = base_url
        .split("://")
        .nth(1)
        .unwrap_or_default()
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    let without_user = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = if let Some(rest) = without_user.strip_prefix('[') {
        rest.split_once(']').map_or(rest, |(host, _)| host)
    } else {
        without_user
            .split_once(':')
            .map_or(without_user, |(host, _)| host)
    };
    host == "localhost" || host == "::1" || host.starts_with("127.")
}

/// Validate URL shape without deciding whether it may be used.
pub fn validate_base_url(base_url: &str) -> Result<(), ProviderError> {
    let trimmed = base_url.trim();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err(ProviderError::InvalidBaseUrl);
    }
    if trimmed.len() > 2_048 {
        return Err(ProviderError::InvalidBaseUrl);
    }
    Ok(())
}

/// Gate actual generation, not merely saving a provider instance. Adding or
/// editing an endpoint does not transmit ProcMix context.
pub fn ensure_remote_allowed(base_url: &str, allow_remote: bool) -> Result<(), ProviderError> {
    validate_base_url(base_url)?;
    if !is_local_base_url(base_url) && !allow_remote {
        return Err(ProviderError::RemoteNotAllowed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_presets_declare_api_key_requirements() {
        for preset in provider_presets() {
            if preset.is_local
                || preset.kind == AssistantProviderKind::Custom
                || preset.kind == AssistantProviderKind::Codex
            {
                assert!(
                    !preset.requires_api_key,
                    "{} must not require an API key",
                    preset.label
                );
            } else {
                assert!(
                    preset.requires_api_key,
                    "{} must require an API key",
                    preset.label
                );
                assert!(!preset.default_base_url.is_empty());
            }
        }

        let openai = AssistantProviderKind::Openai.preset();
        assert!(openai.requires_api_key);
        let zhipu = AssistantProviderKind::Zhipu.preset();
        assert!(zhipu.requires_api_key);
        let zhipu_coding = AssistantProviderKind::ZhipuCoding.preset();
        assert!(zhipu_coding.requires_api_key);
        assert_eq!(
            zhipu_coding.default_base_url,
            "https://api.z.ai/api/coding/paas/v4"
        );
        let minimax = AssistantProviderKind::Minimax.preset();
        assert!(minimax.requires_api_key);
    }

    #[test]
    fn validate_base_url_accepts_remote_provider_endpoints() {
        assert!(validate_base_url("https://open.bigmodel.cn/api/paas/v4").is_ok());
        assert!(validate_base_url("https://api.openai.com/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.1:11434/v1").is_ok());
        assert!(validate_base_url("ftp://example.invalid").is_err());
    }

    #[test]
    fn empty_provider_names_use_the_preset_label() {
        assert_eq!(
            default_provider_name(AssistantProviderKind::Codex),
            "Codex (local config)"
        );
    }
}
