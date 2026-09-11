// Terminal layout apply pipeline ("применить макет").
//
// Applying a layout is an ORCHESTRATED, multi-step async flow — it cannot be
// a single store action because PTY sessions must be spawned (each an await)
// before the UI can render them:
//
//   1. Spend the TerminalPanel auto-open guard (`consumeAutoOpen`) so the
//      panel's one-time "open a first tab" effect can never fire on top of
//      the incoming layout.
//   2. Close every currently open session (after the caller's confirm) —
//      a layout replaces the terminal state wholesale.
//   3. Spawn one PTY per saved window (capped by MAX_TERMINAL_SESSIONS —
//      extra saved windows are dropped with a warning). A saved window's
//      `cwd` rides on `terminal_spawn`'s own cwd override (the backend
//      falls back to home when the directory is gone); then the whole
//      snapshot is committed to `terminalStore` in ONE synchronous action,
//      and the display variant (dock position / fullscreen / size) and
//      Terminal mode are restored.
//   4. Replay per window (`buildReplaySteps`): a window saved INSIDE an ssh
//      session types ONLY its saved connection command — its recorded
//      lastCommand ran REMOTELY and is deliberately not replayed (we cannot
//      observe the remote state; docs/interactive-terminal.md). A local
//      window types its saved lastCommand. PTY input is queued by the
//      kernel line discipline, so writing immediately is safe even before
//      the shell shows its first prompt.
//
// A module-level `isApplying` guard serializes concurrent invocations
// (double-click on the dropdown entry) — the second call is a no-op.

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_TERMINAL_SESSIONS,
  closeTerminalSession,
  forgetTerminalSession,
  spawnTerminalSession,
  terminalBridgeReady,
  writeTerminalSession,
} from "../../services/terminalService";
import type {
  LayoutSnapshotNode,
  LayoutSnapshotRegion,
  LayoutSnapshotTab,
  TerminalLayoutDto,
} from "../../types/terminalLayout";
import {
  buildReplaySteps,
  countSpecTabs,
  isValidSnapshot,
  specRegionSlots,
} from "../../utils/terminalLayoutSnapshot";
import { useExecutionStore } from "../../stores/executionStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useTerminalLayoutsStore } from "../../stores/terminalLayoutsStore";
import { useUIStore } from "../../stores/uiStore";

let isApplying = false;

export interface ApplyResult {
  /** Saved windows dropped because of the PTY session cap. */
  droppedTabs: number;
  /** Saved windows actually opened. */
  openedTabs: number;
}

