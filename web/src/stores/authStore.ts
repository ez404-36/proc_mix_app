// Auth store — holds the Bearer token for the current browser session (F3).
//
// The token is entered on the login screen and kept in `sessionStorage` (per
// decision: token-in-browser, sent per request). It is attached as
// `Authorization: Bearer <token>` to every `/api/*` call by the http client.
// sessionStorage scopes it to the tab and clears on close — it is never sent to
// any third party (the SPA is self-contained).

import { create } from "zustand";

const STORAGE_KEY = "procmix-web-token";

function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

interface AuthState {
  /** The current Bearer token, or null when logged out. */
  token: string | null;
  /** Store the token (session-scoped) and mark the session authenticated. */
  setToken: (token: string) => void;
  /** Clear the token (logout / 401). */
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: readStoredToken(),
  setToken: (token) => {
    try {
      sessionStorage.setItem(STORAGE_KEY, token);
    } catch {
      /* sessionStorage unavailable — keep in memory only */
    }
    set({ token });
  },
  clear: () => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    set({ token: null });
  },
}));

/** Read the current token outside React (used by the http client). */
export function currentToken(): string | null {
  return useAuthStore.getState().token;
}
