import { beforeEach, describe, expect, it } from "vitest";

import {
  allowRunSnapshotSubject,
  denyRunSnapshotRun,
  resolveRunSnapshotConsent,
} from "./runAssistantConsent";

function input(overrides?: Partial<Parameters<
  typeof resolveRunSnapshotConsent
>[0]>) {
  return {
    allowAllRuns: false,
    subjectKey: "command:cmd-1",
    runId: "run-1",
    ...overrides,
  };
}

describe("run assistant consent", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("asks once per subject after an explicit subject-level allowance", () => {
    expect(resolveRunSnapshotConsent(input())).toBe("unknown");

    allowRunSnapshotSubject("command:cmd-1");

    expect(resolveRunSnapshotConsent(input())).toBe("allowed");
    expect(
      resolveRunSnapshotConsent(
        input({ runId: "run-2", subjectKey: "command:cmd-1" }),
      ),
    ).toBe("allowed");
  });

  it("denies only the individual denied run and lets a new run ask again", () => {
    denyRunSnapshotRun("run-1");

    expect(resolveRunSnapshotConsent(input())).toBe("denied");
    expect(resolveRunSnapshotConsent(input({ runId: "run-2" }))).toBe("unknown");
  });

  it("lets the global setting override per-subject memory", () => {
    denyRunSnapshotRun("run-1");
    allowRunSnapshotSubject("command:cmd-1");

    expect(resolveRunSnapshotConsent(input({ allowAllRuns: true }))).toBe(
      "allowed",
    );
  });
});
