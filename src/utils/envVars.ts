// Shared helpers for environment-variable UIs (the Environment view and the
// per-command Env tab). Centralised here so the EnvManager and CommandForm
// agree on exactly what "sensitive", "overrides a system variable", and
// "valid variable name" mean (DRY).

/** Keys that commonly hold sensitive data — their values are masked by default. */
const SENSITIVE_KEY_PATTERNS = [
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'KEY',
  'CREDENTIAL',
  'API_KEY',
  'PRIVATE',
];

/**
 * True when a key name looks like it holds a secret (case-insensitive
 * substring match against {@link SENSITIVE_KEY_PATTERNS}). Used to mask the
 * value by default in the system-variables list.
 */
export function isSensitiveKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => upper.includes(p));
}

/**
 * True when `key` (after trimming) shadows a variable already present in the
 * inherited system environment. Used for the conflict / override badge in both
 * the Environment view and the per-command Env tab.
 */
export function isOverridingSystem(
  key: string,
  systemVars: Record<string, string>,
): boolean {
  const trimmed = key.trim();
  if (trimmed === '') return false;
  return Object.prototype.hasOwnProperty.call(systemVars, trimmed);
}

/** Return just the filename from an absolute path for display purposes. */
export function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? path;
}

/**
 * POSIX-style environment variable name: a letter or underscore followed by
 * letters, digits, or underscores. Mirrors the validation enforced by the
 * Rust backend (`core::env_files::is_valid_env_key`) so the UI can reject a
 * bad name before the IPC round-trip.
 */
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvVarName(name: string): boolean {
  return ENV_VAR_NAME_RE.test(name);
}

/**
 * Information about the value an env entry shadows. `null` when the entry
 * does not override anything (its key is unique across system + all
 * earlier-registered files).
 */
export interface OverrideInfo {
  value: string;
  source: 'system' | 'file';
  /** Set only when `source === 'file'`. */
  filePath?: string;
}

/**
 * Compute what a file entry with the given `key` shadows, applying the same
 * precedence as the executor (later file wins; per-command env not considered
 * here because this util is for the Environment view, not for commands).
 *
 * `currentFilePath` identifies the file the entry belongs to: only files
 * registered BEFORE it count as shadowed sources. Returns `null` when nothing
 * is overridden.
 */
export function findOverride(
  key: string,
  currentFilePath: string,
  systemVars: Record<string, string>,
  envFilePaths: readonly string[],
  envFileSummaries: Record<
    string,
    { entries: ReadonlyArray<{ key: string; value: string }> }
  >,
): OverrideInfo | null {
  // Walk earlier-registered files from LAST to FIRST so we report the file
  // whose value would actually be active (the most recent one that this
  // entry replaces).
  const idx = envFilePaths.indexOf(currentFilePath);
  for (let i = idx - 1; i >= 0; i--) {
    const prevPath = envFilePaths[i];
    if (prevPath === undefined) continue;
    const prev = envFileSummaries[prevPath];
    if (!prev) continue;
    const hit = prev.entries.find((e) => e.key === key);
    if (hit) {
      return { value: hit.value, source: 'file', filePath: prevPath };
    }
  }
  // Fall back to the system layer.
  if (Object.prototype.hasOwnProperty.call(systemVars, key)) {
    return { value: systemVars[key] ?? '', source: 'system' };
  }
  return null;
}
