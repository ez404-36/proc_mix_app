import { useCallback, useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";
import { useCommandStore } from "../../stores/commandStore";
import { collectCategories } from "../../utils/commandFilters";
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

  // Leaving via save or the form's Cancel button. Returns to the Library's
  // Commands tab; `requestNavigation` applies the dirty guard (a save first
  // resets the dirty flag, so it navigates straight through).
  const handleClose = useCallback((): void => {
    setLibraryTab("commands");
    requestNavigation("library");
  }, [setLibraryTab, requestNavigation]);

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
        initialScript={target.mode === "create" ? target.initialScript : undefined}
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
