// Smoke tests for the Mini-App RUNNER (the runtime panel view).
//
// Mocked at the boundaries only: `miniappRepository` (IPC),
// `services/commandRunner` (execution), and `useMiniAppStatusPolling` (the
// timer-driven poller — replaced by a spy so we can assert on the CONFIG it
// receives and feed results back deterministically). The store, the widget
// renderer, and the runner itself all run unchanged.
//
// The contract this file protects: the runner is the single owner of the
// panel's artifact values, and those values must reach BOTH the executor
// (`RunOptions.variableValues`) and the status poller (`variableValues` on
// each config). That wiring is the flagship "artifact as a variable" feature
// and is invisible to any test that only asserts on rendered markup.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

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

vi.mock("../../services/commandRunner", () => ({
  triggerCommandRun: vi.fn().mockResolvedValue("exec-1"),
}));

vi.mock("../../utils/executor", () => ({
  cancelExecution: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn().mockResolvedValue(undefined),
}));

// The poller drives real timers + IPC. Replace the hook with a spy that
// records the configs it was handed and returns whatever the test staged.
vi.mock("../../services/miniappStatusPoller", () => ({
  useMiniAppStatusPolling: vi.fn(() => ({})),
}));

vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import "../../i18n";
import { Message } from "@arco-design/web-react";
import { triggerCommandRun } from "../../services/commandRunner";
import {
  useMiniAppStatusPolling,
  type StatusResult,
  type StatusWidgetConfig,
} from "../../services/miniappStatusPoller";
import { useCommandStore } from "../../stores/commandStore";
import { useExecutionStore } from "../../stores/executionStore";
import { useMiniAppStore } from "../../stores/miniappStore";
import { useUIStore } from "../../stores/uiStore";
import type { MiniApp, MiniAppWidget } from "../../types";
import { cancelExecution } from "../../utils/executor";
import { listMiniAppsFromDb } from "../../utils/miniappRepository";
import { MiniAppRunner } from "./MiniAppRunner";

const DATA_URI_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function buttonWidget(
  overrides: Partial<Extract<MiniAppWidget, { kind: "button" }>> = {},
): MiniAppWidget {
  return {
    id: "w-btn",
    kind: "button",
    layout: { x: 16, y: 100, w: 124, h: 44 },
    label: "Connect",
    action: { kind: "inline", name: "Connect", script: "vpn up" },
    ...overrides,
  };
}

function artifactWidget(
  overrides: Partial<Extract<MiniAppWidget, { kind: "artifact" }>> = {},
): MiniAppWidget {
  return {
    id: "w-art",
    kind: "artifact",
    layout: { x: 16, y: 156, w: 268, h: 56 },
    name: "configPath",
    label: "Config File",
    value: "",
    variant: "path",
    ...overrides,
  };
}

function statusWidget(
  overrides: Partial<Extract<MiniAppWidget, { kind: "status" }>> = {},
): MiniAppWidget {
  return {
    id: "w-status",
    kind: "status",
    layout: { x: 16, y: 16, w: 268, h: 72 },
    label: "Connection",
    source: { kind: "inline", script: "vpn status" },
    intervalMs: 10000,
    mapping: { mode: "raw" },
    ...overrides,
  };
}

function makeMiniApp(overrides: Partial<MiniApp> = {}): MiniApp {
  return {
    id: "ma-1",
    name: "VPN Panel",
    widgets: [],
    tags: [],
    favorite: false,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    runCount: 0,
    panelSize: { w: 320, h: 240 },
    ...overrides,
  };
}

function stageMiniApp(miniapp: MiniApp | null): void {
  useMiniAppStore.setState({
    miniapps: miniapp === null ? [] : [miniapp],
    favorites: [],
    hydrated: true,
  });
  useCommandStore.setState({ commands: [] });
  useUIStore.setState({
    currentView: "miniapp-runner",
    miniappRunnerId: miniapp === null ? "ghost-id" : miniapp.id,
  });
}

/** Render the runner and flush the post-mount `hydrateFromDb` effect. */
async function renderRunner(): Promise<void> {
  vi.mocked(listMiniAppsFromDb).mockResolvedValue(
    useMiniAppStore.getState().miniapps,
  );
  await act(async () => {
    render(<MiniAppRunner />);
  });
}

