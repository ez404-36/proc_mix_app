// Read-only display helpers for a command's execution target.
//
// Centralises the "where does this run" labelling so the tile, table,
// CommandView, console, and workflow inspector all phrase it identically.

import type { TFunction } from "i18next";
import type { ExecutionTarget } from "../types";

/**
 * Resolve the effective target for display. A `Command.target` is optional;
 * `undefined` means local (the executor default), so callers can pass the raw
 * field and get a definite `ExecutionTarget` back.
 */
export function resolveTarget(
  target: ExecutionTarget | undefined,
): ExecutionTarget {
  return target ?? { kind: "local" };
}

/** True when the (possibly absent) target is anything other than local. */
export function isRemoteTarget(target: ExecutionTarget | undefined): boolean {
  return resolveTarget(target).kind !== "local";
}

/**
 * Short, localized label for an execution target, suitable for a badge:
 *   - local        → "" (callers render no badge for local)
 *   - remote/alias → "Remote: <alias>"
 *   - remotePrompt → "Remote (ask at run time)"
 *
 * Local returns an empty string by design — there's nothing to surface for the
 * default, and badges are only shown for remote targets.
 */
export function formatTargetBadge(
  target: ExecutionTarget | undefined,
  t: TFunction,
): string {
  const resolved = resolveTarget(target);
  switch (resolved.kind) {
    case "local":
      return "";
    case "remote":
      return t("commandTarget.badgeRemote", {
        defaultValue: "Remote: {{alias}}",
        alias: resolved.alias,
      });
    case "remotePrompt":
      return t("commandTarget.badgePrompt", {
        defaultValue: "Remote (ask at run time)",
      });
  }
}
