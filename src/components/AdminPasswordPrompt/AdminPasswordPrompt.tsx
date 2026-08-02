import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { EyeIcon, EyeOffIcon } from "../icons";
import { PromptModal } from "../PromptModal/PromptModal";
import {
  registerAdminPasswordPromptHandler,
  type AdminPasswordPromptResult,
} from "../../utils/adminPasswordPrompt";
import {
  usePromptAutoFocus,
  usePromptResolver,
} from "../../hooks/usePromptResolver";

/**
 * Singleton modal that prompts the user for their sudo password.
 *
 * Lives at the App root so the runtime helper `promptForAdminPassword()`
 * (which is called from non-React code paths like `triggerCommandRun`)
 * can open it via a registered handler. The component itself owns no
 * trigger UI — it is purely reactive.
 *
 * Lifecycle (register/resolver/focus) is owned by `usePromptResolver` and
 * the portal/backdrop by `<PromptModal>`. The component supplies only its
 * password field and the two confirm buttons.
 */
export function AdminPasswordPrompt(): React.ReactElement | null {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [password, setPassword] = useState("");
  // Show/hide toggle for the password input. Default to hidden — the
  // user can flip to plaintext while typing if they want to verify
  // what they're entering. Reset to false on every fresh prompt so
  // the next session doesn't inherit "revealed" state from before.
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { close } = usePromptResolver<[], AdminPasswordPromptResult>({
    register: registerAdminPasswordPromptHandler,
    onOpen: () => {
      setPassword("");
      setRevealed(false);
      setVisible(true);
    },
    onClose: () => {
      setPassword("");
      setRevealed(false);
      setVisible(false);
    },
  });

  usePromptAutoFocus(visible, inputRef);

  const handleCancel = useCallback((): void => {
    close(null);
  }, [close]);

  // "Save & continue" — persist the password to the OS keychain and
  // proceed with the elevated run. This is the historical default
  // behaviour and stays bound to the form's submit event so Enter in
  // the input still triggers it.
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const trimmed = password.trim();
      if (trimmed.length === 0) return;
      close({ password: trimmed, remember: true });
    },
    [close, password],
  );

  // "Continue" — use the password for this run only. The caller MUST
  // skip persistence and forward the value one-shot to the executor.
  // Implemented as a separate handler (not a second submit button)
  // so Enter doesn't accidentally pick the no-save path.
  const handleContinue = useCallback((): void => {
    const trimmed = password.trim();
    if (trimmed.length === 0) return;
    close({ password: trimmed, remember: false });
  }, [close, password]);

  if (!visible) return null;

  const titleId = "admin-password-prompt-title";
  const trimmedEmpty = password.trim().length === 0;

  return (
    <PromptModal
      titleId={titleId}
      dialogClassName="admin-password-prompt"
      onBackdropCancel={handleCancel}
      title={t("adminPassword.title", {
        defaultValue: "Administrator password",
      })}
      headerExtra={
        <p
          className="admin-password-prompt__subtitle"
          // No localised key yet — falls back to English copy. S14
          // adds the proper i18n entry.
        >
          {t("adminPassword.subtitle", {
            defaultValue: "Stored securely in your OS keychain",
          })}
        </p>
      }
    >
      <form onSubmit={handleSubmit}>
        <div className="command-form__body">
          <label className="command-form__field">
            <span className="command-form__label">
              {t("adminPassword.label", {
                defaultValue: "Sudo password",
              })}
            </span>
            {/*
              * Input + reveal button live inside a positioned wrapper so
              * the button can overlap the input's right edge. `className="input"`
              * is required — without it, dark theme renders unstyled text
              * black-on-black.
              */}
            <div className="admin-password-prompt__input-wrap">
              <input
                ref={inputRef}
                className="input admin-password-prompt__input"
                type={revealed ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setPassword(e.target.value)
                }
              />
              <button
                type="button"
                className="admin-password-prompt__reveal"
                onClick={() => setRevealed((v) => !v)}
                // Keep keyboard focus in the input after the click —
                // otherwise pressing the toggle steals focus and the
                // user has to click back to keep typing.
                onMouseDown={(e) => e.preventDefault()}
                aria-pressed={revealed}
                aria-label={
                  revealed
                    ? t("adminPassword.hide", {
                        defaultValue: "Hide password",
                      })
                    : t("adminPassword.show", {
                        defaultValue: "Show password",
                      })
                }
                title={
                  revealed
                    ? t("adminPassword.hide", {
                        defaultValue: "Hide password",
                      })
                    : t("adminPassword.show", {
                        defaultValue: "Show password",
                      })
                }
              >
                {revealed ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </label>
        </div>
        <div className="command-form__footer">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={handleCancel}
          >
            {t("adminPassword.cancel", { defaultValue: "Cancel" })}
          </button>
          {/*
            * "Continue" uses the password for this single elevated run
            * without writing it to the OS keychain. Explicit
            * `type="button"` so it cannot be triggered by pressing
            * Enter inside the input — Enter remains bound to the
            * "Save & continue" submit, which is the historical
            * default. We render this button BEFORE the primary one so
            * the keyboard tab order leads from Cancel → Continue →
            * Save & continue, matching the "least-persistent" reading
            * order.
            */}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={handleContinue}
            disabled={trimmedEmpty}
            title={t("adminPassword.continueHint", {
              defaultValue:
                "Use the password for this run only — do not save it",
            })}
          >
            {t("adminPassword.continue", { defaultValue: "Continue" })}
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={trimmedEmpty}
          >
            {t("adminPassword.submit", {
              defaultValue: "Save & continue",
            })}
          </button>
        </div>
      </form>
    </PromptModal>
  );
}
