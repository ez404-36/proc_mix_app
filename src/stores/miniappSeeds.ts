import type { MiniAppWidget } from "../types";
import type { Platform } from "../types/platform";
import type { NewMiniAppInput } from "./miniappStore";

function makeWidgetId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `w-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Per-platform script pair for a seed widget. Mirrors the `SeedScript` shape
 * used by the command seeds (`stores/seeds.ts`) so both seed builders express
 * "the correct script for this host OS" the same way.
 */
interface SeedScript {
  script: string;
  shell: "bash" | "zsh" | "powershell";
}

/**
 * Linux-only demo mini-app modelled on the `openvpn3` CLI. It exercises every
 * widget kind — a polled status indicator, two action buttons, and a path
 * artifact — so it doubles as a reference panel for the widget system.
 *
 * CLI syntax (verified against upstream openvpn3-linux):
 *   - list sessions:  `openvpn3 sessions-list`
 *   - connect:        `openvpn3 session-start --config <path>`
 *   - disconnect:     `openvpn3 session-manage --config <name> --disconnect`
 *
 * `session-manage --disconnect` identifies the session by CONFIG NAME, not by
 * file path, and the config name defaults to the `.ovpn` file's basename
 * (without extension) at `session-start` time. Rather than asking the user to
 * type/remember a second value that must stay in sync with the file they
 * picked, the Disconnect script derives it from the same `configPath`
 * artifact via `basename`. This assumes the common case of a single active
 * session per profile name — `session-manage` itself errors with "More than
 * one session..." if that's ambiguous, or "No sessions..." if none match,
 * which is expected CLI behaviour, not a bug in this seed.
 *
 * The Connect button's script references `${configPath}`, the NAME of the
 * artifact widget below it. At run time the runner routes the artifact's
 * current value through `RunOptions.variableValues`, and the widget layer
 * synthesizes a `VariableSpec` from the artifact so an empty/dropped value
 * degrades to the artifact's default instead of failing.
 *
 * The artifact's own `value` is therefore an EMPTY DEFAULT — never
 * `"${configPath}"`, which would be a self-reference that renders the literal
 * template into the script.
 *
 * The status widget uses `matchMode: "contains"` against the raw, multi-line
 * `sessions-list` output — no script-side grep/cleanup needed. Real output is
 * a block like:
 *   ...
 *         Status: Connection, Client connected
 *   ...
 * so a `contains` rule for the literal string "Client connected" matches
 * regardless of what surrounds it on that line. `sessions-list` itself exits
 * 0 and prints "No sessions available" on an empty session list, so no
 * `|| echo ...` fallback is needed (the old fallback was papering over the
 * wrong subcommand name, not a real gap); `2>&1` folds stderr into the probed
 * text so error output (e.g. `openvpn3` missing) is visible/matchable too.
 */
function buildOpenvpn3Seed(): NewMiniAppInput {
  const widgets: MiniAppWidget[] = [
    {
      id: makeWidgetId(),
      kind: "status",
      layout: { x: 16, y: 16, w: 268, h: 72 },
      label: "Connection Status",
      source: {
        kind: "inline",
        script: "openvpn3 sessions-list 2>&1",
      },
      intervalMs: 10000,
      mapping: {
        mode: "mapped",
        rules: [
          {
            match: "Client connected",
            matchMode: "contains",
            label: "Connected",
            color: "var(--color-success)",
          },
          {
            match: "Client connecting",
            matchMode: "contains",
            label: "Connecting",
            color: "var(--app-color-edit)",
          },
          {
            match: "Client reconnect",
            matchMode: "contains",
            label: "Reconnecting",
            color: "var(--app-color-edit)",
          },
          {
            match: "Client authentication failed",
            matchMode: "contains",
            label: "Auth failed",
            color: "var(--color-danger)",
          },
          {
            match: "No sessions available",
            matchMode: "contains",
            label: "Disconnected",
            color: "var(--color-danger)",
          },
        ],
      },
    },
    {
      id: makeWidgetId(),
      kind: "button",
      // h:56 (not the old 44) — the editor's per-kind minimum for button/
      // toggle widgets; a `.btn` inside the card's `.miniapp-widget--button`
      // padding needs at least ~48-56px to avoid visually clipping against
      // the card's rounded corners (see `MIN_WIDGET_H_BY_KIND` in
      // `MiniAppEditor.tsx`).
      layout: { x: 16, y: 100, w: 124, h: 56 },
      label: "Connect",
      action: {
        kind: "inline",
        name: "Connect",
        script: 'openvpn3 session-start --config "${configPath}"',
      },
    },
    {
      id: makeWidgetId(),
      kind: "button",
      layout: { x: 152, y: 100, w: 132, h: 56 },
      label: "Disconnect",
      action: {
        kind: "inline",
        name: "Disconnect",
        // Derives the session's config NAME from the config PATH artifact
        // (basename without the `.ovpn` extension) — see the seed doc comment
        // above for why this is preferred over a second, hand-typed artifact.
        script:
          'openvpn3 session-manage --config "$(basename "${configPath}" .ovpn)" --disconnect',
      },
    },
    {
      id: makeWidgetId(),
      kind: "artifact",
      // y shifted from 156 to 168 (+12, matching the buttons' +12 height
      // bump) to keep the same 12px gap below the now-taller button row.
      layout: { x: 16, y: 168, w: 268, h: 56 },
      name: "configPath",
      label: "Config File (.ovpn)",
      // Empty default: the user picks a real `.ovpn` file with Browse. An
      // empty value substitutes as an empty string rather than erroring.
      value: "",
      variant: "path",
    },
  ];

  return {
    name: "OpenVPN3 Control Panel",
    nameKey: "miniapps.seeds.openvpn3.name",
    description:
      "Manage OpenVPN3 connections with status, connect, and disconnect",
    descriptionKey: "miniapps.seeds.openvpn3.description",
    widgets,
    tags: ["network", "vpn", "seed"],
    favorite: false,
    os: ["linux"],
    // Compact panel sized to fit the 4 widgets (status 268×72 at 16,16; two
    // 56px-tall buttons on a row ending at x≈284,y≈156; artifact 268×56 at
    // y=168 → bottom 224) with the same ~28px margin the panel always had.
    panelSize: { w: 320, h: 252 },
  };
}

/** Uptime probe per platform for the cross-platform System Info seed. */
const UPTIME_SCRIPTS: Record<Platform, SeedScript> = {
  linux: { script: "uptime -p", shell: "bash" },
  macos: { script: "uptime", shell: "zsh" },
  windows: {
    script:
      "(Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime | " +
      "ForEach-Object { \"up {0} days {1} hours\" -f $_.Days, $_.Hours }",
    shell: "powershell",
  },
};

/** Disk-usage listing per platform. */
const DISK_SCRIPTS: Record<Platform, SeedScript> = {
  linux: { script: "df -h", shell: "bash" },
  macos: { script: "df -h", shell: "zsh" },
  windows: {
    script: "Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize",
    shell: "powershell",
  },
};

/** Memory usage per platform. */
const MEMORY_SCRIPTS: Record<Platform, SeedScript> = {
  linux: { script: "free -h", shell: "bash" },
  macos: { script: "vm_stat", shell: "zsh" },
  windows: {
    script:
      "Get-CimInstance Win32_OperatingSystem | " +
      "Select-Object FreePhysicalMemory, TotalVisibleMemorySize | Format-List",
    shell: "powershell",
  },
};

/**
 * Cross-platform demo mini-app: a polled uptime indicator plus two read-only
 * inspection buttons. It exists so macOS and Windows users are not left with
 * an empty Mini-Apps list (the `openvpn3` seed is Linux-only), and it doubles
 * as a minimal, safe reference panel — every script is read-only and needs no
 * elevation.
 */
function buildSystemInfoSeed(platform: Platform): NewMiniAppInput {
  const uptime = UPTIME_SCRIPTS[platform];
  const disk = DISK_SCRIPTS[platform];
  const memory = MEMORY_SCRIPTS[platform];
  const widgets: MiniAppWidget[] = [
    {
      id: makeWidgetId(),
      kind: "status",
      layout: { x: 16, y: 16, w: 268, h: 72 },
      label: "Uptime",
      source: { kind: "inline", script: uptime.script, shell: uptime.shell },
      intervalMs: 60000,
      mapping: { mode: "raw" },
    },
    {
      id: makeWidgetId(),
      kind: "button",
      // h:56 — the editor's per-kind minimum for button widgets (see the
      // matching comment on the openvpn3 seed above).
      layout: { x: 16, y: 100, w: 124, h: 56 },
      label: "Disk usage",
      action: {
        kind: "inline",
        name: "Disk usage",
        script: disk.script,
        shell: disk.shell,
      },
    },
    {
      id: makeWidgetId(),
      kind: "button",
      layout: { x: 152, y: 100, w: 132, h: 56 },
      label: "Memory",
      action: {
        kind: "inline",
        name: "Memory",
        script: memory.script,
        shell: memory.shell,
      },
    },
  ];

  return {
    name: "System Info",
    nameKey: "miniapps.seeds.systemInfo.name",
    description: "Live uptime with disk and memory inspection buttons",
    descriptionKey: "miniapps.seeds.systemInfo.description",
    widgets,
    tags: ["system", "seed"],
    favorite: false,
    // No `os` restriction — every platform gets a working variant.
    // Buttons now end at y=100+56=156; panel bumped from 180 to 192 to keep
    // the same ~36px bottom margin the panel always had.
    panelSize: { w: 320, h: 192 },
  };
}

/**
 * Materialize the built-in mini-app seeds for the given host platform. Each
 * call produces fresh widget ids; the mini-app id and timestamps are added by
 * the store's `addMiniApp` when the seed is persisted.
 *
 * Every platform receives the cross-platform "System Info" panel; Linux also
 * receives the `openvpn3` reference panel (`openvpn3` is a Linux utility).
 */
export function buildMiniAppSeedsForPlatform(
  platform: Platform,
): NewMiniAppInput[] {
  const seeds: NewMiniAppInput[] = [buildSystemInfoSeed(platform)];
  if (platform === "linux") seeds.push(buildOpenvpn3Seed());
  return seeds;
}
