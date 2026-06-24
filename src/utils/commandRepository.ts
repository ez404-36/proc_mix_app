// IPC wrapper around the Rust-side `commands` table.
//
// The Rust handlers (`list_commands`, `upsert_command`, `delete_command`)
// speak `CommandRecord`, a wire-format struct that uses `null` for absent
// optional fields. The TS `Command` type uses `undefined` for the same
// fields, so this module owns the `null <-> undefined` translation as a
// single boundary. UI code only ever sees `Command` values.

import { invoke } from "@tauri-apps/api/core";
import type {
  Command,
  CommandScope,
  OutputSchema,
  Shell,
  VariableSpec,
} from "../types";

/** Scope values the Rust executor understands; used to narrow the wire string. */
const KNOWN_SCOPES: ReadonlySet<CommandScope> = new Set<CommandScope>([
  "local",
  "global",
]);

function isScope(value: string): value is CommandScope {
  return KNOWN_SCOPES.has(value as CommandScope);
}

/**
 * Set of shell identifiers the Rust executor understands. Used as a
 * type-narrowing guard when decoding a record whose `shell` column is an
 * arbitrary `string | null`. An unknown value is treated as `undefined`
 * so the executor falls back to its per-platform default.
 */
const KNOWN_SHELLS: ReadonlySet<Shell> = new Set<Shell>([
  "bash",
  "zsh",
  "fish",
  "sh",
  "pwsh",
  "powershell",
  "cmd",
]);

function isShell(value: string): value is Shell {
  return KNOWN_SHELLS.has(value as Shell);
}

/**
 * Wire format that matches the Rust `CommandRecord` struct exactly.
 * Optional fields are `T | null` (not `T | undefined`) because serde
 * serialises `Option<T>` as JSON `null` when `None`.
 */
export interface CommandRecord {
  id: string;
  name: string;
  nameKey: string | null;
  description: string | null;
  descriptionKey: string | null;
  icon: string | null;
  script: string;
  shell: string | null;
  args: string[] | null;
  workingDir: string | null;
  env: Record<string, string> | null;
  tags: string[];
  categoryId: string | null;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  runCount: number;
  /**
   * Mirror of the Rust `run_as_admin` field. May be absent on records
   * coming from old databases that predate the column — the Rust side
   * deserialises with `#[serde(default)]`, but the JSON wire type
   * itself doesn't reflect that. We make the field optional here and
   * default to `false` in {@link recordToCommand} so the rest of the
   * UI sees a strict `boolean`.
   */
  runAsAdmin?: boolean;
  /**
   * Mirror of the Rust `variables` field. Optional on the wire because
   * legacy records predate the column; the Rust side deserialises with
   * `#[serde(default)]` to an empty Vec. {@link recordToCommand}
   * normalises `null` / `undefined` to `undefined` (matching `Command`),
   * and {@link commandToRecord} omits the field entirely when the UI
   * has no variables to persist.
   */
  variables?: VariableSpec[];
  /**
   * Mirror of the Rust `output_schema` field. Optional/absent on the
   * wire because legacy records predate the column; the Rust side
   * deserialises with `#[serde(default)]` to `None` and serialises with
   * `skip_serializing_if = "Option::is_none"`. {@link commandToRecord}
   * omits it entirely when the UI has no schema.
   */
  outputSchema?: OutputSchema | null;
  /**
   * Mirror of the Rust `scope` field. Optional/absent on the wire because
   * legacy records predate the column; the Rust side persists `'global'` by
   * default. {@link recordToCommand} normalises `null` / `undefined` /
   * unknown to `"global"`.
   */
  scope?: string | null;
  /**
   * Mirror of the Rust `workflow_id` field — the owning workflow id of a
   * `"local"` command. `null` / absent for global commands.
   */
  workflowId?: string | null;
  /**
   * Mirror of the Rust `api_slug` field — the optional HTTP-API slug. `null` /
   * absent when the command has no slug. {@link commandToRecord} omits it when
   * the UI has no slug so the wire stays byte-identical to legacy payloads.
   */
  apiSlug?: string | null;
  /**
   * Mirror of the Rust `api_enabled` field. Optional/absent on the wire for
   * legacy records (the Rust side deserialises with `#[serde(default)]` to
   * `false`); {@link recordToCommand} normalises a missing value to `false`.
   */
  apiEnabled?: boolean;
}

/**
 * Convert a UI `Command` into the wire-format record sent to Rust.
 * `undefined` fields collapse to `null` so the JSON payload always has
 * an explicit value for every column.
 */
