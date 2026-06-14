import type { TFunction } from "i18next";
import type { WorkflowCondition } from "../types";

/**
 * Render a {@link WorkflowCondition} as a SHORT, glanceable label for a node
 * card — e.g. `> 80`, `содержит "example"`. Distinct from the verbose op
 * labels used in the inspector (`editor.inspector.op.*`, "больше" / "содержит
 * регулярному…"): here comparison ops use a symbol (`>`, `<`, `=`, `≠`) and
 * the text ops (`contains` / `regex`) use a localized short word + a quoted
 * value, matching how a user would read the predicate at a glance.
 *
 * When the subject is a named variable, its name is prefixed (`count > 80`),
 * since otherwise it would be unclear what is being compared. `exitCode` and
 * `stdout` subjects are left implicit (the node's kind already conveys it),
 * keeping the label compact.
 */
export function conditionSummary(
  condition: WorkflowCondition,
  t: TFunction,
): string {
  const { subject, op, value } = condition;

  const predicate = ((): string => {
    switch (op) {
      case "eq":
        return `= ${value}`;
      case "ne":
        return `≠ ${value}`;
      case "gt":
        return `> ${value}`;
      case "lt":
        return `< ${value}`;
      case "contains":
        return `${t("editor.conditionSummary.contains")} "${value}"`;
      case "regex":
        return `${t("editor.conditionSummary.regex")} /${value}/`;
    }
  })();

  if (subject.kind === "variable" && subject.name !== "") {
    return `${subject.name} ${predicate}`;
  }
  return predicate;
}
