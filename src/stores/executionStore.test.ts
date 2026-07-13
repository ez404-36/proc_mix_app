import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Execution, ExecutionLogLine } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useExecutionStore } from "./executionStore";

function reset() {
  useExecutionStore.setState({
    executions: {},
    recentIds: [],
    activeExecutionId: null,
    panelOpen: false,
  });
}

beforeEach(() => {
  reset();
});

describe("executionStore.startExecution", () => {
  it("should create a running execution and open the panel", () => {
    useExecutionStore.getState().startExecution("e1", "cmd-1", "Hello");
    const state = useExecutionStore.getState();
    const exec = state.executions["e1"];
    expect(exec.id).toBe("e1");
    expect(exec.commandId).toBe("cmd-1");
    expect(exec.commandName).toBe("Hello");
    expect(exec.status).toBe("running");
    expect(exec.log).toEqual([]);
    expect(typeof exec.startedAt).toBe("number");
    expect(state.activeExecutionId).toBe("e1");
    expect(state.panelOpen).toBe(true);
    expect(state.recentIds).toEqual(["e1"]);
  });

  it("should move an existing id to the front of recentIds without duplicating", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "A");
    useExecutionStore.getState().startExecution("e2", undefined, "B");
    useExecutionStore.getState().startExecution("e1", undefined, "A");
    expect(useExecutionStore.getState().recentIds).toEqual(["e1", "e2"]);
  });

  it("should keep only the 50 most recent ids", () => {
    for (let i = 0; i < 55; i++) {
      useExecutionStore.getState().startExecution(`e${i}`, undefined, "n");
    }
    const recent = useExecutionStore.getState().recentIds;
    expect(recent).toHaveLength(50);
    // Most recent first.
    expect(recent[0]).toBe("e54");
    expect(recent[49]).toBe("e5");
  });

  it("should preserve original commandId and name when restarting an existing execution", () => {
    useExecutionStore.getState().startExecution("e1", "cmd-old", "Old");
    useExecutionStore.getState().startExecution("e1", "cmd-new", "New");
    const exec = useExecutionStore.getState().executions["e1"];
    // Original commandId/name are preserved (idempotent on restart).
    expect(exec.commandId).toBe("cmd-old");
    expect(exec.commandName).toBe("Old");
  });

  it("should accept a new commandId when the existing execution had none", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "Initial");
    useExecutionStore.getState().startExecution("e1", "cmd-real", "Initial");
    const exec = useExecutionStore.getState().executions["e1"];
    expect(exec.commandId).toBe("cmd-real");
  });

  it("should accept a fallback name when the existing name was empty", () => {
    // Manually seed an execution with an empty name to exercise the
    // `commandName ||` branch.
    useExecutionStore.setState({
      executions: {
        e1: {
          id: "e1",
          commandId: undefined,
          commandName: "",
          status: "running",
          startedAt: 1,
          log: [],
        },
      },
      recentIds: ["e1"],
    });
    useExecutionStore.getState().startExecution("e1", undefined, "Real Name");
    expect(useExecutionStore.getState().executions["e1"].commandName).toBe(
      "Real Name",
    );
  });
});

describe("executionStore.appendLog", () => {
  it("should append the line to the execution's log", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "n");
    const line: ExecutionLogLine = { stream: "stdout", line: "hi", ts: 1 };
    useExecutionStore.getState().appendLog("e1", line);
    expect(useExecutionStore.getState().executions["e1"].log).toEqual([line]);
  });

  it("should preserve previously appended lines (append, not replace)", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "n");
    const a: ExecutionLogLine = { stream: "stdout", line: "1", ts: 1 };
    const b: ExecutionLogLine = { stream: "stderr", line: "2", ts: 2 };
    useExecutionStore.getState().appendLog("e1", a);
    useExecutionStore.getState().appendLog("e1", b);
    expect(useExecutionStore.getState().executions["e1"].log).toEqual([a, b]);
  });

  it("should create a stub execution when the id does not exist yet (resilient to out-of-order delivery)", () => {
    const line: ExecutionLogLine = { stream: "stdout", line: "x", ts: 0 };
    useExecutionStore.getState().appendLog("ghost", line);
    const state = useExecutionStore.getState();
    const exec = state.executions["ghost"];
    expect(exec).toBeDefined();
    expect(exec.id).toBe("ghost");
    expect(exec.status).toBe("running");
    expect(exec.commandName).toBe("");
    expect(exec.log).toEqual([line]);
    expect(state.recentIds).toContain("ghost");
    expect(state.activeExecutionId).toBe("ghost");
    expect(state.panelOpen).toBe(true);
  });
});

