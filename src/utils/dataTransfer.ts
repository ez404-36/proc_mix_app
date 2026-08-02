// Import / Export service layer for Commands and Workflows.
//
// The Rust `export_data` / `import_data` commands handle only the native
// file dialog + raw file IO (passing the document as an opaque String).
// All serialization and validation lives here, where the `Command` /
// `Workflow` app types are defined — so the Rust side never duplicates the
// DTO shapes. Components MUST go through this module rather than calling
// `invoke` directly.

import { invoke } from "@tauri-apps/api/core";
import type { Command, MiniApp, MiniAppWidget, Workflow } from "../types";

/**
 * Current export-envelope schema version. Bump on a breaking change.
 *
 * v2 adds the optional `miniapps` array (Mini-Apps feature). A v1 file (no
 * `miniapps` key) is still accepted on import — `miniapps` is optional, so the
 * guard treats its absence as an empty list. This keeps legacy exports
 * importable without migration.
 */
export const EXPORT_VERSION = 2 as const;

/**
 * Per-install STATE fields that describe how a user has interacted with a
 * record locally — not part of its portable definition. They are stripped
 * on export (a shared workflow/command should not carry the author's run
 * count, last-run time, favourite flag, or local timestamps) and the
 * importer materialises fresh values anyway. Listed once so the export
 * sanitiser and the type guard stay in sync.
 *
 * NOTE: `id` is intentionally KEPT in the export. It is not user state — it
 * is the reference key a workflow node uses to point at a command, so the
 * importer needs it to remap `node.commandId` to the freshly-generated id.
 * The importer discards the original id for the new record.
 */
type InstanceStateFields =
  | "favorite"
  | "runCount"
  | "lastRunAt"
  | "createdAt"
  | "updatedAt";

/**
 * Definition fields deliberately EXCLUDED from export even though they are
 * part of the portable definition (not per-install state). `sound` points at
 * a per-install sound configuration that is meaningless on another machine —
 * the referenced sounds are not bundled — so it is stripped on export and the
 * importer materialises no sound. Kept separate from {@link InstanceStateFields}
 * because the reason for exclusion differs.
 */
type ExportExcludedFields = "sound";

/**
 * Portable, definition-only shapes written to disk: a `Command` /
 * `Workflow` minus the per-install {@link InstanceStateFields} and the
 * {@link ExportExcludedFields}. The importer re-stamps id/timestamps and
 * resets favourite/runCount.
 */
export type ExportedCommand = Omit<Command, InstanceStateFields | ExportExcludedFields>;
export type ExportedWorkflow = Omit<Workflow, InstanceStateFields | ExportExcludedFields>;
/**
 * Portable mini-app definition. `MiniApp` carries no `sound` config (so
 * {@link ExportExcludedFields} does not apply) — only the per-install
 * {@link InstanceStateFields} are stripped. The importer re-stamps id /
 * timestamps and resets `favorite`/`runCount`.
 */
export type ExportedMiniApp = Omit<MiniApp, InstanceStateFields>;

/**
 * Versioned container written to / read from disk. Holds only the portable
 * DEFINITION of each command / workflow (see {@link ExportedCommand}); the
 * importer assigns fresh ids/timestamps so re-importing the same file never
 * overwrites existing entries.
 */
export interface ProcMixExport {
  /**
   * Envelope schema version. `1` is a legacy export (no `miniapps` key); `2`
   * adds the optional `miniapps` array. Both are accepted on import.
   */
  version: number;
  exportedAt: string;
  commands: ExportedCommand[];
  workflows: ExportedWorkflow[];
  /**
   * Mini-apps (v2+). Optional so a v1 export — which predates Mini-Apps — is
   * still a valid envelope; its absence is treated as "no mini-apps".
   */
  miniapps?: ExportedMiniApp[];
}

/**
 * Strip the per-install state fields and the excluded `sound` config from a
 * command for export (keeps id).
 */
function toExportedCommand(cmd: Command): ExportedCommand {
  const {
    favorite: _favorite,
    runCount: _runCount,
    lastRunAt: _lastRunAt,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    sound: _sound,
    ...definition
  } = cmd;
  return definition;
}

/**
 * Strip the per-install state fields and the excluded `sound` config from a
 * workflow for export (keeps id).
 */
function toExportedWorkflow(wf: Workflow): ExportedWorkflow {
  const {
    favorite: _favorite,
    runCount: _runCount,
    lastRunAt: _lastRunAt,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    sound: _sound,
    ...definition
  } = wf;
  return definition;
}

/**
 * Blank the value of a `secret`-variant artifact widget; every other widget is
 * returned unchanged (including a non-secret artifact, whose value IS part of
 * the portable definition — a config path or a plain text default is exactly
 * what makes a shared mini-app usable).
 *
 * SECURITY: a `secret` artifact holds a credential the user typed (a password,
 * a token). It lives in `widgets_json` in the local SQLite DB, which is the
 * user's own machine — but an export file is a SHARE artefact: it is mailed,
 * committed, and posted. Writing the secret verbatim would leak it to every
 * recipient, so the exported widget keeps its `name`/`label`/`variant` (the
 * recipient still gets the input field, correctly typed) but carries an EMPTY
 * value they must fill in themselves. This is the export-side half of the
 * secret-artifact contract; the redaction of secret values in command output
 * is handled by the `sensitive: true` VariableSpec path in the runner.
 */
function stripSecretArtifactValue(widget: MiniAppWidget): MiniAppWidget {
  if (widget.kind === "artifact" && widget.variant === "secret") {
    return { ...widget, value: "" };
  }
  return widget;
}

