import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Shared modal shell for the singleton runtime prompts (admin password, SSH
 * password, working dir, variables, remote host).
 *
 * Every prompt repeated the same scaffolding: a portal to `document.body`, a
 * `command-form__backdrop` whose bare-click cancels, a `command-form` dialog
 * box with `role="dialog"`/`aria-modal`, and a `command-form__header` with the
 * title. This component owns all of it; each prompt supplies only its own
 * `<form>` (body + footer) as `children`, plus a unique `dialogClassName`
 * modifier and a `titleId`/`title`.
 *
 * The backdrop-mousedown-cancels behaviour matches the CommandForm
 * convention — a click that lands on the backdrop itself (not inside the
 * dialog) calls `onCancel`.
 */
export interface PromptModalProps {
  /** Stable id linking the dialog to its `<h2>` via `aria-labelledby`. */
  titleId: string;
  /** Heading text shown in `command-form__header`. */
  title: ReactNode;
  /**
   * Extra dialog-box class modifiers appended after `command-form` (e.g.
   * `"variable-prompt working-dir-prompt"`). Keeps each prompt's existing
   * theme.css hooks intact.
   */
  dialogClassName: string;
  /** Optional extra header content rendered below the title (e.g. a subtitle). */
  headerExtra?: ReactNode;
  /** Called when the user clicks the backdrop outside the dialog box. */
  onBackdropCancel: () => void;
  /** The prompt's `<form>` (body + footer). */
  children: ReactNode;
}

export function PromptModal({
  titleId,
  title,
  dialogClassName,
  headerExtra,
  onBackdropCancel,
  children,
}: PromptModalProps): React.ReactElement {
  const handleBackdropMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    if (event.target === event.currentTarget) {
      onBackdropCancel();
    }
  };

  const dialog = (
    <div
      className="command-form__backdrop"
      role="presentation"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className={`command-form ${dialogClassName}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="command-form__header">
          <h2 id={titleId} className="command-form__title">
            {title}
          </h2>
          {headerExtra}
        </div>
        {children}
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