describe("executionStore.finishExecution", () => {
  it("should update status, exitCode, duration, finishedAt, and clear error", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "n");
    useExecutionStore.getState().finishExecution("e1", {
      status: "success",
      exitCode: 0,
      durationMs: 12,
      finishedAt: 999,
      error: undefined,
    });
    const exec = useExecutionStore.getState().executions["e1"];
    expect(exec.status).toBe("success");
    expect(exec.exitCode).toBe(0);
    expect(exec.durationMs).toBe(12);
    expect(exec.finishedAt).toBe(999);
    expect(exec.error).toBeUndefined();
  });

  it("carries the timedOut flag through so the panel can surface it", () => {
    // Regression: finishExecution previously dropped patch.timedOut, so a
    // timed-out run looked like a generic error in the console.
    useExecutionStore.getState().startExecution("e1", undefined, "n");
    useExecutionStore.getState().finishExecution("e1", {
      status: "error",
      exitCode: null,
      durationMs: 1000,
      finishedAt: 999,
      error: undefined,
      timedOut: true,
    });
    const exec = useExecutionStore.getState().executions["e1"];
    expect(exec.status).toBe("error");
    expect(exec.timedOut).toBe(true);
  });

  it("should fall back to existing values when patch fields are nullish", () => {
    // Seed an execution with pre-existing fields.
    const seed: Execution = {
      id: "e1",
      commandName: "n",
      status: "running",
      startedAt: 1,
      log: [],
      exitCode: 7,
      durationMs: 33,
      finishedAt: 44,
      error: "old",
    };
    useExecutionStore.setState({ executions: { e1: seed }, recentIds: ["e1"] });

    useExecutionStore.getState().finishExecution("e1", {
      status: undefined as unknown as Execution["status"],
      exitCode: undefined,
      durationMs: undefined,
      finishedAt: undefined,
      error: undefined,
    });

    const exec = useExecutionStore.getState().executions["e1"];
    expect(exec.status).toBe("running"); // status fallback
    expect(exec.exitCode).toBe(7);
    expect(exec.durationMs).toBe(33);
    expect(exec.finishedAt).toBe(44);
    expect(exec.error).toBe("old");
  });

  it("should default finishedAt to Date.now() when patch and existing have none", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "n");
    const spy = vi.spyOn(Date, "now").mockReturnValue(1234567);
    useExecutionStore.getState().finishExecution("e1", {
      status: "error",
      exitCode: 1,
      durationMs: undefined,
      finishedAt: undefined,
      error: "boom",
    });
    spy.mockRestore();
    const exec = useExecutionStore.getState().executions["e1"];
    expect(exec.finishedAt).toBe(1234567);
    expect(exec.exitCode).toBe(1);
    expect(exec.error).toBe("boom");
  });

  it("should NOT preserve a null exitCode in the patch (uses ?? operator, falls back to existing)", () => {
    // This documents intentional behavior: `patch.exitCode ?? existing.exitCode`
    // treats null as missing, so the existing (or undefined) value wins.
    useExecutionStore.getState().startExecution("e1", undefined, "n");
    useExecutionStore.getState().finishExecution("e1", {
      status: "error",
      exitCode: null,
      durationMs: 0,
      finishedAt: 1,
      error: "x",
    });
    const exec = useExecutionStore.getState().executions["e1"];
    expect(exec.exitCode).toBeUndefined();
  });

  it("should create a stub execution when the id does not exist yet (resilient to out-of-order delivery)", () => {
    useExecutionStore.getState().finishExecution("ghost", {
      status: "success",
      exitCode: 0,
      durationMs: 12,
      finishedAt: 999,
      error: undefined,
    });
    const state = useExecutionStore.getState();
    const exec = state.executions["ghost"];
    expect(exec).toBeDefined();
    expect(exec.id).toBe("ghost");
    expect(exec.status).toBe("success");
    expect(exec.exitCode).toBe(0);
    expect(exec.durationMs).toBe(12);
    expect(exec.finishedAt).toBe(999);
    expect(exec.log).toEqual([]);
    expect(state.recentIds).toContain("ghost");
  });
});

