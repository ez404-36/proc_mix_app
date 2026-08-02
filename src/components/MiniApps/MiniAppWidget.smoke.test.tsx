// Smoke tests for the Mini-App runtime widget renderer.
//
// `triggerCommandRun` (the execution boundary) and `@tauri-apps/plugin-opener`
// are mocked so nothing crosses the Tauri boundary; the command store and the
// widget itself run unchanged.
//
// The behaviours covered here are the ones a regression would be silent about:
// the artifact values reaching `RunOptions.variableValues` (the flagship
// "artifact as a variable" feature), the toggle's value-based on-state
// derivation (bug S3 — a probe exiting 0 must NOT mean "on"), the TRANSLATED
// status error with the raw backend text kept as a `title` (bug S8), and the
// broken/disabled state for a widget whose `commandRef` no longer resolves.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../services/commandRunner", () => ({
  triggerCommandRun: vi.fn().mockResolvedValue("exec-1"),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/miniappPathPicker", () => ({
  pickArtifactPath: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../utils/commandRepository", () => ({
  listCommandsFromDb: vi.fn().mockResolvedValue([]),
  upsertCommandInDb: vi.fn().mockResolvedValue(undefined),
  deleteCommandInDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import "../../i18n";
import { Message } from "@arco-design/web-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { pickArtifactPath } from "../../services/miniappPathPicker";
import { triggerCommandRun } from "../../services/commandRunner";
import type { StatusResult } from "../../services/miniappStatusPoller";
import { useCommandStore } from "../../stores/commandStore";
import type { Command, MiniAppWidget as WidgetSpec } from "../../types";
import { collectArtifactSpecSources } from "../../utils/miniappInlineCommand";
import { MiniAppWidget } from "./MiniAppWidget";

const LAYOUT = { x: 0, y: 0, w: 160, h: 44 };

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: "cmd-1",
    name: "Deploy",
    script: "echo deploy",
    runAsAdmin: false,
    tags: [],
    favorite: false,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    runCount: 0,
    ...overrides,
  };
}

interface RenderOptions {
  statusResult?: StatusResult;
  artifactValues?: Record<string, string>;
  onArtifactChange?: (name: string, value: string) => void;
  onActionComplete?: () => void;
  /** Artifact widgets whose specs the panel synthesizes for every action. */
  artifactWidgets?: WidgetSpec[];
  /** Defaults to `true` (the editor's bordered-card look), matching the
   * component's own default. */
  bordered?: boolean;
}

/**
 * Render a single widget with the artifact context the runner would supply.
 * `artifactValues` doubles as the execution map (that is exactly what the
 * runner does) and as the display-resolution source.
 */
function renderWidget(widget: WidgetSpec, opts: RenderOptions = {}): void {
  const values = opts.artifactValues ?? {};
  render(
    <MiniAppWidget
      widget={widget}
      statusResult={opts.statusResult}
      onActionComplete={opts.onActionComplete}
      artifactValues={values}
      onArtifactChange={opts.onArtifactChange ?? (() => {})}
      artifactNames={new Set(Object.keys(values))}
      valuesMap={new Map(Object.entries(values))}
      executionValues={values}
      artifactSpecs={collectArtifactSpecSources(opts.artifactWidgets ?? [])}
      bordered={opts.bordered}
    />,
  );
}

beforeEach(() => {
  useCommandStore.setState({ commands: [] });
});

