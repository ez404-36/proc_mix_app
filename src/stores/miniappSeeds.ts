import type { MiniAppWidget, StatusMapping } from "../types";
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
 * widget kind — a polled status indicator, a status-backed toggle, and a path
 * artifact — so it doubles as a reference panel for the widget system.
 *
 * CLI syntax (verified against upstream openvpn3-linux, including LIVE
 * end-to-end testing of every command below against a real openvpn3 daemon —
 * not just documentation):
 *   - list sessions:  `openvpn3 sessions-list`
 *   - connect:        `openvpn3 session-start --config <path>`
 *   - disconnect:     `openvpn3 session-manage --config <path> --disconnect`
 *
 * CRITICAL, VERIFIED LIVE (this invalidated an earlier version of this
 * seed): `session-manage --config` matches the EXACT STRING passed to
 * `session-start --config`, byte for byte — it is NOT a "profile name"
 * derived from the file's basename, and it does NOT accept a basename-only
 * or extension-stripped form even when that happens to be a session's only
 * distinguishing token. `session-start --config "/etc/openvpn/bundled.ovpn"`
 * followed by `session-manage --config "bundled" --disconnect` FAILS with
 * "No sessions started with the configuration profile name was found" —
 * only `session-manage --config "/etc/openvpn/bundled.ovpn" --disconnect`
 * (the identical string) succeeds. So BOTH the Disconnect action and the
 * status probe below use `${configPath}` VERBATIM, never `basename`'d.
 *
 * Connect/Disconnect are a SINGLE status-backed `toggle` widget, not two
 * independent buttons. Two independent buttons let a user click Connect
 * again while already connected — ProcMix has no session dedup of its own
 * (see `docs/plans/plan-mini-prilozhenia-mini-apps-v-procmix.md`), so a
 * second click just fires a second, redundant `session-start`. A toggle
 * whose position is DERIVED from the real probed state cannot be clicked
 * "the wrong way": once connected it renders ON, and a click on an ON
 * switch always runs `offAction` (Disconnect), never `onAction` (Connect)
 * again — see `resolveToggleOnState` / `ToggleWidget.runToggle`.
 *
 * The status probe extracts each session's `Config name:` value from
 * `sessions-list` and compares it for EXACT EQUALITY against `${configPath}`
 * — never a substring/`grep` match — before that session's `Status:` line is
 * ever considered a candidate. This is the second, independent reason
 * `basename`-derived matching was wrong (the first being Disconnect above):
 * an EARLIER version of this probe used `grep "Config name:.*<fragment>"`,
 * where the trailing `.*` after ANY fragment — even the single character the
 * user is mid-typing, e.g. "b" — matches as a SUBSTRING of an unrelated
 * session's full config path (`/etc/openvpn/bundled.ovpn` contains "b"),
 * showing "Connected" for a config the user never even finished typing.
 * Exact-equality comparison (implemented in `awk`, matching the WHOLE
 * `Config name:` value after stripping the leading label and the
 * "(Config not available)" suffix openvpn3 appends when a profile was later
 * removed) closes that gap entirely: no possible `configPath` value can ever
 * partially match a DIFFERENT session's config path. This also matters when
 * the user has multiple mini-app panels open for different `.ovpn` files —
 * each panel's own exact-equality probe can only ever report on ITS OWN
 * session, never bleed into a different panel's.
 *
 * The probe must always `echo` SOMETHING and exit 0, never a bare non-zero
 * exit — a non-`"succeeded"` probe result is ALWAYS rendered as
 * `state: "error"` by `applyStatusMapping` regardless of the `StatusMapping`
 * rules (mapping rules only ever classify a SUCCESSFUL probe's output
 * string). So "no config selected" and "config selected but no matching
 * session" both `echo "Disconnected"` and exit 0 — mapped by a normal rule
 * to a neutral "Disconnected" label — rather than ever surfacing as the
 * generic, scary "Проверка статуса не удалась (failed)" error badge.
 *
 * The Connect/Disconnect actions and the status probe all reference
 * `${configPath}`, the NAME of the artifact widget below them. At run time
 * the runner routes the artifact's current value through
 * `RunOptions.variableValues`, and the widget layer synthesizes a
 * `VariableSpec` from the artifact so an empty/dropped value degrades to the
 * artifact's default instead of failing.
 *
 * The artifact's own `value` is therefore an EMPTY DEFAULT — never
 * `"${configPath}"`, which would be a self-reference that renders the literal
 * template into the script.
 *
 * The status mapping uses `matchMode: "contains"` against the script's own
 * emitted lines — no further script-side cleanup needed (the exact-equality
 * work happens inside the probe script itself, described above; the mapping
 * rules only ever see the WINNING line, never raw `sessions-list` text).
 */
