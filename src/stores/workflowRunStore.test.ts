import { beforeEach, describe, expect, it } from "vitest";

import type { ExecutionLogLine, ExtractedResult } from "../types";
import {
  getExecutionWorkingDir,
  useWorkflowRunStore,
} from "./workflowRunStore";

function logLine(line: string): ExecutionLogLine {
  return { stream: "stdout", line, ts: 0 };
}

beforeEach(() => {
  useWorkflowRunStore.getState().clearAll();
});

describe("workflowRunStore.startRun", () => {
  it("creates a fresh run and records it as recent", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1", { n1: "cmd-1" });

    const state = useWorkflowRunStore.getState();
    const run = state.runs["run-1"];
    expect(run?.workflowId).toBe("wf-1");
    expect(run?.status).toBe("running");
    expect(run?.nodeCommandIds).toEqual({ n1: "cmd-1" });
    expect(state.recentRunIds).toEqual(["run-1"]);
  });

  it("defaults nodeCommandIds to an empty map when omitted", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    expect(useWorkflowRunStore.getState().runs["run-1"]?.nodeCommandIds).toEqual(
      {},
    );
  });

  it("reuses the existing run when startRun is called again with the same id", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    const firstStartedAt = useWorkflowRunStore.getState().runs["run-1"]?.startedAt;

    useWorkflowRunStore.getState().startRun("run-1", "wf-other");

    const run = useWorkflowRunStore.getState().runs["run-1"];
    expect(run?.startedAt).toBe(firstStartedAt);
    expect(run?.workflowId).toBe("wf-1");
    expect(useWorkflowRunStore.getState().recentRunIds).toEqual(["run-1"]);
  });

  it("de-dupes recentRunIds and caps them at MAX_RECENT newest-first", () => {
    for (let i = 0; i < 51; i += 1) {
      useWorkflowRunStore.getState().startRun(`run-${i}`, "wf-1");
    }
    const recent = useWorkflowRunStore.getState().recentRunIds;
    expect(recent).toHaveLength(50);
    expect(recent[0]).toBe("run-50");
    expect(recent).not.toContain("run-0");
  });
});

describe("workflowRunStore.markNodeStarted", () => {
  it("is a no-op for an unknown run", () => {
    useWorkflowRunStore.getState().markNodeStarted("missing", "n1", "exec-1");
    expect(useWorkflowRunStore.getState().runs["missing"]).toBeUndefined();
  });

  it("marks a node running and preserves the executionId across a later call", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().markNodeStarted("run-1", "n1", "exec-1");
    useWorkflowRunStore.getState().markNodeStarted("run-1", "n1");

    const node = useWorkflowRunStore.getState().runs["run-1"]?.nodes["n1"];
    expect(node?.status).toBe("running");
    expect(node?.executionId).toBe("exec-1");
  });
});

describe("workflowRunStore.markNodeFinished", () => {
  it("is a no-op for an unknown run", () => {
    useWorkflowRunStore.getState().markNodeFinished("missing", "n1", 0);
    expect(useWorkflowRunStore.getState().runs["missing"]).toBeUndefined();
  });

  it("marks a node finished with its exit code", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().markNodeStarted("run-1", "n1");
    useWorkflowRunStore.getState().markNodeFinished("run-1", "n1", 2);

    const node = useWorkflowRunStore.getState().runs["run-1"]?.nodes["n1"];
    expect(node?.status).toBe("finished");
    expect(node?.exitCode).toBe(2);
  });
});

describe("workflowRunStore.markBranchTaken", () => {
  it("is a no-op for an unknown run", () => {
    useWorkflowRunStore.getState().markBranchTaken("missing", "n1", "then", "e1");
    expect(useWorkflowRunStore.getState().runs["missing"]).toBeUndefined();
  });

  it("records the branch and de-dupes the edge id", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().markBranchTaken("run-1", "n1", "then", "e1");
    useWorkflowRunStore.getState().markBranchTaken("run-1", "n1", "then", "e1");

    const run = useWorkflowRunStore.getState().runs["run-1"];
    expect(run?.branches["n1"]).toBe("then");
    expect(run?.takenEdgeIds).toEqual(["e1"]);
  });
});

describe("workflowRunStore.markLoopIteration", () => {
  it("is a no-op for an unknown run", () => {
    useWorkflowRunStore.getState().markLoopIteration("missing", "n1", 1);
    expect(useWorkflowRunStore.getState().runs["missing"]).toBeUndefined();
  });

  it("records the iteration number", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().markLoopIteration("run-1", "n1", 3);
    expect(
      useWorkflowRunStore.getState().runs["run-1"]?.loopIterations["n1"],
    ).toBe(3);
  });
});

