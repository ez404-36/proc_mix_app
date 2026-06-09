// Typed wrapper around the `fetch_utility_help` Rust IPC command.
//
// The CommandForm extracts the leading utility name from the script
// field (via `parseUtilityName`) and asks the backend for that
// utility's CLI help so a flag-hint tooltip can be shown. The backend
// only ever runs `<utility> --help` / `-h` / `man` (never a shell) and
// re-validates the name — see `src-tauri/src/core/utility_help.rs` for
// the security model.
//
// An absent / unrecognised / unsafe utility resolves to a
// `status: "not-found"` result (NOT a rejection); `invoke` only rejects
// on a genuine internal backend failure. Callers should still catch
// rejections at their boundary (the `useUtilityHelp` hook does) and
// treat them as "not found" for display purposes.

import { invoke } from "@tauri-apps/api/core";
import type { ParsedCli, UtilityHelp } from "../types";

/**
 * Fetch best-effort CLI help for `utility`.
 *
 * The `utility` argument MUST already be a bare, validated utility name
 * (the caller uses `parseUtilityName`); this wrapper does not pre-clean
 * it. The Rust handler re-validates regardless, so a bad value returns
 * a `"not-found"` result rather than running anything.
 *
 * @param utility bare utility name, e.g. `"df"`.
 * @returns the resolved {@link UtilityHelp}. Rejects only on an internal
 *   backend error (the Rust command's `Result<_, String>` Err channel).
 */
export async function fetchUtilityHelp(
  utility: string,
): Promise<UtilityHelp> {
  return invoke<UtilityHelp>("fetch_utility_help", { utility });
}

/**
 * Parse structured flag / positional-argument metadata from a utility's
 * `--help` output. Uses the heuristic `parse_utility_flags` Tauri command
 * which internally runs the same probes as `fetchUtilityHelp`.
 *
 * Returns a `ParsedCli` with empty arrays when the utility is not found or
 * the help text cannot be parsed — callers treat an empty result as
 * "no pre-fill available".
 *
 * The `utility` argument MUST already be a validated utility name (obtained
 * via `parseUtilityName`); the Rust handler re-validates regardless.
 *
 * @param utility bare utility name, e.g. `"tar"`.
 * @returns the structured CLI metadata. Rejects only on internal backend error.
 */
export async function parseUtilityFlags(utility: string): Promise<ParsedCli> {
  return invoke<ParsedCli>("parse_utility_flags", { utility });
}
