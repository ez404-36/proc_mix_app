// Run actions hook — fires a command/workflow run from a card (F4/F5).
//
// This is the minimal trigger used by the Home / Library Run buttons: it calls
// the run endpoint and hands the resulting executionId to the run store, which
// F6 extends with polling + the console. Variable prompts (`missingVariable`)
// and the poll/console wiring are layered on in F6; here a run is fired and any
// error surfaced to the caller.

import { useCallback } from "react";
import { ApiError, runCommand, runWorkflow } from "../api/client";
import type { ApiEntitySummary } from "../api/types";
import { entityRef } from "../api/types";
import { useRunStore } from "../stores/runStore";
import { startPolling } from "../api/runPoller";

interface UseRunActions {
  /**
   * Fire a run, optionally supplying variable values (to satisfy the command's
   * declared variables / a `missingVariable` retry). Throws the {@link ApiError}
   * on failure so the caller (e.g. the run prompt) can react — a
   * `missingVariable` error means more input is needed.
   */
  run: (
    entity: ApiEntitySummary,
    variables?: Record<string, string>,
  ) => Promise<void>;
}

export function useRunActions(): UseRunActions {
  const trackRun = useRunStore((s) => s.trackRun);

  const run = useCallback(
    async (
      entity: ApiEntitySummary,
      variables?: Record<string, string>,
    ): Promise<void> => {
      const ref = entityRef(entity);
      try {
        const accepted =
          entity.kind === "command"
            ? await runCommand(ref, variables)
            : await runWorkflow(ref, variables);
        trackRun({
          executionId: accepted.executionId,
          kind: entity.kind,
          name: entity.name,
        });
        // Begin polling the run-status endpoint until terminal so the run's
        // progress + captured output flow into the store (and the console).
        startPolling(accepted.executionId);
      } catch (err) {
        // A missingVariable error is recoverable via the prompt; let it
        // propagate WITHOUT recording a failed run so the prompt can ask for
        // the value. Other errors are recorded for the console/toast.
        if (err instanceof ApiError && err.code !== "missingVariable") {
          trackRun({
            executionId: `failed-${Date.now()}`,
            kind: entity.kind,
            name: entity.name,
            error: err.code,
          });
        }
        throw err;
      }
    },
    [trackRun],
  );

  return { run };
}
