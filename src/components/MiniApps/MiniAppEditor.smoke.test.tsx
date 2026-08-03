// Smoke tests for the Mini-App canvas editor.
//
// The IPC surfaces (`miniappRepository`, `commandRepository`) are mocked so
// nothing crosses the Tauri boundary; the stores and the editor itself run
// unchanged. These cover the behaviours that are cheap to break and expensive
// to notice: the keyboard-reachable palette, real widget previews on the
// canvas, undo/redo, duplicate, the collapsible properties sections, and the
// mapping colour swatches.

import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";

vi.mock("../../utils/miniappRepository", () => ({
  listMiniAppsFromDb: vi.fn().mockResolvedValue([]),
  getMiniAppFromDb: vi.fn().mockResolvedValue(null),
  saveMiniAppInDb: vi.fn().mockResolvedValue(undefined),
  deleteMiniAppInDb: vi.fn().mockResolvedValue(undefined),
  runStatusProbe: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../utils/commandRepository", () => ({
  listCommandsFromDb: vi.fn().mockResolvedValue([]),
  upsertCommandInDb: vi.fn().mockResolvedValue(undefined),
  deleteCommandInDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/workflowRepository", () => ({
  listWorkflowsFromDb: vi.fn().mockResolvedValue([]),
  upsertWorkflowInDb: vi.fn().mockResolvedValue(undefined),
  deleteWorkflowInDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import "../../i18n";
import { useCommandStore } from "../../stores/commandStore";
import { useMiniAppStore } from "../../stores/miniappStore";
import { useUIStore } from "../../stores/uiStore";
import type { MiniApp, MiniAppWidget } from "../../types";
import { runStatusProbe } from "../../utils/miniappRepository";
import { ContextMenuProvider } from "../ContextMenu";
import { MiniAppEditor } from "./MiniAppEditor";

// The custom Dropdown calls scrollIntoView on its active option; jsdom does
// not implement it. Stub so the popup can open under the test runner.
HTMLElement.prototype.scrollIntoView = (): void => {};

/** The properties inspector renders `ArtifactRefInput`, which now reads the
 *  context-menu context; every editor render must therefore be wrapped in a
 *  real `ContextMenuProvider`. */
function render(ui: ReactElement): RenderResult {
  return rtlRender(<ContextMenuProvider>{ui}</ContextMenuProvider>);
}

function makeMiniApp(widgets: MiniAppWidget[] = []): MiniApp {
  return {
    id: "ma-1",
    name: "Panel",
    widgets,
    tags: [],
    favorite: false,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    runCount: 0,
    panelSize: { w: 400, h: 320 },
  };
}

function buttonWidget(overrides: Partial<
  Extract<MiniAppWidget, { kind: "button" }>
> = {}): MiniAppWidget {
  return {
    id: "w-btn",
    kind: "button",
    layout: { x: 16, y: 16, w: 140, h: 44 },
    label: "Connect",
    action: { kind: "inline", name: "Connect", script: "echo hi" },
    ...overrides,
  };
}

function toggleWidget(overrides: Partial<
  Extract<MiniAppWidget, { kind: "toggle" }>
> = {}): MiniAppWidget {
  return {
    id: "w-tgl",
    kind: "toggle",
    layout: { x: 16, y: 80, w: 160, h: 44 },
    label: "VPN",
    onAction: { kind: "inline", name: "on", script: "up" },
    offAction: { kind: "inline", name: "off", script: "down" },
    status: {
      source: { kind: "inline", script: "probe" },
      intervalMs: 5000,
      mapping: {
        mode: "mapped",
        rules: [{ match: "up", label: "Connected" }],
      },
    },
    ...overrides,
  };
}

function artifactWidget(overrides: Partial<
  Extract<MiniAppWidget, { kind: "artifact" }>
> = {}): MiniAppWidget {
  return {
    id: "w-art",
    kind: "artifact",
    layout: { x: 16, y: 16, w: 160, h: 44 },
    name: "configPath",
    label: "Config path",
    value: "",
    variant: "text",
    ...overrides,
  };
}

/** Select the first canvas widget through the KEYBOARD route (focus), which
 *  is what makes the properties inspector reachable without a mouse. */
function selectFirstWidget(): void {
  const widget = document.querySelector(".ma-canvas-widget");
  if (widget === null) throw new Error("no widget on the canvas");
  fireEvent.focus(widget);
}

function resetStores(miniapp: MiniApp | null): void {
  useMiniAppStore.setState({
    miniapps: miniapp === null ? [] : [miniapp],
    favorites: [],
    hydrated: true,
  });
  useCommandStore.setState({ commands: [] });
  useUIStore.setState({
    currentView: "miniapp-editor",
    miniappEditorId: miniapp === null ? null : miniapp.id,
    miniappEditorDirty: false,
    pendingNavigation: null,
  });
}

beforeEach(() => {
  resetStores(null);
});
afterEach(() => {
  resetStores(null);
  vi.clearAllMocks();
});

describe("MiniAppEditor — palette", () => {
  it("renders each widget kind as a real keyboard-reachable button", () => {
    render(<MiniAppEditor />);

    for (const label of ["Button", "Toggle", "Status", "Artifact"]) {
      const entry = screen.getByRole("button", { name: new RegExp(label) });
      expect(entry.tagName).toBe("BUTTON");
    }
  });

  it("clicking a palette entry adds that widget to the draft", () => {
    render(<MiniAppEditor />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Button/ }));
    });

    // The properties inspector switches from the metadata view to the
    // selected-widget view once a widget exists and is selected.
    const paneTitles = Array.from(
      document.querySelectorAll(".ma-canvas-editor__pane-title"),
    ).map((el) => el.textContent);
    expect(paneTitles).toContain("Properties");
  });

  it("explains that a palette entry can be dragged or clicked", () => {
    render(<MiniAppEditor />);
    expect(screen.getByText("Drag onto the panel, or click to add.")).toBeTruthy();
  });
});

