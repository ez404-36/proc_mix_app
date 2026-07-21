// Typed wrappers around the interactive-Terminal Tauri commands.
//
// `invoke` is confined to this service layer (project convention): the
// store/components call these functions, never `invoke` directly. Each
// function maps 1:1 to a `#[tauri::command]` in
// `src-tauri/src/commands/terminal.rs`. See `docs/interactive-terminal.md`
// for why this is a deliberately separate feature from `utils/executor.ts`
// (the sandboxed command executor).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TerminalEvent } from "../types/terminal";

const TERMINAL_EVENT_CHANNEL = "terminal-event";

/**
 * Maximum number of concurrently open PTY sessions. MUST mirror the
 * authoritative backend cap `MAX_TERMINAL_SESSIONS` in
 * `src-tauri/src/core/terminal/types.rs` — the frontend uses it only to
 * disable the "new tab" button and explain WHY before the user hits the
 * backend error; the backend remains the real enforcer (a `terminal_spawn`
 * past the cap still rejects). Keep the two in sync.
 */
export const MAX_TERMINAL_SESSIONS = 10;

/** Spawn a new interactive PTY session. `shell` and `cwd` are optional
 *  overrides of the platform default shell / starting directory (home
 *  directory when omitted or not an existing directory). Resolves to the
 *  new session id.
 *
 *  Callers MUST `await terminalBridgeReady()` before invoking this — see
 *  that function's doc comment for why. */
export async function spawnTerminalSession(
  shell?: string,
  cwd?: string,
): Promise<string> {
  return invoke<string>("terminal_spawn", { shell, cwd });
}

/** Write raw text (keystrokes, a paste) to a session's PTY stdin. */
export async function writeTerminalSession(
  sessionId: string,
  data: string,
): Promise<void> {
  await invoke("terminal_write", { sessionId, data });
}

/** Resize a session's PTY to the given terminal cell dimensions. */
export async function resizeTerminalSession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke("terminal_resize", { sessionId, cols, rows });
}

/** Close a terminal session (kills its shell). Idempotent. */
export async function closeTerminalSession(sessionId: string): Promise<void> {
  await invoke("terminal_close", { sessionId });
}

/**
 * Module-level event plumbing. Unlike `utils/executor.ts` — where every
 * consumer of `execution-event` already knows the execution id up front and
 * mounts before the run is started (`triggerCommandRun` registers state,
 * THEN invokes) — a Terminal tab's consumer (`TerminalView`, which creates
 * the xterm.js instance) does not exist yet when `terminal_spawn` resolves:
 * it only mounts once React re-renders with the new session id in the
 * store. The backend's PTY reader thread, however, starts emitting `Data`
 * events (the shell's own startup banner / first prompt) IMMEDIATELY after
 * spawning, well before that render happens. Without buffering, that first
 * output — including the prompt showing the working directory — is lost:
 * there is no error, the events are simply emitted with no listener
 * registered for that `sessionId` yet, and `Terminal.write()` never runs.
 *
 * The fix has three parts:
 *   1. A SINGLE global `listen()` is bootstrapped at module load (mirroring
 *      `ensureSubscribed()` in `utils/executor.ts`), so the Tauri IPC
 *      listener is registered well before any `terminal_spawn` call can be
 *      made (`terminalBridgeReady()` lets a caller await this explicitly).
 *   2. Every event for a session is appended to a bounded ring buffer
 *      (`sessionBuffers`) — regardless of whether a live handler is
 *      currently registered — and `subscribeTerminalSession(sessionId, …)`
 *      replays that ENTIRE buffer to a NEW subscriber before switching to
 *      live delivery.
 *   3. Crucially, replay is NON-destructive: the buffer is NOT cleared when
 *      a subscriber reads it. This is what makes the fix resilient to React
 *      18 StrictMode's dev-only double-invoke of a mount effect (`setup →
 *      cleanup → setup`): `useTerminalSession`'s first (soon-to-be-discarded)
 *      effect invocation subscribes, replays the buffer into a
 *      soon-to-be-disposed `Terminal` instance, and immediately unsubscribes
 *      on cleanup; the SECOND (final, visible) invocation then subscribes
 *      again and — because the buffer was never destructively drained —
 *      still sees the full history, including the shell's first prompt. A
 *      destructive "delete on first replay" buffer (an earlier version of
 *      this file) loses that history to the StrictMode ghost instance,
 *      which is exactly the bug this comment exists to prevent regressing:
 *      the terminal tab renders BLANK (no prompt, no working directory) and
 *      any events racing that same narrow window (including early keystroke
 *      echoes) are lost the same way.
 *
 * The buffer for a session is NOT auto-cleared on its `Exit` event — doing
 * so would reintroduce the exact same class of bug for the `Exit` event
 * itself (a StrictMode ghost subscriber could observe `Exit`, trigger
 * cleanup, and leave the real subscriber never knowing the shell exited).
 * Instead, `forgetTerminalSession` is called explicitly once the UI is done
 * with a session (see `TerminalTabs`'s close handler), and the rolling cap
 * above bounds memory for any session that is left open indefinitely.
 */
