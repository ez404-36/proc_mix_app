/**
 * Suppress the default WebKit/webview context menu in all builds.
 *
 * Tauri 2 has no first-class option to disable the native context menu; the
 * accepted approach is a global `contextmenu` listener that calls
 * `preventDefault()`. We previously kept the native menu in dev so developers
 * retained "Inspect Element", but Tauri 2 debug builds respond to F12 at the
 * WebKit level which provides the same access without leaking the native
 * Back/Forward/Reload/Inspect menu into the dev UI.
 *
 * The custom in-app context menu (rendered by `ContextMenuProvider`) is
 * unaffected — it builds its own UI from React state and ignores the native
 * menu entirely.
 */
export function installContextMenuGuard(): void {
  if (typeof window === "undefined") return;
  window.addEventListener(
    "contextmenu",
    (event) => {
      event.preventDefault();
    },
    { capture: true },
  );
}
