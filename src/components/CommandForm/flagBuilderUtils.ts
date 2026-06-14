import type { ParsedFlag } from "../../types";

export interface FlagRow {
  rowId: string;
  flag: ParsedFlag;
  value: string;
  /** Use the short alias (e.g. `-v`) when true; the long alias when false. */
  useShort: boolean;
}

export function shortFlag(flags: string[]): string | undefined {
  return flags.find((f) => f.startsWith("-") && !f.startsWith("--"));
}

export function longFlag(flags: string[]): string | undefined {
  return flags.find((f) => f.startsWith("--"));
}

export function primaryFlag(flags: string[]): string {
  return flags.reduce(
    (best, f) => (f.length > best.length ? f : best),
    "",
  );
}

/** Returns the alias to use for a row based on useShort and available aliases. */
export function resolveAlias(row: FlagRow): string {
  if (row.useShort) {
    return shortFlag(row.flag.flags) ?? primaryFlag(row.flag.flags);
  }
  return longFlag(row.flag.flags) ?? primaryFlag(row.flag.flags);
}

function shellQuote(value: string): string {
  if (value.includes(" ") || value.includes("\t")) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

export interface ArgRow {
  name: string;
  description: string;
  required: boolean;
  value: string;
}

/**
 * Assemble the final command string.
 *
 * Boolean short-form flags with `useShort=true` are grouped together
 * (#7: emit `-czf` instead of `-c -z -f`). Value-taking flags and long-form
 * flags are always emitted individually.
 */
export function assembleScript(
  utilityName: string,
  argRows: ArgRow[],
  positionalRaw: string,
  flagRows: FlagRow[],
): string {
  const parts: string[] = [utilityName];

  // Named positional args.
  for (const arg of argRows) {
    if (arg.value.trim().length > 0) {
      parts.push(shellQuote(arg.value));
    }
  }

  // Free-text positional args.
  const rawTrimmed = positionalRaw.trim();
  if (rawTrimmed.length > 0) {
    // Split and re-join to normalize whitespace; quote individual tokens.
    for (const tok of rawTrimmed.split(/\s+/)) {
      if (tok.length > 0) parts.push(shellQuote(tok));
    }
  }

  // Separate boolean-short rows that can be grouped from everything else.
  const groupable: FlagRow[] = [];
  const individual: FlagRow[] = [];

  for (const row of flagRows) {
    const alias = resolveAlias(row);
    if (!row.flag.takesValue && alias.startsWith("-") && !alias.startsWith("--")) {
      groupable.push(row);
    } else {
      individual.push(row);
    }
  }

  // Emit groupable short boolean flags as a single combined token when ≥2.
  if (groupable.length === 1) {
    parts.push(resolveAlias(groupable[0]!));
  } else if (groupable.length > 1) {
    const chars = groupable.map((r) => resolveAlias(r).slice(1)).join("");
    parts.push(`-${chars}`);
  }

  // Individual flags (long, or value-taking, or mixed).
  for (const row of individual) {
    const alias = resolveAlias(row);
    if (row.flag.takesValue) {
      parts.push(alias);
      if (row.value.trim().length > 0) parts.push(shellQuote(row.value));
    } else {
      parts.push(alias);
    }
  }

  return parts.join(" ");
}
