// IPC wrapper around the Rust-side `miniapps` table.
//
// The Rust handlers (`list_miniapps`, `get_miniapp`, `save_miniapp`,
// `delete_miniapp`, registered in lib.rs) speak `MiniAppRecord`, a
// wire-format struct that uses `null` for absent optional fields (serde
// serialises `Option::None` as JSON `null` / omits it). The TS `MiniApp`
// type uses `undefined` for the same fields, so this module owns the
// `null <-> undefined` translation as a single boundary — exactly like
// `commandRepository` does for `Command` and `workflowRepository` for
// `Workflow`. UI code only ever sees `MiniApp` values.

import { invoke } from "@tauri-apps/api/core";
import type {
  MiniApp,
  MiniAppAction,
  MiniAppWidget,
  PanelSize,
  Shell,
  StatusMapping,
  StatusSource,
  TextStyle,
  VariableSpec,
  WidgetLayout,
  WidgetStyle,
} from "../types";
import { isPlatform } from "../types";
import {
  makeEnumGuard,
  nullToUndef,
  omitWhenUndefined,
  undefToNull,
} from "./repositoryHelpers";

/** Shell identifiers the Rust executor understands; narrows the wire string
 * so an unknown value decodes to `undefined` (executor falls back to its
 * per-platform default). Mirrors the guard in `commandRepository`. */
const isShell = makeEnumGuard<Shell>([
  "bash",
  "zsh",
  "fish",
  "sh",
  "pwsh",
  "powershell",
  "cmd",
]);

/** Status-mapping modes the runner understands; an unknown value falls back
 * to `"raw"` so a malformed mapping never crashes the decoder. */
const isStatusMode = makeEnumGuard<"raw" | "mapped">(["raw", "mapped"]);

/** Per-rule match strategies the poller understands; an unknown/absent value
 * falls back to `undefined` here (`applyStatusMapping` treats that as
 * `"exact"`), so a malformed record never crashes the decoder. */
const isMatchMode = makeEnumGuard<"exact" | "contains" | "regex">([
  "exact",
  "contains",
  "regex",
]);

/** Artifact variants the UI renders; an unknown value falls back to `"text"`. */
const isArtifactVariant = makeEnumGuard<"path" | "text" | "secret">([
  "path",
  "text",
  "secret",
]);

/** Text-alignment values the text widget renders; an unknown value falls back
 * to `"left"`. */
const isTextAlign = makeEnumGuard<"left" | "center" | "right">([
  "left",
  "center",
  "right",
]);

/** Fill/outline variants a button or toggle widget's `style` renders; an
 * unknown value falls back to `"fill"`. */
const isWidgetVariant = makeEnumGuard<"fill" | "outline">([
  "fill",
  "outline",
]);

/** Default panel size for a mini-app that carries no `panelSize` on the wire
 *  (legacy rows, or a payload built before the column existed). Mirrors the
 *  Rust `default_panel_size` so both sides agree on the compact-control-panel
 *  fallback without an extra round-trip. */
const DEFAULT_PANEL_SIZE: PanelSize = { w: 400, h: 320 };

/** Wire format matching the Rust `PanelSizeRecord` struct. */
export interface PanelSizeRecord {
  w: number;
  h: number;
}

/** Domain shape of a single `mapped`-rule entry (the element type of
 * `StatusMapping["rules"]`). */
type StatusRule = NonNullable<StatusMapping["rules"]>[number];

/** Domain shape of a toggle widget's optional poll config (the element type
 * of the `toggle` variant's `status` field). */
type ToggleStatus = NonNullable<
  Extract<MiniAppWidget, { kind: "toggle" }>["status"]
>;

/**
 * Wire format that matches the Rust `MiniAppActionRecord` enum. It is a
 * single interface with `kind: string` (mirroring the `WorkflowNodeRecord`
 * convention) rather than a discriminated union: a `commandRef` carries
 * `commandId`; an `inline` carries `name` / `script` / etc. Optional fields
 * are `T | null` because serde serialises `Option<T>` as JSON `null`.
 */
export interface MiniAppActionRecord {
  kind: string;
  commandId?: string | null;
  name?: string;
  script?: string;
  shell?: string | null;
  args?: string[] | null;
  workingDir?: string | null;
  env?: Record<string, string> | null;
  runAsAdmin?: boolean;
  variables?: VariableSpec[];
}

