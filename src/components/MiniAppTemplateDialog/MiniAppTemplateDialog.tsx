import { useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { NewMiniAppInput } from "../../stores/miniappStore";

interface MiniAppTemplateDialogProps {
  open: boolean;
  /** Built-in templates for the current host platform, in display order. */
  templates: ReadonlyArray<NewMiniAppInput>;
  onSelect: (template: NewMiniAppInput) => void;
  onCancel: () => void;
}

/**
 * "From template" picker for the Mini-Apps tab. Lists every built-in
 * template (`buildMiniAppSeedsForPlatform`) as a clickable name + description
 * row — clicking one adds it via the normal `addMiniApp` path and closes the
 * dialog.
 *
 * Mirrors `ConfirmDialog`'s portal/backdrop/keyboard mechanics
 * (`.command-form__backdrop`, Esc-free — backdrop click cancels, initial
 * focus on Cancel) but replaces the message + confirm/cancel footer with a
 * clickable list, styled after `CommandPalette`'s `palette__item` rows.
 */
export function MiniAppTemplateDialog({
  open,
  templates,
  onSelect,
  onCancel,
}: MiniAppTemplateDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onCancel();
  };

  const modal = (
    <div className="command-form__backdrop" onClick={handleBackdropClick}>
      <div
        className="command-form command-form--confirm"
        role="dialog"
        aria-modal="true"
        aria-label={t("miniapps.templateDialogTitle")}
      >
        <h2 className="command-form__title">
          {t("miniapps.templateDialogTitle")}
        </h2>

        <div className="miniapp-template-dialog__list" role="listbox">
          {templates.map((template, index) => {
            const name = template.nameKey ? t(template.nameKey) : template.name;
            const description = template.descriptionKey
              ? t(template.descriptionKey)
              : template.description;
            return (
              <div
                key={`${template.nameKey ?? template.name}-${index}`}
                role="option"
                aria-selected={false}
                className="miniapp-template-dialog__item"
                onClick={() => onSelect(template)}
              >
                <div className="miniapp-template-dialog__item-title">
                  {name}
                </div>
                {description ? (
                  <div className="miniapp-template-dialog__item-desc">
                    {description}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="command-form__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn--ghost"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
