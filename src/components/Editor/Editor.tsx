import type { ReactElement } from "react";
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
  const editorWorkflowId = useUIStore((s) => s.editorWorkflowId);

  // The header (dynamic title + the form-level actions Properties / Save /
  // Delete) is rendered by WorkflowCanvas, which owns the draft state those
  // actions operate on. This view is just the column shell.
  return (
    <div className="editor-view">
      <WorkflowCanvas workflowId={editorWorkflowId} />
    </div>
  );
}
