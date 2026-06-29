// Web UI store — theme preference only.
//
// The web UI keeps its OWN persisted preference (localStorage key
// `procmix-web-ui`), independent from the desktop app. Persisted shape matches
// the no-FOUC inline script in index.html (`{ state: { theme } }`), so the
// pre-paint pass and the React store agree.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface UIState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      theme: "system",
      setTheme: (theme) => set({ theme }),
    }),
    { name: "procmix-web-ui" },
  ),
);