/** The configs handed to the poller on the most recent render. */
function latestPollerConfigs(): StatusWidgetConfig[] {
  const calls = vi.mocked(useMiniAppStatusPolling).mock.calls;
  const last = calls[calls.length - 1];
  if (last === undefined) throw new Error("poller was never called");
  return last[0];
}

/** Stage the results the mocked poller hands back on the next render. */
function stagePollerResults(results: Record<string, StatusResult>): void {
  vi.mocked(useMiniAppStatusPolling).mockImplementation(() => results);
}

beforeEach(() => {
  vi.mocked(useMiniAppStatusPolling).mockImplementation(() => ({}));
  stageMiniApp(null);
  useExecutionStore.setState({ executions: {}, recentIds: [] });
});

afterEach(() => {
  stageMiniApp(null);
  useExecutionStore.setState({ executions: {}, recentIds: [] });
  vi.clearAllMocks();
});

describe("MiniAppRunner — header", () => {
  it("renders the mini-app name", async () => {
    stageMiniApp(makeMiniApp({ widgets: [buttonWidget()] }));
    await renderRunner();

    expect(screen.getByText("VPN Panel")).toBeTruthy();
  });

  it("renders an emoji icon beside the title", async () => {
    stageMiniApp(makeMiniApp({ icon: "🔌" }));
    await renderRunner();

    expect(screen.getByText("🔌")).toBeTruthy();
  });

  it("renders a data-URI icon as an <img>", async () => {
    stageMiniApp(makeMiniApp({ icon: DATA_URI_ICON }));
    await renderRunner();

    expect(
      document.querySelector(".view-title__icon")?.getAttribute("src"),
    ).toBe(DATA_URI_ICON);
  });

  it("renders a seed mini-app's TRANSLATED name, and its description on title hover", async () => {
    stageMiniApp(
      makeMiniApp({
        name: "raw literal name",
        nameKey: "miniapps.seeds.systemInfo.name",
        descriptionKey: "miniapps.seeds.systemInfo.description",
      }),
    );
    await renderRunner();

    expect(screen.getByText("System Info")).toBeTruthy();
    expect(
      screen.queryByText("Live uptime with disk and memory inspection buttons"),
    ).toBeNull();

    act(() => {
      fireEvent.mouseEnter(screen.getByText("System Info").closest("h1")!);
    });
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe(
      "Live uptime with disk and memory inspection buttons",
    );
  });

  it("resolves ${artifact} references in the description, shown on title hover", async () => {
    stageMiniApp(
      makeMiniApp({
        description: "Config at ${configPath}",
        widgets: [artifactWidget({ value: "/etc/a.ovpn" })],
      }),
    );
    await renderRunner();

    expect(screen.queryByText("Config at /etc/a.ovpn")).toBeNull();

    act(() => {
      fireEvent.mouseEnter(screen.getByText("VPN Panel").closest("h1")!);
    });
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe("Config at /etc/a.ovpn");
  });

  it("Back clears the runner id and returns to the list", async () => {
    stageMiniApp(makeMiniApp({ widgets: [buttonWidget()] }));
    await renderRunner();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
    });

    expect(useUIStore.getState().currentView).toBe("library");
    expect(useUIStore.getState().libraryTab).toBe("miniapps");
    expect(useUIStore.getState().miniappRunnerId).toBeNull();
  });
});

