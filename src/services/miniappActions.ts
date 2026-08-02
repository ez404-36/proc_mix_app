// Thin wrapper over `miniappStore`, mirroring `commandActions` /
// `workflowActions`. UI / service code (notably the import orchestrator) goes
// through this facade rather than touching the store directly, so `src/services`
// stays free of direct store imports and this is the sanctioned seam for a
// future history wrapper — the store doc notes a `miniappCreated` history event
// is planned but the `HistoryEventKind` union does not yet carry it, so for now
// this only persists (no history row).
//
// The helper is a plain function (not a hook) so it can be invoked from
// anywhere — event handlers, effects, the import service, tests.

import { useMiniAppStore } from "../stores/miniappStore";
import type { MiniApp } from "../types";

type NewMiniAppInput = Parameters<
  ReturnType<typeof useMiniAppStore.getState>["addMiniApp"]
>[0];

/**
 * Persist a new mini-app via the store and return its materialised form
 * (with a generated id + timestamps). Returns the record so a caller (e.g. the
 * import flow) can track the old→new id mapping for command references.
 */
export function createMiniApp(input: NewMiniAppInput): MiniApp {
  return useMiniAppStore.getState().addMiniApp(input);
}