const sessionHandlers = new Map<string, Set<(event: TerminalEvent) => void>>();
const sessionBuffers = new Map<string, TerminalEvent[]>();
/** Rolling cap per session — generous enough to cover a shell's startup
 *  banner/prompt and any output racing a StrictMode double-mount, without
 *  keeping unbounded scrollback in memory for a long-lived session. */
const MAX_BUFFERED_EVENTS_PER_SESSION = 500;

function bufferEvent(event: TerminalEvent): void {
  const buffer = sessionBuffers.get(event.sessionId) ?? [];
  buffer.push(event);
  if (buffer.length > MAX_BUFFERED_EVENTS_PER_SESSION) {
    buffer.shift();
  }
  sessionBuffers.set(event.sessionId, buffer);
}

function routeEvent(event: TerminalEvent): void {
  bufferEvent(event);
  const handlers = sessionHandlers.get(event.sessionId);
  if (handlers) {
    for (const h of handlers) h(event);
  }
}

let unlistenPromise: Promise<UnlistenFn> | null = null;

function ensureSubscribed(): Promise<UnlistenFn> {
  if (unlistenPromise) {
    return unlistenPromise;
  }
  unlistenPromise = listen<TerminalEvent>(TERMINAL_EVENT_CHANNEL, (event) => {
    routeEvent(event.payload);
  });
  unlistenPromise.catch((err) => {
    console.error("terminal-event listener failed to attach:", err);
  });
  return unlistenPromise;
}

// Start subscribing immediately when this module loads, exactly like
// `utils/executor.ts` does for `execution-event` — so the listener is live
// well before the user can trigger the first `spawnTerminalSession` call.
void ensureSubscribed();

/**
 * Resolves once the global `terminal-event` listener is live on the Tauri
 * side. Callers MUST await this before calling `spawnTerminalSession` —
 * otherwise the backend's PTY reader thread can start emitting before the
 * frontend is listening at all (not just before a specific tab subscribes,
 * which the buffering above already handles).
 */
export async function terminalBridgeReady(): Promise<void> {
  await ensureSubscribed();
}

/**
 * Subscribe to `terminal-event`s for ONE session. Replays every buffered
 * event for that session (see the module doc above — this replay is
 * non-destructive, so a StrictMode-driven resubscribe still sees the full
 * history), then delivers further events live. Returns the unsubscribe
 * function.
 */
export function subscribeTerminalSession(
  sessionId: string,
  handler: (event: TerminalEvent) => void,
): () => void {
  void ensureSubscribed();

  const buffered = sessionBuffers.get(sessionId);
  if (buffered && buffered.length > 0) {
    for (const event of buffered) handler(event);
  }

  let handlers = sessionHandlers.get(sessionId);
  if (!handlers) {
    handlers = new Set();
    sessionHandlers.set(sessionId, handlers);
  }
  handlers.add(handler);

  return () => {
    const current = sessionHandlers.get(sessionId);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      sessionHandlers.delete(sessionId);
    }
  };
}

/**
 * Drop a session's buffered events and handler bookkeeping. Call this once
 * the UI is permanently done with a session (the user closed its tab) —
 * NOT automatically on an `Exit` event (see the module doc above for why).
 * A no-op if the session was never buffered/subscribed.
 */
export function forgetTerminalSession(sessionId: string): void {
  sessionBuffers.delete(sessionId);
  sessionHandlers.delete(sessionId);
}
