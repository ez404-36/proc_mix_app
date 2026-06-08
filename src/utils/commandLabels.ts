import type { TFunction } from "i18next";
import type { Command } from "../types";

/**
 * Resolve the human-readable name of a command.
 *
 * Built-in/seed commands carry a `nameKey` pointing at an i18next entry —
 * those are translated via `t(nameKey)`. User-created commands store their
 * literal `name` and are returned as-is. If a translation lookup falls
 * through (i18next returns the key itself when no resource is found), we
 * fall back to the literal `name` so the UI never displays a raw key.
 */
export function getCommandName(cmd: Command, t: TFunction): string {
  if (cmd.nameKey) {
    const translated = t(cmd.nameKey);
    if (translated !== cmd.nameKey) return translated;
  }
  return cmd.name;
}

/**
 * Resolve the human-readable description of a command. Same resolution
 * rules as `getCommandName`. Returns `undefined` when the command has no
 * description at all.
 */
export function getCommandDescription(
  cmd: Command,
  t: TFunction,
): string | undefined {
  if (cmd.descriptionKey) {
    const translated = t(cmd.descriptionKey);
    if (translated !== cmd.descriptionKey) return translated;
  }
  return cmd.description;
}
