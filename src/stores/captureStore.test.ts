import { beforeEach, describe, expect, it } from "vitest";

import { MAX_CAPTURE_ROWS, useCaptureStore } from "./captureStore";
import type { CaptureEvent } from "../types/capture";

function event(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    pid: 100,
    ppid: 1,
    image: "C:/tools/git.exe",
    commandLine: "git status",
    timestamp: "0",
    ...overrides,
  };
}

beforeEach(() => {
  useCaptureStore.setState({
    recording: false,
    rows: [],
    selectedIds: new Set<string>(),
  });
});

describe("captureStore.addEvent", () => {
  it("appends a row with a redacted command line", () => {
    useCaptureStore
      .getState()
      .addEvent(event({ commandLine: "mysql --password=hunter2" }));
    const { rows } = useCaptureStore.getState();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.commandLine).toBe("mysql --password=***");
    expect(rows[0]?.commandLine).not.toContain("hunter2");
  });

  it("assigns a unique id to each row", () => {
    const add = useCaptureStore.getState().addEvent;
    add(event());
    add(event());
    const ids = useCaptureStore.getState().rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("caps retained rows at MAX_CAPTURE_ROWS, dropping oldest", () => {
    const add = useCaptureStore.getState().addEvent;
    for (let i = 0; i < MAX_CAPTURE_ROWS + 10; i++) {
      add(event({ commandLine: `cmd ${i}` }));
    }
    const { rows } = useCaptureStore.getState();
    expect(rows).toHaveLength(MAX_CAPTURE_ROWS);
    // The oldest ("cmd 0") should have been evicted; the newest kept.
    expect(rows[0]?.commandLine).toBe("cmd 10");
    expect(rows[rows.length - 1]?.commandLine).toBe(
      `cmd ${MAX_CAPTURE_ROWS + 9}`,
    );
  });

  it("drops selection for rows evicted by the cap", () => {
    const { addEvent, toggleSelected } = useCaptureStore.getState();
    addEvent(event({ commandLine: "first" }));
    const firstId = useCaptureStore.getState().rows[0]!.id;
    toggleSelected(firstId);
    expect(useCaptureStore.getState().selectedIds.has(firstId)).toBe(true);

    for (let i = 0; i < MAX_CAPTURE_ROWS; i++) {
      useCaptureStore.getState().addEvent(event({ commandLine: `c ${i}` }));
    }
    // The first row is gone; its selection must be gone too.
    expect(useCaptureStore.getState().selectedIds.has(firstId)).toBe(false);
  });
});

describe("captureStore selection", () => {
  it("toggleSelected flips membership", () => {
    useCaptureStore.getState().addEvent(event());
    const id = useCaptureStore.getState().rows[0]!.id;
    const { toggleSelected } = useCaptureStore.getState();
    toggleSelected(id);
    expect(useCaptureStore.getState().selectedIds.has(id)).toBe(true);
    toggleSelected(id);
    expect(useCaptureStore.getState().selectedIds.has(id)).toBe(false);
  });

  it("setAllSelected(true) selects every row, false clears", () => {
    const add = useCaptureStore.getState().addEvent;
    add(event());
    add(event());
    useCaptureStore.getState().setAllSelected(true);
    expect(useCaptureStore.getState().selectedIds.size).toBe(2);
    useCaptureStore.getState().setAllSelected(false);
    expect(useCaptureStore.getState().selectedIds.size).toBe(0);
  });
});

describe("captureStore.clear", () => {
  it("wipes rows and selection (ephemeral guarantee)", () => {
    const { addEvent, toggleSelected, clear } = useCaptureStore.getState();
    addEvent(event());
    toggleSelected(useCaptureStore.getState().rows[0]!.id);
    clear();
    expect(useCaptureStore.getState().rows).toHaveLength(0);
    expect(useCaptureStore.getState().selectedIds.size).toBe(0);
  });
});
