import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Command,
  ExecutionEvent,
  OutputSchema,
  VariableSpec,
} from "../types";
import { detectAdminEscalation } from "./detectAdminEscalation";

export interface RunOptions {
  workingDir?: string;
  envOverride?: Record<string, string>;
  /**
   * Optional client-supplied execution id. When provided, the Rust executor
   * uses it verbatim instead of generating a fresh UUID. This lets the caller
   * register state keyed on the id (e.g. transient marks, React refs) BEFORE
   * the IPC promise resolves — closing the race where Started events arrive
   * during the await and find no consumer ready for them.
   *
   * Used by the CommandForm live-run feature. Must be a stable, unique string;
   * prefer `crypto.randomUUID()`.
   */
  executionId?: string;
  /**
   * Per-invocation override for the elevated-spawn flag. When set, this
   * takes precedence over `cmd.runAsAdmin` — useful for live-run inside
   * the CommandForm, where the checkbox in the form may differ from the
   * persisted value. When omitted, `cmd.runAsAdmin` is used.
   */
  elevated?: boolean;
  /**
   * One-shot administrator password for this run only. When set on an
   * elevated Unix run, the Rust executor uses it for sudo's stdin and
   * does NOT touch the OS keychain. The string is forwarded verbatim
   * across the IPC boundary; the caller MUST NOT persist it via
   * `setAdminPassword` — that's the entire point of this field (the
   * "Continue without saving" flow).
   *
   * Ignored when `elevated` resolves to false or on Windows (UAC).
   */
  adminPassword?: string;
  /**
   * Pre-collected values for every `${name}` reference in the command's
   * `script`, `args`, `workingDir`, or `env`. The Rust parser merges
   * this map with each spec's `defaultValue` (caller-supplied wins),
   * then substitutes the template before spawning the child.
   *
   * Callers MUST pass an explicit object — even `{}` — rather than
   * `undefined`. This forces every call-site to decide whether values
   * were collected (UI prompt, programmatic) or there are no variables
   * to collect, instead of silently relying on a fallback. The Rust
   * `#[serde(default)]` on the field handles wire-level absence, but
   * the JS type contract is intentionally stricter.
   */
  variableValues: Record<string, string>;
}

interface ExecuteRequestPayload {
  script: string;
  shell?: string;
  args?: string[];
  workingDir?: string;
  env?: Record<string, string>;
  commandId?: string;
  executionId?: string;
  /**
   * Mirrors `ExecuteRequest.elevated` on the Rust side. Omitted (rather
   * than sent as `false`) when the run is non-elevated, so existing
   * payloads in the wild stay byte-identical.
   */
  elevated?: boolean;
  /**
   * Mirrors `ExecuteRequest.admin_password` on the Rust side. Omitted
   * when the caller wants the executor to fall back to the keychain —
   * see `RunOptions.adminPassword` for the threat model and intended
   * use.
   */
  adminPassword?: string;
  /**
   * Mirrors `ExecuteRequest.variables` on the Rust side. The list of
   * `${name}` specs declared on the command — the parser consults each
   * spec's `defaultValue` when the caller's `variableValues` is missing
   * an entry. Omitted from the payload when the command has no
   * variables so the wire stays byte-identical for legacy commands.
   */
  variables?: VariableSpec[];
  /**
   * Mirrors `ExecuteRequest.variable_values` on the Rust side. Per-run
   * map of values (merged caller input + UI prompt results). Omitted
   * from the payload when empty so the wire stays byte-identical for
   * commands without parameterisation.
   */
  variableValues?: Record<string, string>;
  /**
   * Mirrors `ExecuteRequest.timeout_seconds` on the Rust side. When set,
   * the executor kills the spawned process after this many seconds.
   * Omitted from the payload when absent so the wire stays byte-identical
   * for commands without a timeout.
   */
  timeoutSeconds?: number;
  /**
   * Mirrors `ExecuteRequest.output_schema` on the Rust side. When set,
   * the executor buffers stdout, runs the extractor after the child
   * finishes, and emits a `result` event with the parsed fields. Omitted
   * from the payload when the command has no schema so the wire stays
   * byte-identical for commands without output parsing.
   */
  outputSchema?: OutputSchema;
}

function buildEnv(
  cmd: Command,
  override?: Record<string, string>,
): Record<string, string> | undefined {
  if (!cmd.env && !override) return undefined;
  return { ...(cmd.env ?? {}), ...(override ?? {}) };
}

