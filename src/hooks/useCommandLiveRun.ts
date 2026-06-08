import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import { Message } from "@arco-design/web-react";

import type { Command, Execution, ExecutionEvent } from "../types";
import {
  isAdminPasswordRequiredError,
  setAdminPassword,
} from "../utils/adminPassword";
import { promptForAdminPassword } from "../utils/adminPasswordPrompt";
import {
  cancelExecution,
  runCommand,
  subscribeExecutionEvents,
} from "../utils/executor";
import {
  resolveVariableValues,
  triggerCommandRun,
} from "../services/commandRunner";
import { useExecutionStore } from "../stores/executionStore";
import { markTransient, unmarkTransient } from "../utils/transientExecutions";
import {
  CANCEL_GRACE_MS,
  CANCEL_FALLBACK_MS,
  envRowsToRecord,
  INITIAL_RUN_RESULT,
  parseTimeoutSeconds,
  rowsToVariableSpecs,
} from "../utils/commandFormState";
import type { FormState, RunResult, RunStatus } from "../types/commandForm";

export interface UseCommandLiveRunOptions {
  /** The command being edited (or null in create mode) — used by the
   *  global-console run path for a stable id and name. */
  command: Command | null;
  /** Where a test run's output is shown — see CommandFormProps. */
  runTarget: "embedded" | "global";
  /** Refresh hook from `useAdminEscalation` so the live-run can update the
   *  "password stored?" hint immediately after persisting one. */
  setAdminPasswordStored: Dispatch<SetStateAction<boolean>>;
  t: TFunction;
}

export interface UseCommandLiveRunResult {
  /** Embedded live-run accumulated result. */
  runResult: RunResult;
  /** Sticky collapse state for the embedded output panel. */
  outputCollapsed: boolean;
  setOutputCollapsed: Dispatch<SetStateAction<boolean>>;
  /** Tracked global-console execution record (global run target). */
  globalExecution: Execution | undefined;
  /** True while the tracked global-console run is running/pending. */
  isGlobalRunning: boolean;
  /** Start an embedded live-run for the current form state. */
  run: () => Promise<void>;
  /** Cancel the in-flight embedded run. */
  cancel: () => void;
  /** Clear the embedded output panel. */
  clear: () => void;
  /** Run the current form on the app-wide console (global target). */
  runGlobal: () => Promise<void>;
  /** Cancel the in-flight global-console run. */
  cancelGlobal: () => void;
  /** Reset embedded run state to idle (used on open-target change). */
  resetRun: () => void;
  /**
   * Cancel an active embedded run from the save path (best-effort) without
   * waiting. Reproduces CommandForm.handleSave's cancel block. Does NOT
   * call teardownRun — callers invoke {@link teardownRun} explicitly.
   */
  cancelActiveRunForSave: () => void;
  /**
   * Tear down the in-flight live-run (unsubscribe, unmark transient, clear
   * fallback timer). Safe to call multiple times.
   */
  teardownRun: () => void;
  /**
   * Close-with-guard: cancel any in-flight embedded run, then invoke
   * `onClose`, waiting up to CANCEL_GRACE_MS when a run was active.
   * Reproduces CommandForm.requestClose verbatim.
   */
  closeWithRunGuard: (onClose: () => void) => void;
}

/**
 * Owns the command form's live-run lifecycle for both run targets:
 *   - embedded: the inline `LiveRunOutput` panel, driven by direct
 *     `subscribeExecutionEvents` plumbing and an admin-password sentinel
 *     retry loop.
 *   - global: routes through `triggerCommandRun` onto the app-wide console
 *     and tracks status via the execution store.
 *
 * Extracted from CommandForm so the container is a thin composition (SRP).
 * The critical side-effect ordering inside `run` (pin ref → markTransient →
 * subscribe → invoke) is preserved verbatim.
 */
