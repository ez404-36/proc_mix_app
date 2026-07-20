import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalEvent } from "../types/terminal";

// See executor.test.ts for the same hoisting rationale: `terminalService`
// subscribes to "terminal-event" at MODULE LOAD via a top-level
// `void ensureSubscribed()` call, so the mock must exist before the module
// import below runs.
const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<(...args: unknown[]) => unknown>(),
  listenMock: vi.fn<(...args: unknown[]) => Promise<() => void>>(() =>
    Promise.resolve(() => {}),
  ),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import {
  forgetTerminalSession,
  spawnTerminalSession,
  subscribeTerminalSession,
  terminalBridgeReady,
  writeTerminalSession,
} from "./terminalService";

type TauriListener = (e: { payload: TerminalEvent }) => void;
const moduleLoadListener: TauriListener =
  listenMock.mock.calls[0]?.[1] as TauriListener;

function emit(event: TerminalEvent): void {
  moduleLoadListener({ payload: event });
}

beforeEach(() => {
  invokeMock.mockReset();
  // Do NOT reset listenMock — the module-level bootstrap subscription must
  // stay wired to `moduleLoadListener` across tests, exactly like
  // executor.test.ts.
});

describe("terminalService command wrappers", () => {
  it("spawnTerminalSession invokes terminal_spawn with shell/cwd", async () => {
    invokeMock.mockResolvedValueOnce("session-1");
    const id = await spawnTerminalSession("/bin/zsh", "/tmp");
    expect(id).toBe("session-1");
    expect(invokeMock).toHaveBeenCalledWith("terminal_spawn", {
      shell: "/bin/zsh",
      cwd: "/tmp",
    });
  });

  it("writeTerminalSession invokes terminal_write with sessionId/data", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await writeTerminalSession("session-1", "ls\n");
    expect(invokeMock).toHaveBeenCalledWith("terminal_write", {
      sessionId: "session-1",
      data: "ls\n",
    });
  });

  it("terminalBridgeReady resolves once the global listener is attached", async () => {
    await expect(terminalBridgeReady()).resolves.toBeUndefined();
  });
});

describe("subscribeTerminalSession event buffering", () => {
  it("replays events that arrived before any subscriber existed", () => {
    const sessionId = "early-session";
    emit({ type: "data", sessionId, data: "cHJvbXB0" });
    emit({ type: "data", sessionId, data: "bW9yZQ==" });

    const received: TerminalEvent[] = [];
    const unsubscribe = subscribeTerminalSession(sessionId, (e) =>
      received.push(e),
    );

    expect(received).toEqual([
      { type: "data", sessionId, data: "cHJvbXB0" },
      { type: "data", sessionId, data: "bW9yZQ==" },
    ]);
    unsubscribe();
  });

  it("delivers events live to an already-subscribed handler", () => {
    const sessionId = "live-session";
    const received: TerminalEvent[] = [];
    const unsubscribe = subscribeTerminalSession(sessionId, (e) =>
      received.push(e),
    );

    emit({ type: "data", sessionId, data: "aGVsbG8=" });

    expect(received).toEqual([{ type: "data", sessionId, data: "aGVsbG8=" }]);
    unsubscribe();
  });

  /**
   * This is the exact scenario that caused the "terminal tab renders blank"
   * regression: React 18 StrictMode dev-double-invokes a mount effect
   * (setup → cleanup → setup). The FIRST (soon-to-be-discarded) subscribe
   * call must NOT destructively drain the buffer, or the SECOND (real,
   * visible) subscribe call sees nothing.
   */
  it("a StrictMode-style subscribe/unsubscribe/resubscribe still sees the full buffered history", () => {
    const sessionId = "strict-mode-session";
    // Backend starts emitting before ANY subscriber exists — the shell's
    // startup banner / first prompt.
    emit({ type: "data", sessionId, data: "cHJvbXB0MQ==" });

    // First (StrictMode "ghost") mount: subscribes, immediately unsubscribes.
    const ghostReceived: TerminalEvent[] = [];
    const unsubscribeGhost = subscribeTerminalSession(sessionId, (e) =>
      ghostReceived.push(e),
    );
    unsubscribeGhost();

    // Second (real, visible) mount: subscribes again.
    const realReceived: TerminalEvent[] = [];
    const unsubscribeReal = subscribeTerminalSession(sessionId, (e) =>
      realReceived.push(e),
    );

    // The REAL subscriber must still see the buffered prompt — this is what
    // a destructive buffer would break.
    expect(realReceived).toEqual([
      { type: "data", sessionId, data: "cHJvbXB0MQ==" },
    ]);
    // The ghost subscriber saw it too (expected — it existed when the event
    // arrived), but that must not have consumed it for the real subscriber.
    expect(ghostReceived).toEqual([
      { type: "data", sessionId, data: "cHJvbXB0MQ==" },
    ]);

    // Live events after the resubscribe must reach only the real handler.
    emit({ type: "data", sessionId, data: "bGl2ZQ==" });
    expect(realReceived).toEqual([
      { type: "data", sessionId, data: "cHJvbXB0MQ==" },
      { type: "data", sessionId, data: "bGl2ZQ==" },
    ]);
    expect(ghostReceived).toHaveLength(1);

    unsubscribeReal();
  });

  it("does not clear the buffer on an Exit event (ghost-subscriber safety)", () => {
    const sessionId = "exit-session";
    emit({ type: "data", sessionId, data: "cHJvbXB0" });

    const ghostReceived: TerminalEvent[] = [];
    const unsubscribeGhost = subscribeTerminalSession(sessionId, (e) =>
      ghostReceived.push(e),
    );
    unsubscribeGhost();

    emit({ type: "exit", sessionId, exitCode: 0 });

    const realReceived: TerminalEvent[] = [];
    const unsubscribeReal = subscribeTerminalSession(sessionId, (e) =>
      realReceived.push(e),
    );

    expect(realReceived).toEqual([
      { type: "data", sessionId, data: "cHJvbXB0" },
      { type: "exit", sessionId, exitCode: 0 },
    ]);
    unsubscribeReal();
  });

  it("forgetTerminalSession drops buffered events for that session", () => {
    const sessionId = "forgotten-session";
    emit({ type: "data", sessionId, data: "cHJvbXB0" });
    forgetTerminalSession(sessionId);

    const received: TerminalEvent[] = [];
    const unsubscribe = subscribeTerminalSession(sessionId, (e) =>
      received.push(e),
    );
    expect(received).toEqual([]);
    unsubscribe();
  });

  it("events for one session never leak into another session's subscriber", () => {
    const sessionA = "session-a";
    const sessionB = "session-b";
    emit({ type: "data", sessionId: sessionA, data: "YQ==" });
    emit({ type: "data", sessionId: sessionB, data: "Yg==" });

    const receivedA: TerminalEvent[] = [];
    const unsubscribeA = subscribeTerminalSession(sessionA, (e) =>
      receivedA.push(e),
    );

    expect(receivedA).toEqual([
      { type: "data", sessionId: sessionA, data: "YQ==" },
    ]);
    unsubscribeA();
  });
});
