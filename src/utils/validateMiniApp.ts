// Structural validation for a Mini-App draft.
//
// WHY THIS EXISTS: the editor used to gate Save on a single check (the
// mini-app's `name` is non-empty), so a panel whose buttons pointed at no
// command, whose inline scripts were empty, or whose artifacts had invalid /
// duplicated names persisted happily and only failed at run time with an
// opaque backend error. Validation belongs at the point where the data is
// authored, not at the point where it is executed.
//
// The module is deliberately pure and React-free: it returns i18n KEYS plus
// params, and the editor resolves them with `t()` at the render site (service
// and util modules never format user-facing text).

import type {
  MiniApp,
  MiniAppAction,
  MiniAppWidget,
  StatusMapping,
  StatusSource,
} from "../types";
import { VAR_RE } from "./commandFormState";
import { ARTIFACT_NAME_PATTERN } from "./miniappInlineCommand";

/**
 * A single problem found in a draft.
 *
 * `widgetId` is `undefined` for a mini-app-level issue (currently only the
 * name). `field` is a stable, machine-readable path the editor matches on to
 * decorate the offending input; `messageKey` + `params` are handed to `t()`.
 */
export interface MiniAppValidationIssue {
  /** Owning widget, or `undefined` for a mini-app-level issue. */
  widgetId?: string;
  /** Stable field path, e.g. `"name"`, `"action.commandId"`, `"source.script"`. */
  field: string;
  /** i18next key for the human-readable message. */
  messageKey: string;
  /** Interpolation params for `messageKey`. */
  params?: Record<string, string>;
}

/** Field path for the mini-app's own name. */
export const FIELD_NAME = "name";
/** Field path for any widget's `label`. */
export const FIELD_LABEL = "label";
/** Field path for an artifact widget's reference `name`. */
export const FIELD_ARTIFACT_NAME = "artifactName";
/** Field path for an artifact widget's `value`. */
export const FIELD_ARTIFACT_VALUE = "artifactValue";
/** Field path for an artifact widget's `persist` flag. */
export const FIELD_ARTIFACT_PERSIST = "artifactPersist";
/** Field path for a text widget's displayed `content`. */
export const FIELD_TEXT_CONTENT = "textContent";
/** Field path for a text widget's `style.fontSize`. */
export const FIELD_TEXT_FONT_SIZE = "textFontSize";

/** Inclusive bounds for a text widget's font size (px). Mirrors the editor's
 *  `NumberField` min/max, so a value the editor cannot produce is still caught
 *  if it arrives via import. */
export const TEXT_FONT_SIZE_MIN = 8;
export const TEXT_FONT_SIZE_MAX = 96;

/**
 * Collect the artifact names a `${ref}` token may legitimately resolve to.
 * Only names matching {@link ARTIFACT_NAME_PATTERN} count — an invalid name
 * can never be substituted by the Rust parser, so referencing it is still an
 * unknown reference (and the name itself is reported separately).
 */
export function collectValidArtifactNames(
  widgets: ReadonlyArray<MiniAppWidget>,
): Set<string> {
  const names = new Set<string>();
  for (const w of widgets) {
    if (w.kind !== "artifact") continue;
    if (!ARTIFACT_NAME_PATTERN.test(w.name)) continue;
    names.add(w.name);
  }
  return names;
}

/** Extract every `${name}` reference from `text`, in order, deduplicated. */
function referencedNames(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  VAR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VAR_RE.exec(text)) !== null) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Push an `unknownRef` issue for every `${name}` in `text` that is neither a
 * panel artifact nor a variable the owning action declares itself.
 */
function checkRefs(
  issues: MiniAppValidationIssue[],
  text: string,
  widgetId: string,
  field: string,
  artifactNames: ReadonlySet<string>,
  declaredNames: ReadonlySet<string>,
): void {
  for (const name of referencedNames(text)) {
    if (artifactNames.has(name)) continue;
    if (declaredNames.has(name)) continue;
    issues.push({
      widgetId,
      field,
      messageKey: "miniapps.editor.validation.unknownRef",
      params: { name },
    });
  }
}

/** The variable names an inline action declares for itself. */
function declaredVariableNames(action: MiniAppAction): Set<string> {
  if (action.kind !== "inline") return new Set<string>();
  return new Set((action.variables ?? []).map((v) => v.name));
}

/** The variable names an inline status source declares for itself. */
function declaredSourceNames(source: StatusSource): Set<string> {
  if (source.kind !== "inline") return new Set<string>();
  return new Set((source.variables ?? []).map((v) => v.name));
}

/**
 * Validate one action (a button's `action`, or a toggle's `onAction` /
 * `offAction`). `prefix` names the field path segment (`"action"`,
 * `"onAction"`, `"offAction"`).
 */
