//! Minimal OpenAI-compatible chat-completions client.
//!
//! The provider client deliberately knows nothing about editor drafts or
//! patches. Callers assemble a prompt; this module authenticates, enforces
//! transport limits, honours cancellation, and extracts one message string.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use dirs::home_dir;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use super::types::AssistantBackendError;

/// Fixed safety limit. This is not a user setting because it also bounds
/// accidental provider spend and unbounded model responses.
pub const MAX_OUTPUT_TOKENS: u32 = 4_000;

#[derive(Clone, Debug)]
pub struct ProviderConfig {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub timeout: Duration,
    pub use_responses_api: bool,
}

/// Minimal Codex CLI settings needed to reuse the user's local login and
/// provider configuration. Unknown Codex settings are ignored.
#[derive(Clone, Debug)]
pub struct CodexCliSettings {
    pub base_url: String,
    pub api_key: Option<String>,
    pub use_responses_api: bool,
    pub catalog_path: PathBuf,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct CodexConfigFile {
    model_provider: Option<String>,
    model_catalog_json: Option<String>,
    model_providers: HashMap<String, CodexProviderConfigFile>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct CodexProviderConfigFile {
    base_url: Option<String>,
    experimental_bearer_token: Option<String>,
    wire_api: Option<String>,
}

#[derive(Deserialize)]
struct CodexCatalogFile {
    #[serde(default = "Vec::new")]
    models: Vec<CodexCatalogModelFile>,
}

#[derive(Deserialize)]
struct CodexCatalogModelFile {
    slug: String,
    #[serde(default)]
    display_name: Option<String>,
}

/// Resolve a Codex path that may use `~/`. Returns `None` only when the OS has
/// no home directory.
fn resolve_codex_path(path: &str) -> Option<PathBuf> {
    if let Some(relative) = path.strip_prefix("~/") {
        return home_dir().map(|home| home.join(relative));
    }
    Some(PathBuf::from(path))
}

/// Load only the local Codex fields used by this provider. Auth stays inside
/// the Codex configuration and the token is never logged or sent to the UI.
pub fn load_codex_cli_settings() -> Result<CodexCliSettings, ProviderError> {
    let codex_home = home_dir()
        .ok_or(ProviderError::NotConfigured("home directory unavailable"))?
        .join(".codex");
    let config_path = codex_home.join("config.toml");
    let config_text = std::fs::read_to_string(&config_path)
        .map_err(|_| ProviderError::NotConfigured("config.toml is unavailable"))?;
    let config: CodexConfigFile = toml::from_str(&config_text)
        .map_err(|_| ProviderError::NotConfigured("config.toml is invalid"))?;

    let provider_name = config
        .model_provider
        .unwrap_or_else(|| "openai".to_string());
    let provider = config
        .model_providers
        .get(&provider_name)
        .ok_or(ProviderError::NotConfigured("model provider is missing"))?;
    let base_url = provider
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .ok_or(ProviderError::NotConfigured("base URL is missing"))?;
    let catalog_path = config
        .model_catalog_json
        .as_deref()
        .and_then(resolve_codex_path)
        .unwrap_or_else(|| codex_home.join("models.json"));

    Ok(CodexCliSettings {
        base_url: base_url.to_string(),
        api_key: provider.experimental_bearer_token.clone(),
        use_responses_api: provider
            .wire_api
            .as_deref()
            .is_none_or(|wire| wire.eq_ignore_ascii_case("responses")),
        catalog_path,
    })
}

/// Parse Codex's local catalog. Its shape is provider-specific (`slug` /
/// `display_name`), unlike OpenAI-compatible `/models`.
pub fn parse_codex_models(body: &str) -> Result<Vec<(String, String)>, ProviderError> {
    let catalog: CodexCatalogFile =
        serde_json::from_str(body).map_err(|_| ProviderError::InvalidResponse)?;
    let models = catalog
        .models
        .into_iter()
        .filter(|model| !model.slug.trim().is_empty())
        .map(|model| {
            let name = model
                .display_name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| model.slug.clone());
            (model.slug, name)
        })
        .collect();
    Ok(models)
}

/// Load models from the catalog referenced by the local Codex configuration.
pub fn list_codex_cli_models() -> Result<Vec<(String, String)>, ProviderError> {
    let settings = load_codex_cli_settings()?;
    let body = std::fs::read_to_string(&settings.catalog_path)
        .map_err(|_| ProviderError::NotConfigured("model catalog is unavailable"))?;
    parse_codex_models(&body)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub ok: bool,
    pub model_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Eq, Error, PartialEq)]
