import { useEffect, useMemo, useRef, useState } from "react";

import { parseUtilityFlags } from "../services/utilityHelp";
import type { ParsedCli, UtilityHelp } from "../types";
import type { UtilityNameRange } from "../utils/utilityName";

/**
 * Proactively fetch parsed CLI flags for every utility range that has
 * resolved to "found" in `helpByUtility`, keyed by utility name — for the
 * editor's per-command flag highlighting (every command in a `|`/`;`
 * chain, not just the leading one).
 *
 * A name already fetched this session is not re-fetched; a name that
 * drops out of the "found" set is pruned from both the accumulated map
 * and the fetch marker (so a later re-appearance re-fetches). A rejected
 * fetch clears its own marker so it can be retried on the next effect run
 * for the same name.
 *
 * This is the same proactive fetch/prune behaviour `useUtilityFlagBuilder`
 * runs for the command form's Script field, extracted so callers that
 * only need flag highlighting — not the single-utility flag-builder panel
 * — can reuse it without pulling in that machinery (e.g. the Mini-App
 * script fields via `ArtifactRefInput`).
 */
export function useFlagsByUtility(
  utilityRanges: ReadonlyArray<UtilityNameRange>,
  helpByUtility: ReadonlyMap<string, UtilityHelp>,
): ReadonlyMap<string, ParsedCli> {
  const [flagsByUtility, setFlagsByUtility] = useState<
    ReadonlyMap<string, ParsedCli>
  >(() => new Map());
  const fetchedUtilitiesRef = useRef<Set<string>>(new Set());

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

  return flagsByUtility;
}