export function useCommandLiveRun(
  form: FormState,
  opts: UseCommandLiveRunOptions,
): UseCommandLiveRunResult {
  // `runTarget` is part of the options contract (callers branch on it in
  // their JSX) but the hook itself supports both targets unconditionally,
  // so it is not destructured here.
  const { command, setAdminPasswordStored, t } = opts;

  // Live-run state. `runResult` accumulates events from the spawned
  // process; `outputCollapsed` is sticky once expanded so subsequent
  // runs don't keep collapsing/expanding the panel.
  const [runResult, setRunResult] = useState<RunResult>(INITIAL_RUN_RESULT);
  const [outputCollapsed, setOutputCollapsed] = useState<boolean>(true);

  /** Currently in-flight execution id, captured in a ref so it is
   *  available synchronously inside the event handler and to the
   *  unmount cleanup without re-running effect deps on every change. */
  const runIdRef = useRef<string | null>(null);
  /** Unsubscribe function for the in-flight run's event handler. */
  const runUnsubRef = useRef<(() => void) | null>(null);
  /** Pending fallback timer started by `handleCancel`. */
  const cancelTimerRef = useRef<number | null>(null);
  /** Ref mirror of `runResult.status` so async callbacks (cleanup) can
   *  read the latest value without re-creating the close handler. */
  const runStatusRef = useRef<RunStatus>("idle");
  useEffect(() => {
    runStatusRef.current = runResult.status;
  }, [runResult.status]);
  /** Ref mirror of `form.envRows` so the run callbacks always see the
   *  latest value without `form.envRows` (an unstable array reference)
   *  appearing in the `useCallback` dep arrays — which would recreate
   *  the callbacks on every render and could disrupt in-flight runs. */
  const envRowsRef = useRef(form.envRows);
  useEffect(() => {
    envRowsRef.current = form.envRows;
  }, [form.envRows]);

  // --- Global-console run target (runTarget === "global") -------------
  // When the host routes runs to the app-wide console, we track the
  // launched execution id here and read its live status from the
  // execution store. The embedded `runResult` machinery above is left
  // untouched (and unused in this mode) so the component supports both
  // targets without forking its event plumbing.
  const [globalRunId, setGlobalRunId] = useState<string | null>(null);
  const globalExecution = useExecutionStore((s) =>
    globalRunId ? s.executions[globalRunId] : undefined,
  );
  const globalRunStatus = globalExecution?.status;
  const isGlobalRunning =
    globalRunStatus === "running" || globalRunStatus === "pending";

  /**
   * Tear down the in-flight live-run, if any. Removes the event handler
   * from the executor fan-out, clears the transient mark so future runs
   * with a new id route normally, and clears any pending fallback timer.
   * Safe to call multiple times.
   */
  const teardownRun = useCallback((): void => {
    if (runUnsubRef.current) {
      runUnsubRef.current();
      runUnsubRef.current = null;
    }
    if (runIdRef.current) {
      unmarkTransient(runIdRef.current);
      runIdRef.current = null;
    }
    if (cancelTimerRef.current !== null) {
      window.clearTimeout(cancelTimerRef.current);
      cancelTimerRef.current = null;
    }
  }, []);

  const handleClearOutput = useCallback((): void => {
    // Clear only the visible lines and terminal metadata; if a run is
    // still in flight we keep status `running` so the user sees the
    // panel update with fresh output as it arrives.
    setRunResult((prev) =>
      prev.status === "running"
        ? { ...prev, lines: [] }
        : INITIAL_RUN_RESULT,
    );
  }, []);

  /**
   * Cancel the in-flight run. The executor emits a `cancelled` event
   * which our handler turns into the terminal state. To guard against
   * a missing/dropped event we also start a fallback timer that
   * force-transitions to `cancelled` after `CANCEL_FALLBACK_MS`.
   */
  const handleCancel = useCallback((): void => {
    const id = runIdRef.current;
    if (!id) return;
    cancelExecution(id).catch((err) => {
      console.error("Failed to cancel transient execution:", err);
    });
    if (cancelTimerRef.current !== null) {
      window.clearTimeout(cancelTimerRef.current);
    }
    cancelTimerRef.current = window.setTimeout(() => {
      cancelTimerRef.current = null;
      // Only force-transition if we're still running — otherwise the
      // executor's terminal event already cleaned up.
      if (runStatusRef.current === "running") {
        setRunResult((prev) => ({
          ...prev,
          status: "cancelled",
        }));
        teardownRun();
      }
    }, CANCEL_FALLBACK_MS);
  }, [teardownRun]);

  /**
   * Start a transient live-run for the current form state. Does NOT
   * require the form to be valid or saved — only that the script is
   * non-empty. The run goes through the same IPC as a normal command
   * run but is filtered out of the execution store by `useExecutionBridge`.
   *
   * Race-fix history: an earlier version generated the id Rust-side and
   * tried to `markTransient` it AFTER `await runCommand(...)` resolved.
   * Tauri can deliver execution events while the IPC promise is still
   * pending (Started is emitted inside `spawn_execution` before the
   * function returns), so events would arrive at the bridge with no
   * transient mark — leaking the run into the global OutputPanel — and
   * at the local handler with `runIdRef.current` still null — so the
   * form never saw any events and got stuck on "Running…" forever.
   *
   * The fix: pre-generate the id on the JS side, set `runIdRef` and
   * `markTransient` synchronously, register the handler, THEN invoke.
   * Rust honors the client-supplied `executionId` (see `ExecuteRequest`
   * in src-tauri/src/core/executor.rs), so every event from this run
   * carries the id we already know.
   */
  const handleRun = useCallback(async (): Promise<void> => {
    if (form.script.trim() === "") return;
    // If a previous run is still being cleaned up, tear it down first.
    // (Should never happen in practice because the Run button becomes
    // Cancel while running, but be defensive.)
    teardownRun();

    // Generate the id synchronously so every piece of state can be wired
    // up before any async boundary. The Rust executor will use this id
    // verbatim — no second id is ever introduced.
    const executionId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `transient-${Date.now()}-${Math.random()}`;

    // CRITICAL ORDERING — all four side-effects below MUST run before the
    // first event from Rust can be dispatched:
    //   1. Pin the id in a ref so the local handler can filter by it.
    //   2. Mark transient so the bridge skips its store-write fast path.
    //   3. Subscribe the local handler to the executor fan-out.
    //   4. Then invoke — at this point Rust is free to emit events
    //      knowing all consumers are ready.
    runIdRef.current = executionId;
    markTransient(executionId);

    const handleEvent = (event: ExecutionEvent): void => {
      if (event.executionId !== runIdRef.current) return;
      switch (event.kind) {
        case "started": {
          setRunResult({
            status: "running",
            lines: [],
            exitCode: null,
            durationMs: null,
            timedOut: false,
          });
          setOutputCollapsed(false);
          return;
        }
        case "stdout": {
          setRunResult((prev) => ({
            ...prev,
            lines: [...prev.lines, { stream: "stdout", text: event.line }],
          }));
          return;
        }
        case "stderr": {
          setRunResult((prev) => ({
            ...prev,
            lines: [...prev.lines, { stream: "stderr", text: event.line }],
          }));
          return;
        }
        case "finished": {
          const timedOut = event.timedOut === true;
          // A timeout is its own terminal state — NOT a generic "failed".
          // The process was killed by us, so the exit code is usually
          // absent; surfacing "Failed / exit ?" here is exactly the
          // confusing behaviour the user reported. We mark it `timedOut`
          // and inject an explanatory line so the terminal explains why
          // the run stopped.
          const ok = event.exitCode === 0 && !timedOut;
          setRunResult((prev) => {
            const lines = timedOut
              ? [
                  ...prev.lines,
                  {
                    stream: "stderr" as const,
                    text: t("commandForm.output.timedOutLine", {
                      seconds: parseTimeoutSeconds(form.timeoutSeconds) ?? "",
                    }),
                  },
                ]
              : prev.lines;
            return {
              ...prev,
              status: timedOut ? "timedOut" : ok ? "finished" : "failed",
              exitCode: event.exitCode,
              durationMs: event.durationMs,
              timedOut,
              lines,
            };
          });
          teardownRun();
          return;
        }
        case "error": {
          setRunResult((prev) => ({
            ...prev,
            status: "failed",
            lines: [
              ...prev.lines,
              { stream: "stderr", text: event.message },
            ],
          }));
          teardownRun();
          return;
        }
        case "cancelled": {
          setRunResult((prev) => ({
            ...prev,
            status: "cancelled",
          }));
          teardownRun();
          return;
        }
      }
    };
    runUnsubRef.current = subscribeExecutionEvents(handleEvent);

    const synthetic: Command = {
      // The Command `id` field is used only to populate `commandId` on the
      // execute request (so events can carry it for store lookups). It is
      // distinct from `executionId`. We use the same UUID here to avoid
      // generating two — the JS bridge stays correct because transient
      // events are filtered out of the store entirely.
      id: executionId,
      name: form.name.trim() || "Form test",
      script: form.script,
      shell: form.shell,
      tags: [],
      favorite: false,
      createdAt: "",
      updatedAt: "",
      runCount: 0,
      // The live-run honours the unsaved checkbox — users testing an
      // admin script don't need to save first. The `elevated` option
      // below mirrors this, so opts and cmd stay in agreement.
      runAsAdmin: form.runAsAdmin,
      // Carry the in-form variable specs so the Rust parser can both
      // resolve `${name}` references using each spec's default AND
      // know which references are "known" vs typos. Without this the
      // backend sees an empty `variables` array and rejects every
      // `${...}` reference with a MissingVariable error.
      variables: rowsToVariableSpecs(form.variables),
      timeoutSeconds: parseTimeoutSeconds(form.timeoutSeconds),
      // Carry the in-form output schema so a live test run extracts and
      // emits the same `result` event a saved run would — letting the
      // user verify their schema before saving.
      ...(form.outputSchema !== undefined
        ? { outputSchema: form.outputSchema }
        : {}),
      // Carry the in-form env rows so the live run sees the same env
      // overrides as a saved run would.
      ...(envRowsToRecord(envRowsRef.current) !== undefined
        ? { env: envRowsToRecord(envRowsRef.current) }
        : {}),
    };

    // Resolve variable values up front, BEFORE flipping the panel
    // into "running" state. The prompt modal may sit open for a
    // while waiting on user input — showing "Running…" during that
    // wait is misleading. Once resolution returns we know the run
    // is actually going to start (or the user cancelled).
    const resolved = await resolveVariableValues(synthetic, {});
    if (resolved === null) {
      // User cancelled the prompt — drop the event subscription so
      // the next Run click starts clean. The panel state was never
      // touched (status still "idle"), so nothing to undo.
      teardownRun();
      return;
    }

    // Optimistic: panel into running state. The real `started` event
    // will overwrite this, but it makes the UI feel responsive
    // while the IPC round-trip happens.
    setRunResult({
      status: "running",
      lines: [],
      exitCode: null,
      durationMs: null,
      timedOut: false,
    });
    setOutputCollapsed(false);

    // Reusable invocation closure. The `executionId` and event
    // subscription are pinned above, so a retry after the
    // ADMIN_PASSWORD_REQUIRED sentinel reuses the same plumbing — Rust
    // does NOT emit any events when it returns the sentinel from the
    // command handler (it bails before spawning), so the id is still
    // pristine on the second attempt.
    const invokeOnce = async (
      adminPassword: string | undefined,
    ): Promise<void> => {
      await runCommand(synthetic, {
        executionId,
        elevated: form.runAsAdmin,
        variableValues: resolved,
        ...(adminPassword !== undefined ? { adminPassword } : {}),
      });
    };

    const reportFailure = (err: unknown): void => {
      const message = err instanceof Error ? err.message : String(err);
      setRunResult({
        status: "failed",
        lines: [{ stream: "stderr", text: message }],
        exitCode: null,
        durationMs: null,
        timedOut: false,
      });
      teardownRun();
    };

    try {
      await invokeOnce(undefined);
    } catch (err) {
      // Sentinel path: the elevated-flag was set but no password is
      // stored in the keychain. Open the singleton prompt, then
      // either persist + retry (remember=true) or retry with a
      // one-shot password attached to RunOptions (remember=false).
      // Mirrors `triggerCommandRun`'s logic so the form's live-run
      // surfaces the same UX as runs from the Library / palette.
      if (!isAdminPasswordRequiredError(err)) {
        reportFailure(err);
        return;
      }
      const promptResult = await promptForAdminPassword();
      if (promptResult === null) {
        // User cancelled — drop the run quietly, no toast.
        setRunResult(INITIAL_RUN_RESULT);
        teardownRun();
        return;
      }
      let retryPassword: string | undefined;
      if (promptResult.remember) {
        try {
          await setAdminPassword(promptResult.password);
        } catch (saveErr) {
          const saveMsg =
            saveErr instanceof Error ? saveErr.message : String(saveErr);
          Message.error(
            `${t("runCommand.adminPasswordSaveFailed", {
              defaultValue: "Failed to save admin password",
            })}: ${saveMsg}`,
          );
          // Refresh the cached "stored?" flag so the hint stays
          // accurate after a failed save.
          setAdminPasswordStored(false);
          setRunResult(INITIAL_RUN_RESULT);
          teardownRun();
          return;
        }
        // Successful persist — update the local cache so the hint
        // disappears immediately rather than waiting for the next
        // checkbox toggle to re-query.
        setAdminPasswordStored(true);
      } else {
        retryPassword = promptResult.password;
      }
      try {
        await invokeOnce(retryPassword);
      } catch (retryErr) {
        if (isAdminPasswordRequiredError(retryErr)) {
          Message.error(
            t("runCommand.adminPasswordRejected", {
              defaultValue: "Wrong administrator password — please try again",
            }),
          );
          setRunResult(INITIAL_RUN_RESULT);
          teardownRun();
          return;
        }
        reportFailure(retryErr);
      }
    }
  }, [
    form.name,
    form.script,
    form.shell,
    form.runAsAdmin,
    form.variables,
    form.timeoutSeconds,
    form.outputSchema,
    t,
    teardownRun,
    setAdminPasswordStored,
  ]);

  /**
   * Run the current (possibly unsaved) form state on the APP-WIDE console
   * instead of the embedded panel. Reuses `triggerCommandRun` so admin
   * password, variable prompts, and history logging behave exactly like a
   * Library run. The synthetic command carries the real command id when
   * editing (so the console shows the right name and history is accurate);
   * in create mode there is no id yet, so the run is a one-off draft.
   *
   * Used only when `runTarget === "global"` (the full-screen CommandEditor).
   */
  const handleRunGlobal = useCallback(async (): Promise<void> => {
    if (form.script.trim() === "") return;
    const synthetic: Command = {
      id: command?.id ?? `draft-${Date.now()}`,
      name: form.name.trim() || t("commandForm.title.create"),
      description: form.description.trim() || undefined,
      script: form.script,
      shell: form.shell,
      tags: [],
      favorite: false,
      createdAt: "",
      updatedAt: "",
      runCount: 0,
      runAsAdmin: form.runAsAdmin,
      variables: rowsToVariableSpecs(form.variables),
      timeoutSeconds: parseTimeoutSeconds(form.timeoutSeconds),
      ...(form.outputSchema !== undefined
        ? { outputSchema: form.outputSchema }
        : {}),
      ...(envRowsToRecord(envRowsRef.current) !== undefined
        ? { env: envRowsToRecord(envRowsRef.current) }
        : {}),
    };
    const executionId = await triggerCommandRun(synthetic, {
      elevated: form.runAsAdmin,
      variableValues: {},
    });
    // `triggerCommandRun` returns null on a cancelled prompt / failed
    // launch; only track a real run so the button reflects live status.
    if (executionId) setGlobalRunId(executionId);
  }, [
    command?.id,
    form.name,
    form.description,
    form.script,
    form.shell,
    form.runAsAdmin,
    form.variables,
    form.timeoutSeconds,
    form.outputSchema,
    t,
  ]);

  /** Cancel the in-flight global-console run (if any). */
  const handleCancelGlobal = useCallback((): void => {
    if (!globalRunId) return;
    cancelExecution(globalRunId).catch((err) => {
      console.error("Failed to cancel execution:", err);
    });
  }, [globalRunId]);

  /** Reset embedded run state to idle (open-target change). */
  const resetRun = useCallback((): void => {
    setRunResult(INITIAL_RUN_RESULT);
    setOutputCollapsed(true);
  }, []);

  /**
   * Best-effort cancel of an active embedded run from the save path. Does
   * not wait and does not call teardownRun — handleSave invokes teardownRun
   * explicitly afterward, matching the original ordering.
   */
  const cancelActiveRunForSave = useCallback((): void => {
    // If a live-run is still active when the user saves, cancel it so
    // we don't leak a background process after the modal closes.
    if (runStatusRef.current === "running" && runIdRef.current) {
      cancelExecution(runIdRef.current).catch(() => {
        // Best-effort.
      });
    }
  }, []);

  /**
   * Close the modal, cancelling any in-flight live-run first. If a run
   * is running we issue cancel and wait up to `CANCEL_GRACE_MS` for the
   * process to exit gracefully; the modal closes either way after the
   * grace window. Output is discarded — transient runs do not persist.
   */
  const closeWithRunGuard = useCallback(
    (onClose: () => void): void => {
      if (runStatusRef.current === "running" && runIdRef.current) {
        cancelExecution(runIdRef.current).catch((err) => {
          console.error("Failed to cancel transient execution on close:", err);
        });
        // Give the executor a brief moment to acknowledge — keeps the
        // process from being orphaned on a fast modal close.
        window.setTimeout(() => {
          teardownRun();
          onClose();
        }, CANCEL_GRACE_MS);
      } else {
        teardownRun();
        onClose();
      }
    },
    [teardownRun],
  );

  // Belt-and-suspenders: on unmount, tear down any in-flight run. This
  // handles the case where the parent unmounts the form without going
  // through `closeWithRunGuard` (e.g. navigation away).
  useEffect(() => {
    return () => {
      if (runIdRef.current) {
        cancelExecution(runIdRef.current).catch(() => {
          // Best-effort: nothing else to do on unmount.
        });
      }
      teardownRun();
    };
    // teardownRun is stable (empty deps); we intentionally only want this
    // cleanup to run on real component unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    runResult,
    outputCollapsed,
    setOutputCollapsed,
    globalExecution,
    isGlobalRunning,
    run: handleRun,
    cancel: handleCancel,
    clear: handleClearOutput,
    runGlobal: handleRunGlobal,
    cancelGlobal: handleCancelGlobal,
    resetRun,
    cancelActiveRunForSave,
    teardownRun,
    closeWithRunGuard,
  };
}