describe("executionStore.setExecutionResult", () => {
  it("attaches the result to an existing execution", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "n");
    const result = { fields: { host: "srv" }, returnValue: "srv" };
    useExecutionStore.getState().setExecutionResult("e1", result);
    expect(useExecutionStore.getState().executions["e1"].result).toEqual(result);
  });

  it("creates a running stub when the id does not exist yet (out-of-order result)", () => {
    const result = { fields: { x: 1 }, returnValue: 1 };
    useExecutionStore.getState().setExecutionResult("ghost", result);
    const state = useExecutionStore.getState();
    const exec = state.executions["ghost"];
    expect(exec).toBeDefined();
    expect(exec.status).toBe("running");
    expect(exec.commandName).toBe("");
    expect(exec.result).toEqual(result);
    expect(state.recentIds).toContain("ghost");
    expect(state.activeExecutionId).toBe("ghost");
    expect(state.panelOpen).toBe(true);
  });
});

describe("executionStore panel sizing / dock position", () => {
  it("setPanelHeight clamps to the minimum panel height", () => {
    useExecutionStore.getState().setPanelHeight(1);
    expect(useExecutionStore.getState().panelHeight).toBeGreaterThanOrEqual(1);
    // A very large request is clamped down to fit the viewport.
    useExecutionStore.getState().setPanelHeight(100000);
    expect(useExecutionStore.getState().panelHeight).toBeLessThan(100000);
  });

  it("setPanelWidth clamps to the minimum panel width", () => {
    useExecutionStore.getState().setPanelWidth(1);
    expect(useExecutionStore.getState().panelWidth).toBeGreaterThanOrEqual(1);
    useExecutionStore.getState().setPanelWidth(100000);
    expect(useExecutionStore.getState().panelWidth).toBeLessThan(100000);
  });

  it("setConsolePosition updates the dock position", () => {
    useExecutionStore.getState().setConsolePosition("left");
    expect(useExecutionStore.getState().consolePosition).toBe("left");
  });
});

describe("executionStore.setActiveExecution / setPanelOpen", () => {
  it("setActiveExecution should set the active id to a string or null", () => {
    useExecutionStore.getState().setActiveExecution("x");
    expect(useExecutionStore.getState().activeExecutionId).toBe("x");
    useExecutionStore.getState().setActiveExecution(null);
    expect(useExecutionStore.getState().activeExecutionId).toBeNull();
  });

  it("setPanelOpen should toggle the panel flag", () => {
    useExecutionStore.getState().setPanelOpen(true);
    expect(useExecutionStore.getState().panelOpen).toBe(true);
    useExecutionStore.getState().setPanelOpen(false);
    expect(useExecutionStore.getState().panelOpen).toBe(false);
  });
});

describe("executionStore.clearExecution", () => {
  it("should remove the execution from the map and from recentIds", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "n");
    useExecutionStore.getState().startExecution("e2", undefined, "n");
    useExecutionStore.getState().clearExecution("e1");
    const state = useExecutionStore.getState();
    expect(state.executions["e1"]).toBeUndefined();
    expect(state.recentIds).toEqual(["e2"]);
  });

  it("should set activeExecutionId to the next recent id when the cleared one was active", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "n");
    useExecutionStore.getState().startExecution("e2", undefined, "n");
    // After two starts: activeExecutionId === "e2", recentIds === ["e2","e1"]
    useExecutionStore.getState().clearExecution("e2");
    expect(useExecutionStore.getState().activeExecutionId).toBe("e1");
  });

  it("should set activeExecutionId to null when no recent ids remain after clearing the active one", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "n");
    useExecutionStore.getState().clearExecution("e1");
    expect(useExecutionStore.getState().activeExecutionId).toBeNull();
  });

  it("should leave activeExecutionId untouched when a non-active id is cleared", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "n");
    useExecutionStore.getState().startExecution("e2", undefined, "n");
    // active is "e2", clear "e1" -> active stays "e2"
    useExecutionStore.getState().clearExecution("e1");
    expect(useExecutionStore.getState().activeExecutionId).toBe("e2");
  });
});

