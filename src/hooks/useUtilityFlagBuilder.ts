import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { parseUtilityFlags } from "../services/utilityHelp";
import type { FormState } from "../types/commandForm";
import type { ParsedCli, UtilityHelp } from "../types";
import type { UtilityNameRange } from "../utils/utilityName";
import { useFlagsByUtility } from "./useFlagsByUtility";

export interface UseUtilityFlagBuilderParams {
  /** Every recognised utility range in the current script (leading + chained). */
  utilityRanges: ReadonlyArray<UtilityNameRange>;
  /** Resolved help per utility name (absent while loading). */
  helpByUtility: ReadonlyMap<string, UtilityHelp>;
  /** Resolved help for the leading utility, or `null` while loading / none. */
  resolvedHelp: UtilityHelp | null;
  /** The leading utility range, or `null` when the script has none. */
  utilityRange: UtilityNameRange | null;
  /** The form-state setter — used by the builder's "apply" callback. */
  setForm: Dispatch<SetStateAction<FormState>>;
}

export interface UseUtilityFlagBuilderResult {
  /** Whether the inline flag-builder panel is open. */
  flagBuilderOpen: boolean;
  /** Parsed CLI feeding the (single-utility) flag-builder panel. */
  flagBuilderData: ParsedCli | null;
  /** True while the on-demand fetch for the builder panel is in flight. */
  flagBuilderLoading: boolean;
  /**
   * Parsed CLI per recognised utility name, for the editor's per-command
   * flag highlighting (every command in a `|`/`;` chain, not just the
   * leading one). Populated proactively as each utility resolves to "found".
   */
  flagsByUtility: ReadonlyMap<string, ParsedCli>;
  /** Fetch parsed CLI on demand, then open the inline builder panel. */
  handleOpenFlagBuilder: () => void;
  /** Apply a builder-edited script back onto the form. */
  handleFlagBuilderChange: (script: string) => void;
  /** Close the builder panel (keeping the cached flags for highlighting). */
  handleFlagBuilderDismiss: () => void;
}

/**
 * Owns the flag-builder concerns for the command form: the open/loading
 * state, the on-demand single-utility fetch, the proactive
 * fetch/prune-per-found-utility effect (so flag highlights appear for
 * every command in a chain), and keeping the panel in sync with the
 * leading utility.
 *
 * Extracted verbatim from CommandForm so the container stays a thin
 * composition of focused hooks (SRP). The form remains the state owner —
 * this hook only reads the derived utility ranges/help and calls back out
 * through `setForm` when the user applies builder edits.
 */
export function useUtilityFlagBuilder(
  params: UseUtilityFlagBuilderParams,
): UseUtilityFlagBuilderResult {
  const { utilityRanges, helpByUtility, resolvedHelp, utilityRange, setForm } =
    params;

  // Flag builder: open/closed state + parsed CLI data fetched on demand.
  const [flagBuilderOpen, setFlagBuilderOpen] = useState<boolean>(false);
  const [flagBuilderData, setFlagBuilderData] = useState<ParsedCli | null>(null);
  const [flagBuilderLoading, setFlagBuilderLoading] = useState<boolean>(false);
  const flagBuilderOpenRef = useRef(flagBuilderOpen);
  flagBuilderOpenRef.current = flagBuilderOpen;

  // Flag builder: fetch parsed CLI on demand, then open the inline section.
  const handleOpenFlagBuilder = useCallback((): void => {
    if (!utilityRange) return;
    const name = utilityRange.name;
    setFlagBuilderLoading(true);
    void parseUtilityFlags(name).then((parsed) => {
      setFlagBuilderData(parsed);
      setFlagBuilderOpen(true);
      setFlagBuilderLoading(false);
    }).catch(() => {
      setFlagBuilderLoading(false);
    });
  }, [utilityRange]);

  // Parsed CLI per recognised+found utility name, for the editor's
  // per-command flag highlighting (every command in a `|`/`;` chain, not
  // just the leading one). The proactive fetch/prune logic is shared with
  // `ArtifactRefInput`'s shell-syntax highlighting via `useFlagsByUtility`.
  const flagsByUtility = useFlagsByUtility(utilityRanges, helpByUtility);

  // Close the single-utility flag-builder panel when no utility in the
  // script is found anymore (the proactive fetch above already handles
  // fetching/pruning `flagsByUtility` itself).
  const anyUtilityFound = utilityRanges.some(
    (range) => helpByUtility.get(range.name)?.status === "found",
  );
  useEffect(() => {
    if (!anyUtilityFound) {
      setFlagBuilderData(null);
      if (flagBuilderOpenRef.current) setFlagBuilderOpen(false);
    }
  }, [anyUtilityFound]);

  // Keep the single-utility flag-builder panel in sync with the leading
  // utility's parsed flags (or clear it when the leading utility changes /
  // is no longer found).
  const leadingUtilityName =
    resolvedHelp?.status === "found" ? utilityRange?.name ?? null : null;
  useEffect(() => {
    if (leadingUtilityName === null) {
      setFlagBuilderData(null);
      if (flagBuilderOpenRef.current) setFlagBuilderOpen(false);
      return;
    }
    const flags = flagsByUtility.get(leadingUtilityName);
    if (flags !== undefined) setFlagBuilderData(flags);
  }, [leadingUtilityName, flagsByUtility]);

  const handleFlagBuilderChange = useCallback(
    (script: string): void => {
      setForm((s) => ({ ...s, script }));
    },
    [setForm],
  );

  const handleFlagBuilderDismiss = useCallback((): void => {
    setFlagBuilderOpen(false);
    // Do NOT clear flagBuilderData — it is still used for flag highlighting
    // in the ScriptEditor overlay even when the builder panel is closed.
  }, []);

  return {
    flagBuilderOpen,
    flagBuilderData,
    flagBuilderLoading,
    flagsByUtility,
    handleOpenFlagBuilder,
    handleFlagBuilderChange,
    handleFlagBuilderDismiss,
  };
}
