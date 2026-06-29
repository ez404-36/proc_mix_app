// Theme controller (F10) — mirrors the desktop app's useTheme.
//
// Resolves `light | dark | system` against `prefers-color-scheme` (with a live
// `matchMedia` listener) and applies `data-theme` to <html> so the shared
// `theme.css` tokens resolve. The web UI is hand-rolled (no Arco), so the
// `arco-theme` body attribute is intentionally NOT set.

import { useEffect, useState } from "react";
import { useUIStore, type ResolvedTheme, type Theme } from "../stores/uiStore";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia(DARK_MEDIA_QUERY).matches ? "dark" : "light";
}

function resolveTheme(theme: Theme, systemTheme: ResolvedTheme): ResolvedTheme {
  return theme === "system" ? systemTheme : theme;
}

interface UseThemeResult {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (t: Theme) => void;
}

export function useTheme(): UseThemeResult {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    getSystemTheme(),
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia(DARK_MEDIA_QUERY);
    const handler = (e: MediaQueryListEvent): void => {
      setSystemTheme(e.matches ? "dark" : "light");
    };
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  const resolvedTheme = resolveTheme(theme, systemTheme);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }, [resolvedTheme]);

  return { theme, resolvedTheme, setTheme };
}
