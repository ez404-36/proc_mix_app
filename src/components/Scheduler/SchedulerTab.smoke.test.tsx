// Smoke test for the Scheduler view (a top-level sidebar view since the
// scheduler was promoted out of the Library tab strip).
//
// We mock the repository surfaces (IPC) so the test never crosses the Tauri
// boundary, but the stores, services, and SchedulerTab component all run
// unchanged. The ContextMenu provider is mounted so `useContextMenu`
// resolves inside any child that needs it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../utils/scheduleRepository", () => ({
  listSchedulesFromDb: vi.fn().mockResolvedValue([]),
  upsertScheduleInDb: vi.fn().mockResolvedValue(undefined),
  deleteScheduleInDb: vi.fn().mockResolvedValue(undefined),
  setScheduleEnabledInDb: vi.fn().mockResolvedValue(undefined),
  runScheduleNowInDb: vi.fn().mockResolvedValue(undefined),
  previewNextRuns: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../utils/commandRepository", () => ({
  upsertCommandInDb: vi.fn().mockResolvedValue(undefined),
  deleteCommandInDb: vi.fn().mockResolvedValue(undefined),
  listCommandsFromDb: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../utils/workflowRepository", () => ({
  upsertWorkflowInDb: vi.fn().mockResolvedValue(undefined),
  deleteWorkflowInDb: vi.fn().mockResolvedValue(undefined),
  listWorkflowsFromDb: vi.fn().mockResolvedValue([]),
}));

vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn() },
}));

import "../../i18n";
import { ContextMenuProvider } from "../ContextMenu";
import { useScheduleStore } from "../../stores/scheduleStore";
import { useUIStore } from "../../stores/uiStore";
import type { Schedule } from "../../types";
import { SchedulerTab } from "./SchedulerTab";

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "sch-1",
    name: "Nightly backup",
    enabled: true,
    targetKind: "command",
    targetId: "c-1",
    cron: "0 2 * * *",
    variableValues: {},
    skipIfRunning: false,
    captureOutput: true,
    catchUpPolicy: "none",
    maxRetries: 0,
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    runCount: 0,
    ...overrides,
  };
}

function resetStores(): void {
  useScheduleStore.setState({ schedules: [], hydrated: true });
  useUIStore.setState({ currentView: "scheduler", scheduleEditorTarget: null });
}

function renderScheduler(): void {
  render(
    <ContextMenuProvider>
      <SchedulerTab />
    </ContextMenuProvider>,
  );
}

beforeEach(() => {
  resetStores();
});
afterEach(() => {
  resetStores();
});

describe("Scheduler view", () => {
  it("shows the Scheduler UI and the empty-state", () => {
    renderScheduler();

    expect(
      screen.getByText(
        "Schedules run only while ProcMix is running (including minimized to the tray).",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "No schedules yet. Create one to run a command or workflow automatically.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "New schedule" })).toBeTruthy();
  });

  it("with a schedule shows its card and cron", () => {
    useScheduleStore.setState({
      schedules: [makeSchedule({ name: "Nightly backup" })],
      hydrated: true,
    });
    renderScheduler();

    expect(screen.getByText("Nightly backup")).toBeTruthy();
    expect(screen.getByText("0 2 * * *")).toBeTruthy();
  });

  it("New schedule button is always enabled", () => {
    renderScheduler();

    const newButton = screen.getByRole("button", { name: "New schedule" });
    expect((newButton as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Scheduler view — navigation to the editor page", () => {
  it("New schedule navigates to the scheduler-editor view with a create target", () => {
    renderScheduler();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    });

    expect(useUIStore.getState().currentView).toBe("scheduler-editor");
    expect(useUIStore.getState().scheduleEditorTarget).toEqual({
      mode: "create",
      scheduleId: null,
    });
  });

  it("View → Edit navigates with an edit target carrying the id", () => {
    useScheduleStore.setState({
      schedules: [makeSchedule({ id: "sch-9", name: "Nightly backup" })],
      hydrated: true,
    });
    renderScheduler();

    // Open the preview modal from the card's View button, then Edit from it.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "View" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    });

    expect(useUIStore.getState().currentView).toBe("scheduler-editor");
    expect(useUIStore.getState().scheduleEditorTarget).toEqual({
      mode: "edit",
      scheduleId: "sch-9",
    });
  });
});

describe("Scheduler card — context menu", () => {
  it("right-click → Edit navigates to the editor with an edit target", () => {
    useScheduleStore.setState({
      schedules: [makeSchedule({ id: "sch-7", name: "Nightly backup" })],
      hydrated: true,
    });
    renderScheduler();

    act(() => {
      fireEvent.contextMenu(screen.getByText("Nightly backup"));
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    });

    expect(useUIStore.getState().currentView).toBe("scheduler-editor");
    expect(useUIStore.getState().scheduleEditorTarget).toEqual({
      mode: "edit",
      scheduleId: "sch-7",
    });
  });

  it("right-click → Delete opens the confirm dialog", () => {
    useScheduleStore.setState({
      schedules: [makeSchedule({ id: "sch-8", name: "Nightly backup" })],
      hydrated: true,
    });
    renderScheduler();

    act(() => {
      fireEvent.contextMenu(screen.getByText("Nightly backup"));
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    });

    expect(
      screen.getByRole("dialog", { name: "Delete schedule?" }),
    ).toBeTruthy();
  });
});
