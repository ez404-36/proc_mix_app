import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../utils/executor", () => ({
  cancelExecution: vi.fn().mockResolvedValue(undefined),
}));

import "../../i18n";
import { useExecutionStore } from "../../stores/executionStore";
import { cancelExecution } from "../../utils/executor";
import { MiniAppActiveProcesses } from "./MiniAppActiveProcesses";

beforeEach(() => {
  useExecutionStore.setState({ executions: {}, recentIds: [] });
  vi.clearAllMocks();
});

describe("MiniAppActiveProcesses", () => {
  it("renders nothing when entries is empty", () => {
    const { container } = render(<MiniAppActiveProcesses entries={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one row per entry with its widget label", () => {
    render(
      <MiniAppActiveProcesses
        entries={[
          { executionId: "e1", widgetLabel: "Connect" },
          { executionId: "e2", widgetLabel: "Disconnect" },
        ]}
      />,
    );
    expect(screen.getByText("Connect")).toBeTruthy();
    expect(screen.getByText("Disconnect")).toBeTruthy();
    expect(document.querySelectorAll(".miniapp-processes__item")).toHaveLength(
      2,
    );
  });

  it("shows a pending placeholder before the pid is known", () => {
    render(
      <MiniAppActiveProcesses
        entries={[{ executionId: "e1", widgetLabel: "Connect" }]}
      />,
    );
    expect(screen.getByText("starting…")).toBeTruthy();
  });

  it("shows the real PID once the execution store has one", () => {
    useExecutionStore.setState({
      executions: {
        e1: {
          id: "e1",
          commandName: "Connect",
          status: "running",
          startedAt: Date.now(),
          log: [],
          pid: 9001,
        },
      },
      recentIds: ["e1"],
    });
    render(
      <MiniAppActiveProcesses
        entries={[{ executionId: "e1", widgetLabel: "Connect" }]}
      />,
    );
    expect(screen.getByText("PID 9001")).toBeTruthy();
  });

  it("Cancel calls cancelExecution with the row's execution id", () => {
    render(
      <MiniAppActiveProcesses
        entries={[{ executionId: "e1", widgetLabel: "Connect" }]}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(cancelExecution).toHaveBeenCalledWith("e1");
  });

  it("shows the entry count", () => {
    render(
      <MiniAppActiveProcesses
        entries={[
          { executionId: "e1", widgetLabel: "Connect" },
          { executionId: "e2", widgetLabel: "Disconnect" },
          { executionId: "e3", widgetLabel: "Restart" },
        ]}
      />,
    );
    expect(screen.getByText("3")).toBeTruthy();
  });
});