export function useApplyTerminalLayout(): (layout: TerminalLayoutDto) => Promise<ApplyResult> {
  const { t } = useTranslation();

  return useCallback(
    async (layout: TerminalLayoutDto): Promise<ApplyResult> => {
      if (isApplying) return { droppedTabs: 0, openedTabs: 0 };
      isApplying = true;
      try {
        // A corrupt snapshot degrades to one window instead of failing.
        const spec: LayoutSnapshotNode = isValidSnapshot(layout.layout)
          ? layout.layout
          : { type: "region", tabs: [{}], activeTabIndex: 0 };

        const terminal = useTerminalStore.getState();
        const ui = useUIStore.getState();
        const execution = useExecutionStore.getState();

        // 1. The auto-open guard must never open a stray first tab on top
        // of the layout.
        terminal.consumeAutoOpen();

        // 2. Replace: close every open session (its PTY + store state).
        for (const sessionId of Object.keys(terminal.sessions)) {
          await closeTerminalSession(sessionId);
          forgetTerminalSession(sessionId);
        }

        // 3. Spawn one PTY per saved window, capped by the backend's hard
        // limit (surplus saved windows are dropped, not fatal).
        const slots = specRegionSlots(spec);
        const totalTabs = countSpecTabs(spec);
        const maxTabs = MAX_TERMINAL_SESSIONS;
        const assignments: Array<{
          regionSlot: number;
          tabIndex: number;
          sessionId: string;
          number: number;
          title: string;
        }> = [];

        await terminalBridgeReady();
        let opened = 0;
        let dropped = 0;
        let nextNumber = useTerminalStore.getState().reserveTabNumber();
        try {
          for (let slot = 0; slot < slots.length; slot += 1) {
            for (let tabIndex = 0; tabIndex < slots[slot].tabCount; tabIndex += 1) {
              if (opened >= maxTabs) {
                dropped = totalTabs - opened;
                break;
              }
              // A saved cwd becomes the shell's STARTING directory —
              // `terminal_spawn`'s backend resolve silently falls back to
              // home when the directory no longer exists. (Irrelevant for
              // ssh windows: the connection starts in the remote home.)
              const savedCwd = findSpecTab(spec, slot, tabIndex)?.cwd;
              let sessionId: string;
              try {
                sessionId = await spawnTerminalSession(
                  undefined,
                  savedCwd?.trim() ? savedCwd : undefined,
                );
              } catch (err) {
                console.error("terminal layout spawn failed:", err);
                dropped = totalTabs - opened;
                break;
              }
              const number = nextNumber;
              nextNumber = useTerminalStore.getState().reserveTabNumber();
              const savedTab = findSpecTab(spec, slot, tabIndex);
              const title =
                savedTab?.title && savedTab.title.trim() !== ""
                  ? savedTab.title
                  : t("outputPanel.terminal.tabTitle", {
                      defaultValue: "Terminal {{number}}",
                      number,
                    });
              assignments.push({ regionSlot: slot, tabIndex, sessionId, number, title });
              opened += 1;
            }
            if (dropped > 0 || opened >= maxTabs) break;
          }

          // One synchronous store commit: sessions + regions + tree +
          // lastCommands. Fresh region ids are allocated inside the action
          // in the SAME depth-first slot order as the spawn loop above.
          useTerminalStore.getState().applyLayoutSnapshot(spec, assignments);

          // Restore the display variant. Fullscreen ignores the saved size
          // (mirroring the live CSS), and a bottom dock takes the height
          // while a side dock takes the width.
          ui.setConsolePosition(layout.position);
          ui.setConsoleFullscreen(layout.fullscreen);
          if (!layout.fullscreen) {
            if (layout.position === "bottom" && layout.size.height !== undefined) {
              execution.setPanelHeight(layout.size.height);
            } else if (layout.position !== "bottom" && layout.size.width !== undefined) {
              execution.setPanelWidth(layout.size.width);
            }
          }
          useTerminalStore.getState().setPanelMode("terminal");
          useTerminalLayoutsStore.getState().setActiveLayout(layout.id);

          // Replay per window (see `buildReplaySteps`): an ssh window types
          // its CONNECTION command (the saved lastCommand ran remotely and
          // is deliberately not replayed); a local window types its saved
          // lastCommand — its cwd was applied at spawn above. PTY input is
          // queued by the kernel line discipline, so writing immediately is
          // safe before the shell's first prompt.
          const steps = buildReplaySteps(spec, (slot, tabIndex) =>
            assignments.find((a) => a.regionSlot === slot && a.tabIndex === tabIndex)
              ?.sessionId,
          );
          for (const step of steps) {
            try {
              await writeTerminalSession(step.sessionId, step.text);
            } catch (err) {
              // The session may have died between spawn and replay —
              // non-fatal for the rest of the layout.
              console.error("terminal layout command replay failed:", err);
            }
          }

          return { droppedTabs: dropped, openedTabs: opened };
        } finally {
          // Release the one number reserved but never consumed by an
          // assignment (see the pre-reserve above) so it doesn't inflate
          // subsequent tabs' numbers.
          useTerminalStore.getState().releaseTabNumber(nextNumber);
        }
      } finally {
        isApplying = false;
      }
    },
    [t],
  );
}

/** The saved tab descriptor for a (slot, tabIndex) pair, or `undefined`. */
function findSpecTab(spec: LayoutSnapshotNode, slot: number, tabIndex: number): LayoutSnapshotTab | undefined {
  const regions: LayoutSnapshotRegion[] = [];
  const walk = (node: LayoutSnapshotNode): void => {
    if (node.type === "region") regions.push(node);
    else node.children.forEach(walk);
  };
  walk(spec);
  return regions[slot]?.tabs[tabIndex];
}