function buildOpenvpn3Seed(): NewMiniAppInput {
  const statusMapping: StatusMapping = {
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
        // Emitted by the status script itself (see below) whenever no
        // config is selected yet, or the selected config has no matching
        // session in `sessions-list` — the ordinary "not connected" state,
        // not a probe failure. Matched LAST so a real openvpn3 status line
        // that happens to also contain this word (unlikely, but the rule
        // order is the tie-breaker) never shadows it.
        match: "Disconnected",
        matchMode: "contains",
        label: "Disconnected",
        color: "var(--color-text-muted)",
      },
    ],
  };
  // The status probe openvpn3 CLI invocation shared by the status widget and
  // the toggle's own status source (see the seed doc comment above for the
  // full rationale). Exits early with "Disconnected" when no config is
  // selected; otherwise scans `sessions-list` for a session whose
  // `Config name:` value is EXACTLY `${configPath}` (never a substring
  // match) and prints that session's `Status:` line, falling back to
  // "Disconnected" when none matches. Always echoes something and exits 0.
  const statusScript =
    'cfg="${configPath}"; [ -z "$cfg" ] && { echo "Disconnected"; exit 0; }; ' +
    'result="$(openvpn3 sessions-list 2>&1 | awk -v want="$cfg" \'' +
    '/Config name:/{line=$0; sub(/^[^:]*:[ \\t]*/,"",line); ' +
    'sub(/[ \\t]*\\(Config not available\\)[ \\t]*$/,"",line); ' +
    'sub(/[ \\t]+$/,"",line); matched=(line==want)?1:0; next} ' +
    'matched && /Status:/{print; matched=0}\')"; ' +
    '[ -z "$result" ] && echo "Disconnected" || echo "$result"';
  const widgets: MiniAppWidget[] = [
    {
      id: makeWidgetId(),
      kind: "status",
      layout: { x: 16, y: 16, w: 268, h: 72 },
      label: "Connection Status",
      source: { kind: "inline", script: statusScript },
      intervalMs: 10000,
      mapping: statusMapping,
    },
    {
      id: makeWidgetId(),
      kind: "toggle",
      // h:56 — the editor's per-kind minimum for button/toggle widgets; a
      // `.toggle-switch` inside the card's `.miniapp-widget--button` padding
      // needs at least ~48-56px to avoid visually clipping against the
      // card's rounded corners (see `MIN_WIDGET_H_BY_KIND` in
      // `MiniAppEditor.tsx`).
      layout: { x: 16, y: 100, w: 268, h: 56 },
      label: "VPN Connection",
      onAction: {
        kind: "inline",
        name: "Connect",
        script: 'openvpn3 session-start --config "${configPath}"',
      },
      offAction: {
        kind: "inline",
        name: "Disconnect",
        // Passes `${configPath}` VERBATIM — `session-manage --config`
        // requires the EXACT string given to `session-start --config`, not
        // a basename/profile-name derivation. See the seed doc comment above
        // (verified live against a real openvpn3 daemon).
        script: 'openvpn3 session-manage --config "${configPath}" --disconnect',
      },
      status: {
        source: { kind: "inline", script: statusScript },
        intervalMs: 10000,
        mapping: statusMapping,
        onValue: "Connected",
      },
    },
    {
      id: makeWidgetId(),
      kind: "artifact",
      layout: { x: 16, y: 168, w: 268, h: 56 },
      name: "configPath",
      label: "Config File (.ovpn)",
      // Empty default: the user picks a real `.ovpn` file with Browse. An
      // empty value substitutes as an empty string rather than erroring.
      value: "",
      variant: "path",
      persist: true,
    },
  ];

  return {
    name: "OpenVPN3 Control Panel",
    nameKey: "miniapps.seeds.openvpn3.name",
    description:
      "Manage OpenVPN3 connections with status, connect, and disconnect",
    descriptionKey: "miniapps.seeds.openvpn3.description",
    icon: "🌐",
    widgets,
    tags: ["network", "vpn", "seed"],
    favorite: false,
    os: ["linux"],
    // Compact panel sized to fit the 3 widgets (status 268×72 at 16,16;
    // toggle 268×56 at y=100; artifact 268×56 at y=168 → bottom 224) with the
    // same ~16px margin the panel always had.
    panelSize: { w: 320, h: 240 },
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
 * Instantaneous CPU load probe per platform, normalized to a single "NN%
 * busy" line so the status widget's `raw` mapping shows a compact, consistent
 * badge regardless of host OS. Polled every 5s (much shorter than the other
 * two probes) since load is only useful as a near-real-time reading.
 *
 *   - linux:   `top -bn1` prints one `%Cpu(s):` summary line with user (2nd
 *              field) and system (4th field) percentages; busy = their sum.
 *   - macos:   `top -l 1 -n 0` prints a `CPU usage: NN% user, NN% sys, NN%
 *              idle` line with no process rows (`-n 0`); busy = 100 - idle
 *              (field 7, trailing `%` stripped).
 *   - windows: `Win32_Processor.LoadPercentage` is already the OS's own
 *              busy-percent per logical processor; averaged across all of
 *              them for one whole-machine figure.
 */
const CPU_LOAD_SCRIPTS: Record<Platform, SeedScript> = {
  linux: {
    script: "top -bn1 | awk '/^%Cpu/ {printf \"%.0f%% busy\\n\", $2+$4}'",
    shell: "bash",
  },
  macos: {
    script:
      "top -l 1 -n 0 | awk '/CPU usage/ {gsub(\"%\", \"\", $7); " +
      'printf "%.0f%% busy\\n", 100-$7}\'',
    shell: "zsh",
  },
  windows: {
    script:
      "Get-CimInstance Win32_Processor | " +
      "Measure-Object -Property LoadPercentage -Average | " +
      'ForEach-Object { "{0:N0}% busy" -f $_.Average }',
    shell: "powershell",
  },
};

/**
 * Static system summary (host, OS, CPU model + core count) per platform —
 * one read-only button so users can quickly check what machine they're on
 * without leaving the panel.
 */
const SYSTEM_DETAILS_SCRIPTS: Record<Platform, SeedScript> = {
  linux: {
    script:
      'echo "Host: $(hostname)"; echo "OS: $(uname -srm)"; ' +
      'echo "CPU: $(grep -m1 "model name" /proc/cpuinfo | cut -d: -f2 | ' +
      'xargs) ($(nproc) cores)"',
    shell: "bash",
  },
  macos: {
    script:
      'echo "Host: $(hostname)"; ' +
      'echo "OS: $(sw_vers -productName) $(sw_vers -productVersion) ' +
      '($(uname -m))"; ' +
      'echo "CPU: $(sysctl -n machdep.cpu.brand_string) ' +
      '($(sysctl -n hw.ncpu) cores)"',
    shell: "zsh",
  },
  windows: {
    script:
      "Get-CimInstance Win32_OperatingSystem | " +
      "Select-Object Caption, Version, CSName | Format-List; " +
      "Get-CimInstance Win32_Processor | " +
      "Select-Object Name, NumberOfCores | Format-List",
    shell: "powershell",
  },
};

/**
 * Cross-platform demo mini-app: polled uptime + CPU load indicators plus
 * read-only disk, memory, and system-details inspection buttons. It exists
 * so macOS and Windows users are not left with an empty Mini-Apps list (the
 * `openvpn3` seed is Linux-only), and it doubles as a minimal, safe reference
 * panel — every script is read-only and needs no elevation.
 */
function buildSystemInfoSeed(platform: Platform): NewMiniAppInput {
  const uptime = UPTIME_SCRIPTS[platform];
  const disk = DISK_SCRIPTS[platform];
  const memory = MEMORY_SCRIPTS[platform];
  const cpuLoad = CPU_LOAD_SCRIPTS[platform];
  const systemDetails = SYSTEM_DETAILS_SCRIPTS[platform];
  const widgets: MiniAppWidget[] = [
    {
      id: makeWidgetId(),
      kind: "status",
      layout: { x: 16, y: 16, w: 130, h: 72 },
      label: "Uptime",
      source: { kind: "inline", script: uptime.script, shell: uptime.shell },
      intervalMs: 60000,
      mapping: { mode: "raw" },
    },
    {
      id: makeWidgetId(),
      kind: "status",
      layout: { x: 154, y: 16, w: 130, h: 72 },
      label: "CPU load",
      source: {
        kind: "inline",
        script: cpuLoad.script,
        shell: cpuLoad.shell,
      },
      intervalMs: 5000,
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
    {
      id: makeWidgetId(),
      kind: "button",
      layout: { x: 16, y: 168, w: 268, h: 56 },
      label: "System details",
      action: {
        kind: "inline",
        name: "System details",
        script: systemDetails.script,
        shell: systemDetails.shell,
      },
    },
  ];

  return {
    name: "System Info",
    nameKey: "miniapps.seeds.systemInfo.name",
    description:
      "Live uptime and CPU load with disk, memory, and system-details buttons",
    descriptionKey: "miniapps.seeds.systemInfo.description",
    icon: "🖥️",
    widgets,
    tags: ["system", "seed"],
    favorite: false,
    // No `os` restriction — every platform gets a working variant.
    // Buttons now end at y=168+56=224; panel bumped from 192 to 256 to keep
    // the same ~32px bottom margin the panel always had.
    panelSize: { w: 320, h: 256 },
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