function validateAction(
  issues: MiniAppValidationIssue[],
  action: MiniAppAction,
  widgetId: string,
  prefix: string,
  artifactNames: ReadonlySet<string>,
): void {
  if (action.kind === "commandRef") {
    if (action.commandId.trim() === "") {
      issues.push({
        widgetId,
        field: `${prefix}.commandId`,
        messageKey: "miniapps.editor.validation.commandRequired",
      });
    }
    return;
  }
  const declared = declaredVariableNames(action);
  if (action.script.trim() === "") {
    issues.push({
      widgetId,
      field: `${prefix}.script`,
      messageKey: "miniapps.editor.validation.scriptRequired",
    });
  } else {
    checkRefs(
      issues,
      action.script,
      widgetId,
      `${prefix}.script`,
      artifactNames,
      declared,
    );
  }
  if (action.workingDir !== undefined) {
    checkRefs(
      issues,
      action.workingDir,
      widgetId,
      `${prefix}.workingDir`,
      artifactNames,
      declared,
    );
  }
  for (const arg of action.args ?? []) {
    checkRefs(issues, arg, widgetId, `${prefix}.args`, artifactNames, declared);
  }
  for (const value of Object.values(action.env ?? {})) {
    checkRefs(issues, value, widgetId, `${prefix}.env`, artifactNames, declared);
  }
}

/** Validate a status source (a status widget's, or a toggle's status one). */
function validateSource(
  issues: MiniAppValidationIssue[],
  source: StatusSource,
  widgetId: string,
  prefix: string,
  artifactNames: ReadonlySet<string>,
): void {
  if (source.kind === "commandRef") {
    if (source.commandId.trim() === "") {
      issues.push({
        widgetId,
        field: `${prefix}.commandId`,
        messageKey: "miniapps.editor.validation.commandRequired",
      });
    }
    return;
  }
  if (source.script.trim() === "") {
    issues.push({
      widgetId,
      field: `${prefix}.script`,
      messageKey: "miniapps.editor.validation.scriptRequired",
    });
    return;
  }
  checkRefs(
    issues,
    source.script,
    widgetId,
    `${prefix}.script`,
    artifactNames,
    declaredSourceNames(source),
  );
}

/**
 * Validate a status mapping's rule rows: an empty `match` matches nothing,
 * and a `matchMode: "regex"` rule whose `match` fails to compile as a
 * `RegExp` can never match anything either — both are reported per-row so
 * the editor highlights the offending rule rather than a generic message.
 */
function validateMapping(
  issues: MiniAppValidationIssue[],
  mapping: StatusMapping,
  widgetId: string,
  prefix: string,
): void {
  if (mapping.mode !== "mapped") return;
  const rules = mapping.rules ?? [];
  rules.forEach((rule, index) => {
    if (rule.match.trim() === "") {
      issues.push({
        widgetId,
        field: `${prefix}.rules.match`,
        messageKey: "miniapps.editor.validation.ruleMatchRequired",
        params: { index: String(index + 1) },
      });
      return;
    }
    if (rule.matchMode !== "regex") return;
    try {
      new RegExp(rule.match);
    } catch {
      issues.push({
        widgetId,
        field: `${prefix}.rules.regex`,
        messageKey: "miniapps.editor.validation.invalidRegex",
        params: { index: String(index + 1) },
      });
    }
  });
}

/**
 * Validate a whole mini-app draft. Returns every problem found, in document
 * order (mini-app level first, then per widget in layout order). An empty
 * array means the draft is safe to persist.
 *
 * Rules:
 * - the mini-app `name` is non-empty;
 * - every widget `label` is non-empty;
 * - a `commandRef` action/source names a command; an `inline` one has a script;
 * - an artifact `name` is non-empty, a valid identifier, and unique;
 * - a `secret`-variant artifact never has `persist: true`;
 * - a `mapped` mapping's rules all carry a non-empty `match`;
 * - every `${ref}` token resolves to a panel artifact or a declared variable.
 */
