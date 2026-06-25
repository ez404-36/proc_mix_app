import { useCallback, useEffect, useState } from "react";

interface UseEditorFullscreen {
  /** Whether the editor (palette + canvas) is expanded to fill the app window. */
  fullscreen: boolean;
  /** Toggle the fullscreen state. */
  toggleFullscreen: () => void;
}

/**
 * Editor fullscreen toggle. Owns the `fullscreen` flag and the body-class
 * side effect that lifts the docked OutputPanel above the fullscreen editor
 * layer (CSS-only; see `is-editor-fullscreen`), so a run's output stays
 * visible without leaving fullscreen. The class is cleared on unmount so
 * leaving the editor view never strands it. Extracted verbatim from
 * `WorkflowCanvas`.
 */
export function useEditorFullscreen(): UseEditorFullscreen {
  const [fullscreen, setFullscreen] = useState(false);

  // While the editor is fullscreen it covers the docked OutputPanel (the
  // fullscreen layer sits above it). Toggle a body class so the console is
  // lifted ABOVE the fullscreen editor (CSS-only; see `is-editor-fullscreen`),
  // letting the user watch a run's output without leaving fullscreen. Cleared
  // on unmount so leaving the editor view never strands the class.
  useEffect(() => {
    const cls = "is-editor-fullscreen";
    document.body.classList.toggle(cls, fullscreen);
    return () => document.body.classList.remove(cls);
  }, [fullscreen]);

  const toggleFullscreen = useCallback((): void => {
    setFullscreen((v) => !v);
  }, []);

  return { fullscreen, toggleFullscreen };
}
