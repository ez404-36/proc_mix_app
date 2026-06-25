import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";

import { makeRowId } from "../utils/commandFormState";
import type { EnvRow, FormState } from "../types/commandForm";

export interface UseEnvRowsResult {
  /** Append a fresh empty KEY=VALUE row to the env list. */
  handleEnvRowAdd: () => void;
  /** Remove the env row at `index`. */
  handleEnvRowRemove: (index: number) => void;
  /** Patch the env row at `index` with a partial update. */
  updateEnvRow: (index: number, patch: Partial<EnvRow>) => void;
}

/**
 * Owns the per-command environment-variable row CRUD for the command form.
 * Each handler operates on the row at `index` (row identity is the array
 * position). Extracted verbatim from CommandForm so the container stays a
 * thin composition of focused hooks (SRP); the form remains the state owner.
 */
export function useEnvRows(
  setForm: Dispatch<SetStateAction<FormState>>,
): UseEnvRowsResult {
  const handleEnvRowAdd = useCallback((): void => {
    setForm((s) => ({
      ...s,
      envRows: [
        ...s.envRows,
        { rowId: makeRowId(), key: "", value: "" } satisfies EnvRow,
      ],
    }));
  }, [setForm]);

  const handleEnvRowRemove = useCallback(
    (index: number): void => {
      setForm((s) => ({
        ...s,
        envRows: s.envRows.filter((_, i) => i !== index),
      }));
    },
    [setForm],
  );

  const updateEnvRow = useCallback(
    (index: number, patch: Partial<EnvRow>): void => {
      setForm((s) => ({
        ...s,
        envRows: s.envRows.map((row, i) =>
          i === index ? { ...row, ...patch } : row,
        ),
      }));
    },
    [setForm],
  );

  return { handleEnvRowAdd, handleEnvRowRemove, updateEnvRow };
}