export async function runCommand(
  cmd: Command,
  opts: RunOptions,
): Promise<string> {
  // Resolve elevation at the execution boundary so EVERY entry point
  // (Library, palette, hotkey, tray, live-run) agrees.
  //
  // Precedence:
  //   1. `opts.elevated` — the CommandForm live-run override, honouring
  //      the unsaved checkbox before Save.
  //   2. `cmd.runAsAdmin` — the persisted flag.
  //   3. Inline-escalation detection on the script body.
  //
  // (3) is the fix for the imported-command failure: import forces
  // `runAsAdmin: false` (security — never arrive pre-armed), but a
  // script that begins with `sudo`/`doas`/`pkexec` WILL escalate
  // regardless. Without this, such a command ran on the non-elevated
  // path whose child has `Stdio::null()` stdin and no TTY, so the
  // inline `sudo` died with "a terminal is required to read the
  // password". Routing it through the backend's `sudo -S` path feeds
  // the keychain password on stdin; the now-root inner `sudo` no longer
  // prompts. The CommandForm checkbox auto-detect (useAdminEscalation)
  // only covers the editing surface — this covers direct runs.
  const elevated =
    opts.elevated ?? (cmd.runAsAdmin || detectAdminEscalation(cmd.script));
  // The one-shot password is only meaningful when the run is actually
  // elevated. We deliberately drop it otherwise so a stale value can't
  // leak into a non-admin payload — defence in depth against a future
  // caller that mis-uses RunOptions.
  const adminPassword =
    elevated && opts.adminPassword ? opts.adminPassword : undefined;
  // Trim out empty containers for the wire shape: commands without
  // variables / values continue to send the same JSON as before this
  // feature existed. Object spread + a `keys().length` check is the
  // simplest way to express "omit when empty without ever sending the
  // key as null".
  const variables: VariableSpec[] | undefined =
    cmd.variables && cmd.variables.length > 0 ? cmd.variables : undefined;
  const variableValues: Record<string, string> | undefined =
    Object.keys(opts.variableValues).length > 0 ? opts.variableValues : undefined;
  const req: ExecuteRequestPayload = {
    script: cmd.script,
    shell: cmd.shell,
    args: cmd.args,
    workingDir: opts.workingDir ?? cmd.workingDir,
    env: buildEnv(cmd, opts.envOverride),
    commandId: cmd.id,
    executionId: opts.executionId,
    // Only include the field when true so a non-elevated payload is
    // byte-identical to what we sent before the feature existed.
    ...(elevated ? { elevated: true } : {}),
    // Likewise omit the adminPassword key entirely when absent so
    // non-elevated / keychain-backed runs stay byte-identical to the
    // pre-feature payloads.
    ...(adminPassword ? { adminPassword } : {}),
    ...(variables ? { variables } : {}),
    ...(variableValues ? { variableValues } : {}),
    ...(cmd.timeoutSeconds !== undefined ? { timeoutSeconds: cmd.timeoutSeconds } : {}),
    ...(cmd.outputSchema !== undefined ? { outputSchema: cmd.outputSchema } : {}),
  };
  return invoke<string>("execute_command", { req });
}

export async function cancelExecution(executionId: string): Promise<void> {
  await invoke("cancel_execution", { executionId });
}

export async function listRunningExecutions(): Promise<string[]> {
  return invoke<string[]>("list_running_executions");
}

/**
 * Module-level subscription state. One global `listen()` Promise is started
 * the first time anyone imports this module. All consumers register handlers
 * into a shared Set, so the Tauri-side listener is created exactly once and
 * is live before any user interaction can trigger an execution.
 *
 * This is the fix for the race where `useExecutionBridge` was registering
 * `listen()` inside a useEffect: with the seed-bootstrap added, users could
 * click Run before the listen Promise resolved, dropping every event.
 */
let unlistenPromise: Promise<UnlistenFn> | null = null;
const handlers = new Set<(e: ExecutionEvent) => void>();

function ensureSubscribed(): Promise<UnlistenFn> {
  if (unlistenPromise) {
    return unlistenPromise;
  }
  unlistenPromise = listen<ExecutionEvent>("execution-event", (event) => {
    for (const h of handlers) h(event.payload);
  });
  unlistenPromise.catch((err) => {
    console.error("execution-event listener failed to attach:", err);
  });
  return unlistenPromise;
}

// Start subscribing immediately when this module loads. The Promise is
// retained in `unlistenPromise`; we don't need its resolution here.
void ensureSubscribed();

/**
 * Register a handler for execution events. Returns the unsubscribe function
 * synchronously — the handler is added to the in-memory Set immediately, and
 * the global Tauri listener (set up at module load via `void
 * ensureSubscribed()`) is the only thing that needs to be awaited. Use
 * `awaitBridgeReady()` separately if you need to block on listener readiness.
 *
 * Returning the unsub synchronously is important: under React StrictMode the
 * effect runs twice with the same `handleEvent` reference. If the unsub were
 * delivered via a Promise, the first effect's cleanup could fire before its
 * `.then()` resolved, leaving `cleanup = null` and letting the late `.then()`
 * decide to call `unlisten()` based on its own stale `active` flag — which
 * would then delete the only entry from the deduplicated Set, dropping every
 * subsequent event. Sync return removes that race entirely.
 */
export function subscribeExecutionEvents(
  handler: (e: ExecutionEvent) => void,
): () => void {
  handlers.add(handler);
  // Make sure the global listener bootstrap is in-flight (idempotent).
  void ensureSubscribed();
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Resolves once the global execution-event listener is live on the Tauri
 * side. Callers should await this before invoking any command that emits
 * events, otherwise early events can be dropped.
 */
export async function awaitBridgeReady(): Promise<void> {
  await ensureSubscribed();
}