/** Wire format matching the Rust `StatusSourceRecord` enum. */
export interface StatusSourceRecord {
  kind: string;
  commandId?: string | null;
  script?: string;
  shell?: string | null;
  variables?: VariableSpec[];
}

/** Wire format matching the Rust `StatusRuleRecord` (`match_value` is
 * renamed to `match` on the wire, mirroring the TS shape verbatim). */
export interface StatusRuleRecord {
  match: string;
  matchMode?: string | null;
  label: string;
  color?: string | null;
}

/** Wire format matching the Rust `StatusMappingRecord`. */
export interface StatusMappingRecord {
  field?: string | null;
  mode: string;
  rules?: StatusRuleRecord[] | null;
}

/** Wire format matching the Rust `ToggleStatusRecord` (the toggle widget's
 * optional poll config). */
export interface ToggleStatusRecord {
  source: StatusSourceRecord;
  intervalMs?: number | null;
  mapping: StatusMappingRecord;
  /** Status value that means "switch is ON"; `null` when unconfigured. */
  onValue?: string | null;
}

/** Wire format matching the Rust `TextStyleRecord`. `color` is `T | null`
 * because serde serialises `Option<T>` as JSON `null`; the remaining fields
 * are plain (non-nullable) values. */
export interface TextStyleRecord {
  fontSize: number;
  color?: string | null;
  bold: boolean;
  italic: boolean;
  align: string;
}

/** Wire format matching the Rust `WidgetStyleRecord`. `color` is `T | null`
 * because serde serialises `Option<T>` as JSON `null`; `variant` is a plain
 * (non-nullable) value. */
export interface WidgetStyleRecord {
  color?: string | null;
  variant: string;
}

/**
 * Wire format matching the Rust `MiniAppWidgetRecord` enum — a single
 * interface with `kind: string` plus variant-specific optional fields,
 * mirroring `WorkflowNodeRecord`. `button` sets `action`; `toggle` sets
 * `onAction` / `offAction` / optional `status`; `status` sets `source` /
 * `intervalMs` / `mapping`; `artifact` sets `value` / `variant`; `text` sets
 * `content` / `style`.
 *
 * `layout` carries the canvas position/size. It is optional on the wire
 * because the Rust side may not emit it yet (the column is added in a
 * follow-up); `recordToWidget` synthesises a kind-appropriate default when
 * absent so legacy rows still hydrate. When present it round-trips verbatim.
 */
export interface MiniAppWidgetRecord {
  id: string;
  kind: string;
  layout?: WidgetLayout;
  label: string;
  name?: string;
  icon?: string | null;
  action?: MiniAppActionRecord | null;
  onAction?: MiniAppActionRecord | null;
  offAction?: MiniAppActionRecord | null;
  status?: ToggleStatusRecord | null;
  source?: StatusSourceRecord | null;
  intervalMs?: number;
  mapping?: StatusMappingRecord | null;
  value?: string;
  variant?: string;
  persist?: boolean;
  content?: string;
  // `text` sends a `TextStyleRecord`; `button` / `toggle` send a
  // `WidgetStyleRecord`. Both share the wire key `style` because each
  // widget `kind` is a distinct Rust enum variant with its own `style`
  // field — this flattened TS interface just needs to accept either shape.
  style?: TextStyleRecord | WidgetStyleRecord | null;
}

/**
 * Wire format matching the Rust `StatusProbeResult` struct returned by the
 * headless `run_miniapp_status_probe` command (`#[serde(rename_all =
 * "camelCase")]`). `fields` carries the extracted output-schema values,
 * `returnValue` the command's chosen return value, and `stdoutTail` a
 * trimmed stdout slice for a no-schema probe. Structurally identical to the
 * `StatusProbeResult` interface the status poller consumes — they are kept
 * as separate declarations so this repository stays the single owner of the
 * wire vocabulary (`*Record`), matching the encode/decode convention used
 * for every other Rust-facing struct in this module.
 */
export interface StatusProbeResultRecord {
  status: string;
  exitCode: number | null;
  fields: Record<string, unknown>;
  returnValue: unknown | null;
  stdoutTail: string | null;
}

