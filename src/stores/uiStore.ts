import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  CommandEditorTarget,
  CommandViewState,
  LibraryTab,
  ScheduleEditorTarget,
  ScheduleViewState,
  Theme,
  View,
  WorkflowViewState,
} from "../types";
import { detectInitialLanguage, type Language } from "../i18n";
import type { ConsoleDockPosition } from "./executionStore";

export const DEFAULT_TOGGLE_SHORTCUT = "CommandOrControl+Shift+P";

/**
 * Default list-view preference shared by the three lists: newest-first,
 * tile layout, 10 per page, ungrouped. Each list gets its own copy so a
 * change to one never bleeds into the others.
 */
const DEFAULT_COMMANDS_VIEW: CommandViewState = {
  sortKey: "createdAt",
  sortDir: "desc",
  mode: "tiles",
  pageSize: 10,
  grouped: false,
};

const DEFAULT_WORKFLOWS_VIEW: WorkflowViewState = {
  sortKey: "createdAt",
  sortDir: "desc",
  mode: "tiles",
  pageSize: 10,
  grouped: false,
};

const DEFAULT_SCHEDULES_VIEW: ScheduleViewState = {
  sortKey: "createdAt",
  sortDir: "desc",
  mode: "tiles",
  pageSize: 10,
  grouped: false,
};

interface UIState {
  currentView: View;
  /**
   * Active tab in the Library view. Transient navigation state, like
   * `currentView` — intentionally NOT persisted (see `partialize`).
   */
  libraryTab: LibraryTab;
  /**
   * Which workflow the Editor screen should open. `null` means "create a
   * new workflow"; a string is an existing `Workflow.id` to edit. Set by
   * the Library's Edit / New Workflow actions right before navigating to
   * the editor. Transient — not persisted.
   */
  editorWorkflowId: string | null;
  /**
   * Target for the full-screen command editor (`command-editor` view).
   * `null` means the view is not active. Set by the Library's New / Edit
   * command actions right before navigating to the editor; read by the
   * `CommandEditor` view to resolve the command to edit. Transient — not
   * persisted, mirroring `editorWorkflowId`.
   */
  commandEditorTarget: CommandEditorTarget | null;
  /**
   * Live, possibly-unsaved Script body of the command currently open in the
   * full-screen editor (`command-editor` view). `null` when no command is
   * being edited. Kept in sync by the `CommandForm` as the user types so
   * other surfaces (notably the OutputPanel "Re-run") can replay the script
   * the user is actually looking at, not the last-saved version. Transient —
   * not persisted.
   *
   * Only set while EDITING an existing command (the create path has no
   * command id to correlate against), so it is always paired with a
   * non-null `commandEditorTarget.commandId`.
   */
  commandEditorLiveScript: string | null;
  /**
   * Target for the full-screen schedule editor (`scheduler-editor` view).
   * `null` means the view is not active. Set by the Scheduler's New / Edit
   * actions right before navigating to the editor; read by the
   * `ScheduleEditor` view to resolve the schedule to edit. Transient — not
   * persisted, mirroring `commandEditorTarget`.
   */
  scheduleEditorTarget: ScheduleEditorTarget | null;
  /**
   * Whether the open command editor has unsaved changes. Set by the
   * `CommandForm` via `onDirtyChange`. Read by `requestNavigation` to
   * decide whether leaving needs a confirmation. Transient.
   */
  commandEditorDirty: boolean;
  /**
   * A navigation target deferred by `requestNavigation` because the
   * command editor was dirty. The `CommandEditor` view watches this,
   * shows an "unsaved changes" confirm, and either commits the
   * navigation (`confirmPendingNavigation`) or clears it
   * (`cancelPendingNavigation`). `null` when no navigation is pending.
   */
  pendingNavigation: View | null;
  paletteOpen: boolean;
  /**
   * Whether the navigation sidebar is collapsed to an icons-only rail.
   * A user preference (persisted) — collapsed hides the text labels,
   * brand, and footer hint, leaving icon buttons with hover tooltips.
   */
  sidebarCollapsed: boolean;
  theme: Theme;
  toggleShortcut: string;
  language: Language;
  /**
   * Whether the user has opted into Process Capture (the background
   * "command recorder"). Defaults to `false` and is only flipped to
   * `true` after the user accepts the one-time consent dialog — see
   * `docs/process-capture.md`. Persisted so the consent survives
   * restarts and the dialog is shown only once.
   *
   * No capture command (`start_process_capture`) may run while this is
   * `false`: it gates the entire feature.
   */
  processCaptureEnabled: boolean;
  /** Which edge of the window the output console is docked to (persisted). */
  consolePosition: ConsoleDockPosition;
  /**
   * Per-list sort + display-mode preferences for the Library Commands /
   * Workflows tabs and the Scheduler list. Persisted so the user's chosen
   * sort, view mode, page size, and (commands-only) grouping survive
   * restarts. The current pagination page is NOT held here — it is transient
   * component state that resets on filter/sort/mode changes.
   */
  commandsView: CommandViewState;
  workflowsView: WorkflowViewState;
  schedulesView: ScheduleViewState;
  setView: (v: View) => void;
  setLibraryTab: (tab: LibraryTab) => void;
  setEditorWorkflowId: (id: string | null) => void;
  setCommandEditorTarget: (target: CommandEditorTarget | null) => void;
  /** Update (or clear, with `null`) the live editor Script body. */
  setCommandEditorLiveScript: (script: string | null) => void;
  setScheduleEditorTarget: (target: ScheduleEditorTarget | null) => void;
  setCommandEditorDirty: (dirty: boolean) => void;
  /**
   * Navigate to `v`, but if the command editor is currently open AND
   * dirty, defer the navigation into `pendingNavigation` (so the view
   * can confirm) instead of switching immediately. Use this for all
   * user-initiated navigation that could abandon editor changes
   * (sidebar buttons, in-view Cancel/back).
   */
  requestNavigation: (v: View) => void;
  /** Commit the deferred navigation (user discarded changes). */
  confirmPendingNavigation: () => void;
  /** Drop the deferred navigation (user chose to keep editing). */
  cancelPendingNavigation: () => void;
  togglePalette: () => void;
  setPaletteOpen: (open: boolean) => void;
  /** Toggle the navigation sidebar between expanded and icons-only. */
  toggleSidebar: () => void;
  setTheme: (t: Theme) => void;
  setToggleShortcut: (accel: string) => void;
  setLanguage: (lang: Language) => void;
  setProcessCaptureEnabled: (enabled: boolean) => void;
  setConsolePosition: (position: ConsoleDockPosition) => void;
  /** Merge a partial patch into the Commands list view preference. */
  updateCommandsView: (patch: Partial<CommandViewState>) => void;
  /** Merge a partial patch into the Workflows list view preference. */
  updateWorkflowsView: (patch: Partial<WorkflowViewState>) => void;
  /** Merge a partial patch into the Schedules list view preference. */
  updateSchedulesView: (patch: Partial<ScheduleViewState>) => void;
}