pub enum ProviderError {
    #[error("provider base URL must use HTTP or HTTPS")]
    InvalidBaseUrl,
    #[error("Codex is not configured on this computer")]
    NotConfigured(&'static str),
    #[error("assistant request was cancelled")]
    Cancelled,
    #[error("assistant request timed out")]
    Timeout,
    #[error("assistant provider authentication failed")]
    AuthFailed,
    #[error("assistant provider request failed: {0}")]
    Network(String),
    #[error("assistant provider returned an invalid response")]
    InvalidResponse,
    #[error("assistant provider rejected the request")]
    Provider,
    #[error("assistant provider returned HTTP {0}")]
    HttpStatus(u16),
    #[error("remote assistant endpoints require explicit consent")]
    RemoteNotAllowed,
}

impl ProviderError {
    /// Stable wire error for the frontend without exposing response bodies.
    pub fn backend_error(&self) -> AssistantBackendError {
        match self {
            Self::InvalidBaseUrl => AssistantBackendError::NotConfigured,
            Self::NotConfigured(_) => AssistantBackendError::NotConfigured,
            Self::Cancelled => AssistantBackendError::Timeout,
            Self::Timeout => AssistantBackendError::Timeout,
            Self::AuthFailed => AssistantBackendError::AuthFailed,
            Self::Network(_) => AssistantBackendError::Network,
            Self::InvalidResponse => AssistantBackendError::InvalidAssistantResponse,
            Self::Provider => AssistantBackendError::Provider,
            Self::HttpStatus(_) => AssistantBackendError::Provider,
            Self::RemoteNotAllowed => AssistantBackendError::NotConfigured,
        }
    }
}

#[derive(Deserialize)]
struct ModelsWire {
    #[serde(default)]
    id: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct ModelsResponseWire {
    #[serde(default)]
    data: Option<Vec<ModelsWire>>,
    #[serde(default)]
    models: Option<Vec<ModelsWire>>,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct ChatCompletionRequest<'a> {
    model: &'a str,
    messages: [ChatMessage<'a>; 2],
    stream: bool,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<String>,
}

#[derive(Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessageContent,
}

#[derive(Deserialize)]
struct ChatMessageContent {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ChatToolCall>,
}

#[derive(Deserialize)]
struct ChatToolCall {
    function: ChatToolFunction,
}

#[derive(Deserialize)]
struct ChatToolFunction {
    name: String,
    #[serde(default)]
    arguments: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct ResponsesInputText<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    text: &'a str,
}

#[derive(Serialize)]
struct ResponsesInputMessage<'a> {
    role: &'a str,
    content: [ResponsesInputText<'a>; 1],
}

#[derive(Serialize)]
struct ResponsesRequest<'a> {
    model: &'a str,
    instructions: &'a str,
    input: [ResponsesInputMessage<'a>; 1],
    stream: bool,
    max_output_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<String>,
}

// --- Streaming SSE wire types (chat completions) ---

#[derive(Deserialize)]
struct ChatStreamChunk {
    #[serde(default)]
    choices: Vec<ChatStreamChoice>,
}

#[derive(Deserialize)]
struct ChatStreamChoice {
    #[serde(default)]
    delta: ChatStreamDelta,
}

#[derive(Deserialize, Default)]
struct ChatStreamDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ChatStreamToolCall>,
}

#[derive(Deserialize)]
struct ChatStreamToolCall {
    #[serde(default)]
    function: Option<ChatStreamToolFunction>,
}

#[derive(Deserialize)]
struct ChatStreamToolFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

// --- Streaming SSE wire types (Responses API) ---

#[derive(Deserialize)]
struct ResponsesStreamEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    delta: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<serde_json::Value>,
}

/// Accumulated state across SSE chunks.
#[derive(Debug, Default)]
struct StreamAccumulator {
    text: String,
    tool_name: Option<String>,
    tool_arguments: String,
}

impl StreamAccumulator {
    fn into_completion(self) -> Result<ProviderCompletion, ProviderError> {
        if self.text.trim().is_empty() && self.tool_name.is_none() {
            return Err(ProviderError::InvalidResponse);
        }
        Ok(ProviderCompletion {
            text: self.text,
            tool_name: self.tool_name,
            tool_arguments: if self.tool_arguments.is_empty() {
                None
            } else {
                Some(self.tool_arguments)
            },
        })
    }
}

