import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  describeTerminalSession,
  spawnTerminalSession,
  terminalBridgeReady,
} from "../../services/terminalService";
import { useTerminalStore } from "../../stores/terminalStore";

/**
 * Shared "open a new terminal tab" action: spawns a backend PTY session and
 * registers it in the store under a default "Terminal N" title, starting in
 * the active terminal's cwd when one is observable. Used by the console
 * header's "New terminal" button and each region's tab-strip "+" button, so
 * the spawn logic is defined exactly once.
 *
 * The returned callback takes an optional `regionId`: a region's "+" passes
 * its own id so the new tab joins THAT region's strip; the header button and
 * the auto-open pass nothing, so the tab joins the active region (or opens
 * the very first region when nothing is open yet) — see `openSession`.
 */
export function useOpenTerminalTab(): (regionId?: string) => void {
  const { t } = useTranslation();
  const openSession = useTerminalStore((s) => s.openSession);
  const reserveTabNumber = useTerminalStore((s) => s.reserveTabNumber);
  const releaseTabNumber = useTerminalStore((s) => s.releaseTabNumber);

  return useCallback(
    (regionId?: string): void => {
      const terminalState = useTerminalStore.getState();
      const targetRegion =
        (regionId !== undefined ? terminalState.regions[regionId] : undefined) ??
        (terminalState.activeRegionId
          ? terminalState.regions[terminalState.activeRegionId]
          : undefined) ??
        Object.values(terminalState.regions)[0];
      const referenceSessionId = targetRegion?.activeTabId ?? null;
      const referenceSession =
        referenceSessionId === null
          ? null
          : (terminalState.sessions[referenceSessionId] ?? null);

      // Reserve the number BEFORE the async spawn call (not after it
      // resolves) so two tabs opened back-to-back can't both compute the
      // same "lowest free number" — see `terminalStore.reserveTabNumber`.
      const number = reserveTabNumber();
      // Wait for the global `terminal-event` listener to be live BEFORE
      // spawning — the backend's PTY reader thread starts emitting the
      // shell's first prompt immediately on spawn, and a not-yet-registered
      // Tauri listener would drop those events outright (the per-session
      // buffering in `terminalService` only covers a tab mounting later than
      // the listener, not the listener itself not existing yet).
      void terminalBridgeReady()
        .then(() =>
          referenceSession && !referenceSession.exited
            ? describeTerminalSession(referenceSession.id)
            : Promise.resolve(null),
        )
        .then((description) =>
          spawnTerminalSession(undefined, description?.cwd ?? undefined),
        )
        .then((sessionId) => {
          openSession(
            sessionId,
            t("outputPanel.terminal.tabTitle", {
              defaultValue: "Terminal {{number}}",
              number,
            }),
            number,
            regionId,
          );
        })
        .catch((err) => {
          // The spawn never happened (or the bridge never became ready) —
          // give the reserved number back so it doesn't leak and inflate
          // every subsequent tab's number.
          releaseTabNumber(number);
          console.error("failed to spawn terminal session:", err);
        });
    },
    [openSession, reserveTabNumber, releaseTabNumber, t],
  );
}