describe("executionStore.clearAll", () => {
  it("should reset executions, recentIds, and activeExecutionId", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "n");
    useExecutionStore.getState().clearAll();
    const state = useExecutionStore.getState();
    expect(state.executions).toEqual({});
    expect(state.recentIds).toEqual([]);
    expect(state.activeExecutionId).toBeNull();
  });
});

describe("executionStore pin / rename (console recents)", () => {
  function finish(id: string): void {
    useExecutionStore
      .getState()
      .finishExecution(id, { status: "success", finishedAt: Date.now() });
  }

  it("renameExecution sets a custom name; empty clears it", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "Orig");
    useExecutionStore.getState().renameExecution("e1", "  My run  ");
    expect(useExecutionStore.getState().executions["e1"].customName).toBe(
      "My run",
    );
    useExecutionStore.getState().renameExecution("e1", "  ");
    expect(
      useExecutionStore.getState().executions["e1"].customName,
    ).toBeUndefined();
  });

  it("setPinned marks/unmarks the run as pinned", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "n");
    useExecutionStore.getState().setPinned("e1", true);
    expect(useExecutionStore.getState().executions["e1"].pinned).toBe(true);
    useExecutionStore.getState().setPinned("e1", false);
    expect(useExecutionStore.getState().executions["e1"].pinned).toBe(false);
  });

  it("clearTerminated keeps a pinned terminal run", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "keep");
    useExecutionStore.getState().startExecution("e2", undefined, "drop");
    finish("e1");
    finish("e2");
    useExecutionStore.getState().setPinned("e1", true);
    useExecutionStore.getState().clearTerminated();
    const state = useExecutionStore.getState();
    expect(state.executions["e1"]).toBeDefined();
    expect(state.executions["e2"]).toBeUndefined();
    expect(state.recentIds).toEqual(["e1"]);
  });

  it("clearAll keeps a pinned run and drops the rest", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "keep");
    useExecutionStore.getState().startExecution("e2", undefined, "drop");
    useExecutionStore.getState().setPinned("e1", true);
    useExecutionStore.getState().clearAll();
    const state = useExecutionStore.getState();
    expect(Object.keys(state.executions)).toEqual(["e1"]);
    expect(state.recentIds).toEqual(["e1"]);
  });

  it("pinning moves a run ahead of unpinned runs in recents", () => {
    // recents order is newest-first: e3, e2, e1.
    useExecutionStore.getState().startExecution("e1", undefined, "a");
    useExecutionStore.getState().startExecution("e2", undefined, "b");
    useExecutionStore.getState().startExecution("e3", undefined, "c");
    // Pin the oldest — it must jump to the front of the strip.
    useExecutionStore.getState().setPinned("e1", true);
    expect(useExecutionStore.getState().recentIds).toEqual(["e1", "e3", "e2"]);
  });

  it("a new run is inserted after the pinned block, not at index 0", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "a");
    useExecutionStore.getState().setPinned("e1", true);
    useExecutionStore.getState().startExecution("e2", undefined, "b");
    // e1 stays pinned-left; the fresh e2 lands at the front of the unpinned block.
    expect(useExecutionStore.getState().recentIds).toEqual(["e1", "e2"]);
  });
});

describe("executionStore.reorderRecent (console recents drag-and-drop)", () => {
  it("reorders two unpinned runs within their partition", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "a");
    useExecutionStore.getState().startExecution("e2", undefined, "b");
    useExecutionStore.getState().startExecution("e3", undefined, "c");
    // order: e3, e2, e1. Move e3 onto e1's slot (to the end).
    useExecutionStore.getState().reorderRecent("e3", "e1");
    expect(useExecutionStore.getState().recentIds).toEqual(["e2", "e1", "e3"]);
  });

  it("rejects moving an unpinned run across the pinned boundary", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "a");
    useExecutionStore.getState().startExecution("e2", undefined, "b");
    useExecutionStore.getState().setPinned("e1", true);
    // order: e1 (pinned), e2 (unpinned). Try to move e2 onto e1 — must no-op.
    const before = [...useExecutionStore.getState().recentIds];
    useExecutionStore.getState().reorderRecent("e2", "e1");
    expect(useExecutionStore.getState().recentIds).toEqual(before);
  });

  it("rejects moving a pinned run across the boundary onto an unpinned one", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "a");
    useExecutionStore.getState().startExecution("e2", undefined, "b");
    useExecutionStore.getState().setPinned("e1", true);
    const before = [...useExecutionStore.getState().recentIds];
    useExecutionStore.getState().reorderRecent("e1", "e2");
    expect(useExecutionStore.getState().recentIds).toEqual(before);
  });

  it("reorders within the pinned partition", () => {
    useExecutionStore.getState().startExecution("e1", undefined, "a");
    useExecutionStore.getState().startExecution("e2", undefined, "b");
    useExecutionStore.getState().setPinned("e1", true);
    useExecutionStore.getState().setPinned("e2", true);
    // Both pinned. order: e2, e1 (e2 pinned later → front of pinned block).
    const order = useExecutionStore.getState().recentIds;
    useExecutionStore.getState().reorderRecent(order[0], order[1]);
    expect(useExecutionStore.getState().recentIds).toEqual([order[1], order[0]]);
  });
});

