// Full-screen mini-app constructor (`miniapp-editor` view): a low-code visual
// canvas builder. Three panes — palette (left) | canvas (center) | properties
// (right) — mirror the workflow editor's split, but hand-rolled (no reactflow:
// mini-apps are compact control panels, not node graphs).
//
// Palette→canvas creation uses native HTML5 DnD (custom `application/procmix-
// widget` MIME), the same pattern as the workflow palette. On-canvas widget
// repositioning uses a pointer-capture drag snapped to an 8px grid, the same
// pattern as the Terminal split handle. The target to edit comes from
// `useUIStore.miniappEditorId` (null → create new, a string → edit that
// mini-app); leaving is an explicit navigation back to the Mini-Apps list. A
// local draft (`MiniApp`) isolates edits until Save.
//
// The properties inspector reuses the per-kind sub-forms below (ActionEditor,
// StatusSourceEditor, StatusConfigFields, MappingEditor, …) unchanged.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import { useCommandStore } from "../../stores/commandStore";
import { useMiniAppStore } from "../../stores/miniappStore";
import { useUIStore } from "../../stores/uiStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import type {
  MiniApp,
  MiniAppAction,
  MiniAppWidget,
  PanelSize,
  Shell,
  StatusMapping,
  StatusSource,
  TextStyle,
  WidgetLayout,
  WidgetStyle,
} from "../../types";
import { getCommandName } from "../../utils/commandLabels";
import { collectCategoriesFrom, collectTagsFrom } from "../../utils/commandFilters";
import { runStatusProbe } from "../../utils/miniappRepository";
import type { StatusProbeResultRecord } from "../../utils/miniappRepository";
import type { MiniAppValidationIssue } from "../../utils/validateMiniApp";
import {
  FIELD_ARTIFACT_NAME,
  FIELD_ARTIFACT_PERSIST,
  FIELD_ARTIFACT_VALUE,
  FIELD_LABEL,
  FIELD_TEXT_CONTENT,
  findIssue,
  hasWidgetIssue,
  validateMiniApp,
} from "../../utils/validateMiniApp";
import { applyStatusMapping } from "../../services/miniappStatusPoller";
import type { StatusResult } from "../../services/miniappStatusPoller";
import { ConfirmDialog } from "../ConfirmDialog";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { ToggleSwitch } from "../ToggleSwitch";
import {
  ArrowLeftIcon,
  CancelIcon,
  CopyIcon,
  FileIcon,
  InfoIcon,
  PlusIcon,
  RedoIcon,
  RunIcon,
  SaveIcon,
  SpinnerIcon,
  StatusCheckIcon,
  StatusCrossIcon,
  TrashIcon,
  UndoIcon,
} from "../icons";
import { IconPicker } from "./IconPicker";
import { ArtifactRefInput } from "./ArtifactRefInput";
import { MiniAppMetaModal } from "./MiniAppMetaModal";
import { MiniAppWidget as MiniAppWidgetView } from "./MiniAppWidget";

/** Every shell variant recognised by the executor, in display order. */
const SHELLS: readonly Shell[] = [
  "bash",
  "zsh",
  "fish",
  "sh",
  "pwsh",
  "powershell",
  "cmd",
];

const SHELL_OPTIONS: ReadonlyArray<DropdownOption> = SHELLS.map((sh) => ({
  value: sh,
  label: sh,
}));

/** Default poll interval (ms) for a fresh status/toggle-status config. */
const DEFAULT_INTERVAL_MS = 5000;

/** Snap grid (px) for widget placement and drag-to-move. */
const GRID_SIZE = 8;

/** Default main-panel size for a brand-new mini-app draft. Mirrors the store /
 *  repository / Rust default so a fresh draft matches what the store persists. */
const DEFAULT_PANEL_SIZE = { w: 400, h: 320 };

/** Minimum main-panel dimensions enforced on resize (room for one widget). */
const MIN_PANEL_WIDTH = 200;
const MIN_PANEL_HEIGHT = 160;

/** Minimum widget dimensions enforced on canvas resize (compact for a button). */
const MIN_WIDGET_W = 48;
const MIN_WIDGET_H = 40;

/**
 * Per-kind minimum widget height, clamped tighter than the global
 * `MIN_WIDGET_H` for kinds whose card body is CHEAP to lay out vertically
 * (status/artifact/text: a label above a compact row) and raised for kinds
 * whose card wraps a `.btn`/`.toggle-switch` control that needs real room.
 *
 * The button/toggle floor is derived from the runtime CSS, not guessed: a
 * `.btn` inherits `body`'s `line-height: 1.5` with no override, so its own
 * intrinsic minimum is `border(1) + padding-top(6) + line-height(13px×1.5≈
 * 19.5px) + padding-bottom(6) + border(1) ≈ 33.5px`. The card wrapper now
 * applies `.miniapp-widget--button` for these two kinds (6px top/bottom
 * padding instead of the base 14px), adding `border(1)+padding(6)+padding(6)+
 * border(1) = 14px` on top — combined minimum ≈ 47.5px. `56` rounds that up
 * with a safety margin so a button/toggle can never be resized tight enough
 * to visibly clip against the card's rounded corners.
 */
const MIN_WIDGET_H_BY_KIND: Record<MiniAppWidget["kind"], number> = {
  button: 56,
  toggle: 56,
  status: MIN_WIDGET_H,
  artifact: MIN_WIDGET_H,
  text: MIN_WIDGET_H,
};

function minWidgetHeightFor(kind: MiniAppWidget["kind"]): number {
  return MIN_WIDGET_H_BY_KIND[kind];
}

/** The four corner resize handles shown on a selected widget. */
type ResizeHandle = "nw" | "ne" | "sw" | "se";

/** MIME type carried by a palette drag payload (HTML5 DnD, like the workflow
 *  palette's `application/procmix-node`). */
const DRAG_MIME = "application/procmix-widget";

/** Every widget kind, in palette order. */
const WIDGET_KINDS: readonly MiniAppWidget["kind"][] = [
  "button",
  "toggle",
  "status",
  "artifact",
  "text",
];

/**
 * Theme-token colour choices offered for a text widget. Shares the same
 * rationale as {@link RULE_COLOR_SWATCHES}: a `var(--token)` reference is a
 * legal inline-style colour, so the stored value tracks theme switches while
 * a literal hex still round-trips. `undefined` = the default text colour.
 */
const TEXT_COLOR_SWATCHES: ReadonlyArray<{
  /** The value persisted into `TextStyle.color`. */
  value: string;
  /** Suffix of the `miniapps.editor.textColorSwatch.*` translation key. */
  i18nKey: string;
}> = [
  { value: "var(--color-text)", i18nKey: "text" },
  { value: "var(--color-text-muted)", i18nKey: "muted" },
  { value: "var(--color-primary)", i18nKey: "primary" },
  { value: "var(--color-success)", i18nKey: "success" },
  { value: "var(--app-color-edit)", i18nKey: "warning" },
  { value: "var(--color-danger)", i18nKey: "danger" },
];

/** Bounded undo history depth. Deep enough for a full editing session, small
 *  enough that 50 structural clones of a draft never matter. */
const UNDO_LIMIT = 50;

/**
 * Theme-token colour choices offered for a status mapping rule.
 *
 * A rule's `color` is user-authored DATA that ends up in an inline
 * `style={{ color }}` at render time (`MiniAppWidget`'s `StatusBadge`), so it
 * can never be a CSS class. What it CAN be is a `var(--token)` reference:
 * that is a legal CSS colour value in an inline style, so the stored value
 * stays a plain string end-to-end (poller → badge, unchanged) while the
 * rendered colour tracks theme switches like every other green/red in the app.
 * A literal hex — typed in the custom field, or carried by an older mini-app /
 * an import — still round-trips verbatim.
 *
 * `i18nKey` is the label shown under the swatch; the token drives the value.
 */
const RULE_COLOR_SWATCHES: ReadonlyArray<{
  /** The value persisted into `StatusMapping.rules[].color`. */
  value: string;
  /** Suffix of the `miniapps.editor.ruleColorSwatch.*` translation key. */
  i18nKey: string;
}> = [
  { value: "var(--color-success)", i18nKey: "success" },
  { value: "var(--color-danger)", i18nKey: "danger" },
  { value: "var(--app-color-edit)", i18nKey: "warning" },
  { value: "var(--color-primary)", i18nKey: "primary" },
  { value: "var(--color-text-muted)", i18nKey: "muted" },
];

// --- geometry helpers ------------------------------------------------------

/** Snap a pixel value to the nearest grid line. */
function snap(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

/** Clamp `value` into the inclusive `[lo, hi]` range. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}

// --- inline-env (de)serialisation ------------------------------------------

/** Env is stored as Record<string,string>; edited as KEY=VALUE lines. */
function envToText(env?: Record<string, string>): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function textToEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (key.length > 0) out[key] = value;
  }
  return out;
}

// --- widget factory --------------------------------------------------------