/**
 * Wire format that matches the Rust `MiniAppRecord` struct exactly.
 * Optional fields are `T | null` (not `T | undefined`) because serde
 * serialises `Option<T>` as JSON `null`. `widgets` may be absent on a
 * minimal wire payload (Rust `#[serde(default)]`) and defaults to `[]`.
 */
export interface MiniAppRecord {
  id: string;
  name: string;
  /** i18next key for the display name; set only by built-in seeds. */
  nameKey?: string | null;
  description?: string | null;
  /** i18next key for the display description; set only by built-in seeds. */
  descriptionKey?: string | null;
  icon?: string | null;
  widgets?: MiniAppWidgetRecord[];
  tags: string[];
  categoryId?: string | null;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string | null;
  runCount: number;
  os?: string[] | null;
  panelSize?: PanelSizeRecord;
}

function actionToRecord(a: MiniAppAction): MiniAppActionRecord {
  if (a.kind === "commandRef") {
    return { kind: "commandRef", commandId: a.commandId };
  }
  return {
    kind: "inline",
    name: a.name,
    script: a.script,
    shell: undefToNull(a.shell),
    args: undefToNull(a.args),
    workingDir: undefToNull(a.workingDir),
    env: undefToNull(a.env),
    // `runAsAdmin` is a plain bool on the Rust side (`#[serde(default)]`),
    // so always send it — toggling it OFF must persist (a `?? false` omit
    // would otherwise leave a stale `true` in SQLite).
    runAsAdmin: a.runAsAdmin ?? false,
    // Omit `variables` when absent to mirror the Rust
    // `skip_serializing_if = "Option::is_none"` contract — the same choice
    // `commandRepository` makes for the `Command.variables` column.
    ...omitWhenUndefined("variables", a.variables),
  };
}

function recordToAction(r: MiniAppActionRecord): MiniAppAction {
  if (r.kind === "commandRef") {
    return { kind: "commandRef", commandId: r.commandId ?? "" };
  }
  // "inline" — and the defensive fallback for any unrecognised kind: a
  // malformed action decodes to a no-op inline rather than crashing
  // hydration (the editor surfaces the real problem to the user).
  const shellValue =
    r.shell !== null && r.shell !== undefined && isShell(r.shell)
      ? r.shell
      : undefined;
  return {
    kind: "inline",
    name: r.name ?? "",
    script: r.script ?? "",
    shell: shellValue,
    args: nullToUndef(r.args),
    workingDir: nullToUndef(r.workingDir),
    env: nullToUndef(r.env),
    runAsAdmin: r.runAsAdmin ?? false,
    // `variables` collapses to `undefined` when the record carries no value,
    // an empty array, OR an explicit `null` — matching the
    // `commandRepository` convention for ergonomic `action.variables?.length`.
    variables:
      r.variables !== undefined &&
      r.variables !== null &&
      r.variables.length > 0
        ? r.variables
        : undefined,
  };
}

function sourceToRecord(s: StatusSource): StatusSourceRecord {
  if (s.kind === "commandRef") {
    return { kind: "commandRef", commandId: s.commandId };
  }
  return {
    kind: "inline",
    script: s.script,
    shell: undefToNull(s.shell),
    ...omitWhenUndefined("variables", s.variables),
  };
}

function recordToSource(r: StatusSourceRecord): StatusSource {
  if (r.kind === "commandRef") {
    return { kind: "commandRef", commandId: r.commandId ?? "" };
  }
  const shellValue =
    r.shell !== null && r.shell !== undefined && isShell(r.shell)
      ? r.shell
      : undefined;
  return {
    kind: "inline",
    script: r.script ?? "",
    shell: shellValue,
    variables:
      r.variables !== undefined &&
      r.variables !== null &&
      r.variables.length > 0
        ? r.variables
        : undefined,
  };
}

function ruleToRecord(rule: StatusRule): StatusRuleRecord {
  return {
    match: rule.match,
    matchMode: undefToNull(rule.matchMode),
    label: rule.label,
    color: undefToNull(rule.color),
  };
}

function recordToRule(r: StatusRuleRecord): StatusRule {
  const matchMode = r.matchMode;
  return {
    match: r.match,
    matchMode:
      matchMode !== null && matchMode !== undefined && isMatchMode(matchMode)
        ? matchMode
        : undefined,
    label: r.label,
    color: nullToUndef(r.color),
  };
}

