import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TOGGLE_SHORTCUT,
  useUIStore,
} from "./uiStore";

beforeEach(() => {
  // Reset to documented defaults for isolation.
  useUIStore.setState({
    currentView: "home",
    paletteOpen: false,
    theme: "system",
    toggleShortcut: DEFAULT_TOGGLE_SHORTCUT,
    language: "en",
    processCaptureEnabled: false,
  });
  // Wipe persisted slice so tests can re-observe localStorage writes.
  if (typeof localStorage !== "undefined") localStorage.clear();
});

describe("uiStore constants", () => {
  it("should export the expected default toggle shortcut", () => {
    expect(DEFAULT_TOGGLE_SHORTCUT).toBe("CommandOrControl+Shift+P");
  });
});

describe("uiStore defaults", () => {
  it("should start with view=home, paletteOpen=false, theme=system, shortcut=default, language='en'", () => {
    const state = useUIStore.getState();
    expect(state.currentView).toBe("home");
    expect(state.paletteOpen).toBe(false);
    expect(state.theme).toBe("system");
    expect(state.toggleShortcut).toBe(DEFAULT_TOGGLE_SHORTCUT);
    expect(state.language).toBe("en");
  });

  it("should start with process capture disabled (opt-in)", () => {
    expect(useUIStore.getState().processCaptureEnabled).toBe(false);
  });
});

describe("uiStore.setView", () => {
  it("should change the current view", () => {
    useUIStore.getState().setView("library");
    expect(useUIStore.getState().currentView).toBe("library");
    useUIStore.getState().setView("editor");
    expect(useUIStore.getState().currentView).toBe("editor");
  });
});

describe("uiStore.requestNavigation (command-editor dirty guard)", () => {
  it("navigates immediately when not in the command editor", () => {
    useUIStore.setState({
      currentView: "library",
      commandEditorDirty: true,
      pendingNavigation: null,
    });
    useUIStore.getState().requestNavigation("history");
    expect(useUIStore.getState().currentView).toBe("history");
    expect(useUIStore.getState().pendingNavigation).toBeNull();
  });

  it("navigates immediately when the editor is open but clean", () => {
    useUIStore.setState({
      currentView: "command-editor",
      commandEditorDirty: false,
      pendingNavigation: null,
    });
    useUIStore.getState().requestNavigation("library");
    expect(useUIStore.getState().currentView).toBe("library");
    expect(useUIStore.getState().pendingNavigation).toBeNull();
  });

  it("defers navigation when leaving a dirty command editor", () => {
    useUIStore.setState({
      currentView: "command-editor",
      commandEditorDirty: true,
      pendingNavigation: null,
    });
    useUIStore.getState().requestNavigation("library");
    // Stays put; the target is parked for the view to confirm.
    expect(useUIStore.getState().currentView).toBe("command-editor");
    expect(useUIStore.getState().pendingNavigation).toBe("library");
  });

  it("confirmPendingNavigation commits the target and clears dirty/target", () => {
    useUIStore.setState({
      currentView: "command-editor",
      commandEditorDirty: true,
      commandEditorTarget: { mode: "edit", commandId: "c-1" },
      pendingNavigation: "library",
    });
    useUIStore.getState().confirmPendingNavigation();
    const s = useUIStore.getState();
    expect(s.currentView).toBe("library");
    expect(s.pendingNavigation).toBeNull();
    expect(s.commandEditorDirty).toBe(false);
    expect(s.commandEditorTarget).toBeNull();
  });

  it("cancelPendingNavigation keeps the user in the editor", () => {
    useUIStore.setState({
      currentView: "command-editor",
      commandEditorDirty: true,
      pendingNavigation: "library",
    });
    useUIStore.getState().cancelPendingNavigation();
    expect(useUIStore.getState().currentView).toBe("command-editor");
    expect(useUIStore.getState().pendingNavigation).toBeNull();
    expect(useUIStore.getState().commandEditorDirty).toBe(true);
  });
});

describe("uiStore.togglePalette / setPaletteOpen", () => {
  it("togglePalette should flip paletteOpen each call", () => {
    useUIStore.getState().togglePalette();
    expect(useUIStore.getState().paletteOpen).toBe(true);
    useUIStore.getState().togglePalette();
    expect(useUIStore.getState().paletteOpen).toBe(false);
  });

  it("setPaletteOpen should set the palette to an explicit boolean", () => {
    useUIStore.getState().setPaletteOpen(true);
    expect(useUIStore.getState().paletteOpen).toBe(true);
    useUIStore.getState().setPaletteOpen(false);
    expect(useUIStore.getState().paletteOpen).toBe(false);
  });
});

describe("uiStore.setTheme", () => {
  it("should update the theme value", () => {
    useUIStore.getState().setTheme("dark");
    expect(useUIStore.getState().theme).toBe("dark");
    useUIStore.getState().setTheme("light");
    expect(useUIStore.getState().theme).toBe("light");
  });

  it("should persist theme into localStorage under 'procmix-ui'", () => {
    useUIStore.getState().setTheme("dark");
    const raw = localStorage.getItem("procmix-ui");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as {
      state: { theme: string; toggleShortcut: string };
    };
    expect(parsed.state.theme).toBe("dark");
  });
});

