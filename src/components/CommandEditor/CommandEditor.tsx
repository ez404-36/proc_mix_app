import { useCallback, useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";
import { useCommandStore } from "../../stores/commandStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import {
  collectCategories,
  collectTagsFrom,
} from "../../utils/commandFilters";
import { ConfirmDialog } from "../ConfirmDialog";
import { CommandForm } from "../CommandForm";

/**
 * Full-screen command editor view. Mirrors the workflow `Editor` screen:
 * the target to edit comes from `useUIStore.commandEditorTarget` (set by
 * the Library's New / Edit actions before navigating here), and leaving is
 * an explicit navigation rather than a modal dismiss.
 *
 * Navigation is funnelled through `requestNavigation`, which defers the
 * switch into `pendingNavigation` when the form is dirty so this view can
 * surface the unsaved-changes confirmation (the same app-styled
 * `ConfirmDialog` used elsewhere). On confirm the navigation commits and
 * the editor's dirty flag/target are cleared; on cancel the user stays.
 */
export function CommandEditor(): ReactElement | null {
  const { t } = useTranslation();
  const target = useUIStore((s) => s.commandEditorTarget);
  const commands = useCommandStore((s) => s.commands);
  const workflows = useWorkflowStore((s) => s.workflows);
  const setCommandEditorDirty = useUIStore((s) => s.setCommandEditorDirty);
  const requestNavigation = useUIStore((s) => s.requestNavigation);
  const setLibraryTab = useUIStore((s) => s.setLibraryTab);
  const setCommandEditorTarget = useUIStore((s) => s.setCommandEditorTarget);
  const pendingNavigation = useUIStore((s) => s.pendingNavigation);
  const confirmPendingNavigation = useUIStore(
    (s) => s.confirmPendingNavigation,
  );
  const cancelPendingNavigation = useUIStore((s) => s.cancelPendingNavigation);

  const allCategories = useMemo(
    () => collectCategories(commands),
    [commands],
  );

  // Shared tag base: tags used across BOTH commands and workflows, so a
  // workflow tag is offered as a suggestion in the command form too.
  const allTags = useMemo(
    () => collectTagsFrom(commands, workflows),
    [commands, workflows],
  );

  // Resolve the command to edit from its id so we always render the
  // freshest version (mirrors the workflow editor's id-based contract).
  const command = useMemo(() => {
    if (!target || target.mode === "create" || target.commandId === null) {
      return null;
    }
    return commands.find((c) => c.id === target.commandId) ?? null;
  }, [target, commands]);

  // Guard against an invalid state: the view is active but has no valid
  // target (e.g. the edited command was deleted, or a stale route after a
  // reload). Bounce back to the library so we never show an empty editor.
  const targetInvalid =
    target === null ||
    (target.mode === "edit" &&
      (target.commandId === null || command === null));
  useEffect(() => {
    if (targetInvalid) {
      setCommandEditorDirty(false);
      setCommandEditorTarget(null);
      setLibraryTab("commands");
      requestNavigation("library");
    }
  }, [
    targetInvalid,
    setCommandEditorDirty,
    setCommandEditorTarget,
    setLibraryTab,
    requestNavigation,
  ]);

  // Where to return when the form closes. A local create can only originate
  // from a workflow editor (the "New local command" palette action), and an
  // explicit `returnTo` is set when the editor is opened from a workflow
  // editor (e.g. editing a workflow-local command from the palette). Either
  // signal routes the user back to the workflow editor.
  const isLocalCreate =
    target?.mode === "create" &&
    target.initialScope === "local" &&
    target.initialWorkflowId != null;
  const returnTo = target?.returnTo;

  // Leaving via save or the form's Cancel button. A local create — or any
  // editor opened with `returnTo === "editor"` — returns to the workflow
  // editor it was launched from (the draft + `editorWorkflowId` survive the
  // round-trip, so the same workflow reopens and the command appears in its
  // palette); every other case returns to the Library's Commands tab.
  // `requestNavigation` applies the dirty guard (a save first resets the
  // dirty flag, so it navigates straight through).
  const handleClose = useCallback((): void => {
    if (returnTo !== undefined) {
      requestNavigation(returnTo);
      return;
    }
    if (isLocalCreate) {
      requestNavigation("editor");
      return;
    }
    setLibraryTab("commands");
    requestNavigation("library");
  }, [returnTo, isLocalCreate, setLibraryTab, requestNavigation]);

  if (targetInvalid || target === null) return null;

  // The form renders its own top bar (title + Run/Cancel/Save), so this
  // view no longer needs a `view-header`.
  return (
    <div className="command-editor-view">
      <CommandForm
        command={command}
        mode={target.mode}
        onClose={handleClose}
        onDirtyChange={setCommandEditorDirty}
        runTarget="global"
        categorySuggestions={allCategories}
        tagSuggestions={allTags}
        initialScript={target.mode === "create" ? target.initialScript : undefined}
        initialScope={
          target.mode === "create" ? target.initialScope : undefined
        }
        initialWorkflowId={
          target.mode === "create" ? target.initialWorkflowId : undefined
        }
      />

      <ConfirmDialog
        open={pendingNavigation !== null}
        title={t("commandEditor.unsavedTitle", {
          defaultValue: "Discard unsaved changes?",
        })}
        message={t("commandEditor.unsavedMessage", {
          defaultValue:
            "You have unsaved changes. Leaving this form will discard them.",
        })}
        confirmLabel={t("commandEditor.unsavedConfirm", {
          defaultValue: "Discard",
        })}
        danger
        onConfirm={confirmPendingNavigation}
        onCancel={cancelPendingNavigation}
      />
    </div>
  );
}