export function validateMiniApp(draft: MiniApp): MiniAppValidationIssue[] {
  const issues: MiniAppValidationIssue[] = [];

  if (draft.name.trim() === "") {
    issues.push({
      field: FIELD_NAME,
      messageKey: "miniapps.editor.nameRequired",
    });
  }

  const artifactNames = collectValidArtifactNames(draft.widgets);

  // Names claimed by MORE than one artifact. Both (all) occurrences are
  // reported so the user can see which rows collide — the runner keeps only
  // one of them in its value map, so the others silently desync.
  const nameCounts = new Map<string, number>();
  for (const w of draft.widgets) {
    if (w.kind !== "artifact") continue;
    nameCounts.set(w.name, (nameCounts.get(w.name) ?? 0) + 1);
  }

  for (const widget of draft.widgets) {
    // A text widget's `label` is an editor-internal name (the panel shows its
    // `content`, not its label), so a blank label is legal for it — the other
    // kinds render the label and therefore require one.
    if (widget.label.trim() === "") {
      if (widget.kind !== "text") {
        issues.push({
          widgetId: widget.id,
          field: FIELD_LABEL,
          messageKey: "miniapps.editor.validation.labelRequired",
        });
      }
    } else {
      checkRefs(
        issues,
        widget.label,
        widget.id,
        FIELD_LABEL,
        artifactNames,
        new Set<string>(),
      );
    }

    switch (widget.kind) {
      case "button":
        validateAction(issues, widget.action, widget.id, "action", artifactNames);
        break;
      case "toggle":
        validateAction(
          issues,
          widget.onAction,
          widget.id,
          "onAction",
          artifactNames,
        );
        validateAction(
          issues,
          widget.offAction,
          widget.id,
          "offAction",
          artifactNames,
        );
        if (widget.status !== undefined) {
          validateSource(
            issues,
            widget.status.source,
            widget.id,
            "source",
            artifactNames,
          );
          validateMapping(issues, widget.status.mapping, widget.id, "mapping");
        }
        break;
      case "status":
        validateSource(issues, widget.source, widget.id, "source", artifactNames);
        validateMapping(issues, widget.mapping, widget.id, "mapping");
        break;
      case "artifact": {
        if (widget.name.trim() === "") {
          issues.push({
            widgetId: widget.id,
            field: FIELD_ARTIFACT_NAME,
            messageKey: "miniapps.editor.validation.artifactNameRequired",
          });
        } else if (!ARTIFACT_NAME_PATTERN.test(widget.name)) {
          issues.push({
            widgetId: widget.id,
            field: FIELD_ARTIFACT_NAME,
            messageKey: "miniapps.editor.artifactNameInvalid",
          });
        } else if ((nameCounts.get(widget.name) ?? 0) > 1) {
          issues.push({
            widgetId: widget.id,
            field: FIELD_ARTIFACT_NAME,
            messageKey: "miniapps.editor.validation.duplicateArtifactName",
            params: { name: widget.name },
          });
        }
        // An artifact's value may itself interpolate ANOTHER artifact — but
        // never itself, which would be an unresolvable cycle.
        const selfExcluded = new Set(artifactNames);
        selfExcluded.delete(widget.name);
        checkRefs(
          issues,
          widget.value,
          widget.id,
          FIELD_ARTIFACT_VALUE,
          selfExcluded,
          new Set<string>(),
        );
        if (widget.variant === "secret" && widget.persist === true) {
          issues.push({
            widgetId: widget.id,
            field: FIELD_ARTIFACT_PERSIST,
            messageKey: "miniapps.editor.validation.secretCannotPersist",
          });
        }
        break;
      }
      case "text": {
        // A text widget with no content is useless — the panel would render an
        // empty box.
        if (widget.content.trim() === "") {
          issues.push({
            widgetId: widget.id,
            field: FIELD_TEXT_CONTENT,
            messageKey: "miniapps.editor.validation.textContentRequired",
          });
        } else {
          checkRefs(
            issues,
            widget.content,
            widget.id,
            FIELD_TEXT_CONTENT,
            artifactNames,
            new Set<string>(),
          );
        }
        const size = widget.style.fontSize;
        if (
          !Number.isFinite(size) ||
          size < TEXT_FONT_SIZE_MIN ||
          size > TEXT_FONT_SIZE_MAX
        ) {
          issues.push({
            widgetId: widget.id,
            field: FIELD_TEXT_FONT_SIZE,
            messageKey: "miniapps.editor.validation.fontSizeRange",
            params: {
              min: String(TEXT_FONT_SIZE_MIN),
              max: String(TEXT_FONT_SIZE_MAX),
            },
          });
        }
        break;
      }
    }
  }

  return issues;
}

/** Whether `issues` contains an entry for `widgetId` (any field). */
export function hasWidgetIssue(
  issues: ReadonlyArray<MiniAppValidationIssue>,
  widgetId: string,
): boolean {
  return issues.some((issue) => issue.widgetId === widgetId);
}

/**
 * The first issue matching `widgetId` + `field`, or `undefined`. `widgetId`
 * is `undefined` for mini-app-level fields.
 */
export function findIssue(
  issues: ReadonlyArray<MiniAppValidationIssue>,
  widgetId: string | undefined,
  field: string,
): MiniAppValidationIssue | undefined {
  return issues.find(
    (issue) => issue.widgetId === widgetId && issue.field === field,
  );
}
