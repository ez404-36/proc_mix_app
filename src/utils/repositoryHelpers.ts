// Shared null<->undefined boundary helpers for the IPC repository modules.
//
// The Rust handlers speak wire-format records that use `null` for absent
// optional fields (serde serialises `Option::None` as JSON `null`), while the
// TS domain types use `undefined`. Each repository (`commandRepository`,
// `workflowRepository`, `historyRepository`, `scheduleRepository`) owns the
// translation at its boundary; these helpers factor out the three patterns
// that repeated verbatim across them so the semantics live in one place:
//
//   - `makeEnumGuard` — build a type-narrowing predicate from a finite set of
//     known values (KNOWN_SCOPES / KNOWN_SHELLS / KNOWN_TARGET_KINDS / …).
//   - `nullToUndef`   — collapse a decoded `T | null` to `T | undefined` so UI
//     code can use `??` / `?.` idiomatically (the from-record direction).
//   - `undefToNull`   — collapse a UI `T | undefined` to `T | null` so the wire
//     payload always carries an explicit value (the to-record direction).
//   - `omitWhenUndefined` — build the `...(x !== undefined ? { key: … } : {})`
//     conditional-spread block used when a field must be *omitted* from the
//     wire object (not sent as `null`) to mirror Rust's `skip_serializing_if`.

/**
 * Build a type-narrowing guard for a finite set of known string-ish values.
 * The returned predicate reports whether an arbitrary value is a member of the
 * set, narrowing the type for the caller. Used to validate wire strings whose
 * column type is broader than the domain union (e.g. `shell: string | null`).
 */
export function makeEnumGuard<T extends string>(
  values: readonly T[],
): (value: string) => value is T {
  const set: ReadonlySet<T> = new Set<T>(values);
  return (value: string): value is T => set.has(value as T);
}

/**
 * Collapse a wire `T | null` to a domain `T | undefined`. Mirrors the
 * `value ?? undefined` idiom at the from-record boundary so a single helper
 * documents the intent.
 */
export function nullToUndef<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/**
 * Collapse a domain `T | undefined` to a wire `T | null`. Mirrors the
 * `value ?? null` idiom at the to-record boundary so the JSON payload always
 * carries an explicit value for the column.
 */
export function undefToNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

/**
 * Build a conditional-spread fragment that includes `{ [key]: value }` only
 * when `value` is not `undefined` — mirroring Rust's `skip_serializing_if =
 * "Option::is_none"` so an absent field stays *omitted* from the wire object
 * (rather than serialised as `null`). When `value` is present, an optional
 * `transform` maps it to the stored wire value (e.g. trimming a slug, or
 * normalising an empty string to `null`).
 *
 * Returns an empty object when `value` is `undefined`, so the result spreads
 * to nothing.
 */
export function omitWhenUndefined<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>>;
export function omitWhenUndefined<K extends string, V, R>(
  key: K,
  value: V | undefined,
  transform: (value: V) => R,
): Partial<Record<K, R>>;
export function omitWhenUndefined<K extends string, V, R>(
  key: K,
  value: V | undefined,
  transform?: (value: V) => R,
): Partial<Record<K, V | R>> {
  if (value === undefined) return {};
  const stored: V | R = transform ? transform(value) : value;
  return { [key]: stored } as Record<K, V | R>;
}
