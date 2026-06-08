import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";
import { WorkflowCanvas } from "./WorkflowCanvas";

/**
 * Editor screen. Hosts the visual workflow canvas, honouring the navigation
 * contract from Phase 4: `editorWorkflowId` is the workflow to edit (`null`
 * means create-new).
 *
 * The canvas is intentionally NOT keyed by `editorWorkflowId`: the working
 * draft lives in `useEditorDraftStore`, which survives this component
 * unmounting when the user navigates to another menu item and back. The
 * canvas's hydration effect distinguishes a genuine target switch (re-hydrate)
 * from a same-target remount (preserve the in-progress draft), so a `key`
 * remount would defeat the state-preservation requirement.
 */
export function Editor(): ReactElement {
  const { t } = useTranslation();
  const editorWorkflowId = useUIStore((s) => s.editorWorkflowId);

  return (
    <div className="editor-view">
      <header className="view-header">
        <div>
          <h1 className="view-title">{t("editor.title")}</h1>
          <p className="view-subtitle">{t("editor.subtitle")}</p>
        </div>
      </header>

      <WorkflowCanvas workflowId={editorWorkflowId} />
    </div>
  );
}
