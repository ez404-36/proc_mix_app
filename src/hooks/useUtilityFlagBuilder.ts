import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { parseUtilityFlags } from "../services/utilityHelp";
import type { FormState } from "../types/commandForm";
import type { ParsedCli, UtilityHelp } from "../types";
import type { UtilityNameRange } from "../utils/utilityName";

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
  // Parsed CLI per recognised utility name, for the editor's per-command
  // flag highlighting (every command in a `|`/`;` chain, not just the
  // leading one). Keyed by utility name; populated by the proactive
  // effect below as each utility resolves to "found".
  const [flagsByUtility, setFlagsByUtility] = useState<
    ReadonlyMap<string, ParsedCli>
  >(() => new Map());

  // Flag builder: fetch parsed CLI on demand, then open the inline section.
  const handleOpenFlagBuilder = useCallback((): void => {
    if (!utilityRange) return;
    const name = utilityRange.name;
    setFlagBuilderLoading(true);
    void parseUtilityFlags(name).then((parsed) => {
      setFlagBuilderData(parsed);
      setFlagsByUtility((prev) => new Map(prev).set(name, parsed));
      setFlagBuilderOpen(true);
      setFlagBuilderLoading(false);
    }).catch(() => {
      setFlagBuilderLoading(false);
    });
  }, [utilityRange]);

  // Proactively fetch ParsedCli for EVERY recognised+found utility (so flag
  // highlights appear for each command without the user opening the
  // builder). The fetched flags accumulate in `flagsByUtility`; the leading
  // utility's flags also feed the single-utility flag-builder panel.
  //
  // We track which names have been fetched this session so a status
  // transition loading→found for the same name doesn't refetch, and prune
  // entries whose utility is no longer present in the script.
  //
  // `flagBuilderOpen` is intentionally NOT in the dep array: opening/closing
  // the builder must not re-trigger this effect.
  const fetchedUtilitiesRef = useRef<Set<string>>(new Set());
  const flagBuilderOpenRef = useRef(flagBuilderOpen);
  flagBuilderOpenRef.current = flagBuilderOpen;
  // Stable key of the found-utility name set, so the effect only re-runs
  // when which utilities are FOUND actually changes.
  const foundUtilityKey = useMemo<string>(() => {
    const found = new Set<string>();
    for (const range of utilityRanges) {
      if (helpByUtility.get(range.name)?.status === "found") {
        found.add(range.name);
      }
    }
    return [...found].sort().join("\n");
  }, [utilityRanges, helpByUtility]);
  useEffect(() => {
    const found = foundUtilityKey === "" ? [] : foundUtilityKey.split("\n");
    const foundSet = new Set(found);

    // Prune cached flags + fetch markers for utilities no longer found.
    fetchedUtilitiesRef.current = new Set(
      [...fetchedUtilitiesRef.current].filter((n) => foundSet.has(n)),
    );
    setFlagsByUtility((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const name of prev.keys()) {
        if (!foundSet.has(name)) {
          next.delete(name);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    if (found.length === 0) {
      setFlagBuilderData(null);
      if (flagBuilderOpenRef.current) setFlagBuilderOpen(false);
      return;
    }

    for (const name of found) {
      if (fetchedUtilitiesRef.current.has(name)) continue;
      fetchedUtilitiesRef.current.add(name);
      void parseUtilityFlags(name)
        .then((parsed) => {
          setFlagsByUtility((prev) => new Map(prev).set(name, parsed));
        })
        .catch(() => {
          fetchedUtilitiesRef.current.delete(name);
        });
    }
  }, [foundUtilityKey]);

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
