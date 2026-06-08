// Behavioral test for the "Filters" toggle on the History header:
//
//   - the filter panel is HIDDEN on initial mount
//   - clicking "Filters" reveals the panel
//   - clicking again hides it
//   - when a filter is active in the store and the panel is hidden,
//     the toggle shows a numeric badge so the active state isn't
//     invisible
//
// The smoke test next door already exercises the full record→render
// pipeline; here we only need to mount the History component and
// drive the local toggle state, so the IPC repository is mocked to
// a no-op.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../utils/historyRepository", () => ({
  listHistoryFromDb: vi
    .fn()
    .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
  recordHistoryEventInDb: vi.fn().mockResolvedValue("evt-1"),
  getHistoryEventFromDb: vi.fn().mockResolvedValue(null),
  updateRunHistoryEventInDb: vi.fn().mockResolvedValue(undefined),
  clearHistoryInDb: vi.fn().mockResolvedValue(undefined),
  deleteHistoryEventInDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn() },
}));

import "../../i18n";
import { HISTORY_PAGE_SIZE, useHistoryStore } from "../../stores/historyStore";
import { History } from "./History";

function resetStore(): void {
  useHistoryStore.setState({
    items: [],
    total: 0,
    page: 1,
    pageSize: HISTORY_PAGE_SIZE,
    filter: { kinds: [], nameQuery: "", failedOnly: false },
    loading: false,
    error: undefined,
  });
}

beforeEach(() => {
  resetStore();
});
afterEach(() => {
  resetStore();
});

describe("History — Filters toggle", () => {
  it("filter panel is hidden on initial mount", async () => {
    await act(async () => {
      render(<History />);
      await Promise.resolve();
    });
    // The panel container has a stable id we reference from
    // aria-controls; querying by id ensures we test the actual
    // DOM presence/absence, not just a class flip.
    expect(document.getElementById("history-filter-panel")).toBeNull();
    // The kinds chip group lives inside the panel, so it must also
    // be absent (defense in depth — catches the case where the
    // wrapper renders empty).
    expect(screen.queryByLabelText("Type")).toBeNull();
  });

  it("clicking the toggle reveals the panel; clicking again hides it", async () => {
    await act(async () => {
      render(<History />);
      await Promise.resolve();
    });
    const toggle = screen.getByRole("button", { name: /^Filters$/ });
    // Reveal.
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(document.getElementById("history-filter-panel")).not.toBeNull();
    expect(screen.getByLabelText("Type")).toBeTruthy();
    // After reveal the button label flips to "Hide filters".
    const hideToggle = screen.getByRole("button", { name: /Hide filters/ });
    await act(async () => {
      fireEvent.click(hideToggle);
    });
    expect(document.getElementById("history-filter-panel")).toBeNull();
  });

  it("badge with active-filter count appears when filters are set and panel is hidden", async () => {
    // Pre-populate two filter dimensions BEFORE mount so the badge
    // is visible from the first render — easier to assert.
    useHistoryStore.setState({
      filter: {
        kinds: ["commandRun"],
        nameQuery: "deploy",
        failedOnly: false,
      },
    });
    await act(async () => {
      render(<History />);
      await Promise.resolve();
    });
    const toggle = screen.getByRole("button", { name: /Filters/ });
    // Two active dimensions → badge shows "2".
    const badge = toggle.querySelector(".btn__badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("2");
    // Panel still hidden by default.
    expect(document.getElementById("history-filter-panel")).toBeNull();
  });

  it("no badge when no filters are active", async () => {
    await act(async () => {
      render(<History />);
      await Promise.resolve();
    });
    const toggle = screen.getByRole("button", { name: /^Filters$/ });
    expect(toggle.querySelector(".btn__badge")).toBeNull();
  });
});