describe("MiniAppEditor — canvas previews", () => {
  it("renders the REAL widget for a button, not a generic glyph box", () => {
    resetStores(makeMiniApp([buttonWidget({ label: "Connect" })]));
    render(<MiniAppEditor />);

    // The runtime `.miniapp-widget` markup is what the runner draws.
    expect(document.querySelector(".miniapp-widget")).not.toBeNull();
    expect(screen.getByText("Connect")).toBeTruthy();
  });

  it("renders a toggle preview as an actual switch", () => {
    resetStores(makeMiniApp([toggleWidget()]));
    render(<MiniAppEditor />);

    expect(document.querySelector(".toggle-switch")).not.toBeNull();
  });

  it("makes the preview non-interactive so drags land on the wrapper", () => {
    resetStores(makeMiniApp([buttonWidget()]));
    render(<MiniAppEditor />);

    const preview = document.querySelector(".ma-canvas-widget__preview");
    expect(preview).not.toBeNull();
    // The class is what carries `pointer-events: none`; assert it is applied
    // and that the preview is hidden from the a11y tree (it is decorative —
    // the properties inspector is the real editing surface).
    expect(preview?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("MiniAppEditor — undo / redo", () => {
  it("undo is disabled until the draft is mutated, then reverts the change", () => {
    resetStores(makeMiniApp());
    render(<MiniAppEditor />);

    const undo = screen.getByRole("button", { name: "Undo" });
    expect((undo as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Button/ }));
    });
    expect((undo as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelectorAll(".ma-canvas-widget")).toHaveLength(1);

    act(() => {
      fireEvent.click(undo);
    });
    expect(document.querySelectorAll(".ma-canvas-widget")).toHaveLength(0);
  });

  it("redo replays an undone change", () => {
    resetStores(makeMiniApp());
    render(<MiniAppEditor />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Button/ }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(document.querySelectorAll(".ma-canvas-widget")).toHaveLength(0);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    });
    expect(document.querySelectorAll(".ma-canvas-widget")).toHaveLength(1);
  });

  it("Ctrl+Z undoes, and is ignored while typing in a field", () => {
    resetStores(makeMiniApp());
    render(<MiniAppEditor />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Button/ }));
    });
    expect(document.querySelectorAll(".ma-canvas-widget")).toHaveLength(1);

    // Fired from an <input>: the shortcut must NOT hijack the field's own undo.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    });
    const nameInput = screen.getByLabelText("Name");
    act(() => {
      fireEvent.keyDown(nameInput, { key: "z", ctrlKey: true });
    });
    expect(document.querySelectorAll(".ma-canvas-widget")).toHaveLength(1);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    act(() => {
      fireEvent.keyDown(document, { key: "z", ctrlKey: true });
    });
    expect(document.querySelectorAll(".ma-canvas-widget")).toHaveLength(0);
  });
});