/// Feed one parsed SSE `data:` payload into the accumulator.
/// Returns `true` when the stream is done (`[DONE]` sentinel).
fn feed_stream_data(
    data: &str,
    use_responses_api: bool,
    acc: &mut StreamAccumulator,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> bool {
    if data.trim() == "[DONE]" {
        return true;
    }
    if use_responses_api {
        feed_responses_event(data, acc, on_delta);
    } else {
        feed_chat_chunk(data, acc, on_delta);
    }
    false
}

fn feed_chat_chunk(
    data: &str,
    acc: &mut StreamAccumulator,
    on_delta: &mut (dyn FnMut(&str) + Send),
) {
    let Ok(chunk) = serde_json::from_str::<ChatStreamChunk>(data) else {
        return;
    };
    let Some(choice) = chunk.choices.first() else {
        return;
    };
    if let Some(content) = &choice.delta.content {
        if !content.is_empty() {
            acc.text.push_str(content);
            on_delta(content);
        }
    }
    for tool_call in &choice.delta.tool_calls {
        if let Some(function) = &tool_call.function {
            if let Some(name) = &function.name {
                acc.tool_name = Some(name.clone());
            }
            if let Some(arguments) = &function.arguments {
                acc.tool_arguments.push_str(arguments);
            }
        }
    }
}

fn feed_responses_event(
    data: &str,
    acc: &mut StreamAccumulator,
    on_delta: &mut (dyn FnMut(&str) + Send),
) {
    let Ok(event) = serde_json::from_str::<ResponsesStreamEvent>(data) else {
        return;
    };
    match event.kind.as_str() {
        "response.output_text.delta" => {
            if let Some(delta) = &event.delta {
                if !delta.is_empty() {
                    acc.text.push_str(delta);
                    on_delta(delta);
                }
            }
        }
        "response.output_item.added" => {
            if let Some(name) = &event.name {
                acc.tool_name = Some(name.clone());
            }
        }
        "response.function_call_arguments.delta" => {
            if let Some(delta) = &event.delta {
                acc.tool_arguments.push_str(delta);
            }
        }
        "response.function_call_arguments.done" => {
            if let Some(args) = &event.arguments {
                if let Ok(s) = serde_json::to_string(args) {
                    acc.tool_arguments = s;
                }
            }
        }
        _ => {}
    }
}

#[derive(Deserialize)]
struct ResponsesContent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
struct ResponsesOutput {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    content: Vec<ResponsesContent>,
    #[serde(default)]
    name: String,
    #[serde(default)]
    arguments: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct ResponsesApiResult {
    #[serde(default)]
    output: Vec<ResponsesOutput>,
}

/// A provider reply may be ordinary prose, a legacy JSON object in prose, or a
/// provider-native patch tool call. The command layer owns Assistant-specific
/// validation; this generic result only preserves the provider's fields.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProviderCompletion {
    pub text: String,
    pub tool_name: Option<String>,
    pub tool_arguments: Option<String>,
}

pub const ASSISTANT_PATCH_TOOL_NAME: &str = "propose_assistant_patch";

#[must_use]
pub fn assistant_patch_tool(use_responses_api: bool) -> serde_json::Value {
    let parameters = serde_json::json!({
        "type": "object",
        "required": ["summary", "operations"],
        "properties": {
            "summary": {
                "type": "string",
                "description": "Short explanation of the complete proposed changes."
            },
            "warnings": {
                "type": "array",
                "items": {"type": "string"}
            },
            "operations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["op", "path"],
                    "properties": {
                        "op": {
                            "type": "string",
                            "enum": ["add", "replace", "remove"]
                        },
                        "path": {
                            "type": "string",
                            "description": "Allowed ProcMix field path for the selected target."
                        },
                        "value": {
                            "description": "Replacement value; omit for remove."
                        }
                    }
                }
            }
        }
    });

    if use_responses_api {
        serde_json::json!({
            "type": "function",
            "name": ASSISTANT_PATCH_TOOL_NAME,
            "description": "Propose a complete patch for the ProcMix draft. Do not execute anything.",
            "parameters": parameters
        })
    } else {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": ASSISTANT_PATCH_TOOL_NAME,
                "description": "Propose a complete patch for the ProcMix draft. Do not execute anything.",
                "parameters": parameters
            }
        })
    }
}