describe("uiStore.setToggleShortcut", () => {
  it("should update the toggle shortcut", () => {
    useUIStore.getState().setToggleShortcut("Alt+P");
    expect(useUIStore.getState().toggleShortcut).toBe("Alt+P");
  });

  it("should persist toggleShortcut to localStorage", () => {
    useUIStore.getState().setToggleShortcut("Ctrl+K");
    const raw = localStorage.getItem("procmix-ui");
    const parsed = JSON.parse(raw as string) as {
      state: { toggleShortcut: string };
    };
    expect(parsed.state.toggleShortcut).toBe("Ctrl+K");
  });

  it("should not persist non-allowlisted fields (currentView, paletteOpen)", () => {
    useUIStore.getState().setView("library");
    useUIStore.getState().setPaletteOpen(true);
    useUIStore.getState().setTheme("light"); // force a write
    const raw = localStorage.getItem("procmix-ui");
    const parsed = JSON.parse(raw as string) as {
      state: Record<string, unknown>;
    };
    expect(parsed.state).not.toHaveProperty("currentView");
    expect(parsed.state).not.toHaveProperty("paletteOpen");
  });
});

describe("uiStore.setProcessCaptureEnabled", () => {
  it("should update the process-capture opt-in flag", () => {
    useUIStore.getState().setProcessCaptureEnabled(true);
    expect(useUIStore.getState().processCaptureEnabled).toBe(true);
    useUIStore.getState().setProcessCaptureEnabled(false);
    expect(useUIStore.getState().processCaptureEnabled).toBe(false);
  });

  it("should persist processCaptureEnabled into localStorage under 'procmix-ui'", () => {
    useUIStore.getState().setProcessCaptureEnabled(true);
    const raw = localStorage.getItem("procmix-ui");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as {
      state: { processCaptureEnabled: boolean };
    };
    expect(parsed.state.processCaptureEnabled).toBe(true);
  });
});

describe("uiStore.setLanguage", () => {
  it("should update the language value", () => {
    useUIStore.getState().setLanguage("ru");
    expect(useUIStore.getState().language).toBe("ru");
    useUIStore.getState().setLanguage("en");
    expect(useUIStore.getState().language).toBe("en");
  });

  it("should persist language into localStorage under 'procmix-ui'", () => {
    useUIStore.getState().setLanguage("ru");
    const raw = localStorage.getItem("procmix-ui");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as {
      state: { language: string };
    };
    expect(parsed.state.language).toBe("ru");
  });
});

describe("uiStore navigation-target setters", () => {
  it("setLibraryTab switches the active library tab", () => {
    useUIStore.getState().setLibraryTab("workflows");
    expect(useUIStore.getState().libraryTab).toBe("workflows");
  });

  it("setEditorWorkflowId stores an id or null", () => {
    useUIStore.getState().setEditorWorkflowId("wf-9");
    expect(useUIStore.getState().editorWorkflowId).toBe("wf-9");
    useUIStore.getState().setEditorWorkflowId(null);
    expect(useUIStore.getState().editorWorkflowId).toBeNull();
  });

  it("setCommandEditorTarget sets the target and clears any stale live script", () => {
    useUIStore.setState({ commandEditorLiveScript: "leftover" });
    useUIStore
      .getState()
      .setCommandEditorTarget({ mode: "edit", commandId: "c-1" });
    const s = useUIStore.getState();
    expect(s.commandEditorTarget).toEqual({ mode: "edit", commandId: "c-1" });
    expect(s.commandEditorLiveScript).toBeNull();
  });

  it("setCommandEditorLiveScript updates the live script body", () => {
    useUIStore.getState().setCommandEditorLiveScript("echo hi");
    expect(useUIStore.getState().commandEditorLiveScript).toBe("echo hi");
    useUIStore.getState().setCommandEditorLiveScript(null);
    expect(useUIStore.getState().commandEditorLiveScript).toBeNull();
  });

  it("setScheduleEditorTarget stores the target or null", () => {
    useUIStore
      .getState()
      .setScheduleEditorTarget({ mode: "edit", scheduleId: "s-1" });
    expect(useUIStore.getState().scheduleEditorTarget).toEqual({
      mode: "edit",
      scheduleId: "s-1",
    });
    useUIStore.getState().setScheduleEditorTarget(null);
    expect(useUIStore.getState().scheduleEditorTarget).toBeNull();
  });

  it("setCommandEditorDirty flips the dirty flag", () => {
    useUIStore.getState().setCommandEditorDirty(true);
    expect(useUIStore.getState().commandEditorDirty).toBe(true);
    useUIStore.getState().setCommandEditorDirty(false);
    expect(useUIStore.getState().commandEditorDirty).toBe(false);
  });
});

describe("uiStore.toggleSidebar", () => {
  it("flips the sidebarCollapsed flag on each call", () => {
    const initial = useUIStore.getState().sidebarCollapsed;
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(!initial);
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(initial);
  });
});

describe("uiStore.setConsolePosition", () => {
  it("updates the console dock position", () => {
    useUIStore.getState().setConsolePosition("right");
    expect(useUIStore.getState().consolePosition).toBe("right");
  });
});

describe("uiStore list-view preference setters", () => {
  it("updateCommandsView merges a partial patch", () => {
    useUIStore.getState().updateCommandsView({ mode: "table", pageSize: 25 });
    const view = useUIStore.getState().commandsView;
    expect(view.mode).toBe("table");
    expect(view.pageSize).toBe(25);
    // Untouched keys are preserved from the default.
    expect(view.sortKey).toBe("createdAt");
  });

  it("updateWorkflowsView merges a partial patch", () => {
    useUIStore.getState().updateWorkflowsView({ grouped: true });
    expect(useUIStore.getState().workflowsView.grouped).toBe(true);
  });

  it("updateSchedulesView merges a partial patch", () => {
    useUIStore.getState().updateSchedulesView({ sortDir: "asc" });
    expect(useUIStore.getState().schedulesView.sortDir).toBe("asc");
  });
});
