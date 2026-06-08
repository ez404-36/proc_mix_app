// Import / Export service layer for Commands and Workflows.
//
// The Rust `export_data` / `import_data` commands handle only the native
// file dialog + raw file IO (passing the document as an opaque String).
// All serialization and validation lives here, where the `Command` /
// `Workflow` app types are defined — so the Rust side never duplicates the
// DTO shapes. Components MUST go through this module rather than calling
// `invoke` directly.

import { invoke } from "@tauri-apps/api/core";
import type { Command, Workflow } from "../types";

/** Current export-envelope schema version. Bump on a breaking change. */
export const EXPORT_VERSION = 1 as const;

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
 * Portable, definition-only shapes written to disk: a `Command` /
 * `Workflow` minus the per-install {@link InstanceStateFields}. The
 * importer re-stamps id/timestamps and resets favourite/runCount.
 */
export type ExportedCommand = Omit<Command, InstanceStateFields>;
export type ExportedWorkflow = Omit<Workflow, InstanceStateFields>;

/**
 * Versioned container written to / read from disk. Holds only the portable
 * DEFINITION of each command / workflow (see {@link ExportedCommand}); the
 * importer assigns fresh ids/timestamps so re-importing the same file never
 * overwrites existing entries.
 */
export interface ProcMixExport {
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  commands: ExportedCommand[];
  workflows: ExportedWorkflow[];
}

/** Strip the per-install state fields from a command for export (keeps id). */
function toExportedCommand(cmd: Command): ExportedCommand {
  const {
    favorite: _favorite,
    runCount: _runCount,
    lastRunAt: _lastRunAt,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...definition
  } = cmd;
  return definition;
}

/** Strip the per-install state fields from a workflow for export (keeps id). */
function toExportedWorkflow(wf: Workflow): ExportedWorkflow {
  const {
    favorite: _favorite,
    runCount: _runCount,
    lastRunAt: _lastRunAt,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...definition
  } = wf;
  return definition;
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
 * Type guard for the export envelope. Rejects the wrong version, missing
 * arrays, or any malformed command/workflow inside them.
 */
export function isProcMixExport(value: unknown): value is ProcMixExport {
  if (!isRecord(value)) return false;
  if (value.version !== EXPORT_VERSION) return false;
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
  return true;
}

/**
 * Serialize the current library into a `ProcMixExport` envelope and ask
 * Rust to write it to a user-chosen file.
 *
 * Resolves `true` when the file was saved, `false` when the user cancelled
 * the native dialog. A filesystem error rejects (surfaced as a toast at the
 * call site).
 */
export async function exportData(
  commands: Command[],
  workflows: Workflow[],
): Promise<boolean> {
  const envelope: ProcMixExport = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    commands: commands.map(toExportedCommand),
    workflows: workflows.map(toExportedWorkflow),
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
