import { Message } from "@arco-design/web-react";
import i18n from "../i18n";
import type {
  Command,
  ExecutionVariable,
  HistoryEvent,
  VariableSpec,
} from "../types";
import { useCommandStore } from "../stores/commandStore";
import { useExecutionStore } from "../stores/executionStore";
import {
  isAdminPasswordRequiredError,
  setAdminPassword,
} from "../utils/adminPassword";
import { promptForAdminPassword } from "../utils/adminPasswordPrompt";
import { getCommandName } from "../utils/commandLabels";
import {
  awaitBridgeReady,
  runCommand as invokeRun,
  type RunOptions,
} from "../utils/executor";
import { detectAdminEscalation } from "../utils/detectAdminEscalation";
import {
  recordHistoryEventInDb,
  updateRunHistoryEventInDb,
} from "../utils/historyRepository";
import { isTransient } from "../utils/transientExecutions";
import { scriptReferencesEscalationTool } from "../utils/utilityName";
import { promptForVariables } from "../utils/variablePrompt";
import { promptForWorkingDir } from "../utils/workingDirPrompt";

/**
 * Generate a UUID-like id. Falls back to a timestamped pseudo-random
 * string when `crypto.randomUUID` is missing (Node test runners that
 * polyfill `crypto` minimally; never the actual browser/runtime).
 */
function makeHistoryEventId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `evt-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Generate a client-side execution id, forwarded to the Rust executor so
 * the run is registered (store + history) BEFORE the process is spawned —
 * see the comment at the call site for the race this closes. Same UUID
 * source as {@link makeHistoryEventId} with a distinct prefix in the
 * fallback so the two id spaces never collide in test runners.
 */
function makeExecutionId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `exec-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Insert a `commandRun(status=running)` row in history. Returns a
 * Promise so the caller can `await` the insert before returning the
 * executionId — this guarantees the row exists by the time
 * `useExecutionBridge` receives the first `Finished` / `Cancelled`
 * event and calls `updateRunHistoryEventInDb`. Without the await a
 * fast-completing command races the insert and the update finds no
 * row, leaving the entry stuck on `status: "running"` forever.
 *
 * The caller still wraps the call in a try/catch so a history-write
 * failure cannot abort the user's run — but the normal path awaits
 * the insert to close the race window.
 *
 * Transient runs (CommandForm live-run, identified by `isTransient`)
 * are intentionally NOT logged: the live-run is a draft action, not
 * a saved command invocation, and showing it in history would surprise
 * the user.
 */
async function recordRunStart(
  executionId: string,
  commandId: string,
  commandName: string,
): Promise<void> {
  if (isTransient(executionId)) return;
  const event: HistoryEvent = {
    id: makeHistoryEventId(),
    createdAt: new Date().toISOString(),
    kind: "commandRun",
    commandId,
    commandName,
    executionId,
    status: "running",
  };
  await recordHistoryEventInDb(event);
}

/**
 * Build the final `variableValues` map for a run. Resolution order:
 *   1. Spec defaults — every spec whose `defaultValue !== undefined`
 *      (including the empty string) contributes its default.
 *   2. Caller-supplied values — override defaults from step 1.
 *   3. Prompt result — overrides everything (the user explicitly
 *      filled the value in the modal).
 *
 * The prompt is opened for a spec when EITHER:
 *   - it has no caller-supplied value AND no default (legacy
 *     "implicit prompt" case), OR
 *   - it has no caller-supplied value AND `promptAtRuntime === true`
 *     (explicit "always ask the user, but pre-fill with the default"
 *     case — added so a spec can declare both a default value and a
 *     prompt that uses the default as a pre-fill suggestion).
 *
 * Caller-supplied values are still honored unconditionally — a script
 * triggered programmatically with `{ name: 'value' }` skips the prompt
 * for that spec regardless of `promptAtRuntime`. This preserves the
 * non-interactive run path (workflows, schedules) which must never
 * block on a modal.
 */
