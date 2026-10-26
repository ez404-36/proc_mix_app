//! Tauri commands for assistant provider instances and generation.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::core::assistant::contract;
use crate::core::assistant::prompt::system_prompt;
use crate::core::assistant::provider::{
    self, ProviderCompletion, ProviderConfig, ProviderError, ASSISTANT_PATCH_TOOL_NAME,
};
use crate::core::assistant::providers::{
    default_provider_name, ensure_remote_allowed, provider_presets, requires_api_key,
    validate_base_url, AssistantProviderKind,
};
use crate::core::assistant::state::AssistantState;
use crate::core::assistant::types::{
    AssistantAction, AssistantBackendError, AssistantGenerateRequest, AssistantGenerateResponse,
    AssistantPatch, AssistantRunSnapshot, AssistantTarget,
};
use crate::storage::assistant as storage_assistant;
use crate::storage::assistant_providers as storage_providers;
use crate::storage::assistant_providers::{AssistantProvider, AssistantProviderInput};
use crate::storage::DbPool;

const MAX_USER_MESSAGE_CHARS: usize = 8_000;
/// Large enough for a complete 64-KiB persisted run capture after JSON
/// escaping, plus an allow-listed command/workflow draft and user request.
const MAX_PROMPT_CHARS: usize = 192_000;
const MAX_RUN_SNAPSHOT_CHARS: usize = 64 * 1024;
const MODEL_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PROVIDER_NAME_CHARS: usize = 200;
const ERR_CANCELLED: &str = "ASSISTANT_CANCELLED";
const ERR_DISABLED: &str = "ASSISTANT_DISABLED";
const ERR_NOT_CONFIGURED: &str = "ASSISTANT_NOT_CONFIGURED";
const ERR_INPUT_TOO_LARGE: &str = "ASSISTANT_INPUT_TOO_LARGE";
const ERR_RUN_SNAPSHOTS_DISABLED: &str = "ASSISTANT_RUN_SNAPSHOTS_DISABLED";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssistantContextEnvelope {
    target: AssistantTarget,
    schema_version: u8,
    draft_version: u32,
    draft: serde_json::Value,
}

