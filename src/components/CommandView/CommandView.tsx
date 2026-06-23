import { useEffect, useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Command, VariableSpec } from "../../types";
import {
  getCommandDescription,
  getCommandName,
} from "../../utils/commandLabels";
import { CancelIcon, EditIcon, RunIcon, TrashIcon } from "../icons";
import { formatTargetBadge, isRemoteTarget } from "../../utils/targetLabel";

interface CommandViewProps {
  /** The command to display, or `null` when the view is closed. */
  command: Command | null;
  onClose: () => void;
  onEdit: (command: Command) => void;
  onRun: (command: Command) => void;
  onDelete: (command: Command) => void;
  /**
   * When provided AND the command is workflow-`"local"`, renders a "Make
   * global" action that hands the command to this callback (the caller is
   * responsible for any confirmation + the promote itself). Omitted in the
   * Library, where every viewed command is already global.
   */
  onPromote?: (command: Command) => void;
}

/**
 * Read-only preview of a command, opened by double-clicking a command tile.
 * Mirrors the workflow {@link WorkflowView} modal's mechanics
 * (`ConfirmDialog` / `WorkflowMetaModal` family): `createPortal` to
 * `document.body`, a `.command-form__backdrop` that closes on outside click,
 * Esc closes, `aria-modal`, and initial focus on the primary action.
 *
 * It surfaces the four fields a quick inspection needs — name, timeout,
 * script, and variables — fully read-only. Editing starts only from the
 * "Edit" button here: a casual double-click inspects first, an explicit Edit
 * dives into the editor.
 *
 * Sensitive variables are flagged with a badge; their default values are NOT
 * rendered so a secret default can't leak into the preview.
 */
export function CommandView({
  command,
  onClose,
  onEdit,
  onRun,
  onDelete,
  onPromote,
}: CommandViewProps): ReactElement | null {
  const { t } = useTranslation();
  const editRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (command !== null) {
      editRef.current?.focus();
    }
  }, [command]);

  if (command === null) return null;

  const displayName = getCommandName(command, t);
  const displayDesc = getCommandDescription(command, t);
  const variables = command.variables ?? [];

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
        className="command-form command-form--view command-view"
        role="dialog"
        aria-modal="true"
        aria-label={displayName}
      >
        <div className="workflow-view__header">
          <h2 className="command-form__title">{displayName}</h2>
          <div className="list-tile__meta">
            {isRemoteTarget(command.target) ? (
              <span className="target-badge">
                {formatTargetBadge(command.target, t)}
              </span>
            ) : null}
            {command.shell ? (
              <span className="shell-badge">{command.shell}</span>
            ) : null}
            {command.categoryId !== undefined &&
            command.categoryId.trim() !== "" ? (
              <span className="category-chip">{command.categoryId}</span>
            ) : null}
            {command.tags.map((tag) => (
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
            onClick={() => onDelete(command)}
          >
            <TrashIcon />
          </button>
        </div>

        {displayDesc ? (
          <p className="workflow-view__description">{displayDesc}</p>
        ) : null}

        <div className="command-view__body">
          <section className="command-view__field">
            <h3 className="command-view__label">
              {t("commandForm.fields.timeoutSeconds")}
            </h3>
            <p className="command-view__value">
              {command.timeoutSeconds !== undefined
                ? t("commandView.timeoutValue", {
                    count: command.timeoutSeconds,
                  })
                : t("commandView.noTimeout")}
            </p>
          </section>

          <section className="command-view__field">
            <h3 className="command-view__label">
              {t("commandForm.target.label", { defaultValue: "Where to run" })}
            </h3>
            <p className="command-view__value">
              {isRemoteTarget(command.target)
                ? formatTargetBadge(command.target, t)
                : t("commandForm.target.local", { defaultValue: "Local" })}
            </p>
          </section>

          <section className="command-view__field">
            <h3 className="command-view__label">
              {t("commandForm.fields.script")}
            </h3>
            <pre className="command-view__script">{command.script}</pre>
          </section>

          <section className="command-view__field">
            <h3 className="command-view__label">
              {t("commandForm.variables.title")}
            </h3>
            {variables.length === 0 ? (
              <p className="command-view__value command-view__value--muted">
                {t("commandView.noVariables")}
              </p>
            ) : (
              <ul className="command-view__var-list">
                {variables.map((spec) => (
                  <CommandViewVariable key={spec.name} spec={spec} />
                ))}
              </ul>
            )}
          </section>
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
          {onPromote !== undefined && command.scope === "local" ? (
            <button
              type="button"
              className="btn btn--ghost command-form__action"
              onClick={() => onPromote(command)}
              title={t("editor.makeGlobalHint")}
            >
              {t("editor.makeGlobal")}
            </button>
          ) : null}
          <button
            type="button"
            className="btn command-form__action command-form__action--run"
            onClick={() => onRun(command)}
          >
            <span className="command-form__action-icon--run">
              <RunIcon />
            </span>
            {t("common.run")}
          </button>
          <button
            ref={editRef}
            type="button"
            className="btn btn--primary command-form__action"
            onClick={() => onEdit(command)}
          >
            <EditIcon />
            {t("common.edit")}
          </button>
        </div>


      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

/**
 * One row in the read-only variables list. Shows the name, an optional
 * "sensitive" badge, the default value (or a "prompt at runtime" hint when no
 * default is set), and the description. A sensitive variable's default value
 * is intentionally hidden so a secret can't leak into the preview.
 */
function CommandViewVariable({ spec }: { spec: VariableSpec }): ReactElement {
  const { t } = useTranslation();
  return (
    <li className="command-view__var">
      <div className="command-view__var-head">
        <code className="command-view__var-name">{spec.name}</code>
        {spec.sensitive ? (
          <span className="shell-badge command-view__var-sensitive">
            {t("commandForm.variables.sensitive")}
          </span>
        ) : null}
      </div>
      <p className="command-view__var-default">
        {spec.sensitive
          ? t("commandView.sensitiveValue")
          : spec.defaultValue !== undefined
            ? t("commandView.defaultValue", { value: spec.defaultValue })
            : t("commandForm.variables.promptAtRuntime")}
      </p>
      {spec.description ? (
        <p className="command-view__var-desc">{spec.description}</p>
      ) : null}
    </li>
  );
}