export async function resolveVariableValues(
  cmd: Command,
  callerSupplied: Record<string, string>,
): Promise<Record<string, string> | null> {
  const specs: ReadonlyArray<VariableSpec> = cmd.variables ?? [];
  const merged: Record<string, string> = {};
  const specsNeedingPrompt: VariableSpec[] = [];
  // Pre-fill values passed to the prompt modal so the user sees the
  // spec's default in each input as a starting point. Only populated
  // for specs that will actually be prompted.
  const promptPreset: Record<string, string> = {};
  for (const spec of specs) {
    if (spec.defaultValue !== undefined) {
      // Empty-string defaults are preserved here — only `undefined`
      // (key absent) triggers an implicit prompt. See VariableSpec docs.
      merged[spec.name] = spec.defaultValue;
    }
    if (callerSupplied[spec.name] !== undefined) {
      // Caller value short-circuits prompting for this spec.
      continue;
    }
    const mustPrompt =
      spec.defaultValue === undefined || spec.promptAtRuntime === true;
    if (mustPrompt) {
      specsNeedingPrompt.push(spec);
      if (spec.defaultValue !== undefined) {
        promptPreset[spec.name] = spec.defaultValue;
      }
    }
  }
  // Layer caller-supplied values on top of defaults so callers can
  // override a spec default programmatically.
  for (const key of Object.keys(callerSupplied)) {
    merged[key] = callerSupplied[key] as string;
  }
  if (specsNeedingPrompt.length === 0) {
    return merged;
  }
  const promptResult = await promptForVariables(
    specsNeedingPrompt,
    promptPreset,
  );
  if (promptResult === null) {
    return null;
  }
  // Prompt result wins over defaults; caller-supplied values were
  // already merged above and the prompt only covered specs the
  // caller did NOT supply, so there's no override conflict here.
  for (const key of Object.keys(promptResult)) {
    merged[key] = promptResult[key] as string;
  }
  return merged;
}

/**
 * Build the display-ready variable list captured on an Execution. One entry
 * per declared spec, in declaration order, carrying the value the run was
 * started with (resolved defaults + caller-supplied + prompt). Values for
 * specs flagged `sensitive` are masked to "***" so the OutputPanel never
 * renders a secret. Specs with no resolved value are skipped — there is
 * nothing meaningful to show for them.
 *
 * Returns `undefined` when the command declares no variables, so the
 * Execution field stays absent (and the panel renders nothing) for plain
 * commands.
 */
function buildExecutionVariables(
  cmd: Command,
  values: Record<string, string>,
): ExecutionVariable[] | undefined {
  const specs = cmd.variables ?? [];
  if (specs.length === 0) return undefined;
  const list: ExecutionVariable[] = [];
  for (const spec of specs) {
    const value = values[spec.name];
    if (value === undefined) continue;
    const sensitive = spec.sensitive === true;
    list.push({
      name: spec.name,
      value: sensitive ? "***" : value,
      sensitive,
    });
  }
  return list.length > 0 ? list : undefined;
}

/**
 * Trigger a command and pre-register the execution in the store so that the
 * output panel opens immediately. The execution-event bridge later receives
 * the real `started` event with the same execution id, which is a no-op
 * because startExecution is idempotent on the same id.
 *
 * Bridge readiness is awaited BEFORE the IPC invoke so that the Tauri-side
 * "execution-event" listener is guaranteed to be live by the time Rust emits
 * the first `Started`/`Stdout`/`Stderr`/`Finished` event. Without this gate
 * the listener registration could lose the race with very fast scripts (or
 * with a slow `useSeedBootstrap` blocking React mount), dropping all events
 * and leaving the OutputPanel stuck on "waiting for output".
 *
 * Admin-password sentinel: if the run requires sudo and the keychain is
 * empty, Rust returns the literal "ADMIN_PASSWORD_REQUIRED" error. We
 * detect that exactly once, open the password prompt, and retry the
 * run. The prompt result decides whether the entered password is
 * persisted to the OS keychain ("Save & continue", `remember: true`)
 * or used one-shot via the IPC payload ("Continue", `remember: false`).
 * If the SECOND attempt still raises the sentinel — e.g. the user
 * typed a wrong password and sudo rejected it — we surface a localized
 * "wrong password" toast and stop, never recursing.
 */
/**
 * Advisory for the Class B escalation gap: a script that invokes
 * `sudo`/`doas`/`pkexec` in a position we do NOT auto-elevate (after a
 * `&&`/`|`/`;`, in a subshell, or on a later line). Such a run goes
 * down the non-elevated path — the child has `Stdio::null()` stdin and
 * no controlling TTY — so the inline escalation tool dies with the
 * cryptic "a terminal is required to read the password".
 *
 * We deliberately do NOT auto-elevate these (wrapping the whole line in
 * an outer `sudo -S` would silently elevate the leading command the
 * user chose to keep unprivileged — a behaviour/security regression).
 * Instead we show a one-time, locale-aware hint pointing the user at
 * the proper fix.
 *
 * Returns `true` when the advisory applies, so the caller can decide
 * whether to surface it (it does NOT block the run — the user may know
 * exactly what they're doing).
 */
function shouldAdviseInlineEscalation(
  cmd: Command,
  resolvedElevated: boolean,
): boolean {
  if (resolvedElevated) return false;
  // Leading-position escalation is already auto-elevated by
  // `runCommand` (executor.ts), so it never reaches the failing path.
  if (detectAdminEscalation(cmd.script)) return false;
  return scriptReferencesEscalationTool(cmd.script);
}