function mappingToRecord(m: StatusMapping): StatusMappingRecord {
  return {
    field: undefToNull(m.field),
    mode: m.mode,
    rules: m.rules ? m.rules.map(ruleToRecord) : null,
  };
}

function recordToMapping(r: StatusMappingRecord): StatusMapping {
  return {
    field: nullToUndef(r.field),
    mode: isStatusMode(r.mode) ? r.mode : "raw",
    rules: r.rules ? r.rules.map(recordToRule) : undefined,
  };
}

function toggleStatusToRecord(s: ToggleStatus): ToggleStatusRecord {
  return {
    source: sourceToRecord(s.source),
    intervalMs: undefToNull(s.intervalMs),
    mapping: mappingToRecord(s.mapping),
    onValue: undefToNull(s.onValue),
  };
}

function recordToToggleStatus(r: ToggleStatusRecord): ToggleStatus {
  return {
    source: recordToSource(r.source),
    intervalMs: nullToUndef(r.intervalMs),
    mapping: recordToMapping(r.mapping),
    onValue: nullToUndef(r.onValue),
  };
}

/**
 * Kind-appropriate canvas layout used when a wire record carries no `layout`
 * (legacy rows persisted before the canvas editor, or a Rust side that has
 * not yet learned the column). Sizes mirror the editor's `makeWidget`
 * defaults so a freshly-loaded widget renders at the same footprint a
 * newly-created one would.
 */
function defaultWidgetLayout(kind: string): WidgetLayout {
  switch (kind) {
    case "button":
      return { x: 16, y: 16, w: 140, h: 44 };
    case "toggle":
      return { x: 16, y: 16, w: 160, h: 44 };
    case "status":
      return { x: 16, y: 16, w: 220, h: 60 };
    case "artifact":
      return { x: 16, y: 16, w: 200, h: 56 };
    case "text":
      return { x: 16, y: 16, w: 200, h: 40 };
    default:
      return { x: 16, y: 16, w: 200, h: 60 };
  }
}

/** Fallback text style used when a wire record carries no `style` (legacy
 * rows, or a payload built before the text widget existed). Mirrors the
 * `TextStyle` defaults documented on the domain type. */
const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSize: 14,
  color: undefined,
  bold: false,
  italic: false,
  align: "left",
};

function textStyleToRecord(s: TextStyle): TextStyleRecord {
  return {
    fontSize: s.fontSize,
    color: undefToNull(s.color),
    bold: s.bold,
    italic: s.italic,
    align: s.align,
  };
}

function recordToTextStyle(
  r: TextStyleRecord | WidgetStyleRecord | null | undefined,
): TextStyle {
  if (r === null || r === undefined || "variant" in r) {
    return { ...DEFAULT_TEXT_STYLE };
  }
  return {
    fontSize:
      typeof r.fontSize === "number" && Number.isFinite(r.fontSize)
        ? r.fontSize
        : DEFAULT_TEXT_STYLE.fontSize,
    color: nullToUndef(r.color),
    bold: r.bold ?? DEFAULT_TEXT_STYLE.bold,
    italic: r.italic ?? DEFAULT_TEXT_STYLE.italic,
    align: isTextAlign(r.align) ? r.align : DEFAULT_TEXT_STYLE.align,
  };
}

function widgetStyleToRecord(s: WidgetStyle): WidgetStyleRecord {
  return {
    color: undefToNull(s.color),
    variant: s.variant,
  };
}

/** Decode a wire `style` for a button/toggle widget. The `MiniAppWidgetRecord`
 * field is shared across widget kinds (`text` sends a `TextStyleRecord`,
 * `button`/`toggle` send a `WidgetStyleRecord`), so this narrows via the
 * `variant` key — unique to `WidgetStyleRecord` — before decoding. Unlike
 * `recordToTextStyle`, `style` is OPTIONAL at the domain level: an absent or
 * mismatched record collapses to `undefined` (fully default rendering)
 * rather than a concrete default object — mirroring `WidgetStyle`'s
 * optionality on `MiniAppWidget`. */
function recordToWidgetStyle(
  r: TextStyleRecord | WidgetStyleRecord | null | undefined,
): WidgetStyle | undefined {
  if (r === null || r === undefined || !("variant" in r)) {
    return undefined;
  }
  return {
    color: nullToUndef(r.color),
    variant: isWidgetVariant(r.variant) ? r.variant : "fill",
  };
}