function makeWidgetId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `maw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/** Create a fresh widget of the given kind with sane default dimensions. */
function makeWidget(kind: MiniAppWidget["kind"]): MiniAppWidget {
  const id = makeWidgetId();
  switch (kind) {
    case "button":
      return {
        id,
        kind: "button",
        layout: { x: 16, y: 16, w: 140, h: 56 },
        label: "",
        action: { kind: "commandRef", commandId: "" },
      };
    case "toggle":
      return {
        id,
        kind: "toggle",
        layout: { x: 16, y: 16, w: 160, h: 56 },
        label: "",
        onAction: { kind: "commandRef", commandId: "" },
        offAction: { kind: "commandRef", commandId: "" },
      };
    case "status":
      return {
        id,
        kind: "status",
        layout: { x: 16, y: 16, w: 220, h: 60 },
        label: "",
        source: { kind: "commandRef", commandId: "" },
        intervalMs: DEFAULT_INTERVAL_MS,
        mapping: { mode: "raw" },
      };
    case "artifact":
      return {
        id,
        kind: "artifact",
        layout: { x: 16, y: 16, w: 200, h: 56 },
        name: "",
        label: "",
        value: "",
        variant: "path",
      };
    case "text":
      return {
        id,
        kind: "text",
        layout: { x: 16, y: 16, w: 160, h: 40 },
        label: "",
        content: "",
        // `color` omitted — undefined means the default text colour.
        style: { fontSize: 14, bold: false, italic: false, align: "left" },
      };
  }
}

/** Create a widget of `kind` positioned at the given (pre-snap) canvas
 *  coordinates, snapped to the grid and clamped to the non-negative quadrant. */
function makeWidgetAt(
  kind: MiniAppWidget["kind"],
  x: number,
  y: number,
): MiniAppWidget {
  const base = makeWidget(kind);
  return {
    ...base,
    layout: {
      ...base.layout,
      x: Math.max(0, snap(x)),
      y: Math.max(0, snap(y)),
    },
  };
}

function blankDraft(): MiniApp {
  const ts = new Date().toISOString();
  return {
    id: "",
    name: "",
    widgets: [],
    tags: [],
    favorite: false,
    createdAt: ts,
    updatedAt: ts,
    runCount: 0,
    panelSize: { ...DEFAULT_PANEL_SIZE },
  };
}

// --- artifact references ---------------------------------------------------

/** Type guard narrowing to the artifact widget variant. */
function isArtifactWidget(
  w: MiniAppWidget,
): w is Extract<MiniAppWidget, { kind: "artifact" }> {
  return w.kind === "artifact";
}

/** Collect the named artifacts in a draft — the set of `${name}` references
 *  offerable in the editor's text fields. Empty names are excluded (an unnamed
 *  artifact can't be referenced). */
function collectArtifactNames(widgets: ReadonlyArray<MiniAppWidget>): string[] {
  return widgets
    .filter(isArtifactWidget)
    .map((w) => w.name)
    .filter((name) => name.length > 0);
}

// --- dirty tracking --------------------------------------------------------

/** Stable projection of a draft for the unsaved-changes comparison. Mirrors
 *  `CommandForm`'s `fingerprintForm`: only the fields that actually reach the
 *  persisted mini-app are included, so instance state a concurrent runner may
 *  bump (`runCount`, `lastRunAt`, `updatedAt`) never reads as a user edit. */
function fingerprintDraft(draft: MiniApp): string {
  return JSON.stringify({
    name: draft.name,
    description: draft.description ?? null,
    icon: draft.icon ?? null,
    widgets: draft.widgets,
    tags: draft.tags,
    categoryId: draft.categoryId ?? null,
    favorite: draft.favorite,
    os: draft.os ?? null,
    panelSize: draft.panelSize,
  });
}

// --- geometry clamping -----------------------------------------------------

/** Fit one widget's layout inside `panel`: size first (never below `minH` —
 *  the per-kind floor from {@link minWidgetHeightFor}, defaulting to the
 *  global {@link MIN_WIDGET_H} — never wider/taller than the panel), then
 *  position, so a widget can neither overflow the panel border nor leave the
 *  non-negative quadrant. */
function clampLayoutToPanel(
  layout: WidgetLayout,
  panel: PanelSize,
  minH: number = MIN_WIDGET_H,
): WidgetLayout {
  const w = clamp(layout.w, MIN_WIDGET_W, Math.max(MIN_WIDGET_W, panel.w));
  const h = clamp(layout.h, minH, Math.max(minH, panel.h));
  return {
    w,
    h,
    x: clamp(layout.x, 0, Math.max(0, panel.w - w)),
    y: clamp(layout.y, 0, Math.max(0, panel.h - h)),
  };
}

/** Re-clamp every widget after the panel changes size. Returns the ORIGINAL
 *  array reference when nothing moved, so a no-op panel resize does not churn
 *  the draft (and therefore does not mark it dirty). */
function clampWidgetsToPanel(
  widgets: ReadonlyArray<MiniAppWidget>,
  panel: PanelSize,
): MiniAppWidget[] {
  let changed = false;
  const next = widgets.map((widget) => {
    const layout = clampLayoutToPanel(
      widget.layout,
      panel,
      minWidgetHeightFor(widget.kind),
    );
    if (
      layout.x === widget.layout.x &&
      layout.y === widget.layout.y &&
      layout.w === widget.layout.w &&
      layout.h === widget.layout.h
    ) {
      return widget;
    }
    changed = true;
    return { ...widget, layout };
  });
  return changed ? next : (widgets as MiniAppWidget[]);
}

/**
 * Grab/release pointer capture, tolerating a stale pointer id.
 *
 * `setPointerCapture` throws `NotFoundError` when the pointer is already gone
 * (a pointer that ended between the event dispatching and this handler
 * running — and, in jsdom, always, because the API is unimplemented). The
 * drag itself is still correct without capture: the move/up listeners are
 * bound to the same element and the pointer is already over it. Swallowing
 * here is therefore handling the condition, not hiding it — losing capture
 * only means the drag ends if the pointer leaves the element.
 */
function capturePointer(target: Element, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // No capture — the drag still works, it just cannot follow the pointer
    // outside the element.
  }
}

function releasePointer(target: Element, pointerId: number): void {
  try {
    target.releasePointerCapture(pointerId);
  } catch {
    // Capture was never granted (see `capturePointer`), or already released.
  }
}

// --- palette DnD payload ---------------------------------------------------

interface WidgetDropPayload {
  kind: MiniAppWidget["kind"];
}

/** Parse + validate the HTML5 DnD payload. Foreign / malformed drags are
 *  ignored (returns null) so a stray drop never creates a broken widget. */
function parseWidgetPayload(raw: string): WidgetDropPayload | null {
  if (raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "kind" in parsed) {
      const kind = (parsed as { kind: unknown }).kind;
      if (
        typeof kind === "string" &&
        (WIDGET_KINDS as readonly string[]).includes(kind)
      ) {
        return { kind: kind as MiniAppWidget["kind"] };
      }
    }
  } catch {
    // Malformed payload (e.g. a foreign drag) — ignore.
  }
  return null;
}

/** Drag-start for a palette entry: stash the widget kind in the dataTransfer.
 *  The entry is a real `<button>` (keyboard-reachable); `<button draggable>`
 *  participates in HTML5 DnD exactly like the workflow palette's does. */
function paletteDragStart(
  event: ReactDragEvent<HTMLButtonElement>,
  kind: MiniAppWidget["kind"],
): void {
  event.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind }));
  event.dataTransfer.effectAllowed = "copy";
}

/** Deep-clone a widget under a fresh id, offset one grid step down-right and
 *  re-clamped into the panel. Used by Duplicate (properties panel / Ctrl+D). */
function duplicateWidget(
  widget: MiniAppWidget,
  panel: PanelSize,
): MiniAppWidget {
  const clone = structuredClone(widget);
  return {
    ...clone,
    id: makeWidgetId(),
    layout: clampLayoutToPanel(
      {
        ...clone.layout,
        x: clone.layout.x + GRID_SIZE,
        y: clone.layout.y + GRID_SIZE,
      },
      panel,
      minWidgetHeightFor(clone.kind),
    ),
  };
}

/** True when a keyboard event originates inside a text-editing control, so an
 *  editor-level shortcut (undo, Delete, arrow-nudge) must NOT hijack it.
 *  Mirrors `WorkflowCanvas`'s guard. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

// ===========================================================================
// Editor
// ===========================================================================

export function MiniAppEditor(): ReactElement | null {
  const { t } = useTranslation();
  const editorId = useUIStore((s) => s.miniappEditorId);
  const setMiniappEditorId = useUIStore((s) => s.setMiniappEditorId);
  const setView = useUIStore((s) => s.setView);
  const setLibraryTab = useUIStore((s) => s.setLibraryTab);
  const requestNavigation = useUIStore((s) => s.requestNavigation);
  const setMiniappEditorDirty = useUIStore((s) => s.setMiniappEditorDirty);
  const pendingNavigation = useUIStore((s) => s.pendingNavigation);
  const confirmPendingNavigation = useUIStore(
    (s) => s.confirmPendingNavigation,
  );
  const cancelPendingNavigation = useUIStore((s) => s.cancelPendingNavigation);
  const miniapps = useMiniAppStore((s) => s.miniapps);
  const addMiniApp = useMiniAppStore((s) => s.addMiniApp);
  const updateMiniApp = useMiniAppStore((s) => s.updateMiniApp);
  const commands = useCommandStore((s) => s.commands);

  const editing = editorId !== null;

  const existing = useMemo(
    () => (editorId === null ? null : miniapps.find((m) => m.id === editorId) ?? null),
    [editorId, miniapps],
  );

  // Shared suggestion bases for the metadata Category dropdown and Tags
  // chip editor: union across commands, workflows, AND mini-apps so a
  // category/tag used by any entity is offered everywhere (mirrors
  // CommandEditor's pattern, extended to mini-apps).
  const workflows = useWorkflowStore((s) => s.workflows);
  const categorySuggestions = useMemo(
    () => collectCategoriesFrom(commands, workflows, miniapps),
    [commands, workflows, miniapps],
  );
  const tagSuggestions = useMemo(
    () => collectTagsFrom(commands, workflows, miniapps),
    [commands, workflows, miniapps],
  );

  // Guard against a stale route (edited mini-app deleted, or a bad id): bounce
  // back to the list so we never render an orphaned editor.
  useEffect(() => {
    if (editorId !== null && existing === null) {
      setMiniappEditorId(null);
      setLibraryTab("miniapps");
      setView("library");
    }
  }, [editorId, existing, setMiniappEditorId, setLibraryTab, setView]);

  const [draft, setDraft] = useState<MiniApp>(() =>
    existing ? structuredClone(existing) : blankDraft(),
  );

  // Fingerprint of the last SAVED (or freshly opened) state. `draft` is
  // compared against it to derive `isDirty`; a successful save re-baselines it
  // so saving clears the unsaved-changes guard without leaving the editor.
  const [baseline, setBaseline] = useState<string>(() =>
    fingerprintDraft(existing ? existing : blankDraft()),
  );

  // Which mini-app the current draft was baselined from. Keyed on the ID, NOT
  // the object identity: `existing` is derived from the `miniapps` array, so a
  // concurrent store write (e.g. `markMiniAppRun` from an open runner) yields a
  // new object for the SAME mini-app. Re-baselining on that identity change
  // would silently discard the user's in-progress edits.
  const baselinedIdRef = useRef<string | null>(editorId);

  useEffect(() => {
    if (baselinedIdRef.current === editorId) return;
    baselinedIdRef.current = editorId;
    const next = existing ? structuredClone(existing) : blankDraft();
    setDraft(next);
    setBaseline(fingerprintDraft(next));
  }, [editorId, existing]);

  const isDirty = useMemo(
    () => fingerprintDraft(draft) !== baseline,
    [draft, baseline],
  );

  // ---------------------------------------------------------------
  // Undo / redo. A bounded stack of whole-draft snapshots: the draft is a
  // small plain object, so snapshotting it is cheaper and far less
  // error-prone than an inverse-operation log.
  //
  // `pushHistory(key)` records the CURRENT draft as the state to return to,
  // and is called BEFORE a mutation. Consecutive pushes carrying the same
  // `key` coalesce into one entry, so typing a label is a single undo step
  // rather than one per keystroke. Any differently-keyed action (selecting
  // another widget, dragging, adding, deleting) ends the run.
  // ---------------------------------------------------------------
  const [undoStack, setUndoStack] = useState<MiniApp[]>([]);
  const [redoStack, setRedoStack] = useState<MiniApp[]>([]);
  const lastPushKeyRef = useRef<string | null>(null);

  const pushHistory = useCallback(
    (key?: string): void => {
      if (key !== undefined && lastPushKeyRef.current === key) return;
      lastPushKeyRef.current = key ?? null;
      setUndoStack((stack) => {
        const next = [...stack, structuredClone(draft)];
        return next.length > UNDO_LIMIT ? next.slice(-UNDO_LIMIT) : next;
      });
      setRedoStack([]);
    },
    [draft],
  );

  const handleUndo = useCallback((): void => {
    setUndoStack((stack) => {
      const previous = stack[stack.length - 1];
      if (previous === undefined) return stack;
      setRedoStack((redo) => [...redo, structuredClone(draft)]);
      setDraft(previous);
      lastPushKeyRef.current = null;
      return stack.slice(0, -1);
    });
  }, [draft]);

  const handleRedo = useCallback((): void => {
    setRedoStack((stack) => {
      const next = stack[stack.length - 1];
      if (next === undefined) return stack;
      setUndoStack((undo) => [...undo, structuredClone(draft)]);
      setDraft(next);
      lastPushKeyRef.current = null;
      return stack.slice(0, -1);
    });
  }, [draft]);

  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;

  // Opening a different mini-app starts a fresh history — an undo must never
  // restore a draft belonging to another entity.
  useEffect(() => {
    setUndoStack([]);
    setRedoStack([]);
    lastPushKeyRef.current = null;
  }, [editorId]);

  // Publish the dirty flag so `requestNavigation` can defer a sidebar click
  // into `pendingNavigation` and this view can raise the confirm.
  useEffect(() => {
    setMiniappEditorDirty(isDirty);
  }, [isDirty, setMiniappEditorDirty]);

  // Leaving the editor for good must never leave a stale dirty flag behind —
  // otherwise the NEXT navigation out of an unrelated editor would be blocked.
  useEffect(() => {
    return () => {
      setMiniappEditorDirty(false);
    };
  }, [setMiniappEditorDirty]);

  // The widget currently selected on the canvas (drives the properties panel).
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);

  // Validation issues are computed continuously but only DISPLAYED once the
  // user presses Save — mirroring `CommandForm`'s `showErrors`, so a fresh
  // draft is not covered in red before anything has been attempted.
  const [showErrors, setShowErrors] = useState<boolean>(false);
  const issues = useMemo(() => validateMiniApp(draft), [draft]);

  // The widget queued for deletion, awaiting the confirm dialog.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // Whether the Properties modal (name/description/icon/category/tags/os) is
  // open. Deletion of the whole mini-app is no longer offered from the
  // editor — it stays available from the Library list card's context menu.
  const [metaModalOpen, setMetaModalOpen] = useState<boolean>(false);

  // The bordered main panel — widgets render inside it, and its dimensions
  // drive both the drag clamp bounds and the runner's render size.
  const panelRef = useRef<HTMLDivElement>(null);

  const commandOptions: ReadonlyArray<DropdownOption> = useMemo(
    () => [
      { value: "", label: t("miniapps.editor.selectCommand") },
      ...commands.map((c) => ({ value: c.id, label: getCommandName(c, t) })),
    ],
    [commands, t],
  );

  // Leaving the editor. Routed through `requestNavigation` so a dirty draft
  // parks the target in `pendingNavigation` and raises the confirm below,
  // exactly like the sidebar does. The Library tab is set up front — it is
  // not guarded state, so it is safe to apply even while a navigation is
  // pending confirmation.
  const handleBack = useCallback((): void => {
    setLibraryTab("miniapps");
    requestNavigation("library");
  }, [setLibraryTab, requestNavigation]);

  /**
   * Persist the draft. Returns `true` when it was written, `false` when
   * validation blocked it (in which case the errors become visible and the
   * first offending widget is selected).
   *
   * Save is intentionally never `disabled`: a dead button cannot explain WHY
   * it is blocked. Pressing it reveals the problems instead — the same rule
   * `CommandForm` follows.
   */
  const persistDraft = useCallback((): boolean => {
    if (issues.length > 0) {
      setShowErrors(true);
      const firstWidgetIssue = issues.find((i) => i.widgetId !== undefined);
      if (firstWidgetIssue?.widgetId !== undefined) {
        setSelectedWidgetId(firstWidgetIssue.widgetId);
      }
      return false;
    }
    const name = draft.name.trim();
    const payload = {
      name,
      description: draft.description,
      icon: draft.icon,
      widgets: draft.widgets,
      tags: draft.tags,
      categoryId: draft.categoryId,
      favorite: draft.favorite,
      os: draft.os,
      panelSize: draft.panelSize,
    };
    if (editing && existing) {
      updateMiniApp(existing.id, payload);
    } else {
      const created = addMiniApp(payload);
      // Adopt the new id so a subsequent Save updates the same mini-app
      // instead of creating a second one. `baselinedIdRef` is advanced in
      // lockstep so the id-change effect does not treat this as "open a
      // different mini-app" and reset the draft.
      baselinedIdRef.current = created.id;
      setMiniappEditorId(created.id);
    }
    // Re-baseline: the draft as saved becomes the new clean state.
    setBaseline(fingerprintDraft({ ...draft, name }));
    setDraft((d) => ({ ...d, name }));
    setShowErrors(false);
    return true;
  }, [
    issues,
    draft,
    editing,
    existing,
    updateMiniApp,
    addMiniApp,
    setMiniappEditorId,
  ]);

  const handleSave = useCallback((): void => {
    if (!persistDraft()) return;
    Message.success(t("miniapps.editor.saved"));
  }, [persistDraft, t]);

  const handleSaveAndClose = useCallback((): void => {
    if (!persistDraft()) return;
    Message.success(t("miniapps.editor.saved"));
    // The draft is clean now, so this navigates straight through the guard.
    // `setMiniappEditorDirty(false)` runs from the effect on the next render;
    // navigate imperatively to avoid depending on that ordering.
    setMiniappEditorDirty(false);
    setMiniappEditorId(null);
    setLibraryTab("miniapps");
    setView("library");
  }, [
    persistDraft,
    t,
    setMiniappEditorDirty,
    setMiniappEditorId,
    setLibraryTab,
    setView,
  ]);

  // Metadata edits coalesce per patched key, so typing a description is one
  // undo step. `historyKey` lets a caller override the coalescing bucket.
  const updateDraft = (patch: Partial<MiniApp>, historyKey?: string): void => {
    pushHistory(historyKey ?? `draft:${Object.keys(patch).join(",")}`);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const updateWidget = (
    id: string,
    updater: (w: MiniAppWidget) => MiniAppWidget,
    historyKey?: string,
  ): void => {
    pushHistory(historyKey ?? `widget:${id}`);
    setDraft((d) => ({
      ...d,
      widgets: d.widgets.map((w) => (w.id === id ? updater(w) : w)),
    }));
  };

  // Layout mutations from the numeric fields and the arrow-nudge shortcut.
  // The pointer drags push their own single snapshot at pointer-DOWN and pass
  // `trackHistory: false` for every intermediate move, so a whole drag is one
  // undo step rather than one per pixel.
  const updateWidgetLayout = (
    id: string,
    patch: Partial<WidgetLayout>,
    trackHistory = true,
  ): void => {
    if (trackHistory) pushHistory(`layout:${id}`);
    setDraft((d) => ({
      ...d,
      widgets: d.widgets.map((w) =>
        w.id === id ? { ...w, layout: { ...w.layout, ...patch } } : w,
      ),
    }));
  };

  // Deleting a widget throws away a whole configured action / status / mapping
  // block and there is no undo, so both delete affordances (the canvas `×` and
  // the properties-panel danger button) route through a confirm.
  const requestRemoveWidget = (id: string): void => {
    setPendingDeleteId(id);
  };

  const confirmRemoveWidget = (): void => {
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    if (id === null) return;
    pushHistory();
    setDraft((d) => ({ ...d, widgets: d.widgets.filter((w) => w.id !== id) }));
    setSelectedWidgetId((cur) => (cur === id ? null : cur));
  };

  const pendingDeleteWidget = useMemo(
    () =>
      pendingDeleteId === null
        ? null
        : draft.widgets.find((w) => w.id === pendingDeleteId) ?? null,
    [draft.widgets, pendingDeleteId],
  );

  // Click-to-add from the palette: place at a cascade offset so successive
  // adds don't stack identically. A dropped widget takes the cursor position.
  const addWidget = (kind: MiniAppWidget["kind"]): void => {
    const offset = draft.widgets.length * GRID_SIZE;
    const base = makeWidgetAt(kind, 16 + offset, 16 + offset);
    const widget: MiniAppWidget = {
      ...base,
      layout: clampLayoutToPanel(
        base.layout,
        draft.panelSize,
        minWidgetHeightFor(kind),
      ),
    };
    pushHistory();
    setDraft((d) => ({ ...d, widgets: [...d.widgets, widget] }));
    setSelectedWidgetId(widget.id);
  };

  const selectedWidget = useMemo(
    () => draft.widgets.find((w) => w.id === selectedWidgetId) ?? null,
    [draft.widgets, selectedWidgetId],
  );

  // Clone the selected widget (fresh id, offset one grid step). Configuring a
  // six-button panel otherwise means filling the action editor six times.
  const duplicateSelectedWidget = useCallback((): void => {
    const source = draft.widgets.find((w) => w.id === selectedWidgetId);
    if (source === undefined) return;
    const clone = duplicateWidget(source, draft.panelSize);
    pushHistory();
    setDraft((d) => ({ ...d, widgets: [...d.widgets, clone] }));
    setSelectedWidgetId(clone.id);
  }, [draft.widgets, draft.panelSize, selectedWidgetId, pushHistory]);

  // Arrow-key nudge for the selected widget: 1px, or one grid step with Shift.
  const nudgeSelectedWidget = useCallback(
    (dx: number, dy: number): void => {
      const widget = draft.widgets.find((w) => w.id === selectedWidgetId);
      if (widget === undefined) return;
      const next = clampLayoutToPanel(
        {
          ...widget.layout,
          x: widget.layout.x + dx,
          y: widget.layout.y + dy,
        },
        draft.panelSize,
        minWidgetHeightFor(widget.kind),
      );
      if (next.x === widget.layout.x && next.y === widget.layout.y) return;
      // Coalesce a held arrow key into one undo entry per widget.
      pushHistory(`nudge:${widget.id}`);
      setDraft((d) => ({
        ...d,
        widgets: d.widgets.map((w) =>
          w.id === widget.id ? { ...w, layout: next } : w,
        ),
      }));
    },
    [draft.widgets, draft.panelSize, selectedWidgetId, pushHistory],
  );

  // ---------------------------------------------------------------
  // Palette → canvas drop.
  //
  // The drop handler is bound to the CANVAS, not just the panel: a drop that
  // lands slightly outside the bordered rectangle used to be a silent no-op
  // with no explanation. Now the cursor position is projected into panel
  // coordinates and clamped, so an off-target drop places the widget at the
  // nearest legal spot inside the panel instead of doing nothing.
  //
  // `dragDepth` counts dragenter/dragleave pairs: entering a CHILD element
  // fires `dragleave` on the parent, so a naive boolean flickers the
  // drop-target highlight. The counter is the standard fix.
  // ---------------------------------------------------------------
  const [dragDepth, setDragDepth] = useState<number>(0);
  const isDragActive = dragDepth > 0;

  const hasWidgetPayload = (event: ReactDragEvent<HTMLDivElement>): boolean =>
    event.dataTransfer.types.includes(DRAG_MIME);

  const onCanvasDragEnter = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasWidgetPayload(event)) return;
    event.preventDefault();
    setDragDepth((depth) => depth + 1);
  };

  const onCanvasDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasWidgetPayload(event)) return;
    setDragDepth((depth) => Math.max(0, depth - 1));
  };

  const onCanvasDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasWidgetPayload(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onCanvasDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragDepth(0);
    const payload = parseWidgetPayload(event.dataTransfer.getData(DRAG_MIME));
    if (payload === null) return;
    const panel = panelRef.current;
    const base = makeWidget(payload.kind);
    let x = 16;
    let y = 16;
    if (panel !== null) {
      const rect = panel.getBoundingClientRect();
      // Coordinates relative to the PANEL even when the pointer is outside
      // it; `clampLayoutToPanel` below pulls the result back inside.
      x = event.clientX - rect.left - Math.round(base.layout.w / 2);
      y = event.clientY - rect.top - Math.round(base.layout.h / 2);
    }
    const dropped = makeWidgetAt(payload.kind, x, y);
    const widget: MiniAppWidget = {
      ...dropped,
      layout: clampLayoutToPanel(
        dropped.layout,
        draft.panelSize,
        minWidgetHeightFor(payload.kind),
      ),
    };
    pushHistory();
    setDraft((d) => ({ ...d, widgets: [...d.widgets, widget] }));
    setSelectedWidgetId(widget.id);
  };

  // Pointer-capture drag-to-move for a panel widget. Copies the Terminal
  // split-handle pattern: capture the pointer on the widget, translate each
  // `pointermove`'s delta into a snapped + clamped new `layout.x/y`, release on
  // up/cancel. Width/height are read once at pointer-down and never change
  // during a move, so the clamp bounds stay correct. Widgets are clamped to
  // stay within the panel (`panelSize`), not the surrounding canvas.
  const onWidgetPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    widget: MiniAppWidget,
  ): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    setSelectedWidgetId(widget.id);
    const target = event.currentTarget;
    capturePointer(target, event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const orig = widget.layout;
    const panelW = draft.panelSize.w;
    const panelH = draft.panelSize.h;
    // One snapshot for the WHOLE drag: taken here, before the first move, so
    // a single undo returns the widget to where the drag started.
    pushHistory();

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const maxX = Math.max(0, panelW - orig.w);
      const maxY = Math.max(0, panelH - orig.h);
      updateWidgetLayout(
        widget.id,
        {
          x: clamp(snap(orig.x + dx), 0, maxX),
          y: clamp(snap(orig.y + dy), 0, maxY),
        },
        false,
      );
    };
    const onUp = (upEvent: PointerEvent): void => {
      releasePointer(target, upEvent.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  // Resize the main panel via the bottom-right corner handle. Same
  // pointer-capture pattern as a widget move: capture on down, snap each
  // move delta to the grid, clamp to the minimum size (200×160), release on
  // up/cancel. Width/height update `draft.panelSize`.
  const onPanelResizeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0) return;
    const target = event.currentTarget;
    capturePointer(target, event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const origW = draft.panelSize.w;
    const origH = draft.panelSize.h;
    // One snapshot for the whole panel resize (including the widget re-clamp
    // it triggers), so a single undo restores both.
    pushHistory();

    const onMove = (moveEvent: PointerEvent): void => {
      const dw = moveEvent.clientX - startX;
      const dh = moveEvent.clientY - startY;
      const snappedW = snap(origW + dw);
      const snappedH = snap(origH + dh);
      const clampedW = Math.max(MIN_PANEL_WIDTH, snappedW);
      const clampedH = Math.max(MIN_PANEL_HEIGHT, snappedH);
      // Shrinking the panel must pull every widget back inside it, or the
      // widgets are stranded outside the border (and clipped in the runner,
      // which renders the panel at exactly `panelSize`).
      const panelSize: PanelSize = { w: clampedW, h: clampedH };
      setDraft((d) => ({
        ...d,
        panelSize,
        widgets: clampWidgetsToPanel(d.widgets, panelSize),
      }));
    };
    const onUp = (upEvent: PointerEvent): void => {
      releasePointer(target, upEvent.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  // Resize a widget via one of its four corner handles. Same pointer-capture
  // pattern as a panel resize and a widget move: capture on down, snap each
  // move delta to the grid, clamp size to the minimum and position to the
  // non-negative quadrant, release on up/cancel. For the nw/ne/sw handles the
  // dragged corner moves while the opposite corner stays fixed: x/y shift by
  // the change in width/height (`orig.x + (orig.w - newW)`), so when the size
  // clamps at its minimum the position stops moving too — no jump.
  const onWidgetResizeStart = (
    event: ReactPointerEvent<HTMLDivElement>,
    widgetId: string,
    handle: ResizeHandle,
  ): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const widget = draft.widgets.find((w) => w.id === widgetId);
    if (widget === undefined) {
      return;
    }
    const target = event.currentTarget;
    capturePointer(target, event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const orig = widget.layout;
    const panel = draft.panelSize;
    const minH = minWidgetHeightFor(widget.kind);
    // Which edges the dragged corner sits on. The handle's corner is the one
    // that moves; the opposite corner stays put.
    const leftEdge = handle === "nw" || handle === "sw";
    const topEdge = handle === "nw" || handle === "ne";
    // Upper size bound. Dragging a right/bottom edge can only grow until the
    // widget touches the panel border; dragging a left/top edge grows toward
    // x=0 / y=0, so the bound is the fixed opposite edge's coordinate.
    const maxW = leftEdge
      ? Math.max(MIN_WIDGET_W, orig.x + orig.w)
      : Math.max(MIN_WIDGET_W, panel.w - orig.x);
    const maxH = topEdge
      ? Math.max(minH, orig.y + orig.h)
      : Math.max(minH, panel.h - orig.y);
    // One snapshot for the whole resize gesture.
    pushHistory();

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const rawW = leftEdge ? orig.w - dx : orig.w + dx;
      const rawH = topEdge ? orig.h - dy : orig.h + dy;
      const newW = clamp(snap(rawW), MIN_WIDGET_W, maxW);
      const newH = clamp(snap(rawH), minH, maxH);
      // For a left/top edge, the dragged corner moves and the opposite corner
      // stays fixed: x shifts by the width delta. When the size is clamped at
      // either bound, newW/newH stop changing, so x/y stop moving too.
      const newX = leftEdge
        ? Math.max(0, snap(orig.x + (orig.w - newW)))
        : orig.x;
      const newY = topEdge
        ? Math.max(0, snap(orig.y + (orig.h - newH)))
        : orig.y;
      updateWidgetLayout(
        widgetId,
        { x: newX, y: newY, w: newW, h: newH },
        false,
      );
    };
    const onUp = (upEvent: PointerEvent): void => {
      releasePointer(target, upEvent.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  // ---------------------------------------------------------------
  // Editor-scoped keyboard shortcuts, bound on `document` so the canvas need
  // not be focused (the same contract `WorkflowCanvas` uses):
  //   Ctrl/Cmd+Z            undo
  //   Ctrl/Cmd+Shift+Z, ^Y  redo
  //   Ctrl/Cmd+D            duplicate the selected widget
  //   Delete / Backspace    delete the selected widget (via the confirm)
  //   Arrow keys            nudge 1px; Shift+Arrow nudges one grid step
  //
  // Every branch is suppressed while the event originates in a text-editing
  // control, so none of them hijacks ordinary typing, and while a confirm
  // dialog is open, so Delete cannot queue a second deletion behind the first.
  // ---------------------------------------------------------------
  const modalOpen =
    pendingDeleteId !== null ||
    pendingNavigation !== null ||
    metaModalOpen;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return;
      if (modalOpen) return;

      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === "z" || key === "y") {
          event.preventDefault();
          const wantRedo = key === "y" || event.shiftKey;
          if (wantRedo) {
            handleRedo();
          } else {
            handleUndo();
          }
          return;
        }
        if (key === "d" && selectedWidgetId !== null) {
          event.preventDefault();
          duplicateSelectedWidget();
        }
        return;
      }

      if (selectedWidgetId === null) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        requestRemoveWidget(selectedWidgetId);
        return;
      }

      const step = event.shiftKey ? GRID_SIZE : 1;
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          nudgeSelectedWidget(-step, 0);
          break;
        case "ArrowRight":
          event.preventDefault();
          nudgeSelectedWidget(step, 0);
          break;
        case "ArrowUp":
          event.preventDefault();
          nudgeSelectedWidget(0, -step);
          break;
        case "ArrowDown":
          event.preventDefault();
          nudgeSelectedWidget(0, step);
          break;
        default:
          break;
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    modalOpen,
    selectedWidgetId,
    handleUndo,
    handleRedo,
    duplicateSelectedWidget,
    nudgeSelectedWidget,
  ]);

  if (editorId !== null && existing === null) return null;

  const hasErrors = issues.length > 0;

  return (
    <div className="ma-editor">
      <header className="view-header ma-editor__header">
        <div className="ma-editor__title-wrap">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={handleBack}
            aria-label={t("miniapps.editor.back")}
            title={t("miniapps.editor.back")}
          >
            <ArrowLeftIcon />
          </button>
          <h1 className="view-title">
            {editing
              ? t("miniapps.editor.title.edit")
              : t("miniapps.editor.title.create")}
          </h1>
        </div>
        <div className="view-header__actions">
          {showErrors && hasErrors ? (
            <span className="ma-editor__issue-count" role="status">
              {t("miniapps.editor.validation.issueCount", {
                count: issues.length,
              })}
            </span>
          ) : null}
          <button
            type="button"
            className="btn command-form__action command-form__action--cancel"
            onClick={handleBack}
          >
            <span className="command-form__action-icon--cancel">
              <CancelIcon />
            </span>
            {t("common.close")}
          </button>
          {isDirty ? (
            <span
              className="ma-editor__dirty-indicator"
              role="status"
              aria-label={t("miniapps.editor.unsavedChanges")}
              title={t("miniapps.editor.unsavedChanges")}
            >
              *
            </span>
          ) : null}
          {/*
           * Save is deliberately NOT disabled when the draft is invalid: a
           * dead button cannot say WHY it is blocked. Clicking reveals every
           * problem and selects the first offending widget. `aria-disabled`
           * conveys the invalid state without swallowing the click — the
           * same contract `CommandForm` uses.
           */}
          <button
            type="button"
            className={`btn btn--ghost command-form__action${
              showErrors && hasErrors ? " command-form__action--invalid" : ""
            }`}
            onClick={handleSave}
            aria-disabled={showErrors && hasErrors}
          >
            <SaveIcon />
            {t("miniapps.editor.save")}
          </button>
          <button
            type="button"
            className={`btn btn--primary command-form__action${
              showErrors && hasErrors ? " command-form__action--invalid" : ""
            }`}
            onClick={handleSaveAndClose}
            aria-disabled={showErrors && hasErrors}
          >
            <SaveIcon />
            {t("miniapps.editor.saveAndClose")}
          </button>
        </div>
      </header>

      <div className="ma-toolbar">
        <span className="ma-toolbar__name">
          {draft.name.trim() === "" ? t("miniapps.editor.untitled") : draft.name}
        </span>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setMetaModalOpen(true)}
        >
          {t("miniapps.editor.properties")}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={handleUndo}
          disabled={!canUndo}
          aria-label={t("miniapps.editor.undo")}
          title={t("miniapps.editor.undo")}
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={handleRedo}
          disabled={!canRedo}
          aria-label={t("miniapps.editor.redo")}
          title={t("miniapps.editor.redo")}
        >
          <RedoIcon />
        </button>
        <div className="ma-toolbar__spacer" />
      </div>

      <div className="ma-canvas-editor">
        {/* ---- Palette (left) ---- */}
        <aside className="ma-canvas-editor__palette">
          <span className="ma-canvas-editor__pane-title">
            {t("miniapps.editor.palette")}
          </span>
          {/* Real `<button>`s, like the workflow palette's: keyboard-reachable
              (Tab + Enter/Space adds the widget) while `draggable` keeps the
              HTML5 drag path working. */}
          {WIDGET_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className="btn btn--ghost ma-palette__item"
              draggable
              onDragStart={(event) => paletteDragStart(event, kind)}
              onClick={() => addWidget(kind)}
              title={t(`miniapps.editor.widgetTypeHint.${kind}`)}
            >
              {widgetKindGlyph(kind)}
              {t(`miniapps.editor.widgetType.${kind}`)}
            </button>
          ))}
          <p className="form-hint">{t("miniapps.editor.paletteHint")}</p>
        </aside>

        {/* ---- Canvas (center) ---- */}
        {/* Drag handlers sit on the CANVAS, not the panel: a drop just outside
            the bordered rectangle now lands at the nearest legal panel
            position instead of silently doing nothing. */}
        <div
          className={`ma-canvas-editor__canvas${
            isDragActive ? " is-drop-target" : ""
          }`}
          onDragEnter={onCanvasDragEnter}
          onDragLeave={onCanvasDragLeave}
          onDragOver={onCanvasDragOver}
          onDrop={onCanvasDrop}
        >
          {/* The bordered main panel: widgets live inside it, and the
              bottom-right handle resizes it. The dotted grid stays on the
              canvas container (outside the panel). */}
          <div
            ref={panelRef}
            className={`ma-canvas-panel${isDragActive ? " is-drop-target" : ""}`}
            style={{
              width: draft.panelSize.w,
              height: draft.panelSize.h,
            }}
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setSelectedWidgetId(null);
              }
            }}
          >
            {/* The "drag widgets here" affordance stays visible (dimmed) for
                the duration of a drag even once the panel has widgets — it is
                the only thing naming the legal drop target. */}
            {draft.widgets.length === 0 || isDragActive ? (
              <p
                className={`empty-state ma-canvas__empty${
                  draft.widgets.length > 0 ? " is-overlay" : ""
                }`}
              >
                {t("miniapps.editor.canvasEmpty")}
              </p>
            ) : null}
            {draft.widgets.map((widget) => {
              const isSelected = widget.id === selectedWidgetId;
              const isInvalid = showErrors && hasWidgetIssue(issues, widget.id);
              return (
                <div
                  key={widget.id}
                  className={`ma-canvas-widget${isSelected ? " is-selected" : ""}${
                    isInvalid ? " is-invalid" : ""
                  }`}
                  style={{
                    left: widget.layout.x,
                    top: widget.layout.y,
                    width: widget.layout.w,
                    height: widget.layout.h,
                  }}
                  // Keyboard route into the inspector: without `tabIndex` +
                  // `onFocus` the ONLY way to select a widget is a pointer
                  // drag, which makes the entire properties panel — and every
                  // action, status and mapping field in it — unreachable
                  // without a mouse. Focusing selects; the document-level
                  // shortcuts then handle nudge / duplicate / delete.
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  aria-label={previewLabel(widget, t)}
                  onFocus={() => setSelectedWidgetId(widget.id)}
                  onPointerDown={(event) => onWidgetPointerDown(event, widget)}
                >
                  <WidgetPreview widget={widget} />
                  {isSelected ? (
                    <>
                      <button
                        type="button"
                        className="ma-canvas-widget__delete"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          requestRemoveWidget(widget.id);
                        }}
                        aria-label={t("miniapps.editor.deleteWidget")}
                        title={t("miniapps.editor.deleteWidget")}
                      >
                        <CancelIcon />
                      </button>
                      {(["nw", "ne", "sw", "se"] as const).map((h) => (
                        <div
                          key={h}
                          className={`ma-canvas-widget__resize-handle ma-canvas-widget__resize-handle--${h}`}
                          onPointerDown={(event) =>
                            onWidgetResizeStart(event, widget.id, h)
                          }
                        />
                      ))}
                    </>
                  ) : null}
                </div>
              );
            })}
            {/* Resize handle — bottom-right corner of the panel. */}
            <div
              className="ma-canvas-panel__resize"
              onPointerDown={onPanelResizeStart}
              role="separator"
              aria-orientation="vertical"
              aria-label={t("miniapps.editor.panelSize")}
            />
          </div>
        </div>

  {/* ---- Properties (right) ---- */}
        <PropertiesPanel
          draft={draft}
          selectedWidget={selectedWidget}
          commandOptions={commandOptions}
          issues={showErrors ? issues : EMPTY_ISSUES}
          onUpdateDraft={updateDraft}
          onUpdateWidget={updateWidget}
          onUpdateWidgetLayout={updateWidgetLayout}
          onRemoveWidget={requestRemoveWidget}
          onDuplicateWidget={duplicateSelectedWidget}
        />
      </div>

      {metaModalOpen ? (
        <MiniAppMetaModal
          initial={{
            name: draft.name,
            description: draft.description,
            icon: draft.icon,
            categoryId: draft.categoryId,
            tags: draft.tags,
            os: draft.os,
          }}
          categorySuggestions={categorySuggestions}
          tagSuggestions={tagSuggestions}
          onSave={(meta) => {
            updateDraft(meta);
            setMetaModalOpen(false);
          }}
          onClose={() => setMetaModalOpen(false)}
        />
      ) : null}

      {/* Unsaved-changes guard: raised whenever `requestNavigation` deferred a
          target because the draft is dirty (the ← button and every sidebar
          item both route through it). */}
      <ConfirmDialog
        open={pendingNavigation !== null}
        title={t("miniapps.editor.unsavedTitle")}
        message={t("miniapps.editor.unsavedMessage")}
        confirmLabel={t("miniapps.editor.unsavedConfirm")}
        danger
        onConfirm={confirmPendingNavigation}
        onCancel={cancelPendingNavigation}
      />

      {/* Widget deletion is unrecoverable (no undo), so it is confirmed. */}
      <ConfirmDialog
        open={pendingDeleteWidget !== null}
        title={t("miniapps.editor.deleteWidgetConfirmTitle")}
        message={t("miniapps.editor.deleteWidgetConfirm", {
          label:
            pendingDeleteWidget !== null
              ? previewLabel(pendingDeleteWidget, t)
              : "",
          kind:
            pendingDeleteWidget !== null
              ? t(`miniapps.editor.widgetType.${pendingDeleteWidget.kind}`)
              : "",
        })}
        confirmLabel={t("common.delete")}
        danger
        onConfirm={confirmRemoveWidget}
        onCancel={() => setPendingDeleteId(null)}
      />
    </div>
  );
}

/** Stable empty issue list, so hiding errors never allocates a new array (and
 *  therefore never busts the properties panel's memoisation). */
const EMPTY_ISSUES: ReadonlyArray<MiniAppValidationIssue> = [];

// ===========================================================================
// Canvas widget preview (WYSIWYG)
// ===========================================================================

/** Frozen artifact context for a canvas preview: the editor has no runtime
 *  values, so every artifact reference renders as its literal `${name}`
 *  template and no artifact input is wired to anything. Module-level
 *  constants, so the objects are referentially stable across renders. */
const PREVIEW_ARTIFACT_VALUES: Record<string, string> = {};
const PREVIEW_ARTIFACT_NAMES: ReadonlySet<string> = new Set<string>();
const PREVIEW_VALUES_MAP: ReadonlyMap<string, string> = new Map<
  string,
  string
>();
const PREVIEW_ARTIFACT_SPECS: ReadonlyArray<never> = [];
const noopArtifactChange = (): void => {};

/**
 * WYSIWYG preview of a widget on the editor canvas.
 *
 * Renders the REAL runtime `MiniAppWidget` — a toggle looks like a toggle, a
 * status widget shows its badge, an artifact shows its input — instead of the
 * generic glyph + label box the canvas used to draw. Without this the author
 * cannot see what they are building without saving, navigating to the list and
 * pressing Run.
 *
 * `.ma-canvas-widget__preview` sets `pointer-events: none` on the rendered
 * body, so clicks/drags land on the wrapper (select + move) and no preview
 * control can actually fire an action from the editor. Status results are
 * never supplied, so every status renders its `idle` state — the editor does
 * not poll.
 */
function WidgetPreview({ widget }: { widget: MiniAppWidget }): ReactElement {
  return (
    <span className="ma-canvas-widget__preview" aria-hidden="true">
      <MiniAppWidgetView
        widget={widget}
        artifactValues={PREVIEW_ARTIFACT_VALUES}
        onArtifactChange={noopArtifactChange}
        artifactNames={PREVIEW_ARTIFACT_NAMES}
        valuesMap={PREVIEW_VALUES_MAP}
        executionValues={PREVIEW_ARTIFACT_VALUES}
        artifactSpecs={PREVIEW_ARTIFACT_SPECS}
        // The canvas preview is inert (`pointer-events: none` — see this
        // component's own doc comment), so no action can ever fire here; an
        // untagged execution id would be harmless even if one did.
        miniAppId={undefined}
      />
    </span>
  );
}

// ===========================================================================
// Properties panel: metadata (no selection) OR the selected widget's form
// ===========================================================================

interface PropertiesPanelProps {
  draft: MiniApp;
  selectedWidget: MiniAppWidget | null;
  commandOptions: ReadonlyArray<DropdownOption>;
  /** Validation issues to surface inline. Empty while errors are hidden. */
  issues: ReadonlyArray<MiniAppValidationIssue>;
  onUpdateDraft: (patch: Partial<MiniApp>, historyKey?: string) => void;
  onUpdateWidget: (
    id: string,
    updater: (w: MiniAppWidget) => MiniAppWidget,
    historyKey?: string,
  ) => void;
  onUpdateWidgetLayout: (id: string, patch: Partial<WidgetLayout>) => void;
  onRemoveWidget: (id: string) => void;
  onDuplicateWidget: () => void;
}

/**
 * A collapsible group of related controls inside the properties inspector.
 *
 * The inspector used to be one flat 300px scroll — for a toggle with a status
 * source and a mapping table that is 25+ controls in a single column, with the
 * least important fields (X/Y/W/H) at the very top. Grouping them behind
 * hand-rolled disclosure headers keeps the pane navigable while preserving the
 * canon: a `<button aria-expanded>` toggling a body, exactly like
 * `SystemVarsSection` / `EnvSnapshotTable` do elsewhere.
 *
 * Bodies are UNMOUNTED while collapsed. Every sub-form's state that must
 * survive (the stashed action branch, the inline category editor) lives in the
 * form component itself, so collapsing a section it is inside would lose it —
 * which is why the sections that own such state (Content, Status) default to
 * OPEN and only Layout, which is purely derived from the draft, defaults to
 * collapsed.
 */
function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState<boolean>(defaultOpen);
  return (
    <div className="ma-properties__group">
      <button
        type="button"
        className="ma-properties__group-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="ma-editor__subform-title">{title}</span>
      </button>
      {open ? <div className="ma-properties__group-body">{children}</div> : null}
    </div>
  );
}

function PropertiesPanel({
  draft,
  selectedWidget,
  commandOptions,
  issues,
  onUpdateDraft,
  onUpdateWidget,
  onUpdateWidgetLayout,
  onRemoveWidget,
  onDuplicateWidget,
}: PropertiesPanelProps): ReactElement {
  const { t } = useTranslation();

  // The set of `${name}` references offerable in the panel's text fields.
  // Recomputed only when the widget list changes.
  const artifactNames = useMemo(
    () => collectArtifactNames(draft.widgets),
    [draft.widgets],
  );

  // Only the selected widget's issues reach its sub-form.
  const widgetIssues = useMemo(
    () =>
      selectedWidget === null
        ? EMPTY_ISSUES
        : issues.filter((issue) => issue.widgetId === selectedWidget.id),
    [issues, selectedWidget],
  );

  if (selectedWidget === null) {
    return (
      <aside className="ma-canvas-editor__properties">
        <span className="ma-canvas-editor__pane-title">
          {t("miniapps.editor.metadataSection")}
        </span>
        <p className="form-hint">{t("miniapps.editor.selectWidget")}</p>
        <PanelSizeFields draft={draft} onUpdateDraft={onUpdateDraft} />
      </aside>
    );
  }

  // Only toggle + status widgets carry a status probe / mapping; buttons and
  // artifacts must not show empty Status / Mapping sections.
  const hasStatus =
    selectedWidget.kind === "status" || selectedWidget.kind === "toggle";
  const onChangeWidget = (
    updater: (w: MiniAppWidget) => MiniAppWidget,
    historyKey?: string,
  ): void => onUpdateWidget(selectedWidget.id, updater, historyKey);

  return (
    <aside className="ma-canvas-editor__properties">
      <span className="ma-canvas-editor__pane-title">
        {t("miniapps.editor.properties")}
      </span>
      <div className="ma-properties__section">
        <span className="ma-editor__widget-kind">
          {widgetKindGlyph(selectedWidget.kind)}
          {t(`miniapps.editor.widgetType.${selectedWidget.kind}`)}
        </span>

        {/* Content first: the label and the action(s) are what the author came
            here to set. Layout is last and collapsed — it is precision
            fine-tuning for what the canvas already does by dragging. */}
        <CollapsibleSection title={t("miniapps.editor.section.content")}>
          <WidgetForm
            section="content"
            widget={selectedWidget}
            commandOptions={commandOptions}
            artifactNames={artifactNames}
            issues={widgetIssues}
            onChange={onChangeWidget}
          />
        </CollapsibleSection>

        {hasStatus ? (
          <CollapsibleSection title={t("miniapps.editor.section.status")}>
            <WidgetForm
              section="status"
              widget={selectedWidget}
              commandOptions={commandOptions}
              artifactNames={artifactNames}
              issues={widgetIssues}
              onChange={onChangeWidget}
            />
          </CollapsibleSection>
        ) : null}

        {hasStatus ? (
          <CollapsibleSection title={t("miniapps.editor.section.mapping")}>
            <WidgetForm
              section="mapping"
              widget={selectedWidget}
              commandOptions={commandOptions}
              artifactNames={artifactNames}
              issues={widgetIssues}
              onChange={onChangeWidget}
            />
          </CollapsibleSection>
        ) : null}

        <CollapsibleSection
          title={t("miniapps.editor.section.layout")}
          defaultOpen={false}
        >
          <LayoutFields
            layout={selectedWidget.layout}
            panelSize={draft.panelSize}
            minHeight={minWidgetHeightFor(selectedWidget.kind)}
            onChange={(patch) => onUpdateWidgetLayout(selectedWidget.id, patch)}
          />
        </CollapsibleSection>

        <div className="ma-properties__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onDuplicateWidget}
          >
            <CopyIcon />
            {t("miniapps.editor.duplicateWidget")}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => onRemoveWidget(selectedWidget.id)}
          >
            <TrashIcon />
            {t("miniapps.editor.deleteWidget")}
          </button>
        </div>
      </div>
    </aside>
  );
}

/** Mini-app panel-size controls shown when no widget is selected. Every other
 *  metadata field (name, description, icon, category, tags, os) moved to
 *  {@link MiniAppMetaModal}; this is the only field left in the properties
 *  panel because it is spatial state the canvas itself visualises (the
 *  bordered main panel), not descriptive metadata. */
function PanelSizeFields({
  draft,
  onUpdateDraft,
}: {
  draft: MiniApp;
  onUpdateDraft: (patch: Partial<MiniApp>, historyKey?: string) => void;
}): ReactElement {
  const { t } = useTranslation();

  // Typing a smaller panel size must pull the widgets back inside it, exactly
  // like dragging the panel's resize grip does — otherwise widgets are
  // stranded outside the border and get clipped by the runner.
  const commitPanelSize = (patch: Partial<PanelSize>): void => {
    const panelSize: PanelSize = {
      w: Math.max(MIN_PANEL_WIDTH, patch.w ?? draft.panelSize.w),
      h: Math.max(MIN_PANEL_HEIGHT, patch.h ?? draft.panelSize.h),
    };
    onUpdateDraft({
      panelSize,
      widgets: clampWidgetsToPanel(draft.widgets, panelSize),
    });
  };

  return (
    <div className="ma-properties__section">
      <div className="ma-editor__subform">
        <span className="ma-editor__subform-title">
          {t("miniapps.editor.panelSize")}
        </span>
        <div className="ma-editor__row">
          <NumberField
            label={t("miniapps.editor.panelSizeWidth")}
            value={draft.panelSize.w}
            min={MIN_PANEL_WIDTH}
            onChange={(w) => commitPanelSize({ w })}
          />
          <NumberField
            label={t("miniapps.editor.panelSizeHeight")}
            value={draft.panelSize.h}
            min={MIN_PANEL_HEIGHT}
            onChange={(h) => commitPanelSize({ h })}
          />
        </div>
      </div>
    </div>
  );
}

/** Precision X / Y / width / height inputs for the selected widget's layout.
 *
 *  Every field carries an upper bound derived from `panelSize`, so a typed
 *  value cannot push the widget outside the panel — the same rule the drag and
 *  resize handlers enforce. Each patch is re-clamped as a whole (position and
 *  size interact: growing the width shrinks the legal x range). */
function LayoutFields({
  layout,
  panelSize,
  minHeight,
  onChange,
}: {
  layout: WidgetLayout;
  panelSize: PanelSize;
  /** Per-kind height floor from {@link minWidgetHeightFor}. */
  minHeight: number;
  onChange: (patch: Partial<WidgetLayout>) => void;
}): ReactElement {
  const { t } = useTranslation();

  const commit = (patch: Partial<WidgetLayout>): void => {
    onChange(clampLayoutToPanel({ ...layout, ...patch }, panelSize, minHeight));
  };

  return (
    <div className="ma-editor__subform">
      <span className="ma-editor__subform-title">
        {t("miniapps.editor.layout.label")}
      </span>
      <div className="ma-editor__row">
        <NumberField
          label={t("miniapps.editor.layout.x")}
          value={layout.x}
          min={0}
          max={Math.max(0, panelSize.w - layout.w)}
          onChange={(x) => commit({ x })}
        />
        <NumberField
          label={t("miniapps.editor.layout.y")}
          value={layout.y}
          min={0}
          max={Math.max(0, panelSize.h - layout.h)}
          onChange={(y) => commit({ y })}
        />
      </div>
      <div className="ma-editor__row">
        <NumberField
          label={t("miniapps.editor.layout.width")}
          value={layout.w}
          min={MIN_WIDGET_W}
          max={Math.max(MIN_WIDGET_W, panelSize.w)}
          onChange={(w) => commit({ w })}
        />
        <NumberField
          label={t("miniapps.editor.layout.height")}
          value={layout.h}
          min={minHeight}
          max={Math.max(minHeight, panelSize.h)}
          onChange={(h) => commit({ h })}
        />
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  /** Inclusive upper bound. Omitted for unbounded fields (the panel size). */
  max?: number;
  onChange: (value: number) => void;
}): ReactElement {
  return (
    <label className="form-field">
      <span className="form-field__label">{label}</span>
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const parsed = Number.parseInt(e.target.value, 10);
          if (!Number.isFinite(parsed)) {
            onChange(min);
            return;
          }
          onChange(max === undefined ? Math.max(min, parsed) : clamp(parsed, min, max));
        }}
      />
    </label>
  );
}

function widgetKindGlyph(kind: MiniAppWidget["kind"]): ReactElement {
  switch (kind) {
    case "button":
      return <RunIcon />;
    case "status":
      return <StatusCheckIcon />;
    case "artifact":
      return <FileIcon />;
    case "toggle":
      return <span aria-hidden="true">⇄</span>;
    case "text":
      return <span aria-hidden="true">T</span>;
  }
}

/** Canvas preview label: the widget's own label, falling back to its kind name
 *  when blank. Every widget variant carries a `label` field. */
function previewLabel(
  widget: MiniAppWidget,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  // A text widget has no visible `label` — its `content` is what the panel
  // shows, so the summary reflects that (falling back to the kind name).
  if (widget.kind === "text") {
    const content = widget.content.trim();
    return content.length > 0
      ? content
      : t(`miniapps.editor.widgetType.${widget.kind}`);
  }
  const label = widget.label.trim();
  return label.length > 0 ? label : t(`miniapps.editor.widgetType.${widget.kind}`);
}

// ===========================================================================
// Per-kind widget forms
// ===========================================================================

/**
 * Which slice of a widget's form to render. The properties inspector mounts
 * one `WidgetForm` per collapsible section rather than one flat column:
 *
 *  - `content` — label, icon, action(s), artifact name/value/variant
 *  - `status`  — the probe source, its poll interval, and the toggle's
 *                `onValue`. Only toggles and status widgets have one.
 *  - `mapping` — the field/mode selector and the rule table.
 *
 * A widget kind that owns nothing in a given section renders `null`; the
 * inspector only mounts the sections that can be non-empty.
 */
type WidgetFormSection = "content" | "status" | "mapping";

interface WidgetFormProps {
  section: WidgetFormSection;
  widget: MiniAppWidget;
  commandOptions: ReadonlyArray<DropdownOption>;
  artifactNames: ReadonlyArray<string>;
  issues: ReadonlyArray<MiniAppValidationIssue>;
  onChange: (
    updater: (w: MiniAppWidget) => MiniAppWidget,
    historyKey?: string,
  ) => void;
}

function WidgetForm({
  section,
  widget,
  commandOptions,
  artifactNames,
  issues,
  onChange,
}: WidgetFormProps): ReactElement | null {
  switch (widget.kind) {
    case "button":
      return (
        <ButtonWidgetForm
          section={section}
          widget={widget}
          commandOptions={commandOptions}
          artifactNames={artifactNames}
          issues={issues}
          onChange={onChange}
        />
      );
    case "toggle":
      return (
        <ToggleWidgetForm
          section={section}
          widget={widget}
          commandOptions={commandOptions}
          artifactNames={artifactNames}
          issues={issues}
          onChange={onChange}
        />
      );
    case "status":
      return (
        <StatusWidgetForm
          section={section}
          widget={widget}
          commandOptions={commandOptions}
          artifactNames={artifactNames}
          issues={issues}
          onChange={onChange}
        />
      );
    case "artifact":
      return (
        <ArtifactWidgetForm
          section={section}
          widget={widget}
          artifactNames={artifactNames}
          issues={issues}
          onChange={onChange}
        />
      );
    case "text":
      return (
        <TextWidgetForm
          section={section}
          widget={widget}
          artifactNames={artifactNames}
          issues={issues}
          onChange={onChange}
        />
      );
  }
}

/**
 * Render the `.form-hint` for a field: the first matching validation issue in
 * the danger colour, or the neutral `hint` when the field is clean.
 * Consolidates the pattern used across every sub-form below.
 */
function FieldHint({
  issue,
  hint,
}: {
  issue: MiniAppValidationIssue | undefined;
  hint?: string;
}): ReactElement | null {
  const { t } = useTranslation();
  if (issue !== undefined) {
    return (
      <p className="form-hint ma-editor__field-error">
        {t(issue.messageKey, issue.params)}
      </p>
    );
  }
  if (hint === undefined) return null;
  return <p className="form-hint">{hint}</p>;
}

function LabelField({
  value,
  artifactNames,
  issue,
  hint,
  onChange,
}: {
  /** Owning widget id. Unused by the markup, but kept in the prop list so a
   *  caller cannot forget to scope its history key. */
  widgetId: string;
  value: string;
  artifactNames: ReadonlyArray<string>;
  issue: MiniAppValidationIssue | undefined;
  /** Optional explanatory hint shown when the field is clean. */
  hint?: string;
  onChange: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="form-field">
      <span className="form-field__label">{t("miniapps.editor.label")}</span>
      <ArtifactRefInput
        value={value}
        onChange={onChange}
        artifactNames={artifactNames}
        invalid={issue !== undefined}
        placeholder={t("miniapps.editor.labelPlaceholder")}
        ariaLabel={t("miniapps.editor.label")}
      />
      <FieldHint issue={issue} hint={hint} />
    </div>
  );
}

function ButtonWidgetForm({
  section,
  widget,
  commandOptions,
  artifactNames,
  issues,
  onChange,
}: {
  section: WidgetFormSection;
  widget: Extract<MiniAppWidget, { kind: "button" }>;
  commandOptions: ReadonlyArray<DropdownOption>;
  artifactNames: ReadonlyArray<string>;
  issues: ReadonlyArray<MiniAppValidationIssue>;
  onChange: (
    updater: (w: MiniAppWidget) => MiniAppWidget,
    historyKey?: string,
  ) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  // A button has no status probe and no mapping.
  if (section !== "content") return null;
  return (
    <>
      <LabelField
        widgetId={widget.id}
        value={widget.label}
        artifactNames={artifactNames}
        issue={findIssue(issues, widget.id, FIELD_LABEL)}
        onChange={(label) =>
          onChange(
            (w) => (w.kind === "button" ? { ...w, label } : w),
            `label:${widget.id}`,
          )
        }
      />
      <div className="form-field">
        <span className="form-field__label">{t("miniapps.editor.icon")}</span>
        <IconPicker
          value={widget.icon}
          onChange={(icon) =>
            onChange((w) => (w.kind === "button" ? { ...w, icon } : w))
          }
        />
        <p className="form-hint">{t("miniapps.editor.buttonIconHint")}</p>
      </div>
      <ActionEditor
        labelKey="action"
        action={widget.action}
        commandOptions={commandOptions}
        artifactNames={artifactNames}
        issues={issues}
        widgetId={widget.id}
        fieldPrefix="action"
        onChange={(action) =>
          onChange((w) => (w.kind === "button" ? { ...w, action } : w))
        }
      />
      <WidgetStyleFields
        style={widget.style}
        widgetId={widget.id}
        onChange={(style, historyKey) =>
          onChange(
            (w) => (w.kind === "button" ? { ...w, style } : w),
            historyKey,
          )
        }
      />
    </>
  );
}

function ToggleWidgetForm({
  section,
  widget,
  commandOptions,
  artifactNames,
  issues,
  onChange,
}: {
  section: WidgetFormSection;
  widget: Extract<MiniAppWidget, { kind: "toggle" }>;
  commandOptions: ReadonlyArray<DropdownOption>;
  artifactNames: ReadonlyArray<string>;
  issues: ReadonlyArray<MiniAppValidationIssue>;
  onChange: (
    updater: (w: MiniAppWidget) => MiniAppWidget,
    historyKey?: string,
  ) => void;
}): ReactElement | null {
  const { t } = useTranslation();

  const statusEnabled = widget.status !== undefined;
  const toggleStatus = (enabled: boolean): void => {
    onChange((w) => {
      if (w.kind !== "toggle") return w;
      if (enabled) {
        return {
          ...w,
          status: {
            source: { kind: "commandRef", commandId: "" },
            intervalMs: DEFAULT_INTERVAL_MS,
            mapping: { mode: "raw" },
          },
        };
      }
      const { status: _status, ...rest } = w;
      return rest;
    });
  };

  if (section === "content") {
    return (
      <>
        <LabelField
          widgetId={widget.id}
          value={widget.label}
          artifactNames={artifactNames}
          issue={findIssue(issues, widget.id, FIELD_LABEL)}
          onChange={(label) =>
            onChange(
              (w) => (w.kind === "toggle" ? { ...w, label } : w),
              `label:${widget.id}`,
            )
          }
        />
        <ActionEditor
          labelKey="onAction"
          action={widget.onAction}
          commandOptions={commandOptions}
          artifactNames={artifactNames}
          issues={issues}
          widgetId={widget.id}
          fieldPrefix="onAction"
          onChange={(onAction, historyKey) =>
            onChange(
              (w) => (w.kind === "toggle" ? { ...w, onAction } : w),
              historyKey,
            )
          }
        />
        <ActionEditor
          labelKey="offAction"
          action={widget.offAction}
          commandOptions={commandOptions}
          artifactNames={artifactNames}
          issues={issues}
          widgetId={widget.id}
          fieldPrefix="offAction"
          onChange={(offAction, historyKey) =>
            onChange(
              (w) => (w.kind === "toggle" ? { ...w, offAction } : w),
              historyKey,
            )
          }
        />
        <WidgetStyleFields
          style={widget.style}
          widgetId={widget.id}
          onChange={(style, historyKey) =>
            onChange(
              (w) => (w.kind === "toggle" ? { ...w, style } : w),
              historyKey,
            )
          }
        />
      </>
    );
  }

  if (section === "mapping") {
    if (!widget.status) return null;
    return (
      <MappingEditor
        mapping={widget.status.mapping}
        issues={issues}
        widgetId={widget.id}
        onChange={(mapping, historyKey) =>
          onChange(
            (w) =>
              w.kind === "toggle" && w.status
                ? { ...w, status: { ...w.status, mapping } }
                : w,
            historyKey,
          )
        }
      />
    );
  }

  // section === "status"
  return (
    <>
      <div className="form-checkbox">
        <ToggleSwitch
          checked={statusEnabled}
          onChange={toggleStatus}
          ariaLabel={t("miniapps.editor.statusConfig")}
        />
        <span>{t("miniapps.editor.statusConfig")}</span>
      </div>

      {widget.status ? (
        <>
          <StatusConfigFields
            source={widget.status.source}
            intervalMs={widget.status.intervalMs ?? DEFAULT_INTERVAL_MS}
            mapping={widget.status.mapping}
            commandOptions={commandOptions}
            artifactNames={artifactNames}
            issues={issues}
            widgetId={widget.id}
            onSource={(source, historyKey) =>
              onChange(
                (w) =>
                  w.kind === "toggle" && w.status
                    ? { ...w, status: { ...w.status, source } }
                    : w,
                historyKey,
              )
            }
            onIntervalMs={(intervalMs) =>
              onChange(
                (w) =>
                  w.kind === "toggle" && w.status
                    ? { ...w, status: { ...w.status, intervalMs } }
                    : w,
                `interval:${widget.id}`,
              )
            }
          />
          {/*
           * The value that means "the switch is ON". Without it the toggle
           * falls back to the legacy "the probe exited 0" heuristic, which
           * renders ON for a service that is actually down — see
           * `resolveToggleOnState`.
           *
           * A `<div class="form-field">`, not a `<label>`: it also carries a
           * `<p class="form-hint">`, and a `<p>` inside a `<label>` is invalid
           * HTML (and breaks label-activation). The input is labelled by
           * `aria-label` instead. Same restructure as `ScheduleForm`.
           */}
          <div className="form-field">
            <span className="form-field__label">
              {t("miniapps.editor.onValue")}
            </span>
            <input
              className="input"
              type="text"
              value={widget.status.onValue ?? ""}
              aria-label={t("miniapps.editor.onValue")}
              placeholder={t("miniapps.editor.onValuePlaceholder")}
              onChange={(e) => {
                const raw = e.target.value;
                onChange((w) => {
                  if (w.kind !== "toggle" || !w.status) return w;
                  if (raw === "") {
                    // An empty field means "not configured" — drop the key so
                    // the wire shape matches a toggle that never had one.
                    const { onValue: _onValue, ...status } = w.status;
                    return { ...w, status };
                  }
                  return { ...w, status: { ...w.status, onValue: raw } };
                }, `onValue:${widget.id}`);
              }}
            />
            <p className="form-hint">{t("miniapps.editor.onValueHint")}</p>
          </div>
        </>
      ) : null}
    </>
  );
}

function StatusWidgetForm({
  section,
  widget,
  commandOptions,
  artifactNames,
  issues,
  onChange,
}: {
  section: WidgetFormSection;
  widget: Extract<MiniAppWidget, { kind: "status" }>;
  commandOptions: ReadonlyArray<DropdownOption>;
  artifactNames: ReadonlyArray<string>;
  issues: ReadonlyArray<MiniAppValidationIssue>;
  onChange: (
    updater: (w: MiniAppWidget) => MiniAppWidget,
    historyKey?: string,
  ) => void;
}): ReactElement | null {
  if (section === "content") {
    return (
      <LabelField
        widgetId={widget.id}
        value={widget.label}
        artifactNames={artifactNames}
        issue={findIssue(issues, widget.id, FIELD_LABEL)}
        onChange={(label) =>
          onChange(
            (w) => (w.kind === "status" ? { ...w, label } : w),
            `label:${widget.id}`,
          )
        }
      />
    );
  }

  if (section === "mapping") {
    return (
      <MappingEditor
        mapping={widget.mapping}
        issues={issues}
        widgetId={widget.id}
        onChange={(mapping, historyKey) =>
          onChange(
            (w) => (w.kind === "status" ? { ...w, mapping } : w),
            historyKey,
          )
        }
      />
    );
  }

  // section === "status"
  return (
    <StatusConfigFields
      source={widget.source}
      intervalMs={widget.intervalMs}
      mapping={widget.mapping}
      commandOptions={commandOptions}
      artifactNames={artifactNames}
      issues={issues}
      widgetId={widget.id}
      onSource={(source, historyKey) =>
        onChange((w) => (w.kind === "status" ? { ...w, source } : w), historyKey)
      }
      onIntervalMs={(intervalMs) =>
        onChange(
          (w) => (w.kind === "status" ? { ...w, intervalMs } : w),
          `interval:${widget.id}`,
        )
      }
    />
  );
}

function ArtifactWidgetForm({
  section,
  widget,
  artifactNames,
  issues,
  onChange,
}: {
  section: WidgetFormSection;
  widget: Extract<MiniAppWidget, { kind: "artifact" }>;
  artifactNames: ReadonlyArray<string>;
  issues: ReadonlyArray<MiniAppValidationIssue>;
  onChange: (
    updater: (w: MiniAppWidget) => MiniAppWidget,
    historyKey?: string,
  ) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const nameIssue = findIssue(issues, widget.id, FIELD_ARTIFACT_NAME);
  const valueIssue = findIssue(issues, widget.id, FIELD_ARTIFACT_VALUE);
  const persistIssue = findIssue(issues, widget.id, FIELD_ARTIFACT_PERSIST);
  const isSecret = widget.variant === "secret";
  // An artifact has no status probe and no mapping.
  if (section !== "content") return null;
  return (
    <>
      <div className="form-field">
        <span className="form-field__label">
          {t("miniapps.editor.artifactName")}
        </span>
        <input
          className={`input${nameIssue !== undefined ? " input--error" : ""}`}
          type="text"
          value={widget.name}
          aria-label={t("miniapps.editor.artifactName")}
          aria-required="true"
          aria-invalid={nameIssue !== undefined}
          onChange={(e) => {
            const name = e.target.value;
            onChange(
              (w) => (w.kind === "artifact" ? { ...w, name } : w),
              `artifactName:${widget.id}`,
            );
          }}
        />
        {/* The hint that EXPLAINS the field is shown even while it is empty —
            that is exactly when the user needs it. */}
        <FieldHint
          issue={nameIssue}
          hint={t("miniapps.editor.artifactNameHint")}
        />
      </div>
      {/* `label` vs `name` is the single most confusing pair in the feature,
          so the label field carries its own disambiguating hint here. */}
      <LabelField
        widgetId={widget.id}
        value={widget.label}
        artifactNames={artifactNames}
        issue={findIssue(issues, widget.id, FIELD_LABEL)}
        hint={t("miniapps.editor.artifactLabelHint")}
        onChange={(label) =>
          onChange(
            (w) => (w.kind === "artifact" ? { ...w, label } : w),
            `label:${widget.id}`,
          )
        }
      />
      <div className="form-field">
        <span className="form-field__label">{t("miniapps.editor.value")}</span>
        <ArtifactRefInput
          value={widget.value}
          onChange={(value) =>
            onChange(
              (w) => (w.kind === "artifact" ? { ...w, value } : w),
              `artifactValue:${widget.id}`,
            )
          }
          artifactNames={artifactNames}
          invalid={valueIssue !== undefined}
          placeholder={t("miniapps.editor.valuePlaceholder")}
          ariaLabel={t("miniapps.editor.value")}
        />
        <FieldHint
          issue={valueIssue}
          hint={t("miniapps.editor.artifactValueHint")}
        />
      </div>
      {/* A `<div>`, not a `<label>`: `Dropdown` renders a `<button
          aria-haspopup>`, which a wrapping `<label>` cannot label — the
          click-through affordance silently breaks. `ariaLabel` does the job. */}
      <div className="form-field">
        <span className="form-field__label">
          {t("miniapps.editor.variant.label")}
        </span>
        <Dropdown
          value={widget.variant}
          options={[
            { value: "path", label: t("miniapps.editor.variant.path") },
            { value: "text", label: t("miniapps.editor.variant.text") },
            { value: "secret", label: t("miniapps.editor.variant.secret") },
          ]}
          onChange={(variant) =>
            onChange((w) =>
              w.kind === "artifact"
                ? {
                    ...w,
                    variant: variant as "path" | "text" | "secret",
                    ...(variant === "secret" ? { persist: false } : {}),
                  }
                : w,
            )
          }
          ariaLabel={t("miniapps.editor.variant.label")}
        />
      </div>
      <div className="form-checkbox">
        <ToggleSwitch
          checked={widget.persist ?? false}
          onChange={(persist) =>
            onChange(
              (w) => (w.kind === "artifact" ? { ...w, persist } : w),
              `artifactPersist:${widget.id}`,
            )
          }
          ariaLabel={t("miniapps.editor.artifactPersist")}
          disabled={isSecret}
        />
        <span>{t("miniapps.editor.artifactPersist")}</span>
      </div>
      <FieldHint
        issue={persistIssue}
        hint={
          isSecret
            ? t("miniapps.editor.artifactPersistSecretDisabled")
            : t("miniapps.editor.artifactPersistHint")
        }
      />
    </>
  );
}

/**
 * Colour picker for any widget style whose colour is OPTIONAL: a row of
 * theme-token swatches (from the given `swatches` set) + a free-text field,
 * plus an explicit "default" option that clears the colour (so the widget
 * follows the theme's built-in default). `undefined` = default.
 *
 * Generalises what used to be a text-widget-only `TextColorPicker` — the
 * Button/Toggle style picker needs the identical shape (swatches + default +
 * custom input) with a different swatch set and label keys, and duplicating
 * the JSX for a third time would just be copy-paste. Mirrors
 * {@link RuleColorPicker}, whose colour is NOT optional (a mapping rule
 * always needs one) and therefore has no "default" swatch.
 */
function WidgetColorPicker({
  value,
  swatches,
  groupLabel,
  defaultLabel,
  swatchLabel,
  customLabel,
  onChange,
}: {
  /** The current colour, or `undefined` for the theme default. */
  value: string | undefined;
  swatches: ReadonlyArray<{ value: string; i18nKey: string }>;
  /** `aria-label` for the swatch row's `role="group"`. */
  groupLabel: string;
  /** Label for the "clear colour" swatch. */
  defaultLabel: string;
  /** Resolves a swatch's `i18nKey` to its displayed/aria label. */
  swatchLabel: (i18nKey: string) => string;
  /** `aria-label` for the free-text custom-colour input. */
  customLabel: string;
  onChange: (color: string | undefined) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="ma-editor__rule-color">
      <div className="ma-editor__swatches" role="group" aria-label={groupLabel}>
        <button
          type="button"
          className={`ma-editor__swatch ma-editor__swatch--default${
            value === undefined ? " is-selected" : ""
          }`}
          aria-pressed={value === undefined}
          aria-label={defaultLabel}
          title={defaultLabel}
          onClick={() => onChange(undefined)}
        />
        {swatches.map((swatch) => {
          const label = swatchLabel(swatch.i18nKey);
          const selected = value === swatch.value;
          return (
            <button
              key={swatch.i18nKey}
              type="button"
              className={`ma-editor__swatch${selected ? " is-selected" : ""}`}
              // The swatch's fill IS the value being chosen — a genuinely
              // dynamic style, and always a token reference here.
              style={{ backgroundColor: swatch.value }}
              aria-pressed={selected}
              aria-label={label}
              title={label}
              onClick={() => onChange(selected ? undefined : swatch.value)}
            />
          );
        })}
      </div>
      <input
        className="input ma-editor__rule-color-input"
        type="text"
        value={value ?? ""}
        aria-label={customLabel}
        placeholder={t("miniapps.editor.ruleColorPlaceholder")}
        onChange={(e) => onChange(e.target.value || undefined)}
      />
    </div>
  );
}

/** Colour picker for a text widget's `style.color`. Thin wrapper over
 *  {@link WidgetColorPicker} binding the text-specific swatches and labels. */
function TextColorPicker({
  value,
  onChange,
}: {
  /** The current colour, or `undefined` for the theme default. */
  value: string | undefined;
  onChange: (color: string | undefined) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <WidgetColorPicker
      value={value}
      swatches={TEXT_COLOR_SWATCHES}
      groupLabel={t("miniapps.editor.textColor")}
      defaultLabel={t("miniapps.editor.textColorDefault")}
      swatchLabel={(i18nKey) => t(`miniapps.editor.textColorSwatch.${i18nKey}`)}
      customLabel={t("miniapps.editor.textColorCustom")}
      onChange={onChange}
    />
  );
}

/** Colour picker for a button/toggle's `style.color` (the widget's ON/active
 *  colour). Reuses {@link RULE_COLOR_SWATCHES} — the primary/success/warning/
 *  danger set fits an action button's semantics better than the Text widget's
 *  muted/text-focused palette. */
function ButtonColorPicker({
  value,
  onChange,
}: {
  /** The current colour, or `undefined` for the theme default (`--app-color-run`). */
  value: string | undefined;
  onChange: (color: string | undefined) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <WidgetColorPicker
      value={value}
      swatches={RULE_COLOR_SWATCHES}
      groupLabel={t("miniapps.editor.widgetColor")}
      defaultLabel={t("miniapps.editor.widgetColorDefault")}
      swatchLabel={(i18nKey) => t(`miniapps.editor.ruleColorSwatch.${i18nKey}`)}
      customLabel={t("miniapps.editor.ruleColorCustom")}
      onChange={onChange}
    />
  );
}

/** The three text-alignment choices, in display order. */
const TEXT_ALIGNMENTS: ReadonlyArray<TextStyle["align"]> = [
  "left",
  "center",
  "right",
];

/** Segmented left/center/right selector for a text widget's `style.align`. */
function AlignSelector({
  value,
  onChange,
}: {
  value: TextStyle["align"];
  onChange: (align: TextStyle["align"]) => void;
}): ReactElement {
  const { t } = useTranslation();
  const labelKey: Record<TextStyle["align"], string> = {
    left: "miniapps.editor.alignLeft",
    center: "miniapps.editor.alignCenter",
    right: "miniapps.editor.alignRight",
  };
  return (
    <div
      className="ma-editor__align"
      role="group"
      aria-label={t("miniapps.editor.align")}
    >
      {TEXT_ALIGNMENTS.map((align) => {
        const selected = value === align;
        const label = t(labelKey[align]);
        return (
          <button
            key={align}
            type="button"
            className={`ma-editor__align-option${
              selected ? " is-selected" : ""
            }`}
            aria-pressed={selected}
            aria-label={label}
            title={label}
            onClick={() => onChange(align)}
          >
            {t(`miniapps.editor.alignGlyph.${align}`)}
          </button>
        );
      })}
    </div>
  );
}

/** The two fill/outline choices, in display order. */
const WIDGET_STYLE_VARIANTS: ReadonlyArray<WidgetStyle["variant"]> = [
  "fill",
  "outline",
];

/** Segmented fill/outline selector for a button/toggle's `style.variant`.
 *  Mirrors {@link AlignSelector}'s segmented-control pattern (same CSS
 *  classes) with two options instead of three. */
function WidgetVariantSelector({
  value,
  onChange,
}: {
  value: WidgetStyle["variant"];
  onChange: (variant: WidgetStyle["variant"]) => void;
}): ReactElement {
  const { t } = useTranslation();
  const labelKey: Record<WidgetStyle["variant"], string> = {
    fill: "miniapps.editor.styleVariantFill",
    outline: "miniapps.editor.styleVariantOutline",
  };
  return (
    <div
      className="ma-editor__align"
      role="group"
      aria-label={t("miniapps.editor.widgetStyle")}
    >
      {WIDGET_STYLE_VARIANTS.map((variant) => {
        const selected = value === variant;
        const label = t(labelKey[variant]);
        return (
          <button
            key={variant}
            type="button"
            className={`ma-editor__align-option${
              selected ? " is-selected" : ""
            }`}
            aria-pressed={selected}
            onClick={() => onChange(variant)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Colour + fill/outline controls for a button/toggle's optional `style`.
 * Shared by {@link ButtonWidgetForm} and {@link ToggleWidgetForm} — both bind
 * the same `WidgetStyle` shape to their own widget's `style` field.
 *
 * `style` is omitted entirely (rather than stored with all-default values)
 * once both `color` is undefined and `variant` is back to `"fill"`, so a
 * widget that never customises its look round-trips identically to one saved
 * before this feature existed.
 */
function WidgetStyleFields({
  style,
  widgetId,
  onChange,
}: {
  style: WidgetStyle | undefined;
  widgetId: string;
  onChange: (style: WidgetStyle | undefined, historyKey?: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const color = style?.color;
  const variant = style?.variant ?? "fill";

  const applyStyle = (
    patch: Partial<WidgetStyle>,
    historyKey?: string,
  ): void => {
    const next: WidgetStyle = { color, variant, ...patch };
    onChange(
      next.color === undefined && next.variant === "fill" ? undefined : next,
      historyKey,
    );
  };

  return (
    <div className="ma-editor__subform">
      <span className="ma-editor__subform-title">
        {t("miniapps.editor.widgetStyle")}
      </span>
      <div className="form-field">
        <span className="form-field__label">
          {t("miniapps.editor.widgetColor")}
        </span>
        <ButtonColorPicker
          value={color}
          onChange={(nextColor) =>
            applyStyle({ color: nextColor }, `widgetColor:${widgetId}`)
          }
        />
      </div>
      <div className="form-field">
        <span className="form-field__label">
          {t("miniapps.editor.widgetStyle")}
        </span>
        <WidgetVariantSelector
          value={variant}
          onChange={(nextVariant) =>
            applyStyle({ variant: nextVariant }, `widgetVariant:${widgetId}`)
          }
        />
      </div>
    </div>
  );
}

function TextWidgetForm({
  section,
  widget,
  artifactNames,
  issues,
  onChange,
}: {
  section: WidgetFormSection;
  widget: Extract<MiniAppWidget, { kind: "text" }>;
  artifactNames: ReadonlyArray<string>;
  issues: ReadonlyArray<MiniAppValidationIssue>;
  onChange: (
    updater: (w: MiniAppWidget) => MiniAppWidget,
    historyKey?: string,
  ) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  // A text widget has no status probe and no mapping — only content + style.
  if (section !== "content") return null;

  const contentIssue = findIssue(issues, widget.id, FIELD_TEXT_CONTENT);

  const updateStyle = (patch: Partial<TextStyle>, historyKey?: string): void => {
    onChange(
      (w) => (w.kind === "text" ? { ...w, style: { ...w.style, ...patch } } : w),
      historyKey,
    );
  };

  return (
    <>
      {/* `label` is the editor-internal name shown in the widget list/summary;
          it is NOT displayed on the panel — `content` is. The hint clarifies
          that distinction. */}
      <LabelField
        widgetId={widget.id}
        value={widget.label}
        artifactNames={artifactNames}
        issue={findIssue(issues, widget.id, FIELD_LABEL)}
        hint={t("miniapps.editor.textLabelHint")}
        onChange={(label) =>
          onChange(
            (w) => (w.kind === "text" ? { ...w, label } : w),
            `label:${widget.id}`,
          )
        }
      />
      <div className="form-field">
        <span className="form-field__label">
          {t("miniapps.editor.textContent")}
        </span>
        <ArtifactRefInput
          value={widget.content}
          onChange={(content) =>
            onChange(
              (w) => (w.kind === "text" ? { ...w, content } : w),
              `textContent:${widget.id}`,
            )
          }
          artifactNames={artifactNames}
          invalid={contentIssue !== undefined}
          multiline
          rows={2}
          placeholder={t("miniapps.editor.textContentPlaceholder")}
          ariaLabel={t("miniapps.editor.textContent")}
        />
        <FieldHint
          issue={contentIssue}
          hint={t("miniapps.editor.textContentHint")}
        />
      </div>

      <div className="ma-text-style-controls">
        <NumberField
          label={t("miniapps.editor.fontSize")}
          value={widget.style.fontSize}
          min={8}
          max={96}
          onChange={(fontSize) =>
            updateStyle({ fontSize }, `fontSize:${widget.id}`)
          }
        />

        {/* `<div>` + `aria-label`: the picker is a swatch group + input, not a
            single labelable control. */}
        <div className="form-field">
          <span className="form-field__label">
            {t("miniapps.editor.textColor")}
          </span>
          <TextColorPicker
            value={widget.style.color}
            onChange={(color) =>
              updateStyle({ color }, `textColor:${widget.id}`)
            }
          />
        </div>

        <div className="form-checkbox">
          <ToggleSwitch
            checked={widget.style.bold}
            onChange={(bold) => updateStyle({ bold })}
            ariaLabel={t("miniapps.editor.bold")}
          />
          <span>{t("miniapps.editor.bold")}</span>
        </div>

        <div className="form-checkbox">
          <ToggleSwitch
            checked={widget.style.italic}
            onChange={(italic) => updateStyle({ italic })}
            ariaLabel={t("miniapps.editor.italic")}
          />
          <span>{t("miniapps.editor.italic")}</span>
        </div>

        <div className="form-field">
          <span className="form-field__label">
            {t("miniapps.editor.align")}
          </span>
          <AlignSelector
            value={widget.style.align}
            onChange={(align) => updateStyle({ align }, `align:${widget.id}`)}
          />
        </div>
      </div>
    </>
  );
}

// ===========================================================================
// Status config (source + interval + mapping) — shared by status + toggle
// ===========================================================================

interface StatusConfigFieldsProps {
  source: StatusSource;
  intervalMs: number;
  mapping: StatusMapping;
  commandOptions: ReadonlyArray<DropdownOption>;
  artifactNames: ReadonlyArray<string>;
  issues: ReadonlyArray<MiniAppValidationIssue>;
  widgetId: string;
  onSource: (source: StatusSource, historyKey?: string) => void;
  onIntervalMs: (intervalMs: number) => void;
}

function StatusConfigFields({
  source,
  intervalMs,
  mapping,
  commandOptions,
  artifactNames,
  issues,
  widgetId,
  onSource,
  onIntervalMs,
}: StatusConfigFieldsProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="ma-editor__subform">
      <StatusSourceEditor
        source={source}
        commandOptions={commandOptions}
        artifactNames={artifactNames}
        issues={issues}
        widgetId={widgetId}
        onChange={onSource}
      />

      <StatusProbeTester source={source} mapping={mapping} />

      {/* `<div class="form-field">` + `aria-label`, not a `<label>`: the
          field carries a `<p class="form-hint">`, and a `<p>` inside a
          `<label>` is invalid HTML. Mirrors `ScheduleForm`. */}
      <div className="form-field">
        <span className="form-field__label">
          {t("miniapps.editor.intervalMs")}
        </span>
        <input
          className="input"
          type="number"
          min={1000}
          step={500}
          value={intervalMs}
          aria-label={t("miniapps.editor.intervalMs")}
          onChange={(e) => {
            const parsed = Number.parseInt(e.target.value, 10);
            onIntervalMs(
              Number.isFinite(parsed) ? Math.max(1000, parsed) : 1000,
            );
          }}
        />
        <p className="form-hint">{t("miniapps.editor.intervalMsHint")}</p>
      </div>
    </div>
  );
}

/**
 * "Test probe now" — runs the CURRENT draft `source` headlessly (via the same
 * `run_miniapp_status_probe` IPC the status poller uses) and shows the raw
 * output alongside a LIVE preview of what the current draft `mapping` rules
 * would produce, closing the loop between raw probe output and match rules
 * without saving or leaving the editor.
 *
 * The probe runs with no variable values (the editor has no runner context /
 * real artifact values): a script referencing `${var}` will surface a normal
 * `MissingVariable`-shaped error in the result panel rather than crash — that
 * is an expected, informative outcome here, not a bug.
 *
 * The mapped preview is recomputed from the LAST probe result whenever
 * `mapping` changes, without re-running the probe — only clicking the button
 * again re-probes.
 */
function StatusProbeTester({
  source,
  mapping,
}: {
  source: StatusSource;
  mapping: StatusMapping;
}): ReactElement {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<StatusProbeResultRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runProbe = useCallback((): void => {
    setRunning(true);
    setError(null);
    void (async (): Promise<void> => {
      try {
        const probeResult = await runStatusProbe(source);
        setResult(probeResult);
      } catch (err) {
        setResult(null);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
      }
    })();
  }, [source]);

  const preview = useMemo(() => {
    if (result === null) return null;
    return applyStatusMapping(result, mapping);
  }, [result, mapping]);

  return (
    <div className="form-field">
      <button
        type="button"
        className="btn btn--ghost"
        onClick={runProbe}
        disabled={running}
      >
        {running ? <SpinnerIcon /> : <RunIcon />}
        {t("miniapps.editor.testProbe")}
      </button>
      <p className="form-hint">{t("miniapps.editor.testProbeHint")}</p>

      {error !== null ? (
        <div className="ma-editor__probe-result ma-editor__probe-result--error">
          <StatusCrossIcon />
          <span>{error}</span>
        </div>
      ) : null}

      {result !== null ? (
        <div className="ma-editor__probe-result">
          <span className="form-field__label">
            {t("miniapps.editor.testProbeRawOutput")}
          </span>
          <pre className="ma-editor__probe-output">
            {result.stdoutTail ?? ""}
          </pre>
          {preview !== null ? (
            <div className="ma-editor__probe-preview">
              <span className="form-field__label">
                {t("miniapps.editor.testProbePreview")}
              </span>
              <ProbePreviewBadge result={preview} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Renders the LIVE mapped-preview badge for {@link StatusProbeTester}: the
 *  same three states `StatusBadge` (the runner) renders, reused here so a
 *  "Connected (green)" preview looks exactly like what the runner will show. */
function ProbePreviewBadge({ result }: { result: StatusResult }): ReactElement {
  const { t } = useTranslation();
  switch (result.state) {
    case "error":
      return (
        <span
          className="ma-editor__probe-badge ma-editor__probe-badge--error"
          title={result.detail}
        >
          <StatusCrossIcon />
          <span>{t(result.messageKey, result.params ?? {})}</span>
        </span>
      );
    case "ok":
      return (
        <span
          className="ma-editor__probe-badge ma-editor__probe-badge--ok"
          style={result.color !== undefined ? { color: result.color } : undefined}
        >
          <StatusCheckIcon />
          <span>{result.label}</span>
        </span>
      );
    case "unmatched":
      return (
        <span
          className="ma-editor__probe-badge ma-editor__probe-badge--unmatched"
          title={result.rawString}
        >
          <InfoIcon />
          <span>
            {result.messageKey !== undefined ? t(result.messageKey) : result.label}
          </span>
        </span>
      );
    default:
      return <span className="ma-editor__probe-badge" />;
  }
}

// ===========================================================================
// Status source editor (commandRef dropdown OR inline script)
// ===========================================================================

function StatusSourceEditor({
  source,
  commandOptions,
  artifactNames,
  issues,
  widgetId,
  onChange,
}: {
  source: StatusSource;
  commandOptions: ReadonlyArray<DropdownOption>;
  artifactNames: ReadonlyArray<string>;
  issues: ReadonlyArray<MiniAppValidationIssue>;
  widgetId: string;
  onChange: (source: StatusSource, historyKey?: string) => void;
}): ReactElement {
  const { t } = useTranslation();

  // The branch the user is NOT currently editing, kept alive so flipping the
  // type dropdown to look at the other option and flipping back restores the
  // script (or the selected command) instead of handing back a blank form.
  // There is no undo in this editor, so a destructive switch is unrecoverable.
  const [stashedCommandRef, setStashedCommandRef] = useState<
    Extract<StatusSource, { kind: "commandRef" }> | null
  >(source.kind === "commandRef" ? source : null);
  const [stashedInline, setStashedInline] = useState<
    Extract<StatusSource, { kind: "inline" }> | null
  >(source.kind === "inline" ? source : null);

  const commandIdIssue = findIssue(issues, widgetId, "source.commandId");
  const scriptIssue = findIssue(issues, widgetId, "source.script");

  const options: ReadonlyArray<DropdownOption> = [
    {
      value: "commandRef",
      label: t("miniapps.editor.actionType.commandRef"),
    },
    {
      value: "inline",
      label: t("miniapps.editor.actionType.inline"),
    },
  ];

  const emit = (next: StatusSource, historyKey?: string): void => {
    if (next.kind === "commandRef") {
      setStashedCommandRef(next);
    } else {
      setStashedInline(next);
    }
    onChange(next, historyKey);
  };

  return (
    <div className="form-field">
      <span className="form-field__label">{t("miniapps.editor.source")}</span>
      <Dropdown
        value={source.kind}
        options={options}
        onChange={(kind) => {
          if (kind === source.kind) return;
          if (kind === "commandRef") {
            setStashedInline(
              source.kind === "inline" ? source : stashedInline,
            );
            onChange(
              stashedCommandRef ?? { kind: "commandRef", commandId: "" },
            );
          } else {
            setStashedCommandRef(
              source.kind === "commandRef" ? source : stashedCommandRef,
            );
            onChange(stashedInline ?? { kind: "inline", script: "" });
          }
        }}
        ariaLabel={t("miniapps.editor.source")}
      />

      {source.kind === "commandRef" ? (
        <>
          <Dropdown
            value={source.commandId}
            options={commandOptions}
            onChange={(commandId) => emit({ kind: "commandRef", commandId })}
            ariaLabel={t("miniapps.editor.selectCommand")}
          />
          <FieldHint issue={commandIdIssue} />
        </>
      ) : (
        <>
          <div className="form-field">
            <span className="form-field__label">
              {t("miniapps.editor.inlineScript")}
            </span>
            <ArtifactRefInput
              value={source.script}
              onChange={(script) =>
                emit({ ...source, script }, `sourceScript:${widgetId}`)
              }
              artifactNames={artifactNames}
              invalid={scriptIssue !== undefined}
              multiline
              shellSyntax
              rows={3}
              placeholder={t("miniapps.editor.scriptPlaceholder")}
              ariaLabel={t("miniapps.editor.inlineScript")}
            />
            <FieldHint
              issue={scriptIssue}
              hint={t("miniapps.editor.statusScriptHint")}
            />
          </div>
          {/* `<div>` around a `Dropdown` — a `<label>` cannot label the
              `<button aria-haspopup>` it renders. */}
          <div className="form-field">
            <span className="form-field__label">
              {t("miniapps.editor.shell")}
            </span>
            <Dropdown
              value={source.shell ?? "bash"}
              options={SHELL_OPTIONS}
              onChange={(sh) => emit({ ...source, shell: sh as Shell })}
              ariaLabel={t("miniapps.editor.shell")}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ===========================================================================
// Action editor (commandRef dropdown OR inline script) — buttons + toggles
// ===========================================================================

function ActionEditor({
  action,
  commandOptions,
  artifactNames,
  issues,
  widgetId,
  fieldPrefix,
  labelKey,
  onChange,
}: {
  action: MiniAppAction;
  commandOptions: ReadonlyArray<DropdownOption>;
  artifactNames: ReadonlyArray<string>;
  issues: ReadonlyArray<MiniAppValidationIssue>;
  widgetId: string;
  /** Field-path prefix used by the validator (`action` / `onAction` / …). */
  fieldPrefix: string;
  labelKey: "action" | "onAction" | "offAction";
  onChange: (action: MiniAppAction, historyKey?: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const label = t(`miniapps.editor.${labelKey}`);

  // Hold the non-active branch so flipping the type dropdown and flipping back
  // restores the inline script (or the selected command) rather than a blank
  // form. Without this a 20-line script is destroyed by one dropdown click,
  // with no undo and no confirm.
  const [stashedCommandRef, setStashedCommandRef] = useState<
    Extract<MiniAppAction, { kind: "commandRef" }> | null
  >(action.kind === "commandRef" ? action : null);
  const [stashedInline, setStashedInline] = useState<
    Extract<MiniAppAction, { kind: "inline" }> | null
  >(action.kind === "inline" ? action : null);

  const commandIdIssue = findIssue(
    issues,
    widgetId,
    `${fieldPrefix}.commandId`,
  );

  const options: ReadonlyArray<DropdownOption> = [
    {
      value: "commandRef",
      label: t("miniapps.editor.actionType.commandRef"),
    },
    {
      value: "inline",
      label: t("miniapps.editor.actionType.inline"),
    },
  ];

  const emit = (next: MiniAppAction, historyKey?: string): void => {
    if (next.kind === "commandRef") {
      setStashedCommandRef(next);
    } else {
      setStashedInline(next);
    }
    onChange(next, historyKey);
  };

  return (
    <div className="ma-editor__subform">
      <span className="ma-editor__subform-title">{label}</span>
      <div className="form-field">
        <span className="form-field__label">
          {t("miniapps.editor.actionType.label")}
        </span>
        <Dropdown
          value={action.kind}
          options={options}
          onChange={(kind) => {
            if (kind === action.kind) return;
            if (kind === "commandRef") {
              setStashedInline(action.kind === "inline" ? action : stashedInline);
              onChange(
                stashedCommandRef ?? { kind: "commandRef", commandId: "" },
              );
            } else {
              setStashedCommandRef(
                action.kind === "commandRef" ? action : stashedCommandRef,
              );
              onChange(stashedInline ?? { kind: "inline", name: "", script: "" });
            }
          }}
          ariaLabel={t("miniapps.editor.actionType.label")}
        />
      </div>

      {action.kind === "commandRef" ? (
        // `<div>`, not `<label>`: the body is either a `Dropdown` (a
        // `<button aria-haspopup>`, which a `<label>` cannot label) or a
        // `<p class="form-hint">` — a paragraph inside a label is invalid HTML.
        <div className="form-field">
          <span className="form-field__label">
            {t("miniapps.editor.selectCommand")}
          </span>
          {commandOptions.length > 1 ? (
            <>
              <Dropdown
                value={action.commandId}
                options={commandOptions}
                onChange={(commandId) => emit({ kind: "commandRef", commandId })}
                ariaLabel={t("miniapps.editor.selectCommand")}
              />
              <FieldHint issue={commandIdIssue} />
            </>
          ) : (
            <p className="form-hint">{t("miniapps.editor.noCommands")}</p>
          )}
        </div>
      ) : (
        <InlineActionFields
          action={action}
          artifactNames={artifactNames}
          issues={issues}
          widgetId={widgetId}
          fieldPrefix={fieldPrefix}
          onChange={emit}
        />
      )}
    </div>
  );
}

function InlineActionFields({
  action,
  artifactNames,
  issues,
  widgetId,
  fieldPrefix,
  onChange,
}: {
  action: Extract<MiniAppAction, { kind: "inline" }>;
  artifactNames: ReadonlyArray<string>;
  issues: ReadonlyArray<MiniAppValidationIssue>;
  widgetId: string;
  fieldPrefix: string;
  onChange: (
    action: Extract<MiniAppAction, { kind: "inline" }>,
    historyKey?: string,
  ) => void;
}): ReactElement {
  const { t } = useTranslation();
  const scriptIssue = findIssue(issues, widgetId, `${fieldPrefix}.script`);
  const workingDirIssue = findIssue(
    issues,
    widgetId,
    `${fieldPrefix}.workingDir`,
  );
  const envIssue = findIssue(issues, widgetId, `${fieldPrefix}.env`);
  return (
    <>
      <div className="form-field">
        <span className="form-field__label">{t("miniapps.editor.inlineScript")}</span>
        <ArtifactRefInput
          value={action.script}
          onChange={(script) =>
            onChange({ ...action, script }, `${fieldPrefix}Script:${widgetId}`)
          }
          artifactNames={artifactNames}
          invalid={scriptIssue !== undefined}
          multiline
          shellSyntax
          rows={4}
          placeholder={t("miniapps.editor.scriptPlaceholder")}
          ariaLabel={t("miniapps.editor.inlineScript")}
        />
        <FieldHint issue={scriptIssue} />
      </div>

      <div className="ma-editor__row">
        <label className="form-field">
          <span className="form-field__label">
            {t("miniapps.editor.inlineName")}
          </span>
          <input
            className="input"
            type="text"
            value={action.name}
            placeholder={t("miniapps.editor.inlineNamePlaceholder")}
            onChange={(e) =>
              onChange(
                { ...action, name: e.target.value },
                `${fieldPrefix}Name:${widgetId}`,
              )
            }
          />
        </label>

        {/* `<div>` around a `Dropdown` — a `<label>` cannot label the
            `<button aria-haspopup>` it renders. */}
        <div className="form-field">
          <span className="form-field__label">{t("miniapps.editor.shell")}</span>
          <Dropdown
            value={action.shell ?? "bash"}
            options={SHELL_OPTIONS}
            onChange={(sh) => onChange({ ...action, shell: sh as Shell })}
            ariaLabel={t("miniapps.editor.shell")}
          />
        </div>
      </div>

      {/* Working dir and env are all `<div class="form-field">` +
          `aria-label`, NOT `<label>`: each can render a `<p class="form-hint">`
          (an inline error, or a static hint), and a `<p>` inside a `<label>` is
          invalid HTML and breaks label-activation. Mirrors `ScheduleForm`. */}
      <div className="form-field">
        <span className="form-field__label">
          {t("miniapps.editor.workingDir")}
        </span>
        <input
          className={`input${workingDirIssue !== undefined ? " input--error" : ""}`}
          type="text"
          value={action.workingDir ?? ""}
          aria-label={t("miniapps.editor.workingDir")}
          aria-invalid={workingDirIssue !== undefined}
          placeholder={t("miniapps.editor.workingDirPlaceholder")}
          onChange={(e) =>
            onChange(
              { ...action, workingDir: e.target.value || undefined },
              `${fieldPrefix}Dir:${widgetId}`,
            )
          }
        />
        <FieldHint issue={workingDirIssue} />
      </div>

      <div className="form-field">
        <span className="form-field__label">{t("miniapps.editor.env")}</span>
        <textarea
          className={`input${envIssue !== undefined ? " input--error" : ""}`}
          rows={2}
          value={envToText(action.env)}
          aria-label={t("miniapps.editor.env")}
          aria-invalid={envIssue !== undefined}
          placeholder={t("miniapps.editor.envPlaceholder")}
          onChange={(e) =>
            onChange(
              { ...action, env: textToEnv(e.target.value) },
              `${fieldPrefix}Env:${widgetId}`,
            )
          }
        />
        <FieldHint issue={envIssue} hint={t("miniapps.editor.envHint")} />
      </div>

      <div className="form-checkbox">
        <ToggleSwitch
          checked={action.runAsAdmin ?? false}
          onChange={(runAsAdmin) => onChange({ ...action, runAsAdmin })}
          ariaLabel={t("miniapps.editor.runAsAdmin")}
        />
        <span>{t("miniapps.editor.runAsAdmin")}</span>
      </div>
    </>
  );
}

// ===========================================================================
// Status mapping editor
// ===========================================================================

/**
 * Colour picker for one status-mapping rule: a row of theme-token swatches
 * plus a free-text field for a literal value.
 *
 * Replaces a bare text input whose only guidance was a raw `#22c55e`
 * placeholder — the author had to know a hex code off-hand, and whatever they
 * typed was frozen against the light theme. Picking a swatch stores
 * `var(--color-…)`, which is a legal inline-style colour and therefore follows
 * the active theme; the custom field still accepts (and preserves) any literal.
 */
function RuleColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string | undefined) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="ma-editor__rule-color">
      <div
        className="ma-editor__swatches"
        role="group"
        aria-label={t("miniapps.editor.ruleColor")}
      >
        {RULE_COLOR_SWATCHES.map((swatch) => {
          const label = t(`miniapps.editor.ruleColorSwatch.${swatch.i18nKey}`);
          const selected = value === swatch.value;
          return (
            <button
              key={swatch.i18nKey}
              type="button"
              className={`ma-editor__swatch${selected ? " is-selected" : ""}`}
              // The swatch's fill IS the value being chosen — a genuinely
              // dynamic style, and always a token reference here.
              style={{ backgroundColor: swatch.value }}
              aria-pressed={selected}
              aria-label={label}
              title={label}
              onClick={() => onChange(selected ? undefined : swatch.value)}
            />
          );
        })}
      </div>
      <input
        className="input ma-editor__rule-color-input"
        type="text"
        value={value}
        aria-label={t("miniapps.editor.ruleColorCustom")}
        placeholder={t("miniapps.editor.ruleColorPlaceholder")}
        onChange={(e) => onChange(e.target.value || undefined)}
      />
    </div>
  );
}

function MappingEditor({
  mapping,
  issues,
  widgetId,
  onChange,
}: {
  mapping: StatusMapping;
  issues: ReadonlyArray<MiniAppValidationIssue>;
  widgetId: string;
  onChange: (mapping: StatusMapping, historyKey?: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const rules = mapping.rules ?? [];
  // Every empty-`match` rule produces its own issue, carrying the 1-based row
  // index — so the right row is highlighted rather than all of them.
  const invalidRuleRows = useMemo(() => {
    const rows = new Set<number>();
    for (const issue of issues) {
      if (issue.widgetId !== widgetId) continue;
      if (issue.field !== "mapping.rules.match") continue;
      const index = Number.parseInt(issue.params?.index ?? "", 10);
      if (Number.isFinite(index)) rows.add(index - 1);
    }
    return rows;
  }, [issues, widgetId]);

  // Rows whose `matchMode` is `"regex"` and whose `match` fails to compile —
  // reported the same way as an empty-match issue (own Set, keyed by row).
  const invalidRegexRows = useMemo(() => {
    const rows = new Set<number>();
    for (const issue of issues) {
      if (issue.widgetId !== widgetId) continue;
      if (issue.field !== "mapping.rules.regex") continue;
      const index = Number.parseInt(issue.params?.index ?? "", 10);
      if (Number.isFinite(index)) rows.add(index - 1);
    }
    return rows;
  }, [issues, widgetId]);

  const updateRule = (
    index: number,
    patch: Partial<{
      match: string;
      label: string;
      color?: string;
      matchMode: "exact" | "contains" | "regex";
    }>,
    historyKey?: string,
  ): void => {
    const next = rules.map((rule, i) =>
      i === index ? { ...rule, ...patch } : rule,
    );
    onChange({ ...mapping, rules: next }, historyKey);
  };

  const removeRule = (index: number): void => {
    onChange({ ...mapping, rules: rules.filter((_, i) => i !== index) });
  };

  const addRule = (): void => {
    onChange({
      ...mapping,
      rules: [...rules, { match: "", label: "", matchMode: "exact" }],
    });
  };

  return (
    <div className="form-field">
      <div className="ma-editor__row">
        <label className="form-field">
          <span className="form-field__label">{t("miniapps.editor.field")}</span>
          <input
            className="input"
            type="text"
            value={mapping.field ?? ""}
            placeholder={t("miniapps.editor.fieldPlaceholder")}
            onChange={(e) =>
              onChange(
                { ...mapping, field: e.target.value || undefined },
                `mappingField:${widgetId}`,
              )
            }
          />
        </label>
        {/* `<div>` around a `Dropdown` — a `<label>` cannot label the
            `<button aria-haspopup>` it renders. */}
        <div className="form-field">
          <span className="form-field__label">
            {t("miniapps.editor.mode.label")}
          </span>
          <Dropdown
            value={mapping.mode}
            options={[
              { value: "raw", label: t("miniapps.editor.mode.raw") },
              { value: "mapped", label: t("miniapps.editor.mode.mapped") },
            ]}
            onChange={(mode) =>
              onChange({ ...mapping, mode: mode as "raw" | "mapped" })
            }
            ariaLabel={t("miniapps.editor.mode.label")}
          />
          <p className="form-hint">{t("miniapps.editor.mode.hint")}</p>
        </div>
      </div>

      {mapping.mode === "mapped" ? (
        <div className="ma-editor__rules">
          <span className="form-field__label">{t("miniapps.editor.rules")}</span>
          <p className="form-hint">{t("miniapps.editor.rulesHint")}</p>
          {rules.length === 0 ? (
            <p className="form-hint">{t("miniapps.editor.rulesEmpty")}</p>
          ) : null}
          {rules.map((rule, index) => {
            const matchMode = rule.matchMode ?? "exact";
            const regexInvalid = invalidRegexRows.has(index);
            return (
              <div className="ma-editor__rule-row" key={index}>
                <div
                  className="ma-editor__rule"
                  title={t(`miniapps.editor.matchModeHint.${matchMode}`)}
                >
                  <Dropdown
                    value={matchMode}
                    options={[
                      {
                        value: "exact",
                        label: t("miniapps.editor.matchModeExact"),
                        description: t("miniapps.editor.matchModeHint.exact"),
                      },
                      {
                        value: "contains",
                        label: t("miniapps.editor.matchModeContains"),
                        description: t(
                          "miniapps.editor.matchModeHint.contains",
                        ),
                      },
                      {
                        value: "regex",
                        label: t("miniapps.editor.matchModeRegex"),
                        description: t("miniapps.editor.matchModeHint.regex"),
                      },
                    ]}
                    onChange={(mode) =>
                      updateRule(
                        index,
                        { matchMode: mode as "exact" | "contains" | "regex" },
                        `ruleMatchMode:${widgetId}:${index}`,
                      )
                    }
                    ariaLabel={t("miniapps.editor.matchMode")}
                    className="ma-editor__match-mode"
                  />
                  <input
                    className={`input${
                      invalidRuleRows.has(index) || regexInvalid
                        ? " input--error"
                        : ""
                    }`}
                    type="text"
                    value={rule.match}
                    aria-invalid={invalidRuleRows.has(index) || regexInvalid}
                    placeholder={t(
                      `miniapps.editor.ruleMatchPlaceholder.${matchMode}`,
                    )}
                    aria-label={t("miniapps.editor.ruleMatch")}
                    onChange={(e) =>
                      updateRule(
                        index,
                        { match: e.target.value },
                        `ruleMatch:${widgetId}:${index}`,
                      )
                    }
                  />
                  <input
                    className="input"
                    type="text"
                    value={rule.label}
                    placeholder={t("miniapps.editor.ruleLabelPlaceholder")}
                    aria-label={t("miniapps.editor.ruleLabel")}
                    onChange={(e) =>
                      updateRule(
                        index,
                        { label: e.target.value },
                        `ruleLabel:${widgetId}:${index}`,
                      )
                    }
                  />
                  <RuleColorPicker
                    value={rule.color ?? ""}
                    onChange={(color) =>
                      updateRule(
                        index,
                        { color },
                        `ruleColor:${widgetId}:${index}`,
                      )
                    }
                  />
                  <button
                    type="button"
                    className="btn btn--danger btn--icon"
                    onClick={() => removeRule(index)}
                    aria-label={t("miniapps.editor.removeRule")}
                    title={t("miniapps.editor.removeRule")}
                  >
                    <TrashIcon />
                  </button>
                </div>
                {regexInvalid ? (
                  <p className="form-hint ma-editor__field-error">
                    {t("miniapps.editor.validation.invalidRegex", {
                      index: index + 1,
                    })}
                  </p>
                ) : null}
              </div>
            );
          })}
          <button type="button" className="btn btn--ghost" onClick={addRule}>
            <PlusIcon />
            {t("miniapps.editor.addRule")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
