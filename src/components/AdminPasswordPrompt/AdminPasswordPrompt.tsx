import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { EyeIcon, EyeOffIcon } from "../icons";
import {
  registerAdminPasswordPromptHandler,
  type AdminPasswordPromptResult,
} from "../../utils/adminPasswordPrompt";

/**
 * Singleton modal that prompts the user for their sudo password.
 *
 * Lives at the App root so the runtime helper `promptForAdminPassword()`
 * (which is called from non-React code paths like `triggerCommandRun`)
 * can open it via a registered handler. The component itself owns no
 * trigger UI — it is purely reactive.
 *
 * Lifecycle:
 *   1. Mount → registers a handler that returns a Promise. Any later
 *      call to `promptForAdminPassword()` resolves to that Promise.
 *   2. Handler invocation → flips `visible=true`, stores a resolver
 *      function in a ref, focuses the password input.
 *   3. User submits or cancels → resolver is called with the value or
 *      `null`, modal hides, password state is cleared.
 *   4. Unmount → handler is deregistered.
 *
 * The component is intentionally NOT rendered into the React tree of
 * any specific feature — it's app-global. Multiple instances would
 * fight over the registered slot; the singleton check in
 * `adminPasswordPrompt.ts` keeps the contract.
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
  // Resolver kept in a ref so the handler we register at mount can read
  // a stable function reference even after re-renders. `null` between
  // prompts; non-null only while the modal is open.
  const resolverRef = useRef<
    ((value: AdminPasswordPromptResult | null) => void) | null
  >(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(
    (result: AdminPasswordPromptResult | null): void => {
      const resolve = resolverRef.current;
      resolverRef.current = null;
      setPassword("");
      setRevealed(false);
      setVisible(false);
      // Resolve AFTER the local state has been cleared so a sentinel
      // retry that fires in the same tick (theoretical) sees a fresh
      // empty modal, not a stale one.
      resolve?.(result);
    },
    [],
  );

  // Register the imperative handler exactly once. Re-registering on
  // every render would clobber an in-flight prompt; the empty dep array
  // pins us to mount/unmount.
  useEffect(() => {
    registerAdminPasswordPromptHandler(
      () =>
        new Promise<AdminPasswordPromptResult | null>((resolve) => {
          // If a previous resolver is somehow still around (modal
          // didn't get to close), force-cancel it first so we never
          // strand a Promise. In practice this means a brand-new
          // prompt invoked while another is open inherits the new
          // outcome — but that flow shouldn't happen because the
          // outer sentinel-retry waits on its first promise.
          if (resolverRef.current) {
            resolverRef.current(null);
          }
          resolverRef.current = resolve;
          setPassword("");
          setRevealed(false);
          setVisible(true);
        }),
    );
    return () => {
      registerAdminPasswordPromptHandler(null);
      // If we're being unmounted while a prompt is open (e.g. hot
      // reload), resolve the outstanding Promise to null so callers
      // don't hang forever.
      if (resolverRef.current) {
        resolverRef.current(null);
        resolverRef.current = null;
      }
    };
  }, []);

  // Auto-focus the input each time the modal becomes visible. The
  // input element only exists in the DOM while `visible` is true, so
  // we rerun the effect on every transition.
  useEffect(() => {
    if (visible) {
      // Schedule on the next frame so the input is mounted by the
      // time we try to focus it.
      const id = window.requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(id);
    }
    return undefined;
  }, [visible]);

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

  const handleBackdropMouseDown = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    // Click outside the dialog itself counts as cancel — matches the
    // CommandForm convention.
    if (event.target === event.currentTarget) {
      handleCancel();
    }
  };

  if (!visible) return null;

  const titleId = "admin-password-prompt-title";
  const trimmedEmpty = password.trim().length === 0;

  const dialog = (
    <div
      className="command-form__backdrop"
      role="presentation"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        ref={containerRef}
        className="command-form admin-password-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="command-form__header">
          <h2 id={titleId} className="command-form__title">
            {t("adminPassword.title", {
              defaultValue: "Administrator password",
            })}
          </h2>
          <p
            className="admin-password-prompt__subtitle"
            // No localised key yet — falls back to English copy. S14
            // adds the proper i18n entry.
          >
            {t("adminPassword.subtitle", {
              defaultValue: "Stored securely in your OS keychain",
            })}
          </p>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="command-form__body">
            <label className="command-form__field">
              <span className="command-form__label">
                {t("adminPassword.label", {
                  defaultValue: "Sudo password",
                })}
              </span>
              {/*
                * Input + reveal button live inside a positioned wrapper
                * so the button can overlap the input's right edge
                * without using flex (which would shrink the input on
                * autofill or browser-native quirks). The input itself
                * carries `className="input"` — without it the field
                * gets unstyled browser defaults that on dark theme
                * render as black-on-black, making typed bullets
                * invisible. That was the root cause of the original
                * "input looks empty" report — adding the `input` class
                * also restores the focus ring and theme colours.
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
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
