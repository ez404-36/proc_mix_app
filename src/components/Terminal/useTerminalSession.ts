import { useEffect } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  resizeTerminalSession,
  subscribeTerminalSession,
  writeTerminalSession,
} from "../../services/terminalService";
import { useTerminalStore } from "../../stores/terminalStore";
import type { TerminalEvent } from "../../types/terminal";

/**
 * Decode a base64 string into raw bytes. `atob` + manual byte extraction
 * avoids pulling in a Buffer polyfill — this runs entirely in the Tauri
 * webview, which always has `atob`.
 */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Read the clipboard and paste into `term`. Exported for `TerminalView`'s
 * right-click "Paste" menu item, which shares this exact codepath with the
 * `Ctrl`/`Cmd`+`V` handler wired up below.
 */
export function pasteFromClipboard(term: Terminal): void {
  navigator.clipboard
    ?.readText()
    .then((text) => {
      if (typeof text === "string" && text.length > 0) {
        term.paste(text);
      }
    })
    .catch((err: unknown) => {
      console.warn("paste into terminal failed", err);
    });
}

/**
 * Mount an xterm.js `Terminal` into `containerRef` for the given session,
 * wiring it to the backend PTY: incoming `terminal-event`s (filtered to
 * this `sessionId`) are written to the terminal, and the user's keystrokes
 * (`onData`) are written back to the PTY. A `ResizeObserver` on the
 * container re-fits the terminal and pushes the new cell size to
 * `resizeTerminalSession` so the shell's `$COLUMNS`/`$LINES` and any
 * full-screen program (vim, htop) redraw correctly.
 *
 * The `Terminal` instance is created ONCE per `sessionId` and torn down on
 * unmount — it deliberately does NOT live in `terminalStore` (not
 * serialisable, and Zustand re-renders would fight xterm's own internal
 * mutation-heavy rendering). Instead it is exposed to the caller (for the
 * right-click Copy/Paste/Select-all context menu) via `termRef`, a ref
 * object owned by `TerminalView` — the instance is set once `open()`
 * succeeds and cleared to `null` on cleanup, so a menu handler firing after
 * unmount (e.g. a stale closure) can detect the terminal is gone.
 */
export function useTerminalSession(
  sessionId: string,
  containerRef: React.RefObject<HTMLDivElement | null>,
  termRef: React.RefObject<Terminal | null>,
): void {
  const markExited = useTerminalStore((s) => s.markExited);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      // Bracketed paste (`ESC[200~…ESC[201~`) is only useful when the
      // FOREGROUND program in the PTY explicitly asked for it (readline,
      // some editors); xterm.js tracks that as a terminal-wide mode
      // (`decPrivateModes.bracketedPasteMode`) that a shell can flip on and
      // never flip back off before handing control to a program that does
      // NOT understand the sequence (`sudo`, `ssh`, a bare `read`, a login
      // prompt) — that program then echoes the raw escape bytes back
      // instead of interpreting them, producing literal
      // `^[[200~<text>^[[201~` in the output. Disabling bracketed paste
      // entirely avoids that class of artifact; the small loss (no
      // "this is pasted, not typed" hint to programs that DO support it)
      // is an acceptable trade for never corrupting a paste.
      ignoreBracketedPasteMode: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();
    termRef.current = term;

    // xterm.js's native `Ctrl`/`Cmd`+`V` paste relies on the BROWSER's own
    // `paste` event reaching its hidden textarea, which in turn depends on
    // the OS/webview correctly mapping the physical key combo to a "paste"
    // command — on some keyboard layouts (observed with non-Latin/Cyrillic
    // layouts under WebKitGTK) that browser-level translation silently
    // fails to fire, breaking paste ONLY on those layouts. Intercepting the
    // combo ourselves via `attachCustomKeyEventHandler` and checking
    // `event.code` (the PHYSICAL key, e.g. "KeyV" — layout-independent)
    // rather than `event.key` (the LOGICAL character, which changes with
    // the layout) sidesteps that translation entirely and makes paste work
    // regardless of the active keyboard layout. Returning `false` tells
    // xterm.js to swallow the event (not process it as a literal
    // Ctrl+V/Cmd+V keystroke) once we've handled it ourselves.
    term.attachCustomKeyEventHandler((event) => {
      const isPasteCombo =
        event.type === "keydown" &&
        event.code === "KeyV" &&
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey;
      if (isPasteCombo) {
        pasteFromClipboard(term);
        return false;
      }
      return true;
    });

    // Deliver the user's input straight to the PTY's stdin. Fire-and-forget:
    // a transient write failure (session already exited) surfaces via the
    // `exit` event instead of needing to be handled here.
    const dataDisposable = term.onData((data) => {
      void writeTerminalSession(sessionId, data);
    });

    // `subscribeTerminalSession` (not the raw event channel) replays any
    // `terminal-event`s that arrived for this session BEFORE this effect
    // ran — e.g. the shell's startup banner / first prompt, emitted by the
    // backend's PTY reader thread the instant the shell spawns, which is
    // well before React re-renders with the new session id and mounts
    // this component. Without that replay the first prompt (showing the
    // working directory) would be silently dropped.
    const unsubscribe = subscribeTerminalSession(sessionId, (event: TerminalEvent) => {
      if (event.type === "data") {
        term.write(decodeBase64(event.data));
      } else {
        markExited(sessionId, event.exitCode);
      }
    });

    const pushResize = (): void => {
      fitAddon.fit();
      resizeTerminalSession(sessionId, term.cols, term.rows).catch(() => {
        // The session may have already exited between the resize event and
        // this call — non-fatal, the next successful resize corrects it.
      });
    };
    const resizeObserver = new ResizeObserver(() => pushResize());
    resizeObserver.observe(container);
    // Push the initial fit-derived size once the PTY exists, so the shell's
    // very first prompt is already sized to the container rather than the
    // backend's 80x24 default.
    pushResize();

    return () => {
      termRef.current = null;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unsubscribe();
      term.dispose();
    };
    // `sessionId` never changes for a mounted `TerminalView` (each tab gets
    // its own component instance); `containerRef`/`termRef` are stable ref
    // objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
}