describe("MiniAppRunner — standalone window mode", () => {
  it("resolves the mini-app from the miniappId prop, ignoring the shared uiStore id", async () => {
    // The shared `uiStore.miniappRunnerId` is left null/stale — a standalone
    // window has no reason to touch the MAIN window's store.
    useMiniAppStore.setState({
      miniapps: [makeMiniApp({ widgets: [buttonWidget()] })],
      favorites: [],
      hydrated: true,
    });
    useCommandStore.setState({ commands: [] });
    useUIStore.setState({ miniappRunnerId: null });
    vi.mocked(listMiniAppsFromDb).mockResolvedValue(
      useMiniAppStore.getState().miniapps,
    );

    await act(async () => {
      render(<MiniAppRunner miniappId="ma-1" standalone />);
    });

    expect(screen.getByText("VPN Panel")).toBeTruthy();
  });

  it("hides the Back button, when standalone — the native window chrome is the only way out", async () => {
    useMiniAppStore.setState({
      miniapps: [makeMiniApp({ widgets: [buttonWidget()] })],
      favorites: [],
      hydrated: true,
    });
    useCommandStore.setState({ commands: [] });
    vi.mocked(listMiniAppsFromDb).mockResolvedValue(
      useMiniAppStore.getState().miniapps,
    );

    await act(async () => {
      render(<MiniAppRunner miniappId="ma-1" standalone />);
    });

    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});

describe("MiniAppRunner — panel layout", () => {
  it("sizes the panel from the mini-app's panelSize", async () => {
    stageMiniApp(
      makeMiniApp({
        panelSize: { w: 320, h: 500 },
        widgets: [buttonWidget()],
      }),
    );
    await renderRunner();

    const panel = document.querySelector(".miniapp-runner__panel");
    expect((panel as HTMLElement).style.width).toBe("320px");
    expect((panel as HTMLElement).style.minHeight).toBe("500px");
  });

  it("grows the panel so a widget placed beyond panelSize.h is not clipped", async () => {
    stageMiniApp(
      makeMiniApp({
        panelSize: { w: 320, h: 240 },
        widgets: [
          buttonWidget({ layout: { x: 0, y: 600, w: 120, h: 44 } }),
        ],
      }),
    );
    await renderRunner();

    const panel = document.querySelector(".miniapp-runner__panel");
    // 600 + 44 + 24 (bottom padding) = 668.
    expect((panel as HTMLElement).style.minHeight).toBe("668px");
  });

  it("places each widget slot at its layout position and size", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [buttonWidget({ layout: { x: 24, y: 48, w: 130, h: 40 } })],
      }),
    );
    await renderRunner();

    const slot = document.querySelector(
      ".miniapp-runner__widget-slot",
    ) as HTMLElement;
    expect(slot.style.left).toBe("24px");
    expect(slot.style.top).toBe("48px");
    expect(slot.style.width).toBe("130px");
    expect(slot.style.height).toBe("40px");
  });

  it("renders one slot per widget", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [statusWidget(), buttonWidget(), artifactWidget()],
      }),
    );
    await renderRunner();

    expect(
      document.querySelectorAll(".miniapp-runner__widget-slot"),
    ).toHaveLength(3);
  });

  it("renders widgets WITHOUT the bordered card class (chromeless in the Runner)", async () => {
    stageMiniApp(makeMiniApp({ widgets: [buttonWidget()] }));
    await renderRunner();

    const widgetEl = document.querySelector(".miniapp-widget");
    expect(widgetEl).not.toBeNull();
    expect(widgetEl?.className).toContain("miniapp-widget--chromeless");
  });
});

describe("MiniAppRunner — empty and not-found states", () => {
  it("shows the no-widgets state instead of an empty panel", async () => {
    stageMiniApp(makeMiniApp({ widgets: [] }));
    await renderRunner();

    expect(screen.getByText("This mini-app has no widgets yet.")).toBeTruthy();
    expect(document.querySelector(".miniapp-runner__panel")).toBeNull();
  });

  it("shows a not-found state with a Back action for an unresolvable id", async () => {
    stageMiniApp(null);
    await renderRunner();

    expect(screen.getByText("Mini-app not found")).toBeTruthy();
    expect(
      screen.getByText("This mini-app may have been deleted."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("the not-found Back action still navigates home", async () => {
    stageMiniApp(null);
    await renderRunner();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
    });

    expect(useUIStore.getState().currentView).toBe("library");
    expect(useUIStore.getState().libraryTab).toBe("miniapps");
  });
});

describe("MiniAppRunner — artifact values", () => {
  it("initialises each artifact input from its editor default", async () => {
    stageMiniApp(
      makeMiniApp({ widgets: [artifactWidget({ value: "/etc/a.ovpn" })] }),
    );
    await renderRunner();

    expect(
      (screen.getByLabelText("Config File") as HTMLInputElement).value,
    ).toBe("/etc/a.ovpn");
  });

  it("an edited artifact value reaches the executor as variableValues", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [
          artifactWidget(),
          buttonWidget({
            action: {
              kind: "inline",
              name: "Connect",
              script: "openvpn3 --config ${configPath}",
            },
          }),
        ],
      }),
    );
    await renderRunner();

    act(() => {
      fireEvent.change(screen.getByLabelText("Config File"), {
        target: { value: "/etc/typed.ovpn" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    const [, opts] = vi.mocked(triggerCommandRun).mock.calls[0];
    expect(opts?.variableValues).toEqual({ configPath: "/etc/typed.ovpn" });
  });

  it("editing one artifact does not reset the others", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [
          artifactWidget({ id: "a1", name: "host", label: "Host", value: "h1" }),
          artifactWidget({ id: "a2", name: "port", label: "Port", value: "22" }),
        ],
      }),
    );
    await renderRunner();

    act(() => {
      fireEvent.change(screen.getByLabelText("Host"), {
        target: { value: "h2" },
      });
    });

    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("22");
    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe("h2");
  });

  it("a live artifact value resolves inside another widget's label", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [
          artifactWidget({ name: "host", label: "Host", value: "prod-1" }),
          buttonWidget({ label: "Connect to ${host}" }),
        ],
      }),
    );
    await renderRunner();

    expect(
      screen.getByRole("button", { name: /Connect to prod-1/ }),
    ).toBeTruthy();

    act(() => {
      fireEvent.change(screen.getByLabelText("Host"), {
        target: { value: "prod-2" },
      });
    });

    expect(
      screen.getByRole("button", { name: /Connect to prod-2/ }),
    ).toBeTruthy();
  });

  it("warns once when two artifacts share a name", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [
          artifactWidget({ id: "a1", name: "host", label: "Host A" }),
          artifactWidget({ id: "a2", name: "host", label: "Host B" }),
        ],
      }),
    );
    await renderRunner();

    expect(Message.warning).toHaveBeenCalledTimes(1);
    expect(Message.warning).toHaveBeenCalledWith(
      "Duplicate artifact names: host. Inputs sharing a name share one value.",
    );
  });

  it("does not warn when every artifact name is unique", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [
          artifactWidget({ id: "a1", name: "host", label: "Host" }),
          artifactWidget({ id: "a2", name: "port", label: "Port" }),
        ],
      }),
    );
    await renderRunner();

    expect(Message.warning).not.toHaveBeenCalled();
  });
});

