// Regression test: a saved layout must not keep its dirty marker. Save commit
// uses fresh session observations, and the live snapshot's null optional
// fields must compare equal to the omitted fields in the persisted record.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  describe: vi.fn(),
  show: vi.fn(),
  apply: vi.fn(),
  list: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../../services/terminalService", () => ({
  MAX_TERMINAL_SESSIONS: 10,
  describeTerminalSession: mocks.describe,
}));
vi.mock("../ContextMenu", () => ({
  useContextMenu: () => ({ show: mocks.show }),
}));
vi.mock("./useApplyTerminalLayout", () => ({
  useApplyTerminalLayout: () => mocks.apply,
}));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({
    t: (key: string) =>
      key === "outputPanel.terminalLayouts.dirtyMarker" ? "•" : key,
  }),
}));
vi.mock("@arco-design/web-react", () => ({
  Message: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));
vi.mock("../../services/terminalLayoutsService", () => ({
  listTerminalLayouts: mocks.list,
  saveTerminalLayout: mocks.save,
  renameTerminalLayout: vi.fn(),
  deleteTerminalLayout: vi.fn(),
}));

import { TerminalLayoutPicker } from "./TerminalLayoutPicker";
import { useExecutionStore } from "../../stores/executionStore";
import { useTerminalLayoutsStore } from "../../stores/terminalLayoutsStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useUIStore } from "../../stores/uiStore";
import type { TerminalLayoutDto } from "../../types/terminalLayout";

const SESSION_ID = "session-1";
const REGION_ID = "region-1";

function layoutDto(cwd: string): TerminalLayoutDto {
  return {
    id: "layout-1",
    name: "Alpha",
    position: "bottom",
    fullscreen: false,
    size: { height: 360 },
    createdAt: "2026-09-14T00:00:00+00:00",
    updatedAt: "2026-09-14T00:00:00+00:00",
    layout: {
      type: "region",
      tabs: [{ title: "Terminal 1", lastCommand: "cd /tmp", cwd }],
      activeTabIndex: 0,
    },
  };
}

function resetStores(): void {
  useTerminalStore.setState({
    layoutRoot: { type: "region", regionId: REGION_ID },
    regions: {
      [REGION_ID]: { id: REGION_ID, tabIds: [SESSION_ID], activeTabId: SESSION_ID },
    },
    sessions: {
      [SESSION_ID]: {
        id: SESSION_ID,
        title: "Terminal 1",
        number: 1,
        createdAt: 0,
        exited: false,
      },
    },
    lastCommands: { [SESSION_ID]: "cd /tmp" },
  });
  useUIStore.setState({ consolePosition: "bottom", consoleFullscreen: false });
  useExecutionStore.setState({ panelHeight: 360, panelWidth: 320 });
  useTerminalLayoutsStore.setState({
    layouts: [],
    activeLayoutId: "layout-1",
    isLoading: false,
  });
}

function contextMenuItems(): Array<{ id: string; onSelect: () => void }> {
  const lastCall = mocks.show.mock.calls[mocks.show.mock.calls.length - 1];
  const call = lastCall?.[0] as
    | { items: Array<{ id: string; onSelect: () => void }> }
    | undefined;
  return call?.items ?? [];
}

function selectTrigger(): HTMLElement {
  return screen.getByRole("button", {
    name: "outputPanel.terminalLayouts.ariaLabel",
  });
}

describe("TerminalLayoutPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();

    const saved = layoutDto("/tmp");
    mocks.list.mockResolvedValue([saved]);
    mocks.save.mockResolvedValue({ ...saved, id: "layout-2", name: "Beta" });
    mocks.describe
      .mockResolvedValueOnce({ cwd: "/home/egor", remoteCommand: null })
      .mockResolvedValue({ cwd: "/tmp", remoteCommand: null });
  });

  it("clears the dirty marker after saving a fresh terminal snapshot", async () => {
    render(<TerminalLayoutPicker />);
    await act(async () => {});
    expect(selectTrigger().textContent).toContain("Alpha •");

    fireEvent.click(
      screen.getByTitle("outputPanel.terminalLayouts.manage"),
    );
    act(() => {
      contextMenuItems()
        .find((item) => item.id === "save-as")
        ?.onSelect();
    });

    fireEvent.change(screen.getByLabelText("outputPanel.terminalLayouts.nameLabel"), {
      target: { value: "Beta" },
    });
    const form = screen.getByRole("dialog").querySelector("form");
    if (!form) throw new Error("layout name form is missing");
    fireEvent.submit(form);
    await act(async () => {});

    expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({
      name: "Beta",
      layout: {
        tabs: [{ cwd: "/tmp" }],
      },
    });
    expect(selectTrigger().textContent).toContain("Beta");
    expect(selectTrigger().textContent).not.toContain("•");
  });
});
