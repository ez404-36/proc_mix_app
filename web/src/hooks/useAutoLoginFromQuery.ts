// Auto-login from a `?token=` query parameter (QR quick-connect, F4).
//
// Scanning the QR-with-token variant (see the desktop HTTP API panel) opens
// `.../?token=<candidate>`. On mount — once, after bootstrap — this hook:
//   1. Reads `token` from `window.location.search`, if present.
//   2. Validates it via `validateSession` (the same path `Login` uses) WITHOUT
//      committing it to the auth store first.
//   3. On success, commits it via `useAuthStore.setToken`.
//   4. Either way (success or failure), strips `token` from the address bar
//      immediately via `history.replaceState` — it must not linger in the URL
//      for even a moment longer than needed, and a failed candidate falls
//      through to the normal `Login` screen with no raw token ever surfaced
//      in an error message.
//
// Runs only when the store holds no token yet, so an already-authenticated
// session (a real login, or a token already in sessionStorage) is untouched.

import { useEffect } from "react";
import { validateSession } from "../api/client";
import { useAuthStore } from "../stores/authStore";

/** Strip `token` from the current URL without adding a history entry. */
function stripTokenFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("token");
  window.history.replaceState(null, "", url.toString());
}

/**
 * @param enabled Gate for when the check should run — the caller passes
 *   `false` until bootstrap completes, so this fires only once, after
 *   `fetchBootstrap()` (mirrors the plan's sequencing).
 */
export function useAutoLoginFromQuery(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (useAuthStore.getState().token !== null) return;

    const params = new URLSearchParams(window.location.search);
    const candidate = params.get("token");
    if (candidate === null || candidate === "") return;

    let cancelled = false;
    void validateSession(candidate)
      .then(() => {
        if (!cancelled) useAuthStore.getState().setToken(candidate);
      })
      .catch(() => {
        /* invalid/rate-limited/network — fall through to the login screen */
      })
      .finally(() => {
        stripTokenFromUrl();
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);
}