describe("workflowRunStore.markRetry", () => {
  it("is a no-op for an unknown run", () => {
    useWorkflowRunStore.getState().markRetry("missing", "n1", 2);
    expect(useWorkflowRunStore.getState().runs["missing"]).toBeUndefined();
  });

  it("records the attempt number", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().markRetry("run-1", "n1", 2);
    expect(
      useWorkflowRunStore.getState().runs["run-1"]?.retryAttempts["n1"],
    ).toBe(2);
  });
});

describe("workflowRunStore.appendNodeOutputLine", () => {
  it("is a no-op for an unknown run", () => {
    useWorkflowRunStore.getState().appendNodeOutputLine("missing", "exec-1", "x");
    expect(useWorkflowRunStore.getState().runs["missing"]).toBeUndefined();
  });

  it("is a no-op when the executionId maps to no node", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().appendNodeOutputLine("run-1", "exec-x", "x");
    expect(
      useWorkflowRunStore.getState().runs["run-1"]?.nodeOutputs,
    ).toEqual({});
  });

  it("stores the first line as-is then appends subsequent lines with newlines", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().markNodeStarted("run-1", "n1", "exec-1");

    useWorkflowRunStore.getState().appendNodeOutputLine("run-1", "exec-1", "a");
    useWorkflowRunStore.getState().appendNodeOutputLine("run-1", "exec-1", "b");

    expect(
      useWorkflowRunStore.getState().runs["run-1"]?.nodeOutputs["n1"]?.stdout,
    ).toBe("a\nb");
  });
});

describe("workflowRunStore.setNodeOutputResult", () => {
  const result: ExtractedResult = { fields: { x: 1 }, returnValue: 1 };

  it("is a no-op for an unknown run", () => {
    useWorkflowRunStore.getState().setNodeOutputResult("missing", "exec-1", result);
    expect(useWorkflowRunStore.getState().runs["missing"]).toBeUndefined();
  });

  it("is a no-op when the executionId maps to no node", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().setNodeOutputResult("run-1", "exec-x", result);
    expect(useWorkflowRunStore.getState().runs["run-1"]?.nodeOutputs).toEqual({});
  });

  it("sets the result with empty stdout when no output exists yet", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().markNodeStarted("run-1", "n1", "exec-1");
    useWorkflowRunStore.getState().setNodeOutputResult("run-1", "exec-1", result);

    const output = useWorkflowRunStore.getState().runs["run-1"]?.nodeOutputs["n1"];
    expect(output?.stdout).toBe("");
    expect(output?.result).toEqual(result);
  });

  it("preserves existing stdout when attaching a result", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().markNodeStarted("run-1", "n1", "exec-1");
    useWorkflowRunStore.getState().appendNodeOutputLine("run-1", "exec-1", "hi");
    useWorkflowRunStore.getState().setNodeOutputResult("run-1", "exec-1", result);

    const output = useWorkflowRunStore.getState().runs["run-1"]?.nodeOutputs["n1"];
    expect(output?.stdout).toBe("hi");
    expect(output?.result).toEqual(result);
  });
});

describe("workflowRunStore.setExecutionWorkingDir", () => {
  it("records a resolved directory even before the run exists (no run guard)", () => {
    // The `started` event can land before `startRun`; the write must NOT be
    // dropped (the regression that made every step's directory disappear).
    useWorkflowRunStore
      .getState()
      .setExecutionWorkingDir("missing", "exec-1", "/tmp/build");
    expect(getExecutionWorkingDir("exec-1")).toBe("/tmp/build");
  });

  it("records a resolved directory keyed by execution id", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore
      .getState()
      .setExecutionWorkingDir("run-1", "exec-1", "/tmp/build");
    expect(getExecutionWorkingDir("exec-1")).toBe("/tmp/build");
  });

  it("ignores an empty / whitespace-only directory (home-dir fallback)", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().setExecutionWorkingDir("run-1", "exec-1", "");
    useWorkflowRunStore
      .getState()
      .setExecutionWorkingDir("run-1", "exec-2", "   ");
    useWorkflowRunStore
      .getState()
      .setExecutionWorkingDir("run-1", "exec-3", undefined);
    expect(getExecutionWorkingDir("exec-1")).toBeUndefined();
    expect(getExecutionWorkingDir("exec-2")).toBeUndefined();
    expect(getExecutionWorkingDir("exec-3")).toBeUndefined();
  });

  it("trims the recorded directory", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore
      .getState()
      .setExecutionWorkingDir("run-1", "exec-1", "  /srv/app  ");
    expect(getExecutionWorkingDir("exec-1")).toBe("/srv/app");
  });

  it("clearAll drops recorded working dirs", () => {
    useWorkflowRunStore
      .getState()
      .setExecutionWorkingDir("run-1", "exec-1", "/tmp/x");
    useWorkflowRunStore.getState().clearAll();
    expect(getExecutionWorkingDir("exec-1")).toBeUndefined();
  });
});

