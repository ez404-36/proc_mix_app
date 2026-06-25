import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";

import {
  makeRowId,
  syncVariableDefaultToScript,
} from "../utils/commandFormState";
import type { FormState, VariableRow } from "../types/commandForm";

export interface UseVariableRowsResult {
  /** Append a fresh "prompt at runtime" variable row. */
  handleVariableAdd: () => void;
  /** Remove the variable row at `index`. */
  handleVariableRemove: (index: number) => void;
  /**
   * Patch the variable row at `index`. When the patch changes a named
   * row's `defaultValue`, the script's `${name}` / `${name:old}` references
   * are kept in sync via {@link syncVariableDefaultToScript}.
   */
  updateVariableRow: (index: number, patch: Partial<VariableRow>) => void;
}

/**
 * Owns the variable-row CRUD for the command form. Each handler operates
 * on the row at `index` (row identity is the array position). The handlers
 * are intentionally simple — no debouncing/batching — because the row
 * count is bounded by what a human will reasonably declare.
 *
 * Extracted verbatim from CommandForm so the container stays a thin
 * composition of focused hooks (SRP); the form remains the state owner.
 */
export function useVariableRows(
  setForm: Dispatch<SetStateAction<FormState>>,
): UseVariableRowsResult {
  const handleVariableAdd = useCallback((): void => {
    setForm((s) => ({
      ...s,
      variables: [
        ...s.variables,
        {
          rowId: makeRowId(),
          name: "",
          defaultValue: "",
          description: "",
          sensitive: false,
          // New rows default to "prompt at runtime" — the safest
          // default since an empty string is a meaningful value but
          // unlikely to be what the user wants for a fresh variable.
          promptAtRuntime: true,
          // Fresh row: don't show the "invalid name" error yet. The
          // flag flips to true on first input or blur, or via the
          // global `showErrors` switch on save.
          nameTouched: false,
        },
      ],
    }));
  }, [setForm]);

  const handleVariableRemove = useCallback(
    (index: number): void => {
      setForm((s) => ({
        ...s,
        variables: s.variables.filter((_, i) => i !== index),
      }));
    },
    [setForm],
  );

  const updateVariableRow = useCallback(
    (index: number, patch: Partial<VariableRow>): void => {
      setForm((s) => {
        const updatedVariables = s.variables.map((row, i) =>
          i === index ? { ...row, ...patch } : row,
        );
        // When the default value of a named variable changes, keep every
        // ${name} / ${name:old} reference in the script in sync.
        if ("defaultValue" in patch) {
          const name = updatedVariables[index]?.name;
          if (name) {
            return {
              ...s,
              variables: updatedVariables,
              script: syncVariableDefaultToScript(
                s.script,
                name,
                patch.defaultValue ?? "",
              ),
            };
          }
        }
        return { ...s, variables: updatedVariables };
      });
    },
    [setForm],
  );

  return { handleVariableAdd, handleVariableRemove, updateVariableRow };
}
