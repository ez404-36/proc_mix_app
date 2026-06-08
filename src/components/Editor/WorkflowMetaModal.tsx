import { useEffect, useRef, useState } from "react";
import type {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CancelIcon, CheckIcon } from "../icons";

/**
 * Editable workflow metadata, distinct from the persisted `Workflow` (no id,
 * timestamps, nodes, or edges — those are owned by the canvas / store). The
 * canvas merges this back into the graph on save.
 */
export interface WorkflowMeta {
  name: string;
  description?: string;
  tags: string[];
  categoryId?: string;
  icon?: string;
}

interface WorkflowMetaModalProps {
  initial: WorkflowMeta;
  onSave: (meta: WorkflowMeta) => void;
  onClose: () => void;
}

/** Split a comma-separated tag string into a trimmed, de-duped list. */
function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim();
    if (tag !== "" && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/**
 * Modal collecting a workflow's name (required), description, and tags before
 * the first save. Mirrors `CommandForm`'s modal mechanics: Esc / backdrop
 * cancels, Cmd/Ctrl+Enter saves, focus lands on the name field. Save is
 * blocked until a non-empty name is entered.
 */
export function WorkflowMetaModal({
  initial,
  onSave,
  onClose,
}: WorkflowMetaModalProps): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [tags, setTags] = useState(initial.tags.join(", "));
  const [showError, setShowError] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const trimmedName = name.trim();
  const nameInvalid = trimmedName === "";

  const handleSave = (): void => {
    if (nameInvalid) {
      setShowError(true);
      return;
    }
    const trimmedDesc = description.trim();
    onSave({
      name: trimmedName,
      description: trimmedDesc === "" ? undefined : trimmedDesc,
      tags: parseTags(tags),
      categoryId: initial.categoryId,
      icon: initial.icon,
    });
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSave();
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
        className="command-form command-form--meta"
        role="dialog"
        aria-modal="true"
        aria-label={t("editor.meta.title")}
      >
        <h2 className="command-form__title">{t("editor.meta.title")}</h2>

        <div className="command-form__field">
          <label className="command-form__label" htmlFor="wf-meta-name">
            {t("editor.meta.name")}
          </label>
          <input
            ref={nameRef}
            id="wf-meta-name"
            className="input"
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setName(e.target.value)
            }
          />
          {showError && nameInvalid ? (
            <p className="command-form__error">{t("editor.meta.nameRequired")}</p>
          ) : null}
        </div>

        <div className="command-form__field">
          <label className="command-form__label" htmlFor="wf-meta-desc">
            {t("editor.meta.description")}
          </label>
          <input
            id="wf-meta-desc"
            className="input"
            value={description}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setDescription(e.target.value)
            }
          />
        </div>

        <div className="command-form__field">
          <label className="command-form__label" htmlFor="wf-meta-tags">
            {t("editor.meta.tags")}
          </label>
          <input
            id="wf-meta-tags"
            className="input"
            placeholder={t("editor.meta.tagsPlaceholder")}
            value={tags}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setTags(e.target.value)
            }
          />
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
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--run command-form__action"
            onClick={handleSave}
          >
            <CheckIcon />
            {t("common.apply")}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