export async function triggerCommandRun(
  cmd: Command,
  opts?: RunOptions,
): Promise<string | null> {
  // Resolve the user-facing name once at execution start so the OutputPanel
  // and recent-runs list show the localized label. We read `i18n.t` directly
  // because this helper runs outside the React component tree.
  const displayName = getCommandName(cmd, i18n.t);

  // Variable resolution happens BEFORE any IPC, BEFORE we register the
  // run in the execution store. If the user cancels the prompt we
  // return null straight away, exactly like the admin-password cancel
  // path. The resolved map is merged in via `mergedVariableValues`
  // below so the sentinel-retry branch sees the same values too.
  const callerSupplied = opts?.variableValues ?? {};
  const mergedVariableValues = await resolveVariableValues(
    cmd,
    callerSupplied,
  );
  if (mergedVariableValues === null) {
    // User cancelled the variable prompt. Drop the run silently —
    // matches `promptForAdminPassword`'s cancel semantics.
    return null;
  }

  // Working-directory prompt. Only shown when the command has
  // `promptWorkingDir: true` AND the caller hasn't already supplied a
  // `workingDir` override via RunOptions. Pre-fills with the stored
  // `cmd.workingDir` value (or empty string when unset) so the user can
  // edit an existing path rather than re-type it from scratch.
  let resolvedWorkingDir = opts?.workingDir;
  if (cmd.promptWorkingDir && resolvedWorkingDir === undefined) {
    const prompted = await promptForWorkingDir(cmd.workingDir ?? "");
    if (prompted === null) {
      // User cancelled — abort the run silently.
      return null;
    }
    // Empty string means "use the default" — pass undefined so executor
    // falls back to home dir, matching what an unset workingDir does.
    resolvedWorkingDir = prompted !== "" ? prompted : undefined;
  }

  // Pre-generate the execution id on the CLIENT (unless the caller
  // supplied one, e.g. the CommandForm live-run / OutputPanel re-run) so
  // we can register the store execution AND insert the history row BEFORE
  // spawning the process. Without this, a fast command (`ls -la ~`) emits
  // its `finished` event before the post-invoke insert lands, so
  // `update_run_event` finds no row → the history entry is stuck on
  // `status: "running"` forever. The Rust executor honours a caller-supplied
  // `executionId` verbatim (see `core/executor/mod.rs`), so the events it
  // later emits carry this exact id and merge into the row/execution we
  // register here.
  const executionId = opts?.executionId ?? makeExecutionId();

  const executionVariables = buildExecutionVariables(
    cmd,
    mergedVariableValues as Record<string, string>,
  );

  // Register the run + insert the history row up front, so both exist
  // before any execution event can arrive. `startExecution` is idempotent
  // on the id (the real `started` event merges into it), and the history
  // insert is awaited before the invoke so the later `finished` update
  // always finds the row. A history-write failure must NOT abort the run,
  // so it is caught and logged.
  let historyRecorded = false;

  // Inner helper so the sentinel-retry branch can reuse the bridge-wait
  // + invoke sequence without duplicating it (and without re-inserting the
  // history row / re-registering the execution). The retry overlays a fresh
  // `adminPassword` (one-shot path) on top of the caller's original options
  // without mutating them.
  //
  // `variableValues` is required by the executor wrapper, so we always
  // pass the merged map computed above (defaults + caller + prompt). The
  // pinned `executionId` is forced so the retry reuses the same id.
  async function attempt(runOpts?: RunOptions): Promise<string> {
    await awaitBridgeReady();
    const baseOpts: RunOptions = runOpts ?? { variableValues: {} };
    const optsWithVars: RunOptions = {
      ...baseOpts,
      variableValues: mergedVariableValues as Record<string, string>,
      executionId,
    };

    // Pre-register on the FIRST attempt only — the sentinel retry must not
    // duplicate the store entry or the history row.
    if (!historyRecorded) {
      useExecutionStore
        .getState()
        .startExecution(
          executionId,
          cmd.id,
          displayName,
          cmd.script,
          cmd.shell,
          executionVariables,
          cmd.env,
          Object.keys(mergedVariableValues as Record<string, string>).length > 0
            ? (mergedVariableValues as Record<string, string>)
            : undefined,
        );
      useCommandStore.getState().markCommandRun(cmd.id);
      try {
        await recordRunStart(executionId, cmd.id, displayName);
      } catch (histErr: unknown) {
        console.error("failed to record commandRun history event", histErr);
      }
      historyRecorded = true;
    }

    await invokeRun(cmd, optsWithVars);
    return executionId;
  }

  // Finalize a run that was pre-registered (store + history row marked
  // "running") but never actually spawned — e.g. the user cancelled the
  // admin-password prompt, a one-shot password was wrong, or the launch
  // failed. Without this the pre-registered execution would hang on
  // "running" forever (the exact bug pre-registration otherwise prevents).
  // No-op when nothing was pre-registered (e.g. variable-prompt cancel,
  // which returns before `attempt`).
  function finalizeAbandonedRun(): void {
    if (!historyRecorded) return;
    useExecutionStore.getState().finishExecution(executionId, {
      status: "cancelled",
      exitCode: null,
      durationMs: undefined,
      finishedAt: Date.now(),
      error: undefined,
    });
    if (!isTransient(executionId)) {
      void updateRunHistoryEventInDb(
        executionId,
        undefined,
        undefined,
        "cancelled",
      ).catch((err: unknown) => {
        console.error("failed to finalize abandoned run", executionId, err);
      });
    }
  }

  // Class B advisory: warn (don't block) when the script escalates in a
  // non-leading position that we can't safely auto-elevate, so the user
  // gets an actionable hint instead of the raw sudo "terminal required"
  // error buried in the output. `resolvedElevated` mirrors executor.ts:
  // an explicit override wins, else the persisted flag. The leading-sudo
  // case is excluded inside the helper (it's already auto-elevated).
  const resolvedElevated = opts?.elevated ?? cmd.runAsAdmin;
  if (shouldAdviseInlineEscalation(cmd, resolvedElevated)) {
    Message.warning(
      i18n.t("runCommand.inlineEscalationHint", {
        defaultValue:
          "This command runs sudo internally but isn't elevated. Move sudo to the start of the script, or enable “Run as administrator”.",
      }),
    );
  }

  // Merge the (possibly prompt-resolved) working dir into the options so
  // `attempt` and any sentinel-retry branch see the same value.
  const optsWithDir: RunOptions | undefined =
    resolvedWorkingDir !== opts?.workingDir
      ? { ...(opts ?? { variableValues: {} }), workingDir: resolvedWorkingDir }
      : opts;

  try {
    return await attempt(optsWithDir);
  } catch (err) {
    if (isAdminPasswordRequiredError(err)) {
      // First time the user runs an admin-flagged command on a fresh
      // install (or the user previously cleared the keychain entry).
      // Open the modal, then choose between two flows:
      //
      //   - remember=true  → persist via setAdminPassword, then retry
      //     with the caller's original options (the executor reads
      //     the password from the keychain).
      //   - remember=false → skip persistence, retry with the password
      //     attached to RunOptions so the Rust side uses it one-shot
      //     and never touches the keychain.
      //
      // A second sentinel from the retry means sudo rejected the
      // password — we report and bail rather than looping.
      const promptResult = await promptForAdminPassword();
      if (promptResult === null) {
        // User cancelled — quiet exit, no toast (they're aware). Finalize
        // the pre-registered run so it doesn't hang on "running".
        finalizeAbandonedRun();
        return null;
      }
      let retryOpts: RunOptions | undefined = optsWithDir;
      if (promptResult.remember) {
        try {
          await setAdminPassword(promptResult.password);
        } catch (saveErr) {
          const saveMsg =
            saveErr instanceof Error ? saveErr.message : String(saveErr);
          Message.error(
            `${i18n.t("runCommand.adminPasswordSaveFailed", {
              defaultValue: "Failed to save admin password",
            })}: ${saveMsg}`,
          );
          finalizeAbandonedRun();
          return null;
        }
      } else {
        // One-shot path: do NOT call setAdminPassword. Forward the
        // password via RunOptions so executor.ts attaches it to the
        // IPC payload as `adminPassword`. The Rust executor prefers
        // this value over the keychain.
        retryOpts = {
          ...(optsWithDir ?? { variableValues: {} }),
          variableValues: optsWithDir?.variableValues ?? {},
          adminPassword: promptResult.password,
        };
      }
      try {
        return await attempt(retryOpts);
      } catch (retryErr) {
        if (isAdminPasswordRequiredError(retryErr)) {
          // sudo rejected the password. Could be a typo on either
          // flow. Do NOT auto-clear the keychain — the user can retry
          // from Settings if they want to change a saved value.
          Message.error(
            i18n.t("runCommand.adminPasswordRejected", {
              defaultValue: "Wrong administrator password — please try again",
            }),
          );
          finalizeAbandonedRun();
          return null;
        }
        const retryMsg =
          retryErr instanceof Error ? retryErr.message : String(retryErr);
        Message.error(`Failed to run "${displayName}": ${retryMsg}`);
        finalizeAbandonedRun();
        return null;
      }
    }

    const message = err instanceof Error ? err.message : String(err);
    Message.error(`Failed to run "${displayName}": ${message}`);
    finalizeAbandonedRun();
    return null;
  }
}
