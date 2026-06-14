import type { VariableSpec } from '../types';
import type { EnvRow, RunResult, VariableRow } from '../types/commandForm';

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g;

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

/**
 * Parse all `${name:default}` references from `script` and return a map of
 * name → inline default. References without a colon-default are not included.
 */
export function parseScriptDefaults(script: string): Map<string, string> {
  const map = new Map<string, string>();
  VAR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VAR_RE.exec(script)) !== null) {
    const [, name, inlineDefault] = match;
    if (inlineDefault !== undefined) {
      map.set(name, inlineDefault);
    }
  }
  return map;
}

/**
 * Sync variable row `defaultValue`s from inline `${name:default}` references
 * in `script`. Only rows whose name appears with an inline default are updated;
 * rows whose name appears without one, or not at all, are left untouched.
 */
export function syncScriptDefaultsToRows(
  script: string,
  rows: ReadonlyArray<VariableRow>,
): VariableRow[] {
  // Fast path: no inline defaults in the script ⇒ nothing to sync.
  // Returning the original array reference is critical — this function
  // is called on EVERY keystroke in the script editor; allocating a
  // new array each time busts every downstream `useMemo` keyed on
  // `form.variables` (notably `scriptVariableSpecs`), which in turn
  // rebuilds the script-editor's variable-highlight regexes on every
  // keypress and quickly saturates the GTK/IBus input queue on Linux.
  const defaults = parseScriptDefaults(script);
  if (defaults.size === 0) return rows as VariableRow[];

  let changed = false;
  const next = rows.map((row) => {
    const inlineDefault = defaults.get(row.name);
    if (inlineDefault === undefined) return row;
    // Rule: an empty default always forces promptAtRuntime=true; a
    // non-empty default leaves the user's explicit choice untouched.
    const nextPrompt = inlineDefault === '' ? true : row.promptAtRuntime;
    if (inlineDefault === row.defaultValue && nextPrompt === row.promptAtRuntime) {
      return row;
    }
    changed = true;
    return { ...row, defaultValue: inlineDefault, promptAtRuntime: nextPrompt };
  });
  // Preserve the input reference when no row actually changed.
  return changed ? next : (rows as VariableRow[]);
}

/**
 * Update every `${name}` and `${name:anything}` occurrence in `script` to
 * `${name:newDefault}` (or `${name}` when `newDefault` is `""`).
 */
export function syncVariableDefaultToScript(
  script: string,
  name: string,
  newDefault: string,
): string {
  // Fast path: the script doesn't reference this variable at all.
  // Bypass the regex replace entirely so we hand back the EXACT same
  // string reference — see syncScriptDefaultsToRows for the rationale.
  if (!script.includes(`\${${name}`)) return script;
  VAR_RE.lastIndex = 0;
  let changed = false;
  const out = script.replace(
    VAR_RE,
    (match, n: string) => {
      if (n !== name) return match;
      const replacement =
        newDefault !== '' ? `\${${name}:${newDefault}}` : `\${${name}}`;
      if (replacement !== match) changed = true;
      return replacement;
    },
  );
  return changed ? out : script;
}

export function rowsToVariableSpecs(rows: ReadonlyArray<VariableRow>): VariableSpec[] {
  return rows.map((row) => {
    const spec: VariableSpec = { name: row.name, sensitive: row.sensitive };
    // defaultValue is persisted in two situations:
    //   - any explicit value (incl. "") when the user is NOT prompted,
    //   - a non-empty value when the user IS prompted (used as pre-fill).
    // A prompted spec with an empty default is encoded as `undefined`
    // (no pre-fill), matching the legacy contract.
    if (row.defaultValue !== '' || !row.promptAtRuntime) {
      spec.defaultValue = row.defaultValue;
    }
    // promptAtRuntime is only persisted when it disagrees with the legacy
    // "defaultValue === undefined ⇒ prompt" convention — i.e. when there
    // IS a default AND the user still wants a prompt. This keeps wire
    // payloads small for the common case and round-trips identically
    // through older clients that don't know the field.
    if (row.promptAtRuntime && spec.defaultValue !== undefined) {
      spec.promptAtRuntime = true;
    }
    if (row.description.trim() !== '') {
      spec.description = row.description;
    }
    return spec;
  });
}
