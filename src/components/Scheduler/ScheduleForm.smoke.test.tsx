// Smoke test for the structured recurrence editor in ScheduleForm:
//
//   - switching the recurrence-type dropdown reveals that type's parameter
//     sub-form (e.g. the weekday chips for "weekly", the cron input for
//     "custom");
//   - "weekly" with no selected days blocks Save and shows the hint;
//   - editing a schedule whose cron is a known shape opens the matching
//     structured type; an unrecognised cron opens the Custom expression mode.
//
// previewNextRuns (the only IPC the form touches) is mocked so the test never
// crosses the Tauri boundary; the recurrence model + form logic run unchanged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const previewNextRuns = vi.fn().mockResolvedValue([]);
vi.mock("../../utils/scheduleRepository", () => ({
  listSchedulesFromDb: vi.fn().mockResolvedValue([]),
  upsertScheduleInDb: vi.fn().mockResolvedValue(undefined),
  deleteScheduleInDb: vi.fn().mockResolvedValue(undefined),
  setScheduleEnabledInDb: vi.fn().mockResolvedValue(undefined),
  previewNextRuns: (...args: unknown[]) => previewNextRuns(...args),
}));

vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn() },
}));

import "../../i18n";
import { useCommandStore } from "../../stores/commandStore";
import type { Command, Schedule } from "../../types";
import { ScheduleForm } from "./ScheduleForm";

// The custom Dropdown calls scrollIntoView on its active option; jsdom does
// not implement it. Stub so the popup can open under the test runner.
HTMLElement.prototype.scrollIntoView = (): void => {};

/** Open the recurrence-type dropdown and pick the option with `label`. */
function selectRecurrence(label: string): void {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "When" }));
  });
  act(() => {
    fireEvent.click(screen.getByRole("option", { name: label }));
  });
}

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: "c-1",
    name: "Build",
    script: "echo build",
    tags: [],
    favorite: false,
    createdAt: "2026-06-03T00:00:00Z",
    updatedAt: "2026-06-03T00:00:00Z",
    runCount: 0,
    runAsAdmin: false,
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "sch-1",
    name: "Nightly",
    enabled: true,
    targetKind: "command",
    targetId: "c-1",
    cron: "0 2 * * *",
    variableValues: {},
    skipIfRunning: false,
    captureOutput: true,
    catchUpPolicy: "none",
    maxRetries: 0,
    createdAt: "2026-06-03T00:00:00Z",
    updatedAt: "2026-06-03T00:00:00Z",
    runCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  useCommandStore.setState({
    commands: [makeCommand()],
    favorites: [],
    seedsInitialized: true,
    hydrated: true,
  });
  previewNextRuns.mockClear();
});
afterEach(() => {
  useCommandStore.setState({ commands: [], favorites: [], hydrated: true });
});

describe("ScheduleForm recurrence editor", () => {
  it("defaults to Daily and shows the time field", () => {
    render(<ScheduleForm schedule={null} onClose={vi.fn()} />);
    // The daily "At time" label is present.
    expect(screen.getByText("At time")).toBeTruthy();
  });

  it("switching to Custom reveals the raw cron input", () => {
    render(<ScheduleForm schedule={null} onClose={vi.fn()} />);

    selectRecurrence("Custom cron expression");

    expect(screen.getByLabelText("Cron expression")).toBeTruthy();
  });

  it("Weekly with no days selected shows the hint", () => {
    render(<ScheduleForm schedule={null} onClose={vi.fn()} />);

    selectRecurrence("Weekly");
    // Default weekly seeds Monday; clear it by toggling Mon off.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Mon", pressed: true }));
    });

    expect(screen.getByText("Select at least one day.")).toBeTruthy();
  });

  it("edit mode opens the matching structured type (daily)", () => {
    render(
      <ScheduleForm
        schedule={makeSchedule({ cron: "30 9 * * *" })}
        onClose={vi.fn()}
      />,
    );
    // A daily cron resolves to the Daily type, so the time field shows.
    expect(screen.getByText("At time")).toBeTruthy();
  });

  it("edit mode falls back to Custom for an unrecognised cron", () => {
    render(
      <ScheduleForm
        schedule={makeSchedule({ cron: "0 9-17 * * *" })}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("Cron expression") as HTMLInputElement;
    expect(input.value).toBe("0 9-17 * * *");
  });

  it("blocks Save until a no-default variable is filled in", () => {
    // The command requires `token` (no default) and offers `dir` (has one).
    useCommandStore.setState({
      commands: [
        makeCommand({
          variables: [
            { name: "token" },
            { name: "dir", defaultValue: "/tmp" },
          ],
        }),
      ],
      favorites: [],
      seedsInitialized: true,
      hydrated: true,
    });
    // Edit an existing schedule for that command with no captured values, so
    // the required `token` starts blank.
    render(
      <ScheduleForm
        schedule={makeSchedule({ cron: "30 9 * * *", variableValues: {} })}
        onClose={vi.fn()}
      />,
    );

    const save = screen.getByRole("button", { name: "Save" });
    // Blank required variable -> Save disabled + the explanatory error shows.
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(
        "Fill in every required variable (marked *) before saving — a scheduled run cannot prompt for them.",
      ),
    ).toBeTruthy();

    // The blank required variable is the only field marked aria-invalid.
    const tokenInput = document.querySelector('input[aria-invalid="true"]');
    expect(tokenInput).not.toBeNull();
    // Fill it -> Save enabled.
    act(() => {
      fireEvent.change(tokenInput as HTMLInputElement, {
        target: { value: "secret" },
      });
    });
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });
});