interface PersistedUIState {
  theme: Theme;
  toggleShortcut: string;
  language: Language;
  processCaptureEnabled: boolean;
  sidebarCollapsed: boolean;
  consolePosition: ConsoleDockPosition;
  commandsView: CommandViewState;
  workflowsView: WorkflowViewState;
  schedulesView: ScheduleViewState;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      currentView: "home",
      libraryTab: "commands",
      editorWorkflowId: null,
      commandEditorTarget: null,
      commandEditorLiveScript: null,
      scheduleEditorTarget: null,
      commandEditorDirty: false,
      pendingNavigation: null,
      paletteOpen: false,
      sidebarCollapsed: false,
      theme: "system",
      toggleShortcut: DEFAULT_TOGGLE_SHORTCUT,
      language: detectInitialLanguage(),
      processCaptureEnabled: false,
      consolePosition: "bottom",
      commandsView: DEFAULT_COMMANDS_VIEW,
      workflowsView: DEFAULT_WORKFLOWS_VIEW,
      schedulesView: DEFAULT_SCHEDULES_VIEW,
      setView: (v) => set({ currentView: v }),
      setLibraryTab: (tab) => set({ libraryTab: tab }),
      setEditorWorkflowId: (id) => set({ editorWorkflowId: id }),
      setCommandEditorTarget: (target) =>
        // Clear any stale live script whenever the edit target changes:
        // opening a different command (or the create path) must not let the
        // previous command's unsaved script linger and be replayed.
        set({ commandEditorTarget: target, commandEditorLiveScript: null }),
      setCommandEditorLiveScript: (script) =>
        set({ commandEditorLiveScript: script }),
      setScheduleEditorTarget: (target) =>
        set({ scheduleEditorTarget: target }),
      setCommandEditorDirty: (dirty) => set({ commandEditorDirty: dirty }),
      requestNavigation: (v) =>
        set((s) => {
          // Guard only applies while the command editor is open AND
          // dirty, and only when actually leaving it. Same-view re-nav or
          // a clean editor navigates immediately.
          const leavingDirtyEditor =
            s.currentView === "command-editor" &&
            s.commandEditorDirty &&
            v !== "command-editor";
          if (leavingDirtyEditor) {
            return { pendingNavigation: v };
          }
          return { currentView: v };
        }),
      confirmPendingNavigation: () =>
        set((s) => {
          if (s.pendingNavigation === null) return {};
          return {
            currentView: s.pendingNavigation,
            pendingNavigation: null,
            // Leaving the editor — clear its dirty flag, target, and any
            // live script so a later re-entry starts clean.
            commandEditorDirty: false,
            commandEditorTarget: null,
            commandEditorLiveScript: null,
          };
        }),
      cancelPendingNavigation: () => set({ pendingNavigation: null }),
      togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTheme: (t) => set({ theme: t }),
      setToggleShortcut: (accel) => set({ toggleShortcut: accel }),
      setLanguage: (lang) => set({ language: lang }),
      setProcessCaptureEnabled: (enabled) =>
        set({ processCaptureEnabled: enabled }),
      setConsolePosition: (position) => set({ consolePosition: position }),
      updateCommandsView: (patch) =>
        set((s) => ({ commandsView: { ...s.commandsView, ...patch } })),
      updateWorkflowsView: (patch) =>
        set((s) => ({ workflowsView: { ...s.workflowsView, ...patch } })),
      updateSchedulesView: (patch) =>
        set((s) => ({ schedulesView: { ...s.schedulesView, ...patch } })),
    }),
    {
      name: "procmix-ui",
      partialize: (state): PersistedUIState => ({
        theme: state.theme,
        toggleShortcut: state.toggleShortcut,
        language: state.language,
        processCaptureEnabled: state.processCaptureEnabled,
        sidebarCollapsed: state.sidebarCollapsed,
        consolePosition: state.consolePosition,
        commandsView: state.commandsView,
        workflowsView: state.workflowsView,
        schedulesView: state.schedulesView,
      }),
    },
  ),
);