describe("executionStore.startWorkflowExecution (aggregated process)", () => {
  it("should create one execution keyed by the run id, marked isWorkflow, and open the panel", () => {
    useExecutionStore.getState().startWorkflowExecution("run-1", "My Flow");
    const state = useExecutionStore.getState();
    const exec = state.executions["run-1"];
    expect(exec.id).toBe("run-1");
    expect(exec.isWorkflow).toBe(true);
    expect(exec.commandName).toBe("My Flow");
    expect(exec.commandId).toBeUndefined();
    expect(exec.status).toBe("running");
    expect(state.activeExecutionId).toBe("run-1");
    expect(state.panelOpen).toBe(true);
    expect(state.recentIds).toEqual(["run-1"]);
  });

  it("should fold node output + step headers into the single aggregated entry without creating standalone executions", () => {
    const store = useExecutionStore.getState();
    store.startWorkflowExecution("run-1", "My Flow");
    store.appendWorkflowStepHeader("run-1", "▸ Build");
    store.appendLog("run-1", { stream: "stdout", line: "compiling", ts: 1 });
    store.appendWorkflowStepHeader("run-1", "  exit 0");
    const state = useExecutionStore.getState();
    // Exactly one execution exists — the aggregate. No per-node ids leaked.
    expect(Object.keys(state.executions)).toEqual(["run-1"]);
    expect(state.recentIds).toEqual(["run-1"]);
    const log = state.executions["run-1"].log;
    expect(log.map((l) => [l.stream, l.line])).toEqual([
      ["meta", "▸ Build"],
      ["stdout", "compiling"],
      ["meta", "  exit 0"],
    ]);
  });

  it("should be idempotent on the same run id, preserving the existing log", () => {
    const store = useExecutionStore.getState();
    store.startWorkflowExecution("run-1", "My Flow");
    store.appendLog("run-1", { stream: "stdout", line: "first", ts: 1 });
    store.startWorkflowExecution("run-1", "My Flow");
    const exec = useExecutionStore.getState().executions["run-1"];
    expect(exec.log).toHaveLength(1);
    expect(exec.isWorkflow).toBe(true);
  });

  it("appendWorkflowStepHeader is a no-op when the run was never started", () => {
    useExecutionStore.getState().appendWorkflowStepHeader("ghost", "▸ x");
    expect(useExecutionStore.getState().executions["ghost"]).toBeUndefined();
  });

  it("appendWorkflowStepHeader stores the variant tag when given", () => {
    const store = useExecutionStore.getState();
    store.startWorkflowExecution("run-1", "My Flow");
    store.appendWorkflowStepHeader("run-1", "▸ Build");
    store.appendWorkflowStepHeader("run-1", "  (bash) /home/egor", "workdir");
    const log = useExecutionStore.getState().executions["run-1"].log;
    expect(log[0].variant).toBeUndefined();
    expect(log[1].variant).toBe("workdir");
  });

  it("finishExecution mirrors the workflow's terminal status onto the aggregate", () => {
    const store = useExecutionStore.getState();
    store.startWorkflowExecution("run-1", "My Flow");
    store.finishExecution("run-1", {
      status: "success",
      durationMs: 42,
      finishedAt: 100,
      error: undefined,
    });
    const exec = useExecutionStore.getState().executions["run-1"];
    expect(exec.status).toBe("success");
    expect(exec.durationMs).toBe(42);
    expect(exec.isWorkflow).toBe(true);
  });
});
