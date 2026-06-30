// Login screen (F3).
//
// The user enters the Bearer token; we store it (session-scoped) and validate it
// by hitting an authenticated endpoint. On success the auth store flips and the
// app renders the shell. On 401 we show "invalid token"; the server also rate-
// limits repeated failures (10/60s per IP) — surfaced as a distinct message.

import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import logoUrl from "@app/assets/logo.svg";
import { EyeIcon, EyeOffIcon } from "@app/components/icons";
import { ApiError, validateSession } from "../api/client";
import { useAuthStore } from "../stores/authStore";

export function Login(): React.JSX.Element {
  const { t } = useTranslation();
  const setToken = useAuthStore((s) => s.setToken);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Show/hide toggle for the token input. Defaults to hidden (masked dots);
  // the user can flip to plaintext to verify what they typed.
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      // Validate the candidate token FIRST (without committing it to the store).
      // Only on success do we set it — so a failed check never mounts the shell
      // or fires the entities/history requests.
      await validateSession(token);
      // Dismiss the soft keyboard while the input is still mounted (the simple
      // case). The Face-ID / "Save password" case shows the accessory bar after
      // this runs, so Shell's mount effect forces a viewport reflow to reclaim
      // any leftover strip — see Shell.tsx.
      inputRef.current?.blur();
      setToken(token);
      // The auth store now holds the token; the App re-renders into the shell.
    } catch (err) {
      if (err instanceof ApiError && err.code === "rateLimited") {
        setError(t("web.login.rateLimited", "Too many attempts. Wait a minute and try again."));
      } else if (err instanceof ApiError && err.code === "forbiddenHost") {
        setError(t("web.login.forbiddenHost", "This host is not allowed to access the server."));
      } else if (err instanceof ApiError && err.code === "network") {
        setError(t("web.login.network", "Cannot reach the server."));
      } else {
        setError(t("web.login.invalid", "Invalid token."));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="web-login">
      <form className="web-login__card" onSubmit={onSubmit}>
        <div className="web-login__brand">
          <img className="web-login__logo" src={logoUrl} alt="" aria-hidden="true" />
          <h1 className="view-title web-login__title">ProcMix</h1>
        </div>
        <p className="view-subtitle">
          {t("web.login.subtitle", "Enter your API token to continue")}
        </p>
        <div className="form-field">
          <label htmlFor="web-login-token">
            {t("web.login.tokenLabel", "API token")}
          </label>
          <div className="web-login__input-wrap">
            <input
              ref={inputRef}
              id="web-login-token"
              type={revealed ? "text" : "password"}
              autoComplete="off"
              className={`input web-login__input${error ? " input--error" : ""}`}
              aria-invalid={error ? true : undefined}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
            <button
              type="button"
              className="web-login__reveal"
              onClick={() => setRevealed((v) => !v)}
              onMouseDown={(e) => e.preventDefault()}
              aria-pressed={revealed}
              aria-label={
                revealed
                  ? t("web.login.hideToken", "Hide token")
                  : t("web.login.showToken", "Show token")
              }
              title={
                revealed
                  ? t("web.login.hideToken", "Hide token")
                  : t("web.login.showToken", "Show token")
              }
            >
              {revealed ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
          {error ? <p className="form-hint form-hint--error">{error}</p> : null}
        </div>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || value.trim().length === 0}
        >
          {busy
            ? t("web.login.signingIn", "Signing in…")
            : t("web.login.signIn", "Sign in")}
        </button>
      </form>
    </div>
  );
}
