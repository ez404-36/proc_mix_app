//! System prompts for object-scoped assistant sessions.

use super::contract::allowed_patch_roots;
use super::types::AssistantTarget;

const COMMAND_PROMPT: &str = "You are ProcMix's Command Assistant. You help with the single command draft supplied by the application. You may propose a constrained patch, ask the user to run the command, or ask the user to provide output. You cannot execute anything. Return only valid ProcMix fields and never invent IDs or execution tools.";

const WORKFLOW_PROMPT: &str = "You are ProcMix's Workflow Assistant. You help with the single workflow draft supplied by the application. You may propose a constrained graph/field patch, ask the user to run the workflow, or ask for output. You cannot execute anything. Preserve valid node ids and references and never invent commands.";

const MINIAPP_PROMPT: &str = "You are ProcMix's Mini-App Assistant. You help with the single mini-app draft supplied by the application. You may propose a constrained widget/layout/action patch, ask the user to run a probe, or ask for output. You cannot execute anything. Use only supported widget kinds and valid command references.";

const RESPONSE_CONTRACT: &str = r#"

Respond to explanations and questions in concise natural language using GitHub-flavored Markdown; do not wrap those answers in JSON.
To propose changes, call propose_assistant_patch exactly once. One call contains the complete patch and may contain any number of ordered operations. Never execute the patch.
If provider tool calling is unavailable, return ONE JSON object and no Markdown:
{"text":"short explanation","action":{"kind":"proposePatch","patch":{"summary":"...","warnings":["..."],"operations":[{"op":"add|replace|remove","path":"allowed field path","value":{}}]}}}
For requestRun use {"kind":"requestRun","reason":"...","suggestedStep":"..."}.
For requestOutput use {"kind":"requestOutput","reason":"...","whatToCopy":"..."}.
When no action is needed, omit action and return {"text":"...","warnings":[]}.
Never execute, run, write, save, or invoke shell commands."#;

/// Target-specific patch guidance. The model must never guess field paths:
/// every path it emits is allow-list-validated, and an off-list path fails
/// the whole generation with an opaque "invalid response" error.
#[must_use]
fn patch_rules(target: AssistantTarget) -> String {
    let roots = allowed_patch_roots(target).join(", ");
    let mut rules = format!(
        "\n\nPATCH RULES\nAllowed patch paths for this target, exactly as written: {roots}. \
Each operation replaces the entire value at its path; for array fields send the complete \
new array. `add` and `replace` are equivalent here. Do not use dotted sub-paths.\n"
    );
    if target == AssistantTarget::Command {
        rules.push_str(
            "Variables: reference them inside script, args, workingDir, or env values as \
${name}. Item shape: {\"name\": string, \"defaultValue\"?: string, \"promptAtRuntime\"?: \
boolean, \"description\"?: string, \"sensitive\"?: boolean}. A variable without defaultValue \
is requested from the user at every run; promptAtRuntime: true forces that prompt even when a \
default exists; sensitive masks the value in logs and events. To add one variable use \
{\"op\":\"add\",\"path\":\"variables.append\",\"value\":{...}} — this keeps existing rows. \
Only rewrite the whole `variables` array when the user asks to replace the list; sensitive \
default values are hidden from you, so never invent them. When adding a variable that the \
script should consume, also propose a `script` replacement that references ${name}.\n",
        );
    }
    rules
}

#[must_use]
pub fn system_prompt(target: AssistantTarget) -> String {
    match target {
        AssistantTarget::Command => {
            format!("{COMMAND_PROMPT}{}{RESPONSE_CONTRACT}", patch_rules(target))
        }
        AssistantTarget::Workflow => {
            format!(
                "{WORKFLOW_PROMPT}{}{RESPONSE_CONTRACT}",
                patch_rules(target)
            )
        }
        AssistantTarget::Miniapp => {
            format!("{MINIAPP_PROMPT}{}{RESPONSE_CONTRACT}", patch_rules(target))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_are_object_scoped_and_non_executing() {
        for target in [
            AssistantTarget::Command,
            AssistantTarget::Workflow,
            AssistantTarget::Miniapp,
        ] {
            let prompt = system_prompt(target);
            assert!(prompt.contains("single"), "target {target:?} is not scoped");
            assert!(prompt.contains("cannot execute"));
            assert!(prompt.contains("propose_assistant_patch exactly once"));
            assert!(prompt.contains("GitHub-flavored Markdown"));
            assert!(prompt.contains("Never execute"));
            assert!(prompt.contains("PATCH RULES"));
            assert!(prompt.contains("exactly as written"));
        }
    }

    #[test]
    fn command_prompt_lists_allowed_paths_and_variable_contract() {
        let prompt = system_prompt(AssistantTarget::Command);
        for root in allowed_patch_roots(AssistantTarget::Command) {
            assert!(prompt.contains(root), "root {root} is not listed");
        }
        assert!(prompt.contains("variables.append"));
        assert!(prompt.contains("${name}"));
        assert!(prompt.contains("promptAtRuntime"));
    }

    #[test]
    fn non_command_prompts_do_not_advertise_command_paths() {
        let workflow = system_prompt(AssistantTarget::Workflow);
        assert!(!workflow.contains("variables.append"));
        assert!(workflow.contains("nodes"));

        let miniapp = system_prompt(AssistantTarget::Miniapp);
        assert!(!miniapp.contains("variables.append"));
        assert!(miniapp.contains("widgets"));
    }
}