fn prepare_context(
    request: &AssistantGenerateRequest,
    context: serde_json::Value,
) -> Result<String, String> {
    let envelope: AssistantContextEnvelope =
        serde_json::from_value(context).map_err(|_| "ASSISTANT_INVALID_CONTEXT".to_string())?;
    if envelope.target != request.target
        || envelope.schema_version != 1
        || !envelope.draft.is_object()
        || envelope.draft_version != request.draft_version
    {
        return Err("ASSISTANT_INVALID_CONTEXT".to_string());
    }
    serde_json::to_string(&envelope).map_err(|_| "ASSISTANT_INVALID_CONTEXT".to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderAssistantOutput {
    text: String,
    #[serde(default)]
    action: Option<crate::core::assistant::types::AssistantAction>,
    #[serde(default)]
    warnings: Vec<String>,
}

/// Parse the legacy JSON fallback, or treat other output as ordinary prose.
/// Only a direct JSON object (optionally inside a Markdown fence) is treated as
/// legacy JSON, so explanations that merely contain braces remain prose.
fn parse_provider_output(model_output: &str) -> Result<ProviderAssistantOutput, String> {
    let invalid = || backend_error(AssistantBackendError::InvalidAssistantResponse);
    let trimmed = model_output.trim();
    let candidate = if trimmed.starts_with('{') {
        trimmed
    } else if trimmed.starts_with("```") {
        let without_start = trimmed.split_once('\n').map_or("", |(_, rest)| rest);
        without_start.strip_suffix("```").unwrap_or("").trim_end()
    } else {
        ""
    };

    if candidate.starts_with('{') {
        if let Ok(parsed) = serde_json::from_str::<ProviderAssistantOutput>(candidate) {
            return Ok(parsed);
        }
        let end = candidate.rfind('}').ok_or_else(invalid)?;
        return serde_json::from_str::<ProviderAssistantOutput>(&candidate[..=end])
            .map_err(|_| invalid());
    }

    Ok(ProviderAssistantOutput {
        text: trimmed.to_string(),
        action: None,
        warnings: Vec::new(),
    })
}

/// Convert one provider-native patch tool call to the existing action contract.
/// Text without a call is either ordinary prose or the legacy JSON fallback.
fn parse_provider_completion(
    completion: ProviderCompletion,
) -> Result<ProviderAssistantOutput, String> {
    let invalid = || backend_error(AssistantBackendError::InvalidAssistantResponse);
    match completion.tool_name.as_deref() {
        None => parse_provider_output(&completion.text),
        Some(ASSISTANT_PATCH_TOOL_NAME) => {
            let arguments = completion.tool_arguments.as_deref().ok_or_else(invalid)?;
            let patch: AssistantPatch = serde_json::from_str(arguments).map_err(|_| invalid())?;
            Ok(ProviderAssistantOutput {
                text: if completion.text.trim().is_empty() {
                    patch.summary.clone()
                } else {
                    completion.text
                },
                action: Some(AssistantAction::ProposePatch { patch }),
                warnings: Vec::new(),
            })
        }
        Some(_) => Err(invalid()),
    }
}

fn backend_error(error: AssistantBackendError) -> String {
    let code = match error {
        AssistantBackendError::Disabled => "DISABLED",
        AssistantBackendError::NotConfigured => "NOT_CONFIGURED",
        AssistantBackendError::AuthFailed => "AUTH_FAILED",
        AssistantBackendError::Network => "NETWORK",
        AssistantBackendError::Timeout => "TIMEOUT",
        AssistantBackendError::Provider => "PROVIDER",
        AssistantBackendError::InvalidAssistantResponse => "INVALID_RESPONSE",
        AssistantBackendError::InputTooLarge => "INPUT_TOO_LARGE",
        AssistantBackendError::RunSnapshotsDisabled => "RUN_SNAPSHOTS_DISABLED",
    };
    format!("ASSISTANT_{code}")
}

fn provider_error(error: ProviderError) -> String {
    if matches!(error, ProviderError::Cancelled) {
        return ERR_CANCELLED.to_string();
    }
    if let ProviderError::HttpStatus(status) = error {
        return format!("ASSISTANT_PROVIDER_HTTP_{status}");
    }
    backend_error(error.backend_error())
}

fn validate_provider_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_PROVIDER_NAME_CHARS {
        return Err("INVALID_ASSISTANT_PROVIDER_NAME".to_string());
    }
    Ok(())
}

async fn provider_config(
    pool: &DbPool,
    provider: &AssistantProvider,
) -> Result<ProviderConfig, String> {
    let settings = storage_assistant::load(pool).await?;
    if provider.kind == AssistantProviderKind::Codex {
        let codex = provider::load_codex_cli_settings().map_err(provider_error)?;
        ensure_remote_allowed(&codex.base_url, settings.allow_remote_endpoints)
            .map_err(provider_error)?;
        return Ok(ProviderConfig {
            base_url: codex.base_url,
            model: String::new(),
            api_key: codex.api_key,
            timeout: Duration::from_millis(u64::from(settings.timeout_ms)),
            use_responses_api: codex.use_responses_api,
        });
    }
    validate_base_url(&provider.base_url).map_err(provider_error)?;
    let api_key = crate::security::assistant_api_key::get_for_provider(&provider.id)
        .map_err(super::to_ipc_err)?;
    if requires_api_key(provider.kind) && api_key.is_none() {
        return Err(ERR_NOT_CONFIGURED.to_string());
    }

    Ok(ProviderConfig {
        base_url: provider.base_url.clone(),
        model: String::new(),
        api_key,
        timeout: Duration::from_millis(u64::from(settings.timeout_ms)),
        use_responses_api: provider.kind == AssistantProviderKind::ZaiResponses,
    })
}

#[tauri::command]
pub async fn get_assistant_settings(
    pool: State<'_, DbPool>,
) -> Result<storage_assistant::AssistantSettings, String> {
    storage_assistant::load(pool.inner()).await
}

#[tauri::command]
pub async fn set_assistant_settings(
    pool: State<'_, DbPool>,
    settings: storage_assistant::AssistantSettings,
) -> Result<(), String> {
    storage_assistant::save(pool.inner(), &settings).await
}

#[tauri::command]
pub async fn list_assistant_provider_presets(
    pool: State<'_, DbPool>,
) -> Result<Vec<crate::core::assistant::providers::AssistantProviderPreset>, String> {
    // Remote consent is global and comes from settings; loading it also proves
    // the settings row is initialized before the provider UI is usable.
    let _settings = storage_assistant::load(pool.inner()).await?;
    Ok(provider_presets())
}

#[tauri::command]
pub async fn list_assistant_providers(
    pool: State<'_, DbPool>,
) -> Result<Vec<AssistantProvider>, String> {
    let providers = storage_providers::list(pool.inner()).await?;
    providers
        .into_iter()
        .map(|mut provider| {
            provider.has_api_key =
                crate::security::assistant_api_key::has_for_provider(&provider.id)
                    .map_err(super::to_ipc_err)?;
            Ok(provider)
        })
        .collect()
}

#[tauri::command]
pub async fn save_assistant_provider(
    pool: State<'_, DbPool>,
    provider_id: Option<String>,
    provider: AssistantProviderInput,
) -> Result<AssistantProvider, String> {
    let mut provider = provider;
    if provider.name.trim().is_empty() {
        provider.name = default_provider_name(provider.kind);
    }
    validate_provider_name(&provider.name)?;
    if provider.kind != AssistantProviderKind::Codex {
        validate_base_url(&provider.base_url).map_err(provider_error)?;
    } else {
        // Codex discovers its endpoint and credentials from the local CLI
        // configuration; never persist a URL that could override it.
        provider.base_url.clear();
    }
    let id = provider_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut saved = storage_providers::upsert(pool.inner(), &id, &provider).await?;
    if provider.kind == AssistantProviderKind::Codex {
        // A provider switched to direct Codex mode must not retain an old
        // API-key credential in the OS keychain.
        crate::security::assistant_api_key::clear_for_provider(&saved.id)
            .map_err(super::to_ipc_err)?;
    }
    saved.has_api_key = crate::security::assistant_api_key::has_for_provider(&saved.id)
        .map_err(super::to_ipc_err)?;
    Ok(saved)
}

#[tauri::command]
pub async fn set_assistant_provider_enabled(
    pool: State<'_, DbPool>,
    provider_id: String,
    enabled: bool,
) -> Result<(), String> {
    storage_providers::set_enabled(pool.inner(), &provider_id, enabled).await
}

#[tauri::command]
pub async fn delete_assistant_provider(
    pool: State<'_, DbPool>,
    provider_id: String,
) -> Result<(), String> {
    storage_providers::delete(pool.inner(), &provider_id).await?;
    crate::security::assistant_api_key::clear_for_provider(&provider_id)
        .map_err(super::to_ipc_err)?;
    let mut settings = storage_assistant::load(pool.inner()).await?;
    if settings.active_provider_id.as_deref() == Some(provider_id.as_str()) {
        settings.active_provider_id = None;
        settings.active_model_id = None;
        storage_assistant::save(pool.inner(), &settings).await?;
    }
    Ok(())
}

#[tauri::command]
pub fn assistant_provider_api_key_status(provider_id: String) -> Result<bool, String> {
    crate::security::assistant_api_key::has_for_provider(&provider_id).map_err(super::to_ipc_err)
}

#[tauri::command]
pub fn set_assistant_provider_api_key(provider_id: String, api_key: String) -> Result<(), String> {
    crate::security::assistant_api_key::set_for_provider(&provider_id, &api_key)
        .map_err(super::to_ipc_err)
}

#[tauri::command]
pub fn clear_assistant_provider_api_key(provider_id: String) -> Result<(), String> {
    crate::security::assistant_api_key::clear_for_provider(&provider_id).map_err(super::to_ipc_err)
}

#[tauri::command]
pub async fn test_assistant_provider(
    pool: State<'_, DbPool>,
    provider_id: String,
) -> Result<crate::core::assistant::provider::ProviderTestResult, String> {
    let provider = storage_providers::find(pool.inner(), &provider_id)
        .await?
        .ok_or_else(|| "ASSISTANT_PROVIDER_NOT_FOUND".to_string())?;
    if provider.kind == AssistantProviderKind::Codex {
        let models = provider::list_codex_cli_models().map_err(provider_error)?;
        storage_providers::replace_models(pool.inner(), &provider_id, &models).await?;
        return Ok(crate::core::assistant::provider::ProviderTestResult {
            ok: true,
            model_count: models.len(),
            error: None,
        });
    }
    let config = provider_config(pool.inner(), &provider).await?;
    let token = tokio_util::sync::CancellationToken::new();
    let fetch =
        tokio::time::timeout(MODEL_FETCH_TIMEOUT, provider::list_models(&config, token)).await;
    match fetch {
        Ok(Ok(models)) => {
            storage_providers::replace_models(pool.inner(), &provider_id, &models).await?;
            Ok(crate::core::assistant::provider::ProviderTestResult {
                ok: true,
                model_count: models.len(),
                error: None,
            })
        }
        Ok(Err(error)) => {
            storage_providers::mark_models_unverified(pool.inner(), &provider_id).await?;
            let error = provider_error(error);
            Ok(crate::core::assistant::provider::ProviderTestResult {
                ok: false,
                model_count: 0,
                error: Some(error),
            })
        }
        Err(_) => {
            storage_providers::mark_models_unverified(pool.inner(), &provider_id).await?;
            Ok(crate::core::assistant::provider::ProviderTestResult {
                ok: false,
                model_count: 0,
                error: Some("ASSISTANT_MODEL_FETCH_TIMEOUT".to_string()),
            })
        }
    }
}

#[tauri::command]
pub async fn list_assistant_provider_models(
    pool: State<'_, DbPool>,
    provider_id: String,
    include_hidden: Option<bool>,
) -> Result<Vec<crate::storage::assistant_providers::AssistantProviderModel>, String> {
    storage_providers::list_models(pool.inner(), &provider_id, include_hidden.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn set_assistant_provider_model_hidden(
    pool: State<'_, DbPool>,
    provider_id: String,
    model_id: String,
    hidden: bool,
) -> Result<(), String> {
    storage_providers::set_model_hidden(pool.inner(), &provider_id, &model_id, hidden).await
}

#[tauri::command]
pub async fn set_assistant_active_model(
    pool: State<'_, DbPool>,
    provider_id: String,
    model_id: String,
) -> Result<(), String> {
    let provider = storage_providers::find(pool.inner(), &provider_id)
        .await?
        .ok_or_else(|| "ASSISTANT_PROVIDER_NOT_FOUND".to_string())?;
    if !provider.enabled {
        return Err("ASSISTANT_PROVIDER_DISABLED".to_string());
    }
    let models = storage_providers::list_models(pool.inner(), &provider_id, false).await?;
    if !models.iter().any(|model| model.model_id == model_id) {
        return Err("ASSISTANT_MODEL_NOT_FOUND".to_string());
    }
    let mut settings = storage_assistant::load(pool.inner()).await?;
    settings.active_provider_id = Some(provider_id);
    settings.active_model_id = Some(model_id);
    storage_assistant::save(pool.inner(), &settings).await
}

#[tauri::command]
pub async fn set_assistant_active_provider(
    pool: State<'_, DbPool>,
    provider_id: String,
) -> Result<(), String> {
    let provider = storage_providers::find(pool.inner(), &provider_id)
        .await?
        .ok_or_else(|| "ASSISTANT_PROVIDER_NOT_FOUND".to_string())?;
    if !provider.enabled {
        return Err("ASSISTANT_PROVIDER_DISABLED".to_string());
    }
    let mut settings = storage_assistant::load(pool.inner()).await?;
    settings.active_provider_id = Some(provider_id);
    settings.active_model_id = None;
    storage_assistant::save(pool.inner(), &settings).await
}

#[tauri::command]
pub async fn assistant_generate(
    app: tauri::AppHandle,
    state: State<'_, Arc<AssistantState>>,
    pool: State<'_, DbPool>,
    request: AssistantGenerateRequest,
    run_snapshot: Option<AssistantRunSnapshot>,
    context: serde_json::Value,
) -> Result<AssistantGenerateResponse, String> {
    let user_message = request.user_message.trim();
    if user_message.is_empty() {
        return Err("ASSISTANT_EMPTY_MESSAGE".to_string());
    }
    if user_message.chars().count() > MAX_USER_MESSAGE_CHARS {
        return Err(ERR_INPUT_TOO_LARGE.to_string());
    }
    let context_json = prepare_context(&request, context)?;

    let settings = storage_assistant::load(pool.inner()).await?;
    if !settings.enabled {
        return Err(ERR_DISABLED.to_string());
    }
    storage_assistant::validate(&settings).map_err(|_| ERR_NOT_CONFIGURED.to_string())?;
    let active_provider_id = settings
        .active_provider_id
        .clone()
        .ok_or_else(|| ERR_NOT_CONFIGURED.to_string())?;
    let active_model_id = settings
        .active_model_id
        .clone()
        .ok_or_else(|| ERR_NOT_CONFIGURED.to_string())?;
    let provider = storage_providers::find(pool.inner(), &active_provider_id)
        .await?
        .filter(|provider| provider.enabled)
        .ok_or_else(|| ERR_NOT_CONFIGURED.to_string())?;
    // Codex has an empty stored URL because its endpoint is discovered from
    // ~/.codex/config.toml inside provider_config, which performs the same
    // remote-endpoint consent check against the discovered URL.
    if provider.kind != AssistantProviderKind::Codex {
        ensure_remote_allowed(&provider.base_url, settings.allow_remote_endpoints)
            .map_err(provider_error)?;
    }

    let run_snapshot_json = match run_snapshot {
        Some(snapshot) => {
            if !settings.allow_run_snapshots && !request.run_snapshot_consent {
                return Err(ERR_RUN_SNAPSHOTS_DISABLED.to_string());
            }
            if snapshot.id != request.attached_run_snapshot_id.unwrap_or_default()
                || snapshot.target != request.target
                || snapshot.draft_version != request.draft_version
                || snapshot.stdout_tail.chars().count() > MAX_RUN_SNAPSHOT_CHARS
                || snapshot.stderr_tail.chars().count() > MAX_RUN_SNAPSHOT_CHARS
            {
                return Err("ASSISTANT_INVALID_RUN_SNAPSHOT".to_string());
            }
            Some(
                serde_json::to_string(&snapshot)
                    .map_err(|_| "ASSISTANT_INVALID_RUN_SNAPSHOT".to_string())?,
            )
        }
        None => None,
    };

    let snapshot_chars = run_snapshot_json
        .as_deref()
        .map_or(0, |json| json.chars().count());
    if context_json.chars().count() + user_message.chars().count() + snapshot_chars
        > MAX_PROMPT_CHARS
    {
        return Err(ERR_INPUT_TOO_LARGE.to_string());
    }

    let mut config = provider_config(pool.inner(), &provider).await?;
    config.model = active_model_id;
    let cancellation_token = state.begin_request().await;
    let user_prompt = match run_snapshot_json {
        Some(snapshot_json) => format!(
            "OBJECT_CONTEXT_JSON:\n{context_json}\n\nRUN_SNAPSHOT_JSON:\n{snapshot_json}\n\nUSER_REQUEST:\n{user_message}"
        ),
        None => format!(
            "OBJECT_CONTEXT_JSON:\n{context_json}\n\nUSER_REQUEST:\n{user_message}"
        ),
    };
    let sys = system_prompt(request.target);
    let completion = {
        let app = &app;
        let mut send_delta = move |delta: &str| {
            let _ = tauri::Emitter::emit(app, "assistant-stream-delta", delta.to_string());
        };
        let stream_result = provider::complete_streaming(
            &config,
            &sys,
            &user_prompt,
            cancellation_token.clone(),
            &mut send_delta,
        )
        .await;
        match stream_result {
            Err(ProviderError::HttpStatus(400 | 404 | 415 | 422)) => {
                provider::complete(&config, &sys, &user_prompt, cancellation_token.clone()).await
            }
            result => result,
        }
    };
    state.finish_request().await;

    let completion = completion.map_err(provider_error)?;
    let parsed = parse_provider_completion(completion)?;
    let response = AssistantGenerateResponse {
        message_id: uuid::Uuid::new_v4().to_string(),
        text: parsed.text,
        action: parsed.action,
        warnings: parsed.warnings,
    };
    contract::validate_generate_response(request.target, &response)
        .map_err(|error| format!("ASSISTANT_INVALID_RESPONSE: {error}"))?;
    Ok(response)
}

#[tauri::command]
pub async fn assistant_cancel(state: State<'_, Arc<AssistantState>>) -> Result<(), String> {
    state.cancel_current().await;
    Ok(())
}

// AssistantProviderKind is used indirectly by DTOs; retain an explicit import
// boundary check so renaming the enum does not accidentally break stored rows.
const _: Option<AssistantProviderKind> = None;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_markdown_wrapped_model_output() {
        let plain = r#"{"text":"ok","warnings":[]}"#;
        assert_eq!(parse_provider_output(plain).unwrap().text, "ok");

        let wrapped = "```json\n{\"text\":\"wrapped\",\"warnings\":[]}\n```";
        assert_eq!(parse_provider_output(wrapped).unwrap().text, "wrapped");
    }

    #[test]
    fn treats_non_json_output_as_plain_text() {
        let parsed = parse_provider_output("The script prints two values: {a, b}.").unwrap();
        assert_eq!(parsed.text, "The script prints two values: {a, b}.");
        assert!(parsed.action.is_none());
    }

    #[test]
    fn treats_text_without_tool_call_as_plain_text() {
        let parsed = parse_provider_completion(ProviderCompletion {
            text: "This command copies files safely.".to_string(),
            tool_name: None,
            tool_arguments: None,
        })
        .unwrap();

        assert_eq!(parsed.text, "This command copies files safely.");
        assert!(parsed.action.is_none());
    }

    #[test]
    fn parses_patch_tool_arguments() {
        let parsed = parse_provider_completion(ProviderCompletion {
            text: "Proposing a change.".to_string(),
            tool_name: Some(ASSISTANT_PATCH_TOOL_NAME.to_string()),
            tool_arguments: Some(
                r#"{"summary":"Set script","operations":[{"op":"replace","path":"script","value":"echo hi"}]}"#
                    .to_string(),
            ),
        })
        .unwrap();

        assert_eq!(parsed.text, "Proposing a change.");
        assert!(matches!(
            parsed.action,
            Some(crate::core::assistant::types::AssistantAction::ProposePatch { .. })
        ));
    }

    #[test]
    fn rejects_unknown_or_missing_tool_arguments() {
        let unknown = ProviderCompletion {
            text: String::new(),
            tool_name: Some("execute".to_string()),
            tool_arguments: Some("{}".to_string()),
        };
        assert!(parse_provider_completion(unknown).is_err());

        let missing_arguments = ProviderCompletion {
            text: String::new(),
            tool_name: Some(ASSISTANT_PATCH_TOOL_NAME.to_string()),
            tool_arguments: None,
        };
        assert!(parse_provider_completion(missing_arguments).is_err());
    }
}