describe("MiniAppEditor — duplicate & delete", () => {
  it("Duplicate clones the selected widget offset onto the panel", () => {
    resetStores(makeMiniApp([buttonWidget()]));
    render(<MiniAppEditor />);

    act(() => {
      selectFirstWidget();
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Duplicate widget" }));
    });

    expect(document.querySelectorAll(".ma-canvas-widget")).toHaveLength(2);
  });

  it("Delete key on a selected widget raises the confirm rather than deleting", () => {
    resetStores(makeMiniApp([buttonWidget()]));
    render(<MiniAppEditor />);

    act(() => {
      selectFirstWidget();
    });
    act(() => {
      fireEvent.keyDown(document, { key: "Delete" });
    });

    expect(screen.getByText("Delete widget?")).toBeTruthy();
    // Still on the canvas — deletion is confirmed, never immediate.
    expect(document.querySelectorAll(".ma-canvas-widget")).toHaveLength(1);
  });
});

describe("MiniAppEditor — properties sections", () => {
  it("groups a toggle's controls and collapses Layout by default", () => {
    resetStores(makeMiniApp([toggleWidget()]));
    render(<MiniAppEditor />);

    act(() => {
      selectFirstWidget();
    });

    const layout = screen.getByRole("button", { name: /Layout/ });
    expect(layout.getAttribute("aria-expanded")).toBe("false");

    const content = screen.getByRole("button", { name: /Content/ });
    expect(content.getAttribute("aria-expanded")).toBe("true");

    act(() => {
      fireEvent.click(layout);
    });
    expect(layout.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("X")).toBeTruthy();
  });

  it("does not offer Status / Mapping sections for a button widget", () => {
    resetStores(makeMiniApp([buttonWidget()]));
    render(<MiniAppEditor />);

    act(() => {
      selectFirstWidget();
    });

    expect(screen.queryByRole("button", { name: /^Mapping$/ })).toBeNull();
  });
});

describe("MiniAppEditor — artifact persist toggle", () => {
  it("enables the persist switch for a text/path artifact and toggles it", () => {
    resetStores(makeMiniApp([artifactWidget({ variant: "text" })]));
    render(<MiniAppEditor />);

    act(() => {
      selectFirstWidget();
    });

    const persistSwitch = screen.getByRole("switch", {
      name: "Save value on restart",
    });
    expect(persistSwitch.hasAttribute("disabled")).toBe(false);
    expect(persistSwitch.getAttribute("aria-checked")).toBe("false");

    act(() => {
      fireEvent.click(persistSwitch);
    });

    expect(persistSwitch.getAttribute("aria-checked")).toBe("true");
  });

  it("disables the persist switch for a secret artifact", () => {
    resetStores(
      makeMiniApp([artifactWidget({ variant: "secret", persist: false })]),
    );
    render(<MiniAppEditor />);

    act(() => {
      selectFirstWidget();
    });

    const persistSwitch = screen.getByRole("switch", {
      name: "Save value on restart",
    });
    expect(persistSwitch.hasAttribute("disabled")).toBe(true);
  });

  it("clears persist when switching an artifact's variant to secret", () => {
    resetStores(
      makeMiniApp([artifactWidget({ variant: "text", persist: true })]),
    );
    render(<MiniAppEditor />);

    act(() => {
      selectFirstWidget();
    });

    const variantDropdown = screen.getByRole("button", { name: "Variant" });
    act(() => {
      fireEvent.click(variantDropdown);
    });
    act(() => {
      fireEvent.click(screen.getByRole("option", { name: "Secret" }));
    });

    const persistSwitch = screen.getByRole("switch", {
      name: "Save value on restart",
    });
    expect(persistSwitch.getAttribute("aria-checked")).toBe("false");
    expect(persistSwitch.hasAttribute("disabled")).toBe(true);
  });
});

