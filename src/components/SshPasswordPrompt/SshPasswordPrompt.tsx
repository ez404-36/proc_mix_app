import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { registerSshPasswordPromptHandler } from "../../utils/sshPasswordPrompt";
import { CancelIcon, RunIcon } from "../icons";

/**
 * Singleton modal that asks for a one-shot SSH password before a remote run
 * whose host uses password auth (`Command.promptSshPassword`).
 *
 * Mounted once at the App root. Opened imperatively via `promptForSshPassword`
 * from `commandRunner.ts`, which lives outside the React tree — same
 * handler-registration pattern as `RemoteHostPrompt`. The password is strictly
 * one-shot: it is handed to the run and never persisted (the modal has no
 * "remember" option, unlike the admin-password prompt). See
 * `docs/plans/ssh-remote-password-transient-keychain.md`.
 */
export function SshPasswordPrompt(): React.ReactElement | null {
  const { t } = useTranslation();

  const [open, setOpen] = useState(false);
  // The host the password is for, shown in the prompt so the user knows which
  // connection they're authenticating to.
  const [alias, setAlias] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const resolverRef = useRef<((result: string | null) => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback((result: string | null): void => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpen(false);
    // Clear the secret from component state on close so it never lingers in
    // the React tree after the run is handed off.
    setPassword("");
    setRevealed(false);
    resolve?.(result);
  }, []);

  useEffect(() => {
    registerSshPasswordPromptHandler((forAlias: string) => {
      return new Promise<string | null>((resolve) => {
        // If a previous prompt is somehow still open, cancel it first so the
        // new request owns the single resolver.
        if (resolverRef.current) {
          resolverRef.current(null);
        }
        resolverRef.current = resolve;
        setAlias(forAlias);
        setPassword("");
        setRevealed(false);
        setOpen(true);
      });
    });
    return () => {
      registerSshPasswordPromptHandler(null);
      if (resolverRef.current) {
        resolverRef.current(null);
        resolverRef.current = null;
      }
    };
  }, []);

  // Auto-focus the password input each time the modal opens. The input only
  // exists while `open` is true, so schedule on the next frame.
  useEffect(() => {
    if (open) {
      const id = window.requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(id);
    }
    return undefined;
  }, [open]);

  const handleCancel = useCallback((): void => {
    close(null);
  }, [close]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (password === "") return;
      close(password);
    },
    [close, password],
  );

  const handleBackdropMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    if (event.target === event.currentTarget) {
      handleCancel();
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      handleCancel();
    }
  };

  if (!open) return null;

  const titleId = "ssh-password-prompt-title";

  const dialog = (
    <div
      className="command-form__backdrop"
      role="presentation"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="command-form variable-prompt ssh-password-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <div className="command-form__header">
          <h2 id={titleId} className="command-form__title">
            {t("sshPasswordPrompt.title", {
              defaultValue: "SSH password for {{alias}}",
              alias,
            })}
          </h2>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="command-form__body">
            <div className="command-form__field">
              <span className="command-form__label">
                {t("sshPasswordPrompt.label", { defaultValue: "Password" })}
              </span>
              <div className="ssh-password-prompt__input-wrap">
                <input
                  ref={inputRef}
                  className="input ssh-password-prompt__input"
                  type={revealed ? "text" : "password"}
                  autoComplete="current-password"
                  aria-label={t("sshPasswordPrompt.label", {
                    defaultValue: "Password",
                  })}
                  value={password}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setPassword(e.target.value)
                  }
                />
                <button
                  type="button"
                  className="ssh-password-prompt__reveal"
                  // Don't steal focus from the input on click.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setRevealed((v) => !v)}
                  aria-pressed={revealed}
                  aria-label={
                    revealed
                      ? t("sshPasswordPrompt.hide", { defaultValue: "Hide" })
                      : t("sshPasswordPrompt.reveal", { defaultValue: "Show" })
                  }
                >
                  {revealed
                    ? t("sshPasswordPrompt.hide", { defaultValue: "Hide" })
                    : t("sshPasswordPrompt.reveal", { defaultValue: "Show" })}
                </button>
              </div>
              <span className="command-form__hint" role="note">
                {t("sshPasswordPrompt.hint", {
                  defaultValue:
                    "Used for this run only and never saved. Consider SSH keys for repeated runs.",
                })}
              </span>
            </div>
          </div>
          <div className="command-form__footer">
            <button
              type="button"
              className="btn btn--cancel"
              onClick={handleCancel}
            >
              <span className="btn--cancel-icon">
                <CancelIcon />
              </span>
              {t("sshPasswordPrompt.cancel", { defaultValue: "Cancel" })}
            </button>
            <button type="submit" className="btn btn--run" disabled={password === ""}>
              <RunIcon />
              {t("sshPasswordPrompt.submit", { defaultValue: "Run" })}
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
