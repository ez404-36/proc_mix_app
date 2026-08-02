// Materialisation of a Mini-App inline action into a throwaway `Command`,
// plus the artifact → `VariableSpec` synthesis that makes the flagship
// "artifact as a variable" feature reliable.
//
// WHY THE SYNTHESIS EXISTS (root cause, not a guard):
// A button's inline script is written as `openvpn3 --config ${configPath}`,
// where `configPath` is the NAME of an artifact widget on the same panel.
// The runner routes the artifact's current value through
// `RunOptions.variableValues`, and Rust's `core/parser.rs` substitutes it.
// But `lookup` (parser.rs) only falls back to a declared `VariableSpec`
// default when the run map has no entry — with no spec at all a missing
// entry is a hard `ParseError::MissingVariable`, which surfaces to the user
// as an opaque backend failure.
//
// A runtime entry can legitimately be missing: the artifact was deleted or
// renamed after the script was written, or its `name` is empty/invalid so the
// runner never keyed it. Declaring a spec per artifact turns that hard error
// into "fall back to the artifact's editor-configured default", which is the
// honest semantic.
//
// It also fixes redaction: `core::redact::collect_sensitive_values` only
// collects values whose spec carries `sensitive: true`. A `secret`-variant
// artifact therefore had NO way to be redacted from output / History before
// this synthesis existed.

import type { Command, MiniAppAction, MiniAppWidget, VariableSpec } from "../types";

/** An inline (self-contained script) widget action. */
export type InlineAction = Extract<MiniAppAction, { kind: "inline" }>;

/**
 * Grammar for a referenceable artifact name — the same identifier alphabet
 * `core/parser.rs` accepts inside `${...}` (and that the editor validates
 * against). A name failing this pattern can never be substituted, so no spec
 * is synthesized for it.
 */
export const ARTIFACT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The subset of an `artifact` widget the spec synthesis needs: its reference
 * `name`, the editor-configured default `value`, and the `variant` that
 * decides whether the value is a secret.
 */
export interface ArtifactSpecSource {
  name: string;
  value: string;
  variant: "path" | "text" | "secret";
}

/**
 * Narrow a mini-app's widget list down to the artifacts that can actually be
 * referenced from a script (`name` matches {@link ARTIFACT_NAME_PATTERN}).
 * Duplicate names are collapsed to the FIRST occurrence, matching the
 * runner's `artifactValues` map semantics (see `MiniAppRunner`, which also
 * warns the user when duplicates exist).
 */
export function collectArtifactSpecSources(
  widgets: ReadonlyArray<MiniAppWidget>,
): ArtifactSpecSource[] {
  const seen = new Set<string>();
  const sources: ArtifactSpecSource[] = [];
  for (const w of widgets) {
    if (w.kind !== "artifact") continue;
    if (!ARTIFACT_NAME_PATTERN.test(w.name)) continue;
    if (seen.has(w.name)) continue;
    seen.add(w.name);
    sources.push({ name: w.name, value: w.value, variant: w.variant });
  }
  return sources;
}

/**
 * Merge synthesized artifact specs into an action's own declared specs.
 *
 * A spec the user declared explicitly ALWAYS wins — artifact specs are
 * appended only for names that are not already declared, so an author who
 * wants a prompt (`promptAtRuntime`) or a different default for a name that
 * happens to match an artifact keeps their configuration.
 *
 * A `secret`-variant artifact yields `sensitive: true`, which is what puts
 * its value into Rust's redaction set (`core::redact::collect_sensitive_values`).
 */
export function mergeArtifactVariableSpecs(
  declared: ReadonlyArray<VariableSpec> | undefined,
  artifacts: ReadonlyArray<ArtifactSpecSource>,
): VariableSpec[] {
  const specs: VariableSpec[] = declared !== undefined ? [...declared] : [];
  const declaredNames = new Set(specs.map((s) => s.name));
  for (const artifact of artifacts) {
    if (declaredNames.has(artifact.name)) continue;
    declaredNames.add(artifact.name);
    specs.push({
      name: artifact.name,
      // The editor-configured value is the fallback used when the runtime
      // map carries no entry for this artifact. An empty string is a VALID
      // default (see `VariableSpec.defaultValue`) and, crucially, does not
      // trigger a run-time prompt — a dropped artifact degrades to "empty"
      // rather than blocking on a modal or throwing `MissingVariable`.
      defaultValue: artifact.value,
      ...(artifact.variant === "secret" ? { sensitive: true } : {}),
    });
  }
  return specs;
}

/**
 * Return a shallow copy of a LIBRARY command with the panel's artifact specs
 * merged into its own `variables`. Used by the `commandRef` action path so a
 * referenced command benefits from the same two guarantees as an inline one:
 *
 *  1. A `${artifactName}` in the command's script no longer hard-fails with
 *     `MissingVariable` when the runner has no value for it (a deleted or
 *     unnamed artifact) — it degrades to the artifact's editor default.
 *  2. A `secret`-variant artifact carries `sensitive: true`, so Rust's
 *     `collect_sensitive_values` redacts it from output and History.
 *
 * The stored command is NEVER mutated — a spec the command already declares
 * wins, and the copy exists only for the duration of one run. Returns the
 * original reference when there is nothing to merge, so the common case
 * (a panel with no artifacts) allocates nothing.
 */
export function withArtifactVariableSpecs(
  cmd: Command,
  artifacts: ReadonlyArray<ArtifactSpecSource>,
): Command {
  if (artifacts.length === 0) return cmd;
  const variables = mergeArtifactVariableSpecs(cmd.variables, artifacts);
  if (variables.length === (cmd.variables?.length ?? 0)) return cmd;
  return { ...cmd, variables };
}

/**
 * Mint a UUID-like id for an inline action's ephemeral `Command`. The value
 * is never persisted — the inline command exists only for the duration of a
 * single `triggerCommandRun` call — but a unique id keeps the execution
 * store / history row keyed correctly (and avoids collisions with real
 * command ids). Mirrors the `makeId` fallbacks in the stores.
 */
export function makeInlineCommandId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `ma-inline-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Materialise an inline action into a throwaway {@link Command}. The command
 * is NOT added to the store and is NOT persisted — it exists solely so
 * `triggerCommandRun` has the full execution contract (script, shell, args,
 * working dir, env, admin flag, variables). Optional fields are spread only
 * when present so the resulting object matches the wire shape exactly.
 *
 * `artifacts` are the panel's referenceable artifact widgets; one
 * `VariableSpec` is synthesized per artifact whose name is not already
 * declared by the action (see {@link mergeArtifactVariableSpecs}).
 */
export function buildInlineCommand(
  action: InlineAction,
  artifacts: ReadonlyArray<ArtifactSpecSource> = [],
): Command {
  const ts = new Date().toISOString();
  const variables = mergeArtifactVariableSpecs(action.variables, artifacts);
  return {
    id: makeInlineCommandId(),
    name: action.name,
    script: action.script,
    ...(action.shell !== undefined ? { shell: action.shell } : {}),
    ...(action.args !== undefined ? { args: action.args } : {}),
    ...(action.workingDir !== undefined
      ? { workingDir: action.workingDir }
      : {}),
    ...(action.env !== undefined ? { env: action.env } : {}),
    runAsAdmin: action.runAsAdmin ?? false,
    ...(variables.length > 0 ? { variables } : {}),
    tags: [],
    favorite: false,
    createdAt: ts,
    updatedAt: ts,
    runCount: 0,
  };
}