function widgetToRecord(w: MiniAppWidget): MiniAppWidgetRecord {
  switch (w.kind) {
    case "button":
      return {
        kind: "button",
        id: w.id,
        layout: w.layout,
        label: w.label,
        icon: undefToNull(w.icon),
        action: actionToRecord(w.action),
        style: w.style ? widgetStyleToRecord(w.style) : null,
      };
    case "toggle":
      return {
        kind: "toggle",
        id: w.id,
        layout: w.layout,
        label: w.label,
        onAction: actionToRecord(w.onAction),
        offAction: actionToRecord(w.offAction),
        status: w.status ? toggleStatusToRecord(w.status) : null,
        style: w.style ? widgetStyleToRecord(w.style) : null,
      };
    case "status":
      return {
        kind: "status",
        id: w.id,
        layout: w.layout,
        label: w.label,
        source: sourceToRecord(w.source),
        intervalMs: w.intervalMs,
        mapping: mappingToRecord(w.mapping),
      };
    case "artifact":
      return {
        kind: "artifact",
        id: w.id,
        layout: w.layout,
        name: w.name,
        label: w.label,
        value: w.value,
        variant: w.variant,
        persist: w.persist ?? false,
      };
    case "text":
      return {
        kind: "text",
        id: w.id,
        layout: w.layout,
        label: w.label,
        content: w.content,
        style: textStyleToRecord(w.style),
      };
  }
}

function recordToWidget(r: MiniAppWidgetRecord): MiniAppWidget {
  const layout = r.layout ?? defaultWidgetLayout(r.kind);
  switch (r.kind) {
    case "button":
      return {
        kind: "button",
        id: r.id,
        layout,
        label: r.label,
        icon: nullToUndef(r.icon),
        action: r.action
          ? recordToAction(r.action)
          : { kind: "commandRef", commandId: "" },
        style: recordToWidgetStyle(r.style),
      };
    case "toggle":
      return {
        kind: "toggle",
        id: r.id,
        layout,
        label: r.label,
        onAction: r.onAction
          ? recordToAction(r.onAction)
          : { kind: "commandRef", commandId: "" },
        offAction: r.offAction
          ? recordToAction(r.offAction)
          : { kind: "commandRef", commandId: "" },
        status: r.status ? recordToToggleStatus(r.status) : undefined,
        style: recordToWidgetStyle(r.style),
      };
    case "status":
      return {
        kind: "status",
        id: r.id,
        layout,
        label: r.label,
        source: r.source
          ? recordToSource(r.source)
          : { kind: "commandRef", commandId: "" },
        intervalMs: r.intervalMs ?? 0,
        mapping: r.mapping ? recordToMapping(r.mapping) : { mode: "raw" },
      };
    case "artifact":
      return {
        kind: "artifact",
        id: r.id,
        layout,
        name: r.name ?? "",
        label: r.label,
        value: r.value ?? "",
        variant:
          r.variant !== undefined && isArtifactVariant(r.variant)
            ? r.variant
            : "text",
        persist: r.persist ?? false,
      };
    case "text":
      return {
        kind: "text",
        id: r.id,
        layout,
        label: r.label,
        content: r.content ?? "",
        style: recordToTextStyle(r.style),
      };
    default:
      // Unknown widget kind — fall back to a minimal artifact so a malformed
      // record never crashes hydration. Preserves id/label for traceability.
      return {
        kind: "artifact",
        id: r.id,
        layout,
        name: r.name ?? "",
        label: r.label,
        value: "",
        variant: "text",
        persist: false,
      };
  }
}

/**
 * Coerce an arbitrary wire `panelSize` into a valid `PanelSize`, falling back
 * to {@link DEFAULT_PANEL_SIZE} when the value is absent or malformed (a
 * non-finite `w`/`h`). The boundary guard is here — at the entry point from
 * the wire — so consumers always see a concrete, finite size.
 */
function normalizePanelSize(value: PanelSizeRecord | undefined): PanelSize {
  if (
    value !== undefined &&
    typeof value.w === "number" &&
    Number.isFinite(value.w) &&
    typeof value.h === "number" &&
    Number.isFinite(value.h)
  ) {
    return { w: value.w, h: value.h };
  }
  return { ...DEFAULT_PANEL_SIZE };
}

