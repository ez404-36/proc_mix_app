//! Serializable assistant DTOs shared with the TypeScript layer.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantTarget {
    Command,
    Workflow,
    Miniapp,
    Schedule,
}

/// Per-object override for attaching run snapshots to assistant requests.
/// `Inherit` defers to the global `allow_run_snapshots` setting; `Deny`
/// always wins over global and per-request consent.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssistantRunAccess {
    #[default]
    Inherit,
    Allow,
    Deny,
}

impl AssistantRunAccess {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inherit => "inherit",
            Self::Allow => "allow",
            Self::Deny => "deny",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantBackendError {
    Disabled,
    NotConfigured,
    AuthFailed,
    Network,
    Timeout,
    Provider,
    InvalidAssistantResponse,
    InputTooLarge,
    RunSnapshotsDisabled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantPatchOperationKind {
    Add,
    Replace,
    Remove,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantPatchOperation {
    pub op: AssistantPatchOperationKind,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantPatch {
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
    pub operations: Vec<AssistantPatchOperation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AssistantAction {
    ProposePatch {
        patch: AssistantPatch,
    },
    RequestRun {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        suggested_step: Option<String>,
    },
    RequestOutput {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        what_to_copy: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantGenerateRequest {
    pub target: AssistantTarget,
    #[serde(default)]
    pub object_id: Option<String>,
    pub draft_version: u32,
    pub user_message: String,
    #[serde(default)]
    pub attached_run_snapshot_id: Option<String>,
    /// Explicit per-request consent when the global default is off.
    #[serde(default)]
    pub run_snapshot_consent: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantGenerateResponse {
    pub message_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<AssistantAction>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// Sanitized result of one user-initiated command run. This DTO deliberately
/// has no execution id/env/variables: the frontend builds a bounded, redacted
/// tail before the value ever reaches IPC.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantRunSnapshot {
    pub id: String,
    pub target: AssistantTarget,
    pub draft_version: u32,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub exit_code: Option<i64>,
    pub timed_out: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    pub stdout_tail: String,
    pub stderr_tail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extracted_fields: Option<serde_json::Value>,
}
