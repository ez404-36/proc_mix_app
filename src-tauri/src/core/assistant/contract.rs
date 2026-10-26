//! Semantic validation for assistant model output.

use thiserror::Error;

use super::types::{
    AssistantAction, AssistantGenerateResponse, AssistantPatch, AssistantPatchOperation,
    AssistantPatchOperationKind, AssistantTarget,
};

pub const MAX_RESPONSE_CHARS: usize = 32_000;
pub const MAX_MESSAGE_REASON_CHARS: usize = 8_000;
pub const MAX_PATCH_SUMMARY_CHARS: usize = 2_000;
pub const MAX_PATCH_WARNING_CHARS: usize = 1_000;
pub const MAX_PATCH_PATH_CHARS: usize = 256;
pub const MAX_PATCH_OPERATIONS: usize = 32;
pub const MAX_PATCH_WARNINGS: usize = 16;

#[derive(Debug, Eq, Error, PartialEq)]
pub enum AssistantContractError {
    #[error("assistant action is malformed")]
    Action,
    #[error("assistant message exceeds the output limit")]
    MessageLength,
    #[error("assistant patch operation is malformed")]
    Operation,
    #[error("assistant patch has an invalid number of operations")]
    OperationCount,
    #[error("assistant patch path is not allowed")]
    Path,
    #[error("assistant response exceeds the output limit")]
    ResponseLength,
    #[error("assistant patch summary is empty or too long")]
    Summary,
    #[error("assistant patch warnings are too large")]
    Warnings,
}

pub(crate) fn allowed_patch_roots(target: AssistantTarget) -> &'static [&'static str] {
    match target {
        AssistantTarget::Command => &[
            "name",
            "description",
            "script",
            "shell",
            "args",
            "workingDir",
            "variables",
            "outputSchema",
            "timeoutSeconds",
            "tags",
            "target",
        ],
        AssistantTarget::Workflow => &["name", "description", "nodes", "edges", "tags"],
        AssistantTarget::Miniapp => &["name", "description", "widgets", "tags", "panelSize"],
    }
}

fn is_patch_path_allowed(target: AssistantTarget, path: &str) -> bool {
    !path.is_empty()
        && path.len() <= MAX_PATCH_PATH_CHARS
        && allowed_patch_roots(target)
            .iter()
            .any(|root| path == *root || path.starts_with(&format!("{root}.")))
}

fn is_operation_valid(operation: &AssistantPatchOperation) -> bool {
    match operation.op {
        AssistantPatchOperationKind::Remove => operation.value.is_none(),
        AssistantPatchOperationKind::Add | AssistantPatchOperationKind::Replace => {
            operation.value.is_some()
        }
    }
}

fn validate_patch(
    target: AssistantTarget,
    patch: &AssistantPatch,
) -> Result<(), AssistantContractError> {
    if patch.summary.is_empty() || patch.summary.chars().count() > MAX_PATCH_SUMMARY_CHARS {
        return Err(AssistantContractError::Summary);
    }

    if patch.operations.is_empty() || patch.operations.len() > MAX_PATCH_OPERATIONS {
        return Err(AssistantContractError::OperationCount);
    }

    let warnings = patch.warnings.as_deref().unwrap_or_default();
    if warnings.len() > MAX_PATCH_WARNINGS
        || warnings
            .iter()
            .any(|warning| warning.chars().count() > MAX_PATCH_WARNING_CHARS)
    {
        return Err(AssistantContractError::Warnings);
    }

    for operation in &patch.operations {
        if !is_operation_valid(operation) {
            return Err(AssistantContractError::Operation);
        }
        if !is_patch_path_allowed(target, &operation.path) {
            return Err(AssistantContractError::Path);
        }
    }

    Ok(())
}

/// Validate a provider response after deserialization. Structural serde checks
/// and semantic limits are deliberately separate so malformed provider output
/// cannot enter the frontend as an `AssistantGenerateResponse`.
pub fn validate_generate_response(
    target: AssistantTarget,
    response: &AssistantGenerateResponse,
) -> Result<(), AssistantContractError> {
    if response.text.chars().count() > MAX_RESPONSE_CHARS {
        return Err(AssistantContractError::ResponseLength);
    }

    let Some(action) = &response.action else {
        return Ok(());
    };

    match action {
        AssistantAction::ProposePatch { patch } => validate_patch(target, patch),
        AssistantAction::RequestRun { reason, .. }
        | AssistantAction::RequestOutput { reason, .. } => {
            if reason.chars().count() > MAX_MESSAGE_REASON_CHARS {
                Err(AssistantContractError::MessageLength)
            } else {
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(action: Option<AssistantAction>) -> AssistantGenerateResponse {
        AssistantGenerateResponse {
            message_id: "message-1".to_string(),
            text: "Proposed a command change.".to_string(),
            action,
            warnings: Vec::new(),
        }
    }

    fn patch(path: &str, value: Option<&str>) -> AssistantPatch {
        AssistantPatch {
            summary: "Set script".to_string(),
            warnings: None,
            operations: vec![AssistantPatchOperation {
                op: AssistantPatchOperationKind::Replace,
                path: path.to_string(),
                value: value.map(str::to_string).map(serde_json::Value::String),
            }],
        }
    }

    #[test]
    fn accepts_constrained_command_patch() {
        let action = AssistantAction::ProposePatch {
            patch: patch("outputSchema.pipeline", Some("{}")),
        };
        assert_eq!(
            validate_generate_response(AssistantTarget::Command, &response(Some(action))),
            Ok(())
        );
    }

    #[test]
    fn rejects_identity_and_cross_target_paths() {
        assert_eq!(
            validate_generate_response(
                AssistantTarget::Command,
                &response(Some(AssistantAction::ProposePatch {
                    patch: patch("id", Some("new")),
                }))
            ),
            Err(AssistantContractError::Path)
        );
        assert_eq!(
            validate_generate_response(
                AssistantTarget::Workflow,
                &response(Some(AssistantAction::ProposePatch {
                    patch: patch("widgets", Some("[]")),
                }))
            ),
            Err(AssistantContractError::Path)
        );
    }

    #[test]
    fn rejects_oversized_patch_summary() {
        let mut oversized = patch("script", Some("echo"));
        oversized.summary = "x".repeat(MAX_PATCH_SUMMARY_CHARS + 1);
        assert_eq!(
            validate_generate_response(
                AssistantTarget::Command,
                &response(Some(AssistantAction::ProposePatch { patch: oversized }))
            ),
            Err(AssistantContractError::Summary)
        );
    }
}
