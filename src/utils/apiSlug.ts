// Helpers for the HTTP-API slug field shared by the command and workflow
// editors. The slug addresses an entity over the built-in HTTP API
// (`POST /api/command/{slug}/run`), so it must be URL-safe and unique per type.

/**
 * Allowed slug shape: one or more lowercase letters, digits, or hyphens. No
 * extra leading/trailing/doubled-hyphen rules beyond the character set — keep
 * it simple and predictable. An empty string is "no slug" and is handled
 * separately by the caller (it is valid to leave the field blank).
 */
const SLUG_PATTERN = /^[a-z0-9-]+$/;

/**
 * Whether `slug` is a syntactically valid, non-empty API slug. An empty string
 * returns `false` here; callers treat "blank" as "no slug" before validating.
 */
export function isValidApiSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/**
 * Normalise raw slug input toward the allowed shape as the user types:
 * lowercase, and strip every character outside `[a-z0-9-]`. This makes the
 * field forgiving (a pasted "My Deploy!" becomes "mydeploy") while still
 * guaranteeing the stored value matches {@link isValidApiSlug}.
 */
export function sanitizeApiSlugInput(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/**
 * Whether an error thrown by an upsert is a slug-uniqueness conflict from the
 * backend's partial unique index. The SQLite error surfaces as a string whose
 * message contains `UNIQUE constraint failed` and/or names the index
 * (`idx_commands_api_slug` / `idx_workflows_api_slug`). Matching on either is
 * robust to wording changes in the surrounding error wrapper.
 */
export function isApiSlugConflictError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes("unique constraint failed") ||
    lower.includes("idx_commands_api_slug") ||
    lower.includes("idx_workflows_api_slug")
  );
}