export function commandToRecord(c: Command): CommandRecord {
  return {
    id: c.id,
    name: c.name,
    nameKey: c.nameKey ?? null,
    description: c.description ?? null,
    descriptionKey: c.descriptionKey ?? null,
    icon: c.icon ?? null,
    script: c.script,
    shell: c.shell ?? null,
    args: c.args ?? null,
    workingDir: c.workingDir ?? null,
    env: c.env ?? null,
    tags: c.tags,
    categoryId: c.categoryId ?? null,
    favorite: c.favorite,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastRunAt: c.lastRunAt ?? null,
    runCount: c.runCount,
    runAsAdmin: c.runAsAdmin,
    // Pass through the variable list verbatim — the Rust side stores it
    // as a JSON column. Empty arrays round-trip cleanly; we send the
    // field through unchanged rather than collapsing to `undefined` so
    // the persistence layer can distinguish "user cleared the list"
    // from "field never set".
    ...(c.variables !== undefined ? { variables: c.variables } : {}),
    // Pass the output schema through verbatim — the Rust side stores it
    // as a JSON column. Omitted entirely when absent so the wire stays
    // byte-identical to legacy payloads for commands without a schema.
    ...(c.outputSchema !== undefined ? { outputSchema: c.outputSchema } : {}),
    // Scope: send the explicit value when set, omit otherwise. The Rust side
    // defaults an absent scope to `'global'`, so omitting it keeps the wire
    // byte-identical to legacy payloads for ordinary global commands.
    ...(c.scope !== undefined ? { scope: c.scope } : {}),
    // Owning workflow id for a local command. Omitted entirely for globals.
    ...(c.workflowId !== undefined ? { workflowId: c.workflowId } : {}),
    // HTTP-API slug: omit when absent so the wire stays byte-identical to
    // legacy payloads. An empty string is normalised to `null` (no slug) so the
    // backend's partial unique index never sees a "" collision.
    ...(c.apiSlug !== undefined
      ? { apiSlug: c.apiSlug.trim() === "" ? null : c.apiSlug.trim() }
      : {}),
    // HTTP-API opt-in. Always send so toggling it off persists.
    apiEnabled: c.apiEnabled ?? false,
  };
}

/**
 * Decode a wire-format record into a UI `Command`. Null collapses to
 * `undefined` so consumers can use `??` / `?.` idiomatically.
 */
export function recordToCommand(r: CommandRecord): Command {
  const shellValue =
    r.shell !== null && isShell(r.shell) ? r.shell : undefined;
  return {
    id: r.id,
    name: r.name,
    nameKey: r.nameKey ?? undefined,
    description: r.description ?? undefined,
    descriptionKey: r.descriptionKey ?? undefined,
    icon: r.icon ?? undefined,
    script: r.script,
    shell: shellValue,
    args: r.args ?? undefined,
    workingDir: r.workingDir ?? undefined,
    env: r.env ?? undefined,
    tags: r.tags,
    categoryId: r.categoryId ?? undefined,
    favorite: r.favorite,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastRunAt: r.lastRunAt ?? undefined,
    runCount: r.runCount,
    // Default to `false` so commands loaded from old DBs (where the
    // column didn't exist) don't accidentally inherit `undefined`.
    runAsAdmin: r.runAsAdmin ?? false,
    // `variables` collapses to `undefined` when the record carries no
    // value, an empty array, OR an explicit `null`. The UI treats
    // "command with no variables" as `undefined` for ergonomic
    // `cmd.variables?.length` checks; round-tripping
    // `commandToRecord(recordToCommand(r))` may drop the field entirely
    // for empty lists, which matches the Rust side's
    // `skip_serializing_if = "Option::is_none"` contract for absent
    // legacy data.
    variables:
      r.variables !== undefined && r.variables !== null && r.variables.length > 0
        ? r.variables
        : undefined,
    // `outputSchema` collapses to `undefined` when absent or null so the
    // UI can use `cmd.outputSchema?` idiomatically.
    outputSchema: r.outputSchema ?? undefined,
    // Default to `"global"` so commands loaded from old DBs (no column) or
    // carrying an unrecognised value are treated as ordinary library commands
    // rather than vanishing as orphaned locals.
    scope: r.scope !== null && r.scope !== undefined && isScope(r.scope)
      ? r.scope
      : "global",
    // A local command's owning workflow id; `undefined` for globals.
    workflowId: r.workflowId ?? undefined,
    // HTTP-API slug; `undefined` when the command has none.
    apiSlug: r.apiSlug ?? undefined,
    // Default to `false` so commands loaded from old DBs (no column) are not
    // accidentally treated as API-enabled.
    apiEnabled: r.apiEnabled ?? false,
  };
}

/** Load every persisted command from SQLite, oldest first. */
export async function listCommandsFromDb(): Promise<Command[]> {
  const records = await invoke<CommandRecord[]>("list_commands");
  return records.map(recordToCommand);
}

/** Insert-or-update a single command. */
export async function upsertCommandInDb(cmd: Command): Promise<void> {
  await invoke("upsert_command", { command: commandToRecord(cmd) });
}

/** Remove a command by id. Idempotent — missing ids are not an error. */
export async function deleteCommandInDb(id: string): Promise<void> {
  await invoke("delete_command", { id });
}

/**
 * Cascade-delete every `local`-scoped command owned by `workflowId`. Called
 * when a workflow is deleted so its private commands go with it. Idempotent —
 * a workflow with no local commands is a no-op.
 */
export async function deleteLocalCommandsForWorkflowInDb(
  workflowId: string,
): Promise<void> {
  await invoke("delete_local_commands_for_workflow", { workflowId });
}