fn tool_arguments_string(value: Option<serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::String(arguments) => Some(arguments),
        arguments => serde_json::to_string(&arguments).ok(),
    }
}

/// Join an OpenAI-compatible base URL with the chat-completions path. Trailing
/// slashes are normalized so both `…/v1` and `…/v1/` work.
pub fn completion_url(base_url: &str) -> Result<String, ProviderError> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err(ProviderError::InvalidBaseUrl);
    }
    if trimmed.is_empty() || trimmed.len() > 2_048 {
        return Err(ProviderError::InvalidBaseUrl);
    }
    Ok(format!("{trimmed}/chat/completions"))
}

/// Join a Responses API base URL with the `/responses` path.
pub fn responses_url(base_url: &str) -> Result<String, ProviderError> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err(ProviderError::InvalidBaseUrl);
    }
    if trimmed.is_empty() || trimmed.len() > 2_048 {
        return Err(ProviderError::InvalidBaseUrl);
    }
    Ok(format!("{trimmed}/responses"))
}

/// Parse a non-streaming chat completion body. Text is optional when the model
/// emits exactly one function call; more than one call is deliberately invalid.
pub fn parse_completion(body: &str) -> Result<ProviderCompletion, ProviderError> {
    let completion: ChatCompletionResponse =
        serde_json::from_str(body).map_err(|_| ProviderError::InvalidResponse)?;
    let choice = completion
        .choices
        .first()
        .ok_or(ProviderError::InvalidResponse)?;
    let mut result = ProviderCompletion {
        text: choice.message.content.clone().unwrap_or_default(),
        ..ProviderCompletion::default()
    };
    let mut tool_calls = choice.message.tool_calls.iter();
    if let Some(tool_call) = tool_calls.next() {
        if tool_calls.next().is_some() {
            return Err(ProviderError::InvalidResponse);
        }
        result.tool_name = Some(tool_call.function.name.clone());
        result.tool_arguments = tool_arguments_string(tool_call.function.arguments.clone());
    }
    if result.text.trim().is_empty() && result.tool_name.is_none() {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(result)
}

/// Extract the final message and optional function call from a non-streaming
/// Responses API payload. Reasoning output is deliberately ignored.
pub fn parse_responses(body: &str) -> Result<ProviderCompletion, ProviderError> {
    let response: ResponsesApiResult =
        serde_json::from_str(body).map_err(|_| ProviderError::InvalidResponse)?;
    let mut result = ProviderCompletion::default();
    let mut tool_calls = 0;

    for item in &response.output {
        if item.kind == "message" {
            if result.text.is_empty() {
                result.text = item
                    .content
                    .iter()
                    .find(|content| content.kind == "output_text")
                    .map_or(String::new(), |content| content.text.trim().to_string());
            }
        } else if item.kind == "function_call" {
            tool_calls += 1;
            result.tool_name = Some(item.name.clone());
            result.tool_arguments = tool_arguments_string(item.arguments.clone());
        }
    }

    if tool_calls > 1 || (result.text.trim().is_empty() && result.tool_name.is_none()) {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(result)
}

/// Parse OpenAI-compatible `/models`, plus Ollama's alternate `models` array.
pub fn parse_models(body: &str) -> Result<Vec<(String, String)>, ProviderError> {
    let response: ModelsResponseWire =
        serde_json::from_str(body).map_err(|_| ProviderError::InvalidResponse)?;
    let rows = response.data.or(response.models).unwrap_or_default();
    let models = rows
        .into_iter()
        .filter_map(|row| {
            let id = if row.id.is_empty() { row.model } else { row.id };
            (!id.trim().is_empty()).then(|| {
                let name = row.name.filter(|name| !name.trim().is_empty());
                (id.clone(), name.unwrap_or(id))
            })
        })
        .collect();
    Ok(models)
}

/// Fetch and normalize the provider's live model list.
pub async fn list_models(
    config: &ProviderConfig,
    cancellation_token: CancellationToken,
) -> Result<Vec<(String, String)>, ProviderError> {
    let client = reqwest::Client::builder()
        .timeout(config.timeout)
        .build()
        .map_err(|error| ProviderError::Network(error.to_string()))?;
    let base = config.base_url.trim().trim_end_matches('/');
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err(ProviderError::InvalidBaseUrl);
    }
    let url = format!("{base}/models");
    let mut request = client.get(&url);
    if let Some(api_key) = config.api_key.as_deref() {
        request = request.bearer_auth(api_key);
    }
    let response = tokio::select! {
        () = cancellation_token.cancelled() => return Err(ProviderError::Cancelled),
        result = request.send() => result,
    }
    .map_err(|error| {
        if error.is_timeout() {
            ProviderError::Timeout
        } else {
            ProviderError::Network(error.to_string())
        }
    })?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| ProviderError::Network(error.to_string()))?;
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(ProviderError::AuthFailed);
    }
    if !status.is_success() {
        tracing::debug!("assistant provider models request failed with HTTP {status}");
        return Err(ProviderError::HttpStatus(status.as_u16()));
    }
    parse_models(&body)
}