describe("MiniAppRunner — persisted artifact write-back", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes back only the edited artifact's value after the debounce settles", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [
          artifactWidget({
            id: "a1",
            name: "configPath",
            label: "Config File",
            value: "/etc/a.ovpn",
            variant: "text",
            persist: true,
          }),
          buttonWidget(),
        ],
      }),
    );
    await renderRunner();

    act(() => {
      fireEvent.change(screen.getByLabelText("Config File"), {
        target: { value: "/etc/typed.ovpn" },
      });
    });

    expect(useMiniAppStore.getState().miniapps[0].widgets[0]).toMatchObject({
      value: "/etc/a.ovpn",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    const stored = useMiniAppStore.getState().miniapps[0];
    expect(stored.widgets[0]).toMatchObject({ value: "/etc/typed.ovpn" });
    expect(stored.widgets[1]).toMatchObject(buttonWidget());
  });

  it("never writes back when persist is false or undefined", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [
          artifactWidget({
            id: "a1",
            name: "configPath",
            label: "Config File",
            value: "/etc/a.ovpn",
            variant: "text",
            persist: false,
          }),
        ],
      }),
    );
    await renderRunner();

    act(() => {
      fireEvent.change(screen.getByLabelText("Config File"), {
        target: { value: "/etc/typed.ovpn" },
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(useMiniAppStore.getState().miniapps[0].widgets[0]).toMatchObject({
      value: "/etc/a.ovpn",
    });
  });

  it("never writes back a persist:true secret artifact — runtime guard blocks it", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [
          artifactWidget({
            id: "a1",
            name: "apiKey",
            label: "API Key",
            value: "sekrit",
            variant: "secret",
            persist: true,
          }),
        ],
      }),
    );
    await renderRunner();

    act(() => {
      fireEvent.change(screen.getByLabelText("API Key"), {
        target: { value: "typed-secret" },
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(useMiniAppStore.getState().miniapps[0].widgets[0]).toMatchObject({
      value: "sekrit",
    });
  });

  it("independently debounces multiple persisted artifacts edited in the same window", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [
          artifactWidget({
            id: "a1",
            name: "host",
            label: "Host",
            value: "h1",
            variant: "text",
            persist: true,
          }),
          artifactWidget({
            id: "a2",
            name: "port",
            label: "Port",
            value: "22",
            variant: "text",
            persist: true,
          }),
        ],
      }),
    );
    await renderRunner();

    act(() => {
      fireEvent.change(screen.getByLabelText("Host"), {
        target: { value: "h2" },
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    act(() => {
      fireEvent.change(screen.getByLabelText("Port"), {
        target: { value: "2222" },
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    const stored = useMiniAppStore.getState().miniapps[0];
    expect(stored.widgets[0]).toMatchObject({ value: "h2" });
    expect(stored.widgets[1]).toMatchObject({ value: "2222" });
  });

  it("does not error or write after the runner unmounts before the debounce fires", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [
          artifactWidget({
            id: "a1",
            name: "configPath",
            label: "Config File",
            value: "/etc/a.ovpn",
            variant: "text",
            persist: true,
          }),
        ],
      }),
    );
    vi.mocked(listMiniAppsFromDb).mockResolvedValue(
      useMiniAppStore.getState().miniapps,
    );
    let unmount: () => void = () => {};
    await act(async () => {
      const result = render(<MiniAppRunner />);
      unmount = result.unmount;
    });

    act(() => {
      fireEvent.change(screen.getByLabelText("Config File"), {
        target: { value: "/etc/typed.ovpn" },
      });
    });

    expect(() => {
      unmount();
    }).not.toThrow();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(useMiniAppStore.getState().miniapps[0].widgets[0]).toMatchObject({
      value: "/etc/a.ovpn",
    });
  });
});