describe("MiniAppEditor — mapping rule colours", () => {
  it("offers theme-token swatches that persist a var() reference", () => {
    resetStores(makeMiniApp([toggleWidget()]));
    render(<MiniAppEditor />);

    act(() => {
      selectFirstWidget();
    });

    // Mapping is expanded by default; only Layout starts collapsed.
    const mappingToggle = screen.getByRole("button", { name: /^Mapping$/ });
    expect(mappingToggle.getAttribute("aria-expanded")).toBe("true");

    // The toggle's Content section ALSO renders a "Color" group (the
    // widget style picker), so scope to Mapping's own collapsible body.
    const mappingBody = mappingToggle.parentElement as HTMLElement;
    const swatches = within(mappingBody).getByRole("group", { name: "Color" });
    act(() => {
      fireEvent.click(within(swatches).getByRole("button", { name: "Success" }));
    });

    // A token reference, not a frozen hex — so the badge follows the theme.
    const custom = within(mappingBody).getByLabelText(
      "Custom colour",
    ) as HTMLInputElement;
    expect(custom.value).toBe("var(--color-success)");
  });
});

describe("MiniAppEditor — button widget style", () => {
  it("offers a colour picker and a fill/outline selector in the Content section", () => {
    resetStores(makeMiniApp([buttonWidget()]));
    render(<MiniAppEditor />);

    act(() => {
      selectFirstWidget();
    });

    // Content is expanded by default; scope inside it so the "Style" group
    // label doesn't collide with any other section.
    const content = screen.getByRole("button", { name: /^Content$/ });
    expect(content.getAttribute("aria-expanded")).toBe("true");

    expect(screen.getByRole("group", { name: "Color" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Style" })).toBeTruthy();
  });

  it("selecting a swatch updates the custom-colour field with a var() reference", () => {
    resetStores(makeMiniApp([buttonWidget()]));
    render(<MiniAppEditor />);

    act(() => {
      selectFirstWidget();
    });

    const swatches = screen.getByRole("group", { name: "Color" });
    act(() => {
      fireEvent.click(within(swatches).getByRole("button", { name: "Primary" }));
    });

    const custom = screen.getByLabelText("Custom colour") as HTMLInputElement;
    expect(custom.value).toBe("var(--color-primary)");

    // Deselecting the swatch clears the colour back to the "default" state.
    act(() => {
      fireEvent.click(within(swatches).getByRole("button", { name: "Primary" }));
    });
    expect(custom.value).toBe("");
  });

  it("selecting Outline marks the option selected; the default swatch stays selected until a colour is picked", () => {
    resetStores(makeMiniApp([buttonWidget()]));
    render(<MiniAppEditor />);

    act(() => {
      selectFirstWidget();
    });

    const variantGroup = screen.getByRole("group", { name: "Style" });
    const outline = within(variantGroup).getByRole("button", { name: "Outline" });
    const fill = within(variantGroup).getByRole("button", { name: "Fill" });
    expect(fill.getAttribute("aria-pressed")).toBe("true");

    act(() => {
      fireEvent.click(outline);
    });
    expect(outline.getAttribute("aria-pressed")).toBe("true");
    expect(fill.getAttribute("aria-pressed")).toBe("false");

    act(() => {
      fireEvent.click(fill);
    });
    expect(fill.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("MiniAppEditor — toggle widget style", () => {
  it("offers the same style controls in the Content section, independent of Status/Mapping", () => {
    resetStores(makeMiniApp([toggleWidget()]));
    render(<MiniAppEditor />);

    act(() => {
      selectFirstWidget();
    });

    // The Mapping section's rule colour picker ALSO renders a "Color" group,
    // so scope to Content's own collapsible body to avoid ambiguity.
    const contentToggle = screen.getByRole("button", { name: /^Content$/ });
    const contentBody = contentToggle.parentElement as HTMLElement;

    const swatches = within(contentBody).getByRole("group", { name: "Color" });
    const variantGroup = within(contentBody).getByRole("group", { name: "Style" });

    act(() => {
      fireEvent.click(within(swatches).getByRole("button", { name: "Danger" }));
    });
    const custom = within(contentBody).getByLabelText(
      "Custom colour",
    ) as HTMLInputElement;
    expect(custom.value).toBe("var(--color-danger)");

    act(() => {
      fireEvent.click(within(variantGroup).getByRole("button", { name: "Outline" }));
    });
    expect(
      within(variantGroup)
        .getByRole("button", { name: "Outline" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("MiniAppEditor — mapping rule match mode", () => {
  it("defaults a new rule to Exact and can be changed to Contains/Regex", () => {
    resetStores(makeMiniApp([toggleWidget()]));
    render(<MiniAppEditor />);

    act(() => {
      selectFirstWidget();
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    });

    // Two rule rows now exist (the seed + the new one); their match-mode
    // triggers both default-render "Exact".
    const modeTriggers = screen.getAllByRole("button", {
      name: "Match mode",
    });
    expect(modeTriggers).toHaveLength(2);
    expect(
      within(modeTriggers[1]).getByText("Exact"),
    ).toBeTruthy();

    act(() => {
      fireEvent.click(modeTriggers[1]);
    });
    act(() => {
      fireEvent.click(screen.getByRole("option", { name: /^Contains/ }));
    });
    expect(within(modeTriggers[1]).getByText("Contains")).toBeTruthy();
  });

  it("shows a validation error for an invalid regex pattern", () => {
    resetStores(
      makeMiniApp([
        toggleWidget({
          status: {
            source: { kind: "inline", script: "probe" },
            intervalMs: 5000,
            mapping: {
              mode: "mapped",
              rules: [
                { match: "(unclosed", label: "Bad", matchMode: "regex" },
              ],
            },
          },
        }),
      ]),
    );
    render(<MiniAppEditor />);

    // Validation issues only render after Save is pressed once (mirrors
    // CommandForm's showErrors gate) — Save also auto-selects the first
    // offending widget.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(
      screen.getByText(
        "Rule 1's pattern is not a valid regular expression.",
      ),
    ).toBeTruthy();
  });
});

describe("MiniAppEditor — test probe now", () => {
  it("runs the probe, shows raw output, and live-maps it with current rules", async () => {
    const mockedProbe = vi.mocked(runStatusProbe);
    mockedProbe.mockResolvedValue({
      status: "succeeded",
      exitCode: 0,
      fields: {},
      returnValue: null,
      stdoutTail: "connected",
    });

    resetStores(
      makeMiniApp([
        toggleWidget({
          status: {
            source: { kind: "inline", script: "probe" },
            intervalMs: 5000,
            mapping: {
              mode: "mapped",
              rules: [{ match: "connected", label: "Connected!" }],
            },
          },
        }),
      ]),
    );
    render(<MiniAppEditor />);

    act(() => {
      selectFirstWidget();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test probe now" }));
    });

    expect(mockedProbe).toHaveBeenCalledTimes(1);
    expect(screen.getByText("connected")).toBeTruthy();
    expect(screen.getByText("Connected!")).toBeTruthy();

    // Editing a rule after the probe re-maps the SAME result — no re-probe.
    const matchInputs = screen.getAllByLabelText("Match");
    act(() => {
      fireEvent.change(matchInputs[0], { target: { value: "nope" } });
    });

    expect(mockedProbe).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Connected!")).toBeNull();
    // No rule matches now, so the raw string is shown as the fallback label.
    expect(screen.getAllByText("connected").length).toBeGreaterThan(0);
  });
});

describe("MiniAppEditor — unsaved-changes indicator", () => {
  it("is absent on a pristine load and appears after an edit", () => {
    resetStores(makeMiniApp());
    render(<MiniAppEditor />);

    expect(screen.queryByLabelText("Unsaved changes")).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    });
    act(() => {
      fireEvent.change(screen.getByLabelText("Name"), {
        target: { value: "Panel edited" },
      });
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });

    expect(screen.getByLabelText("Unsaved changes")).toBeTruthy();
  });
});

describe("MiniAppEditor — properties panel (no widget selected)", () => {
  it("shows only the panel size fields, not description/icon/category/tags/os", () => {
    resetStores(makeMiniApp());
    render(<MiniAppEditor />);

    expect(screen.getByLabelText("Width")).toBeTruthy();
    expect(screen.getByLabelText("Height")).toBeTruthy();
    expect(screen.queryByLabelText("Description")).toBeNull();
    expect(screen.queryByLabelText("Platforms")).toBeNull();
  });

  it("no longer renders a favourite toggle in the editor", () => {
    resetStores(makeMiniApp());
    render(<MiniAppEditor />);

    expect(screen.queryByRole("switch", { name: "Favorite" })).toBeNull();
  });
});

describe("MiniAppEditor — header actions", () => {
  it("labels the leave button \"Close\", not \"Cancel\"", () => {
    resetStores(makeMiniApp());
    render(<MiniAppEditor />);

    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("does not offer a Delete button anywhere in the editor", () => {
    resetStores(makeMiniApp());
    render(<MiniAppEditor />);

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("MiniAppEditor — toolbar & Properties modal", () => {
  it("shows the mini-app name as a read-only toolbar span, not an editable input", () => {
    resetStores(makeMiniApp());
    render(<MiniAppEditor />);

    expect(screen.getByText("Panel")).toBeTruthy();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("shows \"Untitled\" in the toolbar for a brand-new mini-app", () => {
    resetStores(null);
    render(<MiniAppEditor />);

    expect(screen.getByText("Untitled")).toBeTruthy();
  });

  it("opens the Properties modal with name/description/icon/category/tags/os fields", () => {
    resetStores(makeMiniApp());
    render(<MiniAppEditor />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    });

    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Description")).toBeTruthy();
    expect(screen.getByText("Icon")).toBeTruthy();
    expect(screen.getByText("Category")).toBeTruthy();
    expect(screen.getByLabelText("Tags")).toBeTruthy();
    expect(screen.getByLabelText("Platforms")).toBeTruthy();
  });

  it("saving the modal updates the draft and the toolbar name", () => {
    resetStores(makeMiniApp());
    render(<MiniAppEditor />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    });
    act(() => {
      fireEvent.change(screen.getByLabelText("Name"), {
        target: { value: "Renamed panel" },
      });
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });

    expect(screen.getByText("Renamed panel")).toBeTruthy();
    expect(screen.getByLabelText("Unsaved changes")).toBeTruthy();
  });

  it("Cancel closes the modal without saving", () => {
    resetStores(makeMiniApp());
    render(<MiniAppEditor />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    });
    act(() => {
      fireEvent.change(screen.getByLabelText("Name"), {
        target: { value: "Discarded" },
      });
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(screen.queryByText("Discarded")).toBeNull();
    expect(screen.getByText("Panel")).toBeTruthy();
    expect(screen.queryByLabelText("Unsaved changes")).toBeNull();
  });

  it("backdrop click closes the modal without saving", () => {
    resetStores(makeMiniApp());
    render(<MiniAppEditor />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    });
    const backdrop = document.querySelector(".command-form__backdrop");
    expect(backdrop).not.toBeNull();
    act(() => {
      fireEvent.click(backdrop as HTMLElement);
    });

    expect(document.querySelector(".command-form--meta")).toBeNull();
  });

  it("Undo/Redo still work from the toolbar", () => {
    resetStores(makeMiniApp());
    render(<MiniAppEditor />);

    const undo = screen.getByRole("button", { name: "Undo" });
    expect((undo as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Button/ }));
    });
    expect((undo as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      fireEvent.click(undo);
    });
    expect(document.querySelectorAll(".ma-canvas-widget")).toHaveLength(0);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    });
    expect(document.querySelectorAll(".ma-canvas-widget")).toHaveLength(1);
  });
});
