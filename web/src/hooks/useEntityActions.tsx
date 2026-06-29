// Entity interaction coordinator (F4/F5).
//
// Centralises the view + run flow shared by Home and Library: opening the
// read-only detail modal, and running an entity — prompting for variable values
// first when a command declares any that need input, else firing directly.
// Returns handlers for the cards plus the modals to render once per view.

import { useCallback, useState } from "react";
import type { ApiEntitySummary, VariableSpec } from "../api/types";
import { getCommand } from "../api/client";
import { useRunActions } from "./useRunActions";
import { EntityDetail } from "../components/EntityDetail";
import { RunPrompt } from "../components/RunPrompt";

interface PromptState {
  entity: ApiEntitySummary;
  variables: VariableSpec[];
}

interface UseEntityActions {
  /** Open the read-only detail modal for an entity. */
  openDetail: (entity: ApiEntitySummary) => void;
  /** Run an entity (prompting for variables when needed). */
  requestRun: (entity: ApiEntitySummary, variables?: VariableSpec[]) => void;
  /** The detail + run-prompt modals; render once per view. */
  modals: React.JSX.Element;
}

export function useEntityActions(): UseEntityActions {
  const { run } = useRunActions();
  const [detailEntity, setDetailEntity] = useState<ApiEntitySummary | null>(
    null,
  );
  const [prompt, setPrompt] = useState<PromptState | null>(null);

  const openDetail = useCallback((entity: ApiEntitySummary): void => {
    setDetailEntity(entity);
  }, []);

  // Run an entity. When variable specs that need input are known, open the
  // prompt; otherwise fire directly. For a command card (where specs aren't
  // loaded yet) we fetch the detail to learn its variables, so a command with
  // required variables always prompts rather than failing with missingVariable.
  const requestRun = useCallback(
    (entity: ApiEntitySummary, variables?: VariableSpec[]): void => {
      const promptIfNeeded = (specs: VariableSpec[]): void => {
        const needsInput = specs.some((s) => s.defaultValue === undefined);
        if (needsInput) {
          setPrompt({ entity, variables: specs });
        } else {
          void run(entity).catch(() => {
            /* failure recorded on the run store */
          });
        }
      };

      if (variables !== undefined) {
        promptIfNeeded(variables);
        return;
      }
      if (entity.kind === "workflow") {
        // Workflows take no per-run variables in this flow — fire directly.
        void run(entity).catch(() => {});
        return;
      }
      // Command card without loaded specs: fetch detail to learn variables.
      void getCommand(entity.apiSlug ?? entity.id)
        .then((c) => promptIfNeeded(c.variables ?? []))
        .catch(() => {
          // Detail fetch failed — attempt a direct run; the run store records
          // any error for the console.
          void run(entity).catch(() => {});
        });
    },
    [run],
  );

  const modals = (
    <>
      <EntityDetail
        entity={detailEntity}
        onClose={() => setDetailEntity(null)}
        onRun={(entity, variables) => {
          setDetailEntity(null);
          requestRun(entity, variables);
        }}
      />
      {prompt ? (
        <RunPrompt
          entity={prompt.entity}
          variables={prompt.variables}
          onClose={() => setPrompt(null)}
          onFired={() => setPrompt(null)}
        />
      ) : null}
    </>
  );

  return { openDetail, requestRun, modals };
}