/**
 * Strip the per-install state fields from a mini-app for export (keeps id —
 * the importer needs it as the reference key, then discards it for a fresh id)
 * and blank every `secret` artifact value (see
 * {@link stripSecretArtifactValue}).
 */
function toExportedMiniApp(ma: MiniApp): ExportedMiniApp {
  const {
    favorite: _favorite,
    runCount: _runCount,
    lastRunAt: _lastRunAt,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...definition
  } = ma;
  return {
    ...definition,
    widgets: definition.widgets.map(stripSecretArtifactValue),
  };
}

/**
 * Error thrown when an imported document is not a well-formed
 * `ProcMixExport`. Carries a stable `code` so the caller can decide how to
 * present it; the message is human-readable for the toast fallback.
 */
export class InvalidImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidImportError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Narrow an unknown decoded value to an `ExportedCommand` — the portable
 * definition only. Per-install state (id/favorite/runCount/timestamps) is
 * intentionally NOT required: the export strips it and the importer
 * materialises fresh values, so a valid file simply omits it. This is a
 * real type guard — no casts are used to force the type.
 */
function isExportedCommand(value: unknown): value is ExportedCommand {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.script === "string" &&
    isStringArray(value.tags)
  );
}

function isWorkflowNode(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.kind === "string";
}

function isWorkflowEdge(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    typeof value.target === "string"
  );
}

/**
 * Narrow an unknown decoded value to an `ExportedWorkflow` — the portable
 * definition only. Validates the graph shape (nodes/edges arrays of
 * well-formed entries) so a malformed file cannot slip a broken workflow
 * into the store. Per-install state is not required (see
 * {@link isExportedCommand}).
 */
function isExportedWorkflow(value: unknown): value is ExportedWorkflow {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    Array.isArray(value.nodes) &&
    value.nodes.every(isWorkflowNode) &&
    Array.isArray(value.edges) &&
    value.edges.every(isWorkflowEdge) &&
    isStringArray(value.tags)
  );
}

/**
 * Narrow an unknown decoded value to an `ExportedMiniApp` — basic shape only:
 * a string id / name and a `widgets` array (plus the `tags` string array the
 * other guards enforce). The widget tree is deep and discriminated; a full
 * structural validation belongs to the store on persist, not the file guard, so
 * a malformed widget is caught when the importer walks it rather than here.
 */
function isExportedMiniApp(value: unknown): value is ExportedMiniApp {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    Array.isArray(value.widgets) &&
    isStringArray(value.tags)
  );
}

/**
 * Type guard for the export envelope. Rejects an unknown version, missing
 * arrays, or any malformed command/workflow/mini-app inside them.
 *
 * Accepts BOTH version 1 (legacy, no `miniapps` key) and version 2 (with an
 * optional `miniapps` array) so a file exported before Mini-Apps shipped still
 * imports. When `miniapps` is present, every entry must pass the basic
 * {@link isExportedMiniApp} shape check.
 */
export function isProcMixExport(value: unknown): value is ProcMixExport {
  if (!isRecord(value)) return false;
  if (value.version !== 1 && value.version !== 2) return false;
  if (
    !Array.isArray(value.commands) ||
    !value.commands.every(isExportedCommand)
  ) {
    return false;
  }
  if (
    !Array.isArray(value.workflows) ||
    !value.workflows.every(isExportedWorkflow)
  ) {
    return false;
  }
  // `miniapps` is optional (absent on a v1 file). When present, validate every
  // entry so a malformed mini-app can't slip past the guard.
  if (
    value.miniapps !== undefined &&
    (!Array.isArray(value.miniapps) ||
      !value.miniapps.every(isExportedMiniApp))
  ) {
    return false;
  }
  return true;
}

/**
 * Serialize the current library into a `ProcMixExport` envelope and ask
 * Rust to write it to a user-chosen file.
 *
 * Resolves `true` when the file was saved, `false` when the user cancelled
 * the native dialog. A filesystem error rejects (surfaced as a toast at the
 * call site).
 *
 * `miniapps` defaults to empty: when none are present the `miniapps` key is
 * OMITTED from the file entirely (rather than written as `[]`) so a
 * mini-app-less export is byte-identical to the pre-Mini-Apps shape — a v2
 * file with no mini-apps stays compact and a reader that ignores the key sees
 * no difference.
 */
export async function exportData(
  commands: Command[],
  workflows: Workflow[],
  miniapps: MiniApp[] = [],
): Promise<boolean> {
  const envelope: ProcMixExport = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    commands: commands.map(toExportedCommand),
    workflows: workflows.map(toExportedWorkflow),
    ...(miniapps.length > 0 ? { miniapps: miniapps.map(toExportedMiniApp) } : {}),
  };
  const payload = JSON.stringify(envelope, null, 2);
  return invoke<boolean>("export_data", { payload });
}

/**
 * Ask Rust to open a file and return its contents, then parse + validate
 * into a `ProcMixExport`.
 *
 * Resolves `null` when the user cancelled the dialog. Throws
 * `InvalidImportError` when the file is not valid JSON or not a
 * well-formed export — the caller surfaces that as an error toast rather
 * than silently swallowing it.
 */
export async function importData(): Promise<ProcMixExport | null> {
  const raw = await invoke<string | null>("import_data");
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidImportError("The selected file is not valid JSON.");
  }

  if (!isProcMixExport(parsed)) {
    throw new InvalidImportError(
      "The selected file is not a valid ProcMix export.",
    );
  }
  return parsed;
}
