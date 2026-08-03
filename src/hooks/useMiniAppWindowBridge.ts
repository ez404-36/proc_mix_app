import { useEffect } from "react";
import { subscribeMiniAppWindowEvents } from "../services/miniappWindow";
import { useMiniAppWindowStore } from "../stores/miniappWindowStore";

/**
 * Subscribes the main window to `miniapp-window-event` and mirrors it into
 * `miniappWindowStore`, so the Library's Mini-Apps tab can render a
 * "running" tile state for any mini-app with an open standalone window.
 * Mounted once, alongside the other bridges (`useExecutionBridge` etc.) in
 * `App.tsx` — never in a mini-app's OWN window (`MiniAppWindowApp`), which
 * has no Library tile to update and does not import this hook.
 */
export function useMiniAppWindowBridge(): void {
  useEffect(() => {
    const unsubscribe = subscribeMiniAppWindowEvents((event) => {
      if (event.kind === "opened") {
        useMiniAppWindowStore.getState().markOpened(event.id);
      } else {
        useMiniAppWindowStore.getState().markClosed(event.id);
      }
    });
    return unsubscribe;
  }, []);
}