describe("workflowRunStore.bufferNodeLine", () => {
  it("is a no-op for an unknown run", () => {
    useWorkflowRunStore.getState().bufferNodeLine("missing", "exec-1", logLine("x"));
    expect(useWorkflowRunStore.getState().runs["missing"]).toBeUndefined();
  });

  it("is a no-op when the executionId maps to no node", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().bufferNodeLine("run-1", "exec-x", logLine("x"));
    expect(useWorkflowRunStore.getState().runs["run-1"]?.lineBuffers).toEqual({});
  });

  it("appends lines to a node's buffer", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().markNodeStarted("run-1", "n1", "exec-1");
    useWorkflowRunStore.getState().bufferNodeLine("run-1", "exec-1", logLine("a"));
    useWorkflowRunStore.getState().bufferNodeLine("run-1", "exec-1", logLine("b"));

    expect(
      useWorkflowRunStore.getState().runs["run-1"]?.lineBuffers["n1"],
    ).toEqual([logLine("a"), logLine("b")]);
  });
});

describe("workflowRunStore.takeNodeBuffer", () => {
  it("returns an empty array and changes nothing when nothing is buffered", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    const taken = useWorkflowRunStore.getState().takeNodeBuffer("run-1", "n1");
    expect(taken).toEqual([]);
    expect(useWorkflowRunStore.getState().runs["run-1"]?.lineBuffers).toEqual({});
  });

  it("returns the buffered lines and removes the buffer", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().markNodeStarted("run-1", "n1", "exec-1");
    useWorkflowRunStore.getState().bufferNodeLine("run-1", "exec-1", logLine("a"));

    const taken = useWorkflowRunStore.getState().takeNodeBuffer("run-1", "n1");

    expect(taken).toEqual([logLine("a")]);
    expect(
      useWorkflowRunStore.getState().runs["run-1"]?.lineBuffers["n1"],
    ).toBeUndefined();
  });
});

describe("workflowRunStore.takeAllBuffers", () => {
  it("returns an empty array when there are no buffers", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    expect(useWorkflowRunStore.getState().takeAllBuffers("run-1")).toEqual([]);
  });

  it("returns every buffer as pairs and clears them all", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().markNodeStarted("run-1", "n1", "exec-1");
    useWorkflowRunStore.getState().markNodeStarted("run-1", "n2", "exec-2");
    useWorkflowRunStore.getState().bufferNodeLine("run-1", "exec-1", logLine("a"));
    useWorkflowRunStore.getState().bufferNodeLine("run-1", "exec-2", logLine("b"));

    const pairs = useWorkflowRunStore.getState().takeAllBuffers("run-1");

    expect(pairs).toEqual([
      ["n1", [logLine("a")]],
      ["n2", [logLine("b")]],
    ]);
    expect(useWorkflowRunStore.getState().runs["run-1"]?.lineBuffers).toEqual({});
  });
});

describe("workflowRunStore.finishRun", () => {
  it("is a no-op for an unknown run", () => {
    useWorkflowRunStore.getState().finishRun("missing", "success");
    expect(useWorkflowRunStore.getState().runs["missing"]).toBeUndefined();
  });

  it("applies status/duration/error from the patch", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore
      .getState()
      .finishRun("run-1", "error", { durationMs: 42, error: "boom" });

    const run = useWorkflowRunStore.getState().runs["run-1"];
    expect(run?.status).toBe("error");
    expect(run?.durationMs).toBe(42);
    expect(run?.error).toBe("boom");
    expect(run?.finishedAt).toBeTypeOf("number");
  });

  it("falls back to the run's existing values when no patch is given", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().finishRun("run-1", "success");

    const run = useWorkflowRunStore.getState().runs["run-1"];
    expect(run?.status).toBe("success");
    expect(run?.durationMs).toBeUndefined();
    expect(run?.error).toBeUndefined();
  });
});

describe("workflowRunStore.clearRun / clearAll", () => {
  it("removes a single run and its recent id", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().startRun("run-2", "wf-1");

    useWorkflowRunStore.getState().clearRun("run-1");

    expect(useWorkflowRunStore.getState().runs["run-1"]).toBeUndefined();
    expect(useWorkflowRunStore.getState().runs["run-2"]).toBeDefined();
    expect(useWorkflowRunStore.getState().recentRunIds).toEqual(["run-2"]);
  });

  it("empties both runs and recentRunIds", () => {
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    useWorkflowRunStore.getState().clearAll();

    expect(useWorkflowRunStore.getState().runs).toEqual({});
    expect(useWorkflowRunStore.getState().recentRunIds).toEqual([]);
  });
});