describe("MiniAppRunner — status polling wiring", () => {
  it("builds one poller config per status widget", async () => {
    stageMiniApp(makeMiniApp({ widgets: [statusWidget(), buttonWidget()] }));
    await renderRunner();

    const configs = latestPollerConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].widgetId).toBe("w-status");
    expect(configs[0].intervalMs).toBe(10000);
    expect(configs[0].source).toEqual({ kind: "inline", script: "vpn status" });
    expect(configs[0].mapping).toEqual({ mode: "raw" });
  });

  it("falls back to the default interval for a status widget with none", async () => {
    stageMiniApp(makeMiniApp({ widgets: [statusWidget({ intervalMs: 0 })] }));
    await renderRunner();

    expect(latestPollerConfigs()[0].intervalMs).toBe(5000);
  });

  it("includes a toggle that carries a status source", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [
          {
            id: "w-tgl",
            kind: "toggle",
            layout: { x: 0, y: 0, w: 160, h: 44 },
            label: "VPN",
            onAction: { kind: "inline", name: "on", script: "up" },
            offAction: { kind: "inline", name: "off", script: "down" },
            status: {
              source: { kind: "inline", script: "vpn status" },
              intervalMs: 3000,
              mapping: { mode: "raw" },
            },
          },
        ],
      }),
    );
    await renderRunner();

    const configs = latestPollerConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].widgetId).toBe("w-tgl");
    expect(configs[0].intervalMs).toBe(3000);
  });

  it("excludes buttons, artifacts, and status-less toggles", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [
          buttonWidget(),
          artifactWidget(),
          {
            id: "w-tgl",
            kind: "toggle",
            layout: { x: 0, y: 0, w: 160, h: 44 },
            label: "VPN",
            onAction: { kind: "inline", name: "on", script: "up" },
            offAction: { kind: "inline", name: "off", script: "down" },
          },
        ],
      }),
    );
    await renderRunner();

    expect(latestPollerConfigs()).toEqual([]);
  });

  it("threads the CURRENT artifact values into every poller config", async () => {
    stageMiniApp(
      makeMiniApp({
        widgets: [
          artifactWidget({ name: "host", label: "Host", value: "prod-1" }),
          statusWidget({
            source: { kind: "inline", script: "ping ${host}" },
          }),
        ],
      }),
    );
    await renderRunner();

    expect(latestPollerConfigs()[0].variableValues).toEqual({
      host: "prod-1",
    });

    act(() => {
      fireEvent.change(screen.getByLabelText("Host"), {
        target: { value: "prod-2" },
      });
    });

    expect(latestPollerConfigs()[0].variableValues).toEqual({
      host: "prod-2",
    });
  });

  it("routes each poller result to the matching widget", async () => {
    stagePollerResults({
      "w-status": { state: "ok", label: "Connected", rawValue: "up" },
    });
    stageMiniApp(makeMiniApp({ widgets: [statusWidget()] }));
    await renderRunner();

    expect(screen.getByText("Connected")).toBeTruthy();
  });
});

