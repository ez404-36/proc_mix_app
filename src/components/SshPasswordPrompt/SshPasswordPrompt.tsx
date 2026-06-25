import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { registerSshPasswordPromptHandler } from "../../utils/sshPasswordPrompt";
import {
  usePromptAutoFocus,
  usePromptResolver,
} from "../../hooks/usePromptResolver";
import { PromptModal } from "../PromptModal/PromptModal";
import { CancelIcon, RunIcon } from "../icons";

/**
 * Singleton modal that asks for a one-shot SSH password before a remote run
 * whose host uses password auth (`Command.promptSshPassword`).
 *
 * Mounted once at the App root. Opened imperatively via `promptForSshPassword`
 * from `commandRunner.ts`, which lives outside the React tree. The password is
 * strictly one-shot: it is handed to the run and never persisted (the modal has
 * no "remember" option, unlike the admin-password prompt). See
 * `docs/plans/ssh-remote-password-transient-keychain.md`.
 *
 * Lifecycle (register/resolver/focus) is owned by `usePromptResolver`; the
 * portal/backdrop by `<PromptModal>`.
 */
export function SshPasswordPrompt(): React.ReactElement | null {
  const { t } = useTranslation();

  const [open, setOpen] = useState(false);
  // The host the password is for, shown in the prompt so the user knows which
  // connection they're authenticating to.
  const [alias, setAlias] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { close } = usePromptResolver<[alias: string], string>({
    register: registerSshPasswordPromptHandler,
    onOpen: (forAlias) => {
      setAlias(forAlias);
      setPassword("");
      setRevealed(false);
      setOpen(true);
    },
    onClose: () => {
      setOpen(false);
      // Clear the secret from component state on close so it never lingers in
      // the React tree after the run is handed off.
      setPassword("");
      setRevealed(false);
    },
  });

  usePromptAutoFocus(open, inputRef);

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

  if (!open) return null;

  const titleId = "ssh-password-prompt-title";

  return (
    <PromptModal
      titleId={titleId}
      dialogClassName="variable-prompt ssh-password-prompt"
      onBackdropCancel={handleCancel}
      title={t("sshPasswordPrompt.title", {
        defaultValue: "SSH password for {{alias}}",
        alias,
      })}
    >
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
    </PromptModal>
  );
}
