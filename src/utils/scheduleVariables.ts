// Helpers for capturing a command's variable values AT CREATION for a
// schedule. Background fires cannot prompt, so the schedule form must collect
// every variable up front and refuse to save while a no-default variable is
// still blank.
//
// These are pure functions (no React) so they can be unit-tested and reused
// by the form and any future bulk-edit flow.

import type { Command, VariableSpec } from "../types";

/**
 * Seed a value map for a command's variables: every spec's `defaultValue`
 * (including the empty string, a valid default) is pre-filled; specs with no
 * default start blank so the user must fill them in.
 */
export function seedVariableValues(
  variables: VariableSpec[] | undefined,
): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const spec of variables ?? []) {
    seed[spec.name] = spec.defaultValue ?? "";
  }
  return seed;
}

/**
 * Names of the variables that MUST be provided (no default). A schedule
 * cannot be saved while any of these maps to an empty string, because the
 * background run would fail with a `missingVariable` error.
 */
export function requiredVariableNames(
  variables: VariableSpec[] | undefined,
): string[] {
  return (variables ?? [])
    .filter((spec) => spec.defaultValue === undefined)
    .map((spec) => spec.name);
}

/**
 * Whether `values` provides a non-empty value for every no-default variable
 * of `command`. Drives the form's save-button enablement.
 */
export function commandVariablesSatisfied(
  command: Command,
  values: Record<string, string>,
): boolean {
  return requiredVariableNames(command.variables).every((name) => {
    const v = values[name];
    return v !== undefined && v.trim() !== "";
  });
}
