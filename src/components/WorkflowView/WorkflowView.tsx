import { useEffect, useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Workflow } from "../../types";
import { CancelIcon, EditIcon, RunIcon, TrashIcon } from "../icons";
import { WorkflowPreviewCanvas } from "./WorkflowPreviewCanvas";

interface WorkflowViewProps {
  /** The workflow to display, or `null` when the view is closed. */
  workflow: Workflow | null;
  onClose: () => void;
  onEdit: (workflow: Workflow) => void;
  onRun: (workflow: Workflow) => void;
  onDelete: (workflow: Workflow) => void;
}

/**
 * Read-only preview of a workflow, opened by double-clicking a Library card.
 * Mirrors the app's portal-modal mechanics (`ConfirmDialog` / `WorkflowMetaModal`):
 * `createPortal` to `document.body`, `.command-form__backdrop` that closes on
 * outside click, Esc closes, `aria-modal`, initial focus on the primary action.
 *
 * The body is the SAME reactflow canvas the editor renders (via
 * {@link WorkflowPreviewCanvas}) so a preview looks identical to editing — but
 * fully read-only: no dragging, no add/remove of nodes or edges, no palette or
 * toolbar. Editing starts only from the "Edit" button here: a casual
 * double-click inspects first, an explicit Edit dives into the editor.
 */
export function WorkflowView({
  workflow,
  onClose,
  onEdit,
  onRun,
  onDelete,
}: WorkflowViewProps): ReactElement | null {
  const { t } = useTranslation();
  const editRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (workflow !== null) {
      editRef.current?.focus();
    }
  }, [workflow]);

  if (workflow === null) return null;

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  const modal = (
    <div
      className="command-form__backdrop"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        className="command-form command-form--view"
        role="dialog"
        aria-modal="true"
        aria-label={workflow.name}
      >
        <div className="workflow-view__header">
          <h2 className="command-form__title">{workflow.name}</h2>
          <div className="list-tile__meta">
            <span className="shell-badge">
              {t("workflow.nodeCount", { count: workflow.nodes.length })}
            </span>
            {workflow.categoryId ? (
              <span className="tag-chip">{workflow.categoryId}</span>
            ) : null}
            {workflow.tags.map((tag) => (
              <span key={tag} className="tag-chip">
                {tag}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--icon btn--danger view-header-delete"
            aria-label={t("common.delete")}
            title={t("common.delete")}
            onClick={() => onDelete(workflow)}
          >
            <TrashIcon />
          </button>
        </div>

        {workflow.description ? (
          <p className="workflow-view__description">{workflow.description}</p>
        ) : null}

        <div className="workflow-view__canvas">
          <WorkflowPreviewCanvas workflow={workflow} />
        </div>

        <div className="command-form__actions">
          <button
            type="button"
            className="btn command-form__action command-form__action--cancel"
            onClick={onClose}
          >
            <span className="command-form__action-icon--cancel">
              <CancelIcon />
            </span>
            {t("common.close")}
          </button>
          <button
            type="button"
            className="btn command-form__action command-form__action--run"
            onClick={() => onRun(workflow)}
          >
            <span className="command-form__action-icon--run">
              <RunIcon />
            </span>
            {t("workflow.run")}
          </button>
          <button
            ref={editRef}
            type="button"
            className="btn btn--primary command-form__action"
            onClick={() => onEdit(workflow)}
          >
            <EditIcon />
            {t("workflow.edit")}
          </button>
        </div>


      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

