// Helpers for the `javascript` output-schema parser step.
//
// The editor seeds a new `javascript` step with a `parse(data)` template
// whose `data` type is INFERRED (as a comment) from the previous step's
// preview value, so the user gets an at-a-glance hint of what they receive.
// The TS-ish type is display-only: the executable body is plain JS (the
// annotation lives in a comment), so no annotation stripping is needed.

/**
 * Build the starter source for a `javascript` parser step. `prevTypeLabel`
 * is a TS-like description of the previous step's output (see `inferTsType`),
 * shown as a comment so the user knows the shape of `data`.
 *
 * When the type spans multiple lines (object with several keys), every
 * continuation line is prefixed with `//` so the whole block stays inside
 * the comment.
 */
export function jsTemplate(prevTypeLabel: string): string {
  const lines = prevTypeLabel.split("\n");
  const commented =
    lines.length === 1
      ? `// type Data = ${prevTypeLabel}`
      : lines.map((l, i) => (i === 0 ? `// type Data = ${l}` : `// ${l}`)).join("\n");
  return `${commented}

function parse(data) {
  return;
}
`;
}

/**
 * Infer a short, TS-like type label for a JSON preview value, used in the
 * `parse(data)` template comment. Best-effort and intentionally shallow:
 *   - null / undefined            → "unknown"
 *   - string / number / boolean   → that primitive
 *   - []                          → "unknown[]"
 *   - [string, …]                 → "string[]" (element type of the first item)
 *   - [{…}, …]                    → "{ a: string; b: number }[]" (first item's shape)
 *   - { … }                       → "{ a: string; b: number }"
 */
export function inferTsType(value: unknown): string {
  if (value === null || value === undefined) return "unknown";

  if (Array.isArray(value)) {
    if (value.length === 0) return "unknown[]";
    const element = inferTsType(value[0]);
    // When the element type is multi-line (an object shape), the `[]` suffix
    // goes right after the closing brace on its last line.
    if (element.includes("\n")) {
      return `${element}[]`;
    }
    return `${element}[]`;
  }

  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return inferObjectType(value as Record<string, unknown>);
    default:
      // bigint / symbol / function never appear in JSON previews.
      return "unknown";
  }
}

/**
 * Build a `{ key: type; … }` label from an object's own enumerable keys.
 * Single-key objects stay on one line; 2+ keys expand to one field per line
 * with 4-space indentation so the template comment reads cleanly:
 *
 *   // type Data = {
 *   //     col0: string;
 *   //     col1: string;
 *   // }
 */
function inferObjectType(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "object";
  if (keys.length === 1) {
    return `{ ${keys[0]}: ${inferTsType(obj[keys[0]])} }`;
  }
  const fields = keys.map((k) => `    ${k}: ${inferTsType(obj[k])};`);
  return `{\n${fields.join("\n")}\n}`;
}