afterEach(() => {
  useCommandStore.setState({ commands: [] });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

describe("MiniAppWidget — button", () => {
  function buttonWidget(
    overrides: Partial<Extract<WidgetSpec, { kind: "button" }>> = {},
  ): WidgetSpec {
    return {
      id: "w-btn",
      kind: "button",
      layout: LAYOUT,
      label: "Connect",
      action: { kind: "inline", name: "Connect", script: "vpn up" },
      ...overrides,
    };
  }

  it("renders the label with the default run glyph", () => {
    renderWidget(buttonWidget());

    expect(screen.getByRole("button", { name: /Connect/ })).toBeTruthy();
    expect(document.querySelector(".miniapp-widget__button-icon")).toBeNull();
  });

  it("renders a configured emoji icon instead of the run glyph", () => {
    renderWidget(buttonWidget({ icon: "🚀" }));

    expect(screen.getByText("🚀")).toBeTruthy();
  });

  it("resolves ${artifact} references in the label", () => {
    renderWidget(buttonWidget({ label: "Connect to ${host}" }), {
      artifactValues: { host: "prod-1" },
    });

    expect(screen.getByRole("button", { name: /Connect to prod-1/ })).toBeTruthy();
  });

  it("click runs the inline action through triggerCommandRun", async () => {
    renderWidget(buttonWidget());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    expect(triggerCommandRun).toHaveBeenCalledTimes(1);
    const [cmd] = vi.mocked(triggerCommandRun).mock.calls[0];
    expect(cmd.script).toBe("vpn up");
    expect(cmd.name).toBe("Connect");
  });

  it("forwards the current artifact values as variableValues", async () => {
    const artifact: WidgetSpec = {
      id: "w-art",
      kind: "artifact",
      layout: LAYOUT,
      name: "configPath",
      label: "Config",
      value: "",
      variant: "path",
    };
    renderWidget(
      buttonWidget({
        action: {
          kind: "inline",
          name: "Connect",
          script: "openvpn3 --config ${configPath}",
        },
      }),
      {
        artifactValues: { configPath: "/etc/client.ovpn" },
        artifactWidgets: [artifact],
      },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    const [, opts] = vi.mocked(triggerCommandRun).mock.calls[0];
    expect(opts?.variableValues).toEqual({ configPath: "/etc/client.ovpn" });
  });

  it("synthesizes a VariableSpec per artifact so a dropped value cannot hard-fail", async () => {
    const artifact: WidgetSpec = {
      id: "w-art",
      kind: "artifact",
      layout: LAYOUT,
      name: "configPath",
      label: "Config",
      value: "/default.ovpn",
      variant: "path",
    };
    renderWidget(buttonWidget(), { artifactWidgets: [artifact] });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    const [cmd] = vi.mocked(triggerCommandRun).mock.calls[0];
    expect(cmd.variables).toEqual([
      { name: "configPath", defaultValue: "/default.ovpn" },
    ]);
  });

  it("marks a secret artifact's synthesized spec as sensitive", async () => {
    const artifact: WidgetSpec = {
      id: "w-art",
      kind: "artifact",
      layout: LAYOUT,
      name: "token",
      label: "Token",
      value: "",
      variant: "secret",
    };
    renderWidget(buttonWidget(), { artifactWidgets: [artifact] });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    const [cmd] = vi.mocked(triggerCommandRun).mock.calls[0];
    expect(cmd.variables).toEqual([
      { name: "token", defaultValue: "", sensitive: true },
    ]);
  });

  it("resolves a commandRef action against the command store", async () => {
    useCommandStore.setState({ commands: [makeCommand({ id: "cmd-7" })] });
    renderWidget(
      buttonWidget({ action: { kind: "commandRef", commandId: "cmd-7" } }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    const [cmd] = vi.mocked(triggerCommandRun).mock.calls[0];
    expect(cmd.id).toBe("cmd-7");
  });

  it("fires onActionComplete only when a run actually started", async () => {
    const onActionComplete = vi.fn();
    renderWidget(buttonWidget(), { onActionComplete });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    expect(onActionComplete).toHaveBeenCalledTimes(1);
  });

  it("does not fire onActionComplete when the run was cancelled", async () => {
    vi.mocked(triggerCommandRun).mockResolvedValueOnce(null);
    const onActionComplete = vi.fn();
    renderWidget(buttonWidget(), { onActionComplete });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    expect(onActionComplete).not.toHaveBeenCalled();
  });

  it("is disabled and shows 'Running…' while a run is in flight", async () => {
    let settle: (id: string | null) => void = () => {};
    vi.mocked(triggerCommandRun).mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    renderWidget(buttonWidget());

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    const running = screen.getByRole("button", { name: /Running/ });
    expect((running as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      settle("exec-1");
    });
    expect(
      (screen.getByRole("button", { name: /Connect/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("renders disabled with a warning marker when the referenced command is gone", () => {
    renderWidget(
      buttonWidget({ action: { kind: "commandRef", commandId: "missing" } }),
    );

    const button = screen.getByRole("button", { name: /Connect/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.className).toContain("is-broken");
    expect(
      screen.getByRole("img", { name: "Linked command is missing" }),
    ).toBeTruthy();
  });

  it("never runs a broken commandRef, even if the click lands", () => {
    renderWidget(
      buttonWidget({ action: { kind: "commandRef", commandId: "missing" } }),
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    expect(triggerCommandRun).not.toHaveBeenCalled();
  });

  it("surfaces a toast when triggerCommandRun throws unexpectedly", async () => {
    vi.mocked(triggerCommandRun).mockRejectedValueOnce(new Error("boom"));
    renderWidget(buttonWidget());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    });

    expect(Message.error).toHaveBeenCalledWith("Failed to run: boom");
  });

  it("renders no inline style when style is unset (regression check)", () => {
    renderWidget(buttonWidget());

    const button = screen.getByRole("button", { name: /Connect/ });
    expect((button as HTMLButtonElement).getAttribute("style")).toBeNull();
  });

  it("applies a custom fill color as background/border with white text", () => {
    renderWidget(
      buttonWidget({
        style: { variant: "fill", color: "var(--color-danger)" },
      }),
    );

    const button = screen.getByRole(
      "button",
      { name: /Connect/ },
    ) as HTMLButtonElement;
    expect(button.style.backgroundColor).toBe("var(--color-danger)");
    expect(button.style.borderColor).toBe("var(--color-danger)");
    expect(button.style.color).toBe("rgb(255, 255, 255)");
  });

  it("applies an outline variant as transparent background with colored border/text", () => {
    renderWidget(
      buttonWidget({
        style: { variant: "outline", color: "var(--color-danger)" },
      }),
    );

    const button = screen.getByRole(
      "button",
      { name: /Connect/ },
    ) as HTMLButtonElement;
    expect(button.style.backgroundColor).toBe("transparent");
    expect(button.style.borderColor).toBe("var(--color-danger)");
    expect(button.style.color).toBe("var(--color-danger)");
  });
});

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

describe("MiniAppWidget — toggle", () => {
  function toggleWidget(
    overrides: Partial<Extract<WidgetSpec, { kind: "toggle" }>> = {},
  ): WidgetSpec {
    return {
      id: "w-tgl",
      kind: "toggle",
      layout: LAYOUT,
      label: "VPN",
      onAction: { kind: "inline", name: "on", script: "vpn up" },
      offAction: { kind: "inline", name: "off", script: "vpn down" },
      ...overrides,
    };
  }

  const statusConfig = (onValue?: string) => ({
    source: { kind: "inline" as const, script: "vpn status" },
    intervalMs: 5000,
    mapping: {
      mode: "mapped" as const,
      rules: [{ match: "up", label: "Connected" }],
    },
    ...(onValue !== undefined ? { onValue } : {}),
  });

  it("renders the shared ToggleSwitch labelled by the widget label", () => {
    renderWidget(toggleWidget());

    expect(screen.getByRole("switch", { name: "VPN" })).toBeTruthy();
    expect(document.querySelector(".toggle-switch")).not.toBeNull();
  });

  it("switching on runs the ON action", async () => {
    renderWidget(toggleWidget());

    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "VPN" }));
    });

    const [cmd] = vi.mocked(triggerCommandRun).mock.calls[0];
    expect(cmd.script).toBe("vpn up");
  });

  it("switching off runs the OFF action", async () => {
    renderWidget(
      toggleWidget({ status: statusConfig("Connected") }),
      {
        statusResult: {
          state: "ok",
          label: "Connected",
          rawValue: "up",
        },
      },
    );

    expect(
      screen.getByRole("switch", { name: "VPN" }).getAttribute("aria-checked"),
    ).toBe("true");

    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "VPN" }));
    });

    const [cmd] = vi.mocked(triggerCommandRun).mock.calls[0];
    expect(cmd.script).toBe("vpn down");
  });

  it("derives ON from an onValue match on the mapped LABEL", () => {
    renderWidget(toggleWidget({ status: statusConfig("Connected") }), {
      statusResult: { state: "ok", label: "Connected", rawValue: "up" },
    });

    expect(
      screen.getByRole("switch", { name: "VPN" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("derives ON from an onValue match on the RAW probe value", () => {
    renderWidget(toggleWidget({ status: statusConfig("up") }), {
      statusResult: { state: "ok", label: "Connected", rawValue: "up" },
    });

    expect(
      screen.getByRole("switch", { name: "VPN" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("stays OFF for a SUCCESSFUL probe whose value does not match onValue", () => {
    // Bug S3: a status command that reports "disconnected" still exits 0. The
    // switch must follow the VALUE, not the exit code.
    renderWidget(toggleWidget({ status: statusConfig("Connected") }), {
      statusResult: { state: "ok", label: "Disconnected", rawValue: "down" },
    });

    expect(
      screen.getByRole("switch", { name: "VPN" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("does not mark a matched, status-backed position as unverified", () => {
    renderWidget(toggleWidget({ status: statusConfig("Connected") }), {
      statusResult: { state: "ok", label: "Connected", rawValue: "up" },
    });

    expect(screen.queryByText("unverified")).toBeNull();
  });

  it("marks a status source with no onValue as unverified", () => {
    renderWidget(toggleWidget({ status: statusConfig() }), {
      statusResult: { state: "ok", label: "Connected", rawValue: "up" },
    });

    expect(screen.getByText("unverified")).toBeTruthy();
  });

  it("marks a status-less toggle as unverified", () => {
    renderWidget(toggleWidget());

    expect(screen.getByText("unverified")).toBeTruthy();
  });

  it("a status-less toggle tracks its own local position optimistically", async () => {
    renderWidget(toggleWidget());
    const toggle = screen.getByRole("switch", { name: "VPN" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(
      screen.getByRole("switch", { name: "VPN" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("renders the inline status badge alongside the switch", () => {
    renderWidget(toggleWidget({ status: statusConfig("Connected") }), {
      statusResult: { state: "ok", label: "Connected", rawValue: "up" },
    });

    expect(screen.getByText("Connected")).toBeTruthy();
    expect(
      document.querySelector(".miniapp-widget__status-inline"),
    ).not.toBeNull();
  });

  it("is disabled and marked broken when an action references a missing command", () => {
    renderWidget(
      toggleWidget({
        offAction: { kind: "commandRef", commandId: "missing" },
      }),
    );

    const toggle = screen.getByRole("switch", { name: "VPN" });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByRole("img", { name: "Linked command is missing" }),
    ).toBeTruthy();
  });

  it("is disabled when the STATUS SOURCE references a missing command", () => {
    renderWidget(
      toggleWidget({
        status: {
          source: { kind: "commandRef", commandId: "missing" },
          intervalMs: 5000,
          mapping: { mode: "raw" },
        },
      }),
    );

    expect(
      (screen.getByRole("switch", { name: "VPN" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("passes the widget's style color/variant through to ToggleSwitch when ON", async () => {
    renderWidget(
      toggleWidget({ style: { variant: "outline", color: "var(--color-danger)" } }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "VPN" }));
    });

    const track = screen.getByRole("switch", { name: "VPN" }) as HTMLButtonElement;
    expect(track.style.borderColor).toBe("var(--color-danger)");
    expect(track.style.background).toBe("transparent");
  });

  it("does not customize ToggleSwitch appearance when style is unset", async () => {
    renderWidget(toggleWidget());

    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "VPN" }));
    });

    const track = screen.getByRole("switch", { name: "VPN" }) as HTMLButtonElement;
    expect(track.getAttribute("style")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe("MiniAppWidget — status", () => {
  function statusWidget(
    overrides: Partial<Extract<WidgetSpec, { kind: "status" }>> = {},
  ): WidgetSpec {
    return {
      id: "w-status",
      kind: "status",
      layout: LAYOUT,
      label: "Connection",
      source: { kind: "inline", script: "vpn status" },
      intervalMs: 5000,
      mapping: { mode: "raw" },
      ...overrides,
    };
  }

  it("renders the label and an idle placeholder before the first probe", () => {
    renderWidget(statusWidget());

    expect(screen.getByText("Connection")).toBeTruthy();
    expect(
      document.querySelector(".miniapp-widget__badge--idle"),
    ).not.toBeNull();
  });

  it("renders a loading badge while a probe is in flight", () => {
    renderWidget(statusWidget(), { statusResult: { state: "loading" } });

    expect(
      document.querySelector(".miniapp-widget__badge--loading"),
    ).not.toBeNull();
  });

  it("renders the resolved label for an ok probe", () => {
    renderWidget(statusWidget(), {
      statusResult: { state: "ok", label: "Connected", rawValue: "up" },
    });

    expect(screen.getByText("Connected")).toBeTruthy();
    expect(document.querySelector(".miniapp-widget__badge--ok")).not.toBeNull();
  });

  it("applies a mapped rule colour to the ok badge", () => {
    renderWidget(statusWidget(), {
      statusResult: {
        state: "ok",
        label: "Connected",
        color: "var(--color-success)",
        rawValue: "up",
      },
    });

    const badge = document.querySelector(".miniapp-widget__badge--ok");
    expect((badge as HTMLElement).style.color).toBe("var(--color-success)");
  });

  it("renders a TRANSLATED error message, not the raw backend literal", () => {
    // Bug S8: the poller is React-free and returns a translation KEY; only the
    // widget may format it.
    renderWidget(statusWidget(), {
      statusResult: {
        state: "error",
        messageKey: "miniapps.runner.status.probeFailed",
        params: { status: "failed" },
        detail: "ParseError::MissingVariable(configPath)",
      },
    });

    expect(
      screen.getByText("Status check did not succeed (failed)"),
    ).toBeTruthy();
    expect(
      screen.queryByText("miniapps.runner.status.probeFailed"),
    ).toBeNull();
  });

  it("keeps the raw backend detail available as a title tooltip", () => {
    renderWidget(statusWidget(), {
      statusResult: {
        state: "error",
        messageKey: "miniapps.runner.status.probeError",
        detail: "ParseError::MissingVariable(configPath)",
      },
    });

    const badge = document.querySelector(".miniapp-widget__badge--error");
    expect(badge?.getAttribute("title")).toBe(
      "ParseError::MissingVariable(configPath)",
    );
    expect(screen.getByText("Status check could not run")).toBeTruthy();
  });

  it("renders a short unmatched raw value as-is, distinct from a real ok match", () => {
    renderWidget(statusWidget(), {
      statusResult: {
        state: "unmatched",
        label: "connecting",
        rawValue: "connecting",
        rawString: "connecting",
      },
    });

    expect(screen.getByText("connecting")).toBeTruthy();
    expect(
      document.querySelector(".miniapp-widget__badge--unmatched"),
    ).not.toBeNull();
    expect(document.querySelector(".miniapp-widget__badge--ok")).toBeNull();
  });

  it("does not dump a multi-line unmatched raw value into the badge label", () => {
    const rawDump = [
      "1: /net/openvpn/v3/sessions/abc123",
      "    Status: Connection, Client connected",
    ].join("\n");
    renderWidget(statusWidget(), {
      statusResult: {
        state: "unmatched",
        label: "",
        messageKey: "miniapps.runner.status.unmatched",
        rawValue: rawDump,
        rawString: rawDump,
      },
    });

    expect(screen.getByText("Unmatched")).toBeTruthy();
    expect(screen.queryByText(rawDump)).toBeNull();
    const badge = document.querySelector(".miniapp-widget__badge--unmatched");
    expect(badge?.getAttribute("title")).toBe(rawDump);
  });

  it("names the missing command rather than showing a generic probe error", () => {
    renderWidget(
      statusWidget({ source: { kind: "commandRef", commandId: "missing" } }),
    );

    expect(screen.getByText("Linked command is missing")).toBeTruthy();
    expect(
      document.querySelector(".miniapp-widget__status.is-broken"),
    ).not.toBeNull();
  });

  it("resolves ${artifact} references in the status label", () => {
    renderWidget(statusWidget({ label: "Status of ${host}" }), {
      artifactValues: { host: "prod-1" },
    });

    expect(screen.getByText("Status of prod-1")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

describe("MiniAppWidget — artifact", () => {
  function artifactWidget(
    overrides: Partial<Extract<WidgetSpec, { kind: "artifact" }>> = {},
  ): WidgetSpec {
    return {
      id: "w-art",
      kind: "artifact",
      layout: LAYOUT,
      name: "configPath",
      label: "Config File",
      value: "",
      variant: "path",
      ...overrides,
    };
  }

  it("path renders an editable input plus DISTINCT Browse and Open actions", () => {
    renderWidget(artifactWidget());

    expect(screen.getByLabelText("Config File")).toBeTruthy();
    const browse = screen.getByRole("button", { name: "Browse…" });
    const open = screen.getByRole("button", { name: "Open" });
    // Distinct glyphs — the two actions must not share an icon.
    expect(browse.innerHTML).not.toBe(open.innerHTML);
  });

  it("path shows the current value and reports edits via onArtifactChange", () => {
    const onArtifactChange = vi.fn();
    renderWidget(artifactWidget(), {
      artifactValues: { configPath: "/etc/a.ovpn" },
      onArtifactChange,
    });

    const input = screen.getByLabelText("Config File") as HTMLInputElement;
    expect(input.value).toBe("/etc/a.ovpn");

    act(() => {
      fireEvent.change(input, { target: { value: "/etc/b.ovpn" } });
    });

    expect(onArtifactChange).toHaveBeenCalledWith("configPath", "/etc/b.ovpn");
  });

  it("path falls back to the editor default before the runner hydrates", () => {
    renderWidget(artifactWidget({ value: "/default.ovpn" }));

    expect(
      (screen.getByLabelText("Config File") as HTMLInputElement).value,
    ).toBe("/default.ovpn");
  });

  it("Open is disabled while the path is empty", () => {
    renderWidget(artifactWidget());

    expect(
      (screen.getByRole("button", { name: "Open" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("Open launches the current path through the OS opener", async () => {
    renderWidget(artifactWidget(), {
      artifactValues: { configPath: "/etc/a.ovpn" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open" }));
    });

    expect(openPath).toHaveBeenCalledWith("/etc/a.ovpn");
  });

  it("Open surfaces a toast when the OS cannot open the path", async () => {
    vi.mocked(openPath).mockRejectedValueOnce(new Error("no such file"));
    renderWidget(artifactWidget(), {
      artifactValues: { configPath: "/etc/missing.ovpn" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open" }));
    });

    expect(Message.error).toHaveBeenCalledWith("Failed to open: no such file");
  });

  it("Browse stores the ABSOLUTE path returned by the native dialog", async () => {
    vi.mocked(pickArtifactPath).mockResolvedValueOnce(
      "/home/user/vpn/config.ovpn",
    );
    const onArtifactChange = vi.fn();
    renderWidget(artifactWidget(), { onArtifactChange });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    });

    expect(pickArtifactPath).toHaveBeenCalledTimes(1);
    expect(onArtifactChange).toHaveBeenCalledWith(
      "configPath",
      "/home/user/vpn/config.ovpn",
    );
  });

  it("Browse is a no-op when the dialog is cancelled", async () => {
    vi.mocked(pickArtifactPath).mockResolvedValueOnce(null);
    const onArtifactChange = vi.fn();
    renderWidget(artifactWidget(), { onArtifactChange });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    });

    expect(pickArtifactPath).toHaveBeenCalledTimes(1);
    expect(onArtifactChange).not.toHaveBeenCalled();
  });

  it("text renders a plain editable input with no Browse / Open", () => {
    const onArtifactChange = vi.fn();
    renderWidget(
      artifactWidget({ variant: "text", name: "region", label: "Region" }),
      { onArtifactChange },
    );

    expect(screen.queryByRole("button", { name: "Browse…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();

    act(() => {
      fireEvent.change(screen.getByLabelText("Region"), {
        target: { value: "eu-west" },
      });
    });
    expect(onArtifactChange).toHaveBeenCalledWith("region", "eu-west");
  });

  it("secret renders a password input hidden by default", () => {
    renderWidget(
      artifactWidget({ variant: "secret", name: "token", label: "API Token" }),
      { artifactValues: { token: "s3cret" } },
    );

    const input = screen.getByLabelText("API Token") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("s3cret");
  });

  it("secret's reveal toggle flips the input between password and text", () => {
    renderWidget(
      artifactWidget({ variant: "secret", name: "token", label: "API Token" }),
      { artifactValues: { token: "s3cret" } },
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Show" }));
    });
    expect(
      (screen.getByLabelText("API Token") as HTMLInputElement).type,
    ).toBe("text");

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    });
    expect(
      (screen.getByLabelText("API Token") as HTMLInputElement).type,
    ).toBe("password");
  });

  it("secret stays editable while masked", () => {
    const onArtifactChange = vi.fn();
    renderWidget(
      artifactWidget({ variant: "secret", name: "token", label: "API Token" }),
      { onArtifactChange },
    );

    act(() => {
      fireEvent.change(screen.getByLabelText("API Token"), {
        target: { value: "new-token" },
      });
    });

    expect(onArtifactChange).toHaveBeenCalledWith("token", "new-token");
  });

  it("resolves ${artifact} references in the artifact's own LABEL", () => {
    renderWidget(
      artifactWidget({ variant: "text", name: "path", label: "Path in ${env}" }),
      { artifactValues: { env: "prod" } },
    );

    expect(screen.getByLabelText("Path in prod")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

describe("MiniAppWidget — text", () => {
  function textWidget(
    overrides: Partial<Extract<WidgetSpec, { kind: "text" }>> = {},
  ): WidgetSpec {
    return {
      id: "w-text",
      kind: "text",
      layout: LAYOUT,
      label: "Heading",
      content: "Hello world",
      style: { fontSize: 14, bold: false, italic: false, align: "left" },
      ...overrides,
    };
  }

  it("renders its content", () => {
    renderWidget(textWidget());

    expect(screen.getByText("Hello world")).toBeTruthy();
    expect(document.querySelector(".miniapp-widget__text")).not.toBeNull();
  });

  it("resolves ${artifact} references in the content", () => {
    renderWidget(textWidget({ content: "Connected to ${host}" }), {
      artifactValues: { host: "prod-1" },
    });

    expect(screen.getByText("Connected to prod-1")).toBeTruthy();
  });

  it("applies fontSize and textAlign from the style", () => {
    renderWidget(
      textWidget({
        style: { fontSize: 22, bold: false, italic: false, align: "center" },
      }),
    );

    const el = document.querySelector(".miniapp-widget__text") as HTMLElement;
    expect(el.style.fontSize).toBe("22px");
    expect(el.style.textAlign).toBe("center");
  });

  it("applies fontWeight bold and fontStyle italic when set", () => {
    renderWidget(
      textWidget({
        style: { fontSize: 14, bold: true, italic: true, align: "left" },
      }),
    );

    const el = document.querySelector(".miniapp-widget__text") as HTMLElement;
    expect(el.style.fontWeight).toBe("bold");
    expect(el.style.fontStyle).toBe("italic");
  });

  it("does not force fontWeight / fontStyle when bold / italic are false", () => {
    renderWidget(textWidget());

    const el = document.querySelector(".miniapp-widget__text") as HTMLElement;
    expect(el.style.fontWeight).toBe("");
    expect(el.style.fontStyle).toBe("");
  });

  it("applies an explicit color when set", () => {
    renderWidget(
      textWidget({
        style: {
          fontSize: 14,
          color: "var(--color-danger)",
          bold: false,
          italic: false,
          align: "left",
        },
      }),
    );

    const el = document.querySelector(".miniapp-widget__text") as HTMLElement;
    expect(el.style.color).toBe("var(--color-danger)");
  });

  it("does not force a color when color is unset (inherits)", () => {
    renderWidget(textWidget());

    const el = document.querySelector(".miniapp-widget__text") as HTMLElement;
    expect(el.style.color).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Card chrome (`bordered` prop) — Runner vs Editor preview
// ---------------------------------------------------------------------------

describe("MiniAppWidget — card chrome", () => {
  function buttonWidget(
    overrides: Partial<Extract<WidgetSpec, { kind: "button" }>> = {},
  ): WidgetSpec {
    return {
      id: "w-btn",
      kind: "button",
      layout: LAYOUT,
      label: "Connect",
      action: { kind: "inline", name: "Connect", script: "vpn up" },
      ...overrides,
    };
  }

  it("renders the bordered card by default (editor preview usage)", () => {
    renderWidget(buttonWidget());

    const el = document.querySelector(".miniapp-widget");
    expect(el).not.toBeNull();
    expect(el?.className).not.toContain("miniapp-widget--chromeless");
  });

  it("renders chromeless when bordered=false (Runner usage)", () => {
    renderWidget(buttonWidget(), { bordered: false });

    const el = document.querySelector(".miniapp-widget");
    expect(el).not.toBeNull();
    expect(el?.className).toContain("miniapp-widget--chromeless");
  });
});