describe("MiniAppRunner — run accounting", () => {
  it("bumps the mini-app's run count when a widget action starts", async () => {
    stageMiniApp(makeMiniApp({ widgets: [buttonWidget()] }));
    await renderRunner();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    const stored = useMiniAppStore.getState().miniapps[0];
    expect(stored.runCount).toBe(1);
    expect(stored.lastRunAt).toBeTruthy();
  });

  it("does not bump the run count when the run was cancelled", async () => {
    vi.mocked(triggerCommandRun).mockResolvedValueOnce(null);
    stageMiniApp(makeMiniApp({ widgets: [buttonWidget()] }));
    await renderRunner();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    expect(useMiniAppStore.getState().miniapps[0].runCount).toBe(0);
  });
});

describe("MiniAppRunner — hydration", () => {
  it("hydrates the store on mount so a deep link still resolves", async () => {
    stageMiniApp(makeMiniApp({ widgets: [buttonWidget()] }));
    await renderRunner();

    expect(listMiniAppsFromDb).toHaveBeenCalled();
  });
});

describe("MiniAppRunner — active processes panel", () => {
  it("renders nothing when nothing is running", async () => {
    stageMiniApp(makeMiniApp({ widgets: [buttonWidget()] }));
    await renderRunner();

    expect(document.querySelector(".miniapp-processes")).toBeNull();
  });

  it("shows a row with the widget's label after clicking a button", async () => {
    stageMiniApp(makeMiniApp({ widgets: [buttonWidget()] }));
    await renderRunner();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    const panel = document.querySelector(".miniapp-processes");
    expect(panel).not.toBeNull();
    expect(within(panel as HTMLElement).getByText("Connect")).toBeTruthy();
  });

  it("shows the PID once the execution store reports one", async () => {
    stageMiniApp(makeMiniApp({ widgets: [buttonWidget()] }));
    await renderRunner();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    // Before the `started` event lands, the row shows a pending placeholder.
    expect(screen.getByText("starting…")).toBeTruthy();

    act(() => {
      useExecutionStore
        .getState()
        .startExecution("exec-1", undefined, "Connect");
      useExecutionStore.setState((s) => ({
        executions: {
          ...s.executions,
          "exec-1": { ...s.executions["exec-1"], pid: 4242 },
        },
      }));
    });

    expect(screen.getByText("PID 4242")).toBeTruthy();
  });

  it("tracks MULTIPLE concurrent processes — one row per running widget", async () => {
    vi.mocked(triggerCommandRun)
      .mockResolvedValueOnce("exec-a")
      .mockResolvedValueOnce("exec-b");
    stageMiniApp(
      makeMiniApp({
        widgets: [
          buttonWidget({ id: "w-1", label: "Connect A" }),
          buttonWidget({
            id: "w-2",
            label: "Connect B",
            action: { kind: "inline", name: "Connect B", script: "vpn up b" },
          }),
        ],
      }),
    );
    await renderRunner();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect A/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect B/ }));
    });

    const panel = document.querySelector(".miniapp-processes") as HTMLElement;
    expect(panel.querySelectorAll(".miniapp-processes__item")).toHaveLength(2);
    expect(within(panel).getByText("Connect A")).toBeTruthy();
    expect(within(panel).getByText("Connect B")).toBeTruthy();
  });

  it("removes the row once the execution reaches a terminal status", async () => {
    stageMiniApp(makeMiniApp({ widgets: [buttonWidget()] }));
    await renderRunner();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });
    expect(document.querySelector(".miniapp-processes")).not.toBeNull();

    act(() => {
      useExecutionStore
        .getState()
        .startExecution("exec-1", undefined, "Connect");
      useExecutionStore.getState().finishExecution("exec-1", {
        status: "success",
        exitCode: 0,
        durationMs: 10,
        finishedAt: Date.now(),
        error: undefined,
        timedOut: false,
      });
    });

    expect(document.querySelector(".miniapp-processes")).toBeNull();
  });

  it("Cancel invokes cancelExecution with the row's execution id", async () => {
    stageMiniApp(makeMiniApp({ widgets: [buttonWidget()] }));
    await renderRunner();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Cancel" }),
      );
    });

    expect(cancelExecution).toHaveBeenCalledWith("exec-1");
  });

  it("clears tracked processes when switching to a different mini-app", async () => {
    stageMiniApp(makeMiniApp({ id: "ma-1", widgets: [buttonWidget()] }));
    await renderRunner();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });
    expect(document.querySelector(".miniapp-processes")).not.toBeNull();

    stageMiniApp(makeMiniApp({ id: "ma-2", widgets: [buttonWidget()] }));
    await renderRunner();

    expect(document.querySelector(".miniapp-processes")).toBeNull();
  });
});