pub async fn complete(
    config: &ProviderConfig,
    system_prompt: &str,
    user_prompt: &str,
    cancellation_token: CancellationToken,
) -> Result<ProviderCompletion, ProviderError> {
    let client = reqwest::Client::builder()
        .timeout(config.timeout)
        .build()
        .map_err(|error| ProviderError::Network(error.to_string()))?;

    let complete_once = |tools: Option<serde_json::Value>, json_mode: bool| {
        let client = &client;
        let cancellation_token = &cancellation_token;
        let system_prompt = &system_prompt;
        let user_prompt = &user_prompt;
        async move {
            let response_format = if json_mode {
                Some(serde_json::json!({ "type": "json_object" }))
            } else {
                None
            };
            let text_format = if json_mode {
                Some(serde_json::json!({ "format": { "type": "json_object" } }))
            } else {
                None
            };
            let (url, body) = if config.use_responses_api {
                (
                    responses_url(&config.base_url)?,
                    serde_json::to_string(&ResponsesRequest {
                        model: config.model.trim(),
                        instructions: system_prompt,
                        input: [ResponsesInputMessage {
                            role: "user",
                            content: [ResponsesInputText {
                                kind: "input_text",
                                text: user_prompt,
                            }],
                        }],
                        stream: false,
                        max_output_tokens: MAX_OUTPUT_TOKENS,
                        text: text_format.clone(),
                        tools: tools.clone(),
                        tool_choice: tools.as_ref().map(|_| "auto".to_string()),
                    })
                    .map_err(|error| ProviderError::Network(error.to_string()))?,
                )
            } else {
                (
                    completion_url(&config.base_url)?,
                    serde_json::to_string(&ChatCompletionRequest {
                        model: config.model.trim(),
                        messages: [
                            ChatMessage {
                                role: "system",
                                content: system_prompt,
                            },
                            ChatMessage {
                                role: "user",
                                content: user_prompt,
                            },
                        ],
                        stream: false,
                        max_tokens: MAX_OUTPUT_TOKENS,
                        response_format: response_format.clone(),
                        tools: tools.clone(),
                        tool_choice: tools.as_ref().map(|_| "auto".to_string()),
                    })
                    .map_err(|error| ProviderError::Network(error.to_string()))?,
                )
            };

            let mut request = client
                .post(&url)
                .header("Content-Type", "application/json")
                .body(body);
            if let Some(api_key) = config.api_key.as_deref() {
                request = request.bearer_auth(api_key);
            }

            let response = tokio::select! {
                () = cancellation_token.cancelled() => return Err(ProviderError::Cancelled),
                result = request.send() => result,
            }
            .map_err(|error| {
                if error.is_timeout() {
                    ProviderError::Timeout
                } else {
                    ProviderError::Network(error.to_string())
                }
            })?;

            let status = response.status();
            let body = response
                .text()
                .await
                .map_err(|error| ProviderError::Network(error.to_string()))?;
            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
            {
                return Err(ProviderError::AuthFailed);
            }
            if !status.is_success() {
                tracing::debug!("assistant provider request failed with HTTP {status}");
                return Err(ProviderError::HttpStatus(status.as_u16()));
            }

            if config.use_responses_api {
                parse_responses(&body)
            } else {
                parse_completion(&body)
            }
        }
    };

    let tool = Some(assistant_patch_tool(config.use_responses_api));
    match complete_once(tool.clone(), false).await {
        Err(ProviderError::HttpStatus(400 | 404 | 415 | 422)) => {
            // Some OpenAI-compatible providers/models reject the tools field.
            // Retry without it, requesting structured JSON output for a more
            // reliable patch parse. If response_format is also unsupported,
            // fall back to plain text (legacy JSON-in-prose still works).
            match complete_once(None, true).await {
                Err(ProviderError::HttpStatus(400 | 404 | 415 | 422)) => {
                    complete_once(None, false).await
                }
                result => result,
            }
        }
        result => result,
    }
}