/**
 * Convert a UI `MiniApp` into the wire-format record sent to Rust.
 * `undefined` fields collapse to `null` so the JSON payload always carries
 * an explicit value for every column.
 */
export function miniappToRecord(ma: MiniApp): MiniAppRecord {
  return {
    id: ma.id,
    name: ma.name,
    nameKey: undefToNull(ma.nameKey),
    description: undefToNull(ma.description),
    descriptionKey: undefToNull(ma.descriptionKey),
    icon: undefToNull(ma.icon),
    widgets: ma.widgets.map(widgetToRecord),
    tags: ma.tags,
    categoryId: undefToNull(ma.categoryId),
    favorite: ma.favorite,
    createdAt: ma.createdAt,
    updatedAt: ma.updatedAt,
    lastRunAt: undefToNull(ma.lastRunAt),
    runCount: ma.runCount,
    os: undefToNull(ma.os),
    panelSize: { w: ma.panelSize.w, h: ma.panelSize.h },
  };
}

/**
 * Decode a wire-format record into a UI `MiniApp`. Null collapses to
 * `undefined` so consumers can use `??` / `?.` idiomatically; absent
 * `widgets` becomes an empty array so callers can always iterate.
 */
export function recordToMiniApp(r: MiniAppRecord): MiniApp {
  const osRecord = nullToUndef(r.os);
  return {
    id: r.id,
    name: r.name,
    nameKey: nullToUndef(r.nameKey),
    description: nullToUndef(r.description),
    descriptionKey: nullToUndef(r.descriptionKey),
    icon: nullToUndef(r.icon),
    widgets: (r.widgets ?? []).map(recordToWidget),
    tags: r.tags,
    categoryId: nullToUndef(r.categoryId),
    favorite: r.favorite,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastRunAt: nullToUndef(r.lastRunAt),
    runCount: r.runCount,
    // `os` collapses to `undefined` (universal — no OS restriction) when the
    // record carries no value or an explicit `null`/empty array; each
    // surviving element is narrowed to `Platform` so a corrupt entry is dropped.
    os:
      osRecord && osRecord.length > 0
        ? osRecord.filter(isPlatform)
        : undefined,
    // `panelSize` defaults to the compact-control-panel size when the wire
    // payload omits it (legacy row, or a non-finite value) so the editor /
    // runner always render a concrete panel.
    panelSize: normalizePanelSize(r.panelSize),
  };
}

/** Load every persisted mini-app from SQLite, oldest first. */
export async function listMiniAppsFromDb(): Promise<MiniApp[]> {
  const records = await invoke<MiniAppRecord[]>("list_miniapps");
  return records.map(recordToMiniApp);
}

/** Fetch a single mini-app by id, or `null` when it does not exist. */
export async function getMiniAppFromDb(id: string): Promise<MiniApp | null> {
  const record = await invoke<MiniAppRecord | null>("get_miniapp", { id });
  return record ? recordToMiniApp(record) : null;
}

/** Insert-or-update a single mini-app. */
export async function saveMiniAppInDb(ma: MiniApp): Promise<void> {
  await invoke("save_miniapp", { miniapp: miniappToRecord(ma) });
}

/** Remove a mini-app by id. Idempotent — missing ids are not an error. */
export async function deleteMiniAppInDb(id: string): Promise<void> {
  await invoke("delete_miniapp", { id });
}

/**
 * Run a status source headlessly via the `run_miniapp_status_probe` command
 * and return its extracted status. The probe is silent (no execution-event
 * stream, no History row); admin elevation is rejected server-side. This is
 * the single IPC boundary the status poller calls — UI code never invokes
 * the command directly.
 *
 * `variableValues` is omitted from the wire payload when absent so it maps
 * to the Rust handler's `#[serde(default)]` empty map (mirroring the
 * `omitWhenUndefined` convention used for inline-script variables).
 *
 * @param source the status source (library command by id, or an inline script).
 * @param variableValues optional `${var}` resolutions for the probe run.
 */
export async function runStatusProbe(
  source: StatusSource,
  variableValues?: Record<string, string>,
): Promise<StatusProbeResultRecord> {
  return invoke<StatusProbeResultRecord>("run_miniapp_status_probe", {
    input: {
      source: sourceToRecord(source),
      ...omitWhenUndefined("variableValues", variableValues),
    },
  });
}
