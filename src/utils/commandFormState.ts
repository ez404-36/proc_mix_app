import type { VariableSpec } from '../types';
import type { EnvRow, RunResult, VariableRow } from '../types/commandForm';

export const CANCEL_GRACE_MS = 200;
export const CANCEL_FALLBACK_MS = 500;

export const INITIAL_RUN_RESULT: RunResult = {
  status: 'idle',
  lines: [],
  exitCode: null,
  durationMs: null,
  timedOut: false,
};

export function parseTimeoutSeconds(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return undefined;
  return n;
}

/**
 * Convert the form's `EnvRow[]` to the `Command.env` shape
 * (`Record<string, string>`). Returns `undefined` when all rows are empty
 * so the field is omitted from the persisted command rather than stored as `{}`.
 * Duplicate keys: last-wins (same order as the rows array).
 */
export function envRowsToRecord(
  rows: ReadonlyArray<EnvRow>,
): Record<string, string> | undefined {
  const filtered = rows.filter((r) => r.key.trim() !== '');
  if (filtered.length === 0) return undefined;
  return Object.fromEntries(filtered.map((r) => [r.key.trim(), r.value]));
}

export function rowsToVariableSpecs(rows: ReadonlyArray<VariableRow>): VariableSpec[] {
  return rows.map((row) => {
    const spec: VariableSpec = { name: row.name, sensitive: row.sensitive };
    if (!row.promptAtRuntime) {
      spec.defaultValue = row.defaultValue;
    }
    if (row.description.trim() !== '') {
      spec.description = row.description;
    }
    return spec;
  });
}
