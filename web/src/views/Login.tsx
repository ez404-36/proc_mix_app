// Login screen (F3).
//
// The user enters the Bearer token; we store it (session-scoped) and validate it
// by hitting an authenticated endpoint. On success the auth store flips and the
// app renders the shell. On 401 we show "invalid token"; the server also rate-
// limits repeated failures (10/60s per IP) — surfaced as a distinct message.

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, validateSession } from "../api/client";
import { useAuthStore } from "../stores/authStore";

export function Login(): React.JSX.Element {
  const { t } = useTranslation();
  const setToken = useAuthStore((s) => s.setToken);
  const clear = useAuthStore((s) => s.clear);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    // Stage the token so the client attaches it, then validate.
    setToken(token);
    try {
      await validateSession();
      // Success — the auth store already holds the token; the App re-renders.
    } catch (err) {
      clear();
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
    <div className="app-shell app-shell--login">
      <form className="command-form command-form--login" onSubmit={onSubmit}>
        <h1 className="view-title">ProcMix</h1>
        <p className="view-subtitle">
          {t("web.login.subtitle", "Enter your API token to continue")}
        </p>
        <div className="form-field">
          <label htmlFor="web-login-token">
            {t("web.login.tokenLabel", "API token")}
          </label>
          <input
            id="web-login-token"
            type="password"
            autoComplete="off"
            className={error ? "input--error" : undefined}
            aria-invalid={error ? true : undefined}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
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