/// Stream a provider completion via SSE, calling `on_delta` for each text
/// chunk. Returns the fully accumulated result when the stream ends.
/// On HTTP 400/404/415/422 (tools rejected), falls back to the non-streaming
/// `complete()` (which handles its own JSON-mode fallback chain).
pub async fn complete_streaming(
    config: &ProviderConfig,
    system_prompt: &str,
    user_prompt: &str,
    cancellation_token: CancellationToken,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> Result<ProviderCompletion, ProviderError> {
    let client = reqwest::Client::builder()
        // A long-running stream is healthy as long as it keeps making progress.
        // Bound only connection/header latency and gaps between chunks; the
        // user-configured timeout must not kill a complete long response.
        .connect_timeout(config.timeout)
        .read_timeout(config.timeout)
        .build()
        .map_err(|error| ProviderError::Network(error.to_string()))?;

    let tool = assistant_patch_tool(config.use_responses_api);
    let tool_json = Some(tool);
    let tool_choice = tool_json.as_ref().map(|_| "auto".to_string());
    let (url, body) = if config.use_responses_api {
        (
            responses_url(&config.base_url)?,
            serde_json::to_string(&ResponsesRequest {
                model: config.model.trim(),
                instructions: system_prompt,
                input: [ResponsesInputMessage {
                    role: "user",
                    content: [ResponsesInputText {
                        kind: "input_text",
                        text: user_prompt,
                    }],
                }],
                stream: true,
                max_output_tokens: MAX_OUTPUT_TOKENS,
                text: None,
                tools: tool_json,
                tool_choice,
            })
            .map_err(|error| ProviderError::Network(error.to_string()))?,
        )
    } else {
        (
            completion_url(&config.base_url)?,
            serde_json::to_string(&ChatCompletionRequest {
                model: config.model.trim(),
                messages: [
                    ChatMessage {
                        role: "system",
                        content: system_prompt,
                    },
                    ChatMessage {
                        role: "user",
                        content: user_prompt,
                    },
                ],
                stream: true,
                max_tokens: MAX_OUTPUT_TOKENS,
                response_format: None,
                tools: tool_json,
                tool_choice,
            })
            .map_err(|error| ProviderError::Network(error.to_string()))?,
        )
    };

    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body);
    if let Some(api_key) = config.api_key.as_deref() {
        request = request.bearer_auth(api_key);
    }

    let response = tokio::select! {
        () = cancellation_token.cancelled() => return Err(ProviderError::Cancelled),
        result = tokio::time::timeout(config.timeout, request.send()) => {
            match result {
                Ok(Ok(response)) => response,
                Ok(Err(error)) if error.is_timeout() => return Err(ProviderError::Timeout),
                Ok(Err(error)) => return Err(ProviderError::Network(error.to_string())),
                Err(_) => return Err(ProviderError::Timeout),
            }
        }
    };

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(ProviderError::AuthFailed);
    }
    if !status.is_success() {
        tracing::debug!("assistant streaming request failed with HTTP {status}");
        return Err(ProviderError::HttpStatus(status.as_u16()));
    }

    let use_responses_api = config.use_responses_api;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut acc = StreamAccumulator::default();

    loop {
        let chunk = tokio::select! {
            () = cancellation_token.cancelled() => return Err(ProviderError::Cancelled),
            chunk = futures_util::StreamExt::next(&mut stream) => chunk,
        };
        let bytes = match chunk {
            Some(Ok(bytes)) => bytes,
            Some(Err(error)) if error.is_timeout() => {
                return Err(ProviderError::Timeout);
            }
            Some(Err(error)) => return Err(ProviderError::Network(error.to_string())),
            None => break,
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim_end_matches('\r').to_string();
            buffer.drain(..=line_end);

            if line.is_empty() || line.starts_with(':') || line.starts_with("event:") {
                continue;
            }

            let data = if let Some(rest) = line.strip_prefix("data: ") {
                rest
            } else if let Some(rest) = line.strip_prefix("data:") {
                rest.trim()
            } else {
                continue;
            };

            if feed_stream_data(data, use_responses_api, &mut acc, on_delta) {
                return acc.into_completion();
            }
        }
    }

    acc.into_completion()
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_completion_url_and_rejects_non_http() {
        assert_eq!(
            completion_url("http://127.0.0.1:11434/v1/").unwrap(),
            "http://127.0.0.1:11434/v1/chat/completions"
        );
        assert!(matches!(
            completion_url("file:///etc"),
            Err(ProviderError::InvalidBaseUrl)
        ));
    }

    #[test]
    fn parses_responses_api_final_message() {
        let body = r#"{
          "output": [
            {"type":"reasoning","content":[{"type":"reasoning_text","text":"thinking"}]},
            {"type":"message","content":[{"type":"output_text","text":"{\"text\":\"ok\"}"}]}
          ]
        }"#;
        assert_eq!(
            parse_responses(body).unwrap(),
            ProviderCompletion {
                text: "{\"text\":\"ok\"}".to_string(),
                ..ProviderCompletion::default()
            }
        );
        assert_eq!(
            parse_responses(r#"{"output":[]}"#),
            Err(ProviderError::InvalidResponse)
        );
    }

    #[test]
    fn parses_first_nonempty_choice() {
        let body = r#"{
          "choices": [
            {"message": {"content": "{\"text\":\"ok\"}"}}
          ]
        }"#;
        assert_eq!(
            parse_completion(body).unwrap(),
            ProviderCompletion {
                text: "{\"text\":\"ok\"}".to_string(),
                ..ProviderCompletion::default()
            }
        );
    }

    #[test]
    fn rejects_empty_or_malformed_completion() {
        assert_eq!(
            parse_completion(r#"{"choices":[{"message":{"content":""}}]}"#),
            Err(ProviderError::InvalidResponse)
        );
        assert_eq!(parse_completion("{}"), Err(ProviderError::InvalidResponse));
    }

    #[test]
    fn maps_provider_errors_to_stable_backend_errors() {
        assert_eq!(
            ProviderError::AuthFailed.backend_error(),
            AssistantBackendError::AuthFailed
        );
        assert_eq!(
            ProviderError::InvalidResponse.backend_error(),
            AssistantBackendError::InvalidAssistantResponse
        );
    }

    #[test]
    fn parses_one_chat_patch_tool_call_with_explanation() {
        let body = r#"{
          "choices": [{
            "message": {
              "content": "I can update the draft.",
              "tool_calls": [{
                "type": "function",
                "function": {
                  "name": "propose_assistant_patch",
                  "arguments": "{\"summary\":\"Update\",\"operations\":[{\"op\":\"replace\",\"path\":\"script\",\"value\":\"echo hi\"}]}"
                }
              }]
            }
          }]
        }"#;

        assert_eq!(
            parse_completion(body).unwrap(),
            ProviderCompletion {
                text: "I can update the draft.".to_string(),
                tool_name: Some(ASSISTANT_PATCH_TOOL_NAME.to_string()),
                tool_arguments: Some(
                    r#"{"summary":"Update","operations":[{"op":"replace","path":"script","value":"echo hi"}]}"#.to_string()
                ),
            }
        );
    }

    #[test]
    fn rejects_multiple_chat_tool_calls() {
        let body = r#"{
          "choices": [{
            "message": {
              "tool_calls": [
                {"function":{"name":"propose_assistant_patch","arguments":"{}"}},
                {"function":{"name":"propose_assistant_patch","arguments":"{}"}}
              ]
            }
          }]
        }"#;

        assert_eq!(parse_completion(body), Err(ProviderError::InvalidResponse));
    }

    #[test]
    fn parses_one_responses_function_call_without_text() {
        let body = r#"{
          "output": [
            {"type":"function_call","name":"propose_assistant_patch","arguments":{"summary":"Update","operations":[]}}
          ]
        }"#;

        let parsed = parse_responses(body).unwrap();
        assert_eq!(parsed.text, "");
        assert_eq!(
            parsed.tool_name,
            Some(ASSISTANT_PATCH_TOOL_NAME.to_string())
        );
        assert_eq!(
            parsed.tool_arguments.as_deref(),
            Some(r#"{"operations":[],"summary":"Update"}"#)
        );
    }

    #[test]
    fn builds_provider_specific_patch_tools() {
        let chat_tool = assistant_patch_tool(false);
        assert_eq!(chat_tool["type"], "function");
        assert_eq!(chat_tool["function"]["name"], ASSISTANT_PATCH_TOOL_NAME);

        let responses_tool = assistant_patch_tool(true);
        assert_eq!(responses_tool["type"], "function");
        assert_eq!(responses_tool["name"], ASSISTANT_PATCH_TOOL_NAME);
    }

    #[test]
    fn feeds_chat_stream_text_and_tool_arguments() {
        let mut acc = StreamAccumulator::default();
        let mut deltas = Vec::new();
        let mut on_delta = |delta: &str| deltas.push(delta.to_string());

        assert!(!feed_stream_data(
            r#"{"choices":[{"delta":{"content":"Hello"}}]}"#,
            false,
            &mut acc,
            &mut on_delta,
        ));
        assert!(!feed_stream_data(
            r#"{"choices":[{"delta":{"content":" world"}}]}"#,
            false,
            &mut acc,
            &mut on_delta,
        ));
        assert!(!feed_stream_data(
            r#"{"choices":[{"delta":{"tool_calls":[{"function":{"name":"propose_assistant_patch","arguments":"{\"summ"}}]}}]}"#,
            false,
            &mut acc,
            &mut on_delta,
        ));
        assert!(!feed_stream_data(
            r#"{"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"ary\":\"x\"}"}}]}}]}"#,
            false,
            &mut acc,
            &mut on_delta,
        ));

        assert_eq!(acc.text, "Hello world");
        assert_eq!(deltas, vec!["Hello", " world"]);
        let completion = acc.into_completion().unwrap();
        assert_eq!(
            completion.tool_name.as_deref(),
            Some(ASSISTANT_PATCH_TOOL_NAME)
        );
        assert_eq!(
            completion.tool_arguments.as_deref(),
            Some(r#"{"summary":"x"}"#)
        );
    }

    #[test]
    fn feeds_responses_stream_events() {
        let mut acc = StreamAccumulator::default();
        let mut deltas = Vec::new();
        let mut on_delta = |delta: &str| deltas.push(delta.to_string());

        assert!(!feed_stream_data(
            r#"{"type":"response.output_text.delta","delta":"Hi"}"#,
            true,
            &mut acc,
            &mut on_delta,
        ));
        assert!(!feed_stream_data(
            r#"{"type":"response.output_item.added","item":{"type":"function_call"},"name":"propose_assistant_patch"}"#,
            true,
            &mut acc,
            &mut on_delta,
        ));
        assert!(!feed_stream_data(
            r#"{"type":"response.function_call_arguments.delta","delta":"{\"a\":1}"}"#,
            true,
            &mut acc,
            &mut on_delta,
        ));

        assert_eq!(acc.text, "Hi");
        assert_eq!(deltas, vec!["Hi"]);
        assert_eq!(acc.tool_name.as_deref(), Some(ASSISTANT_PATCH_TOOL_NAME));
        assert_eq!(acc.tool_arguments, r#"{"a":1}"#);
    }

    #[test]
    fn done_sentinel_returns_true() {
        let mut acc = StreamAccumulator::default();
        let mut on_delta = |_: &str| {};
        assert!(feed_stream_data("[DONE]", false, &mut acc, &mut on_delta));
        assert!(feed_stream_data("[DONE]", true, &mut acc, &mut on_delta));
    }

    #[test]
    fn empty_stream_is_invalid() {
        let acc = StreamAccumulator::default();
        assert!(acc.into_completion().is_err());
    }

    #[test]
    fn chat_completion_request_includes_response_format_in_json_mode() {
        let request = ChatCompletionRequest {
            model: "test",
            messages: [
                ChatMessage {
                    role: "system",
                    content: "sys",
                },
                ChatMessage {
                    role: "user",
                    content: "usr",
                },
            ],
            stream: false,
            max_tokens: 100,
            response_format: Some(serde_json::json!({ "type": "json_object" })),
            tools: None,
            tool_choice: None,
        };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["response_format"]["type"], "json_object");

        let no_format = ChatCompletionRequest {
            response_format: None,
            ..request
        };
        let json = serde_json::to_value(&no_format).unwrap();
        assert!(json.get("response_format").is_none());
    }
}
