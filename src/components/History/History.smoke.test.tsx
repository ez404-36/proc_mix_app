// End-to-end smoke test for the History view:
//
//   user creates a command → commandActions.createCommand calls
//   recordHistoryEventInDb (via the mocked repository), but the same
//   mocked repository's `listHistoryFromDb` returns the same event
//   back when the History store loads. The rendered <History />
//   surface shows the row with the localized title.
//
// We mock the repository surface as a tiny in-memory store so the
// test never crosses the Tauri boundary, but every other module
// (commandActions, commandStore, historyStore, History/HistoryRow)
// runs unchanged. This is the parent-plan's D2 "smoke test" gate.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

// Repository mocks share a single in-memory list so the recorder and
// the lister exchange real events. This is what makes the test a
// "smoke" of the full flow rather than two independent stubs.
const eventBus: { events: import("../../types").HistoryEvent[] } = {
  events: [],
};

vi.mock("../../utils/historyRepository", () => ({
  listHistoryFromDb: vi.fn(async (_filter, page, pageSize) => {
    const start = (page - 1) * pageSize;
    const slice = eventBus.events.slice(start, start + pageSize);
    return {
      items: slice,
      total: eventBus.events.length,
      page,
      pageSize,
    };
  }),
  recordHistoryEventInDb: vi.fn(async (event) => {
    eventBus.events.unshift(event);
    return event.id;
  }),
  getHistoryEventFromDb: vi.fn(async (id) =>
    eventBus.events.find((e) => e.id === id) ?? null,
  ),
  updateRunHistoryEventInDb: vi.fn().mockResolvedValue(undefined),
  clearHistoryInDb: vi.fn(async () => {
    eventBus.events.length = 0;
  }),
  deleteHistoryEventInDb: vi.fn(async (id) => {
    eventBus.events = eventBus.events.filter((e) => e.id !== id);
  }),
}));

// commandRepository stubs so the command store doesn't try to call
// real IPC during the create path.
vi.mock("../../utils/commandRepository", () => ({
  upsertCommandInDb: vi.fn().mockResolvedValue(undefined),
  deleteCommandInDb: vi.fn().mockResolvedValue(undefined),
  listCommandsFromDb: vi.fn().mockResolvedValue([]),
}));

// Silence Arco's Message side effects.
vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn() },
}));

import "../../i18n";
import { createCommand } from "../../services/commandActions";
import { useCommandStore } from "../../stores/commandStore";
import { HISTORY_PAGE_SIZE, useHistoryStore } from "../../stores/historyStore";
import { historyEventSubjectId } from "../../types";
import { History } from "./History";

function resetStores(): void {
  eventBus.events = [];
  useCommandStore.setState({
    commands: [],
    favorites: [],
    seedsInitialized: false,
    hydrated: true,
  });
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
  resetStores();
});
afterEach(() => {
  resetStores();
});

describe("History smoke: record → read → render", () => {
  it(
    "creating a command via commandActions surfaces in the History view " +
      "after load",
    async () => {
      // Step 1: user creates a command.
      const created = createCommand({
        name: "Smoke Greet",
        script: "echo hi",
        tags: [],
        favorite: false,
        runAsAdmin: false,
      });
      // Wait one tick so the fire-and-forget recordHistoryEventInDb
      // call resolves and the eventBus is populated.
      await act(async () => {
        await Promise.resolve();
      });
      expect(eventBus.events).toHaveLength(1);
      expect(eventBus.events[0]?.kind).toBe("commandCreated");

      // Step 2: render the History view. Mount triggers `load()`.
      await act(async () => {
        render(<History />);
        await Promise.resolve();
      });

      // Step 3: the row shows the localized "Created \"Smoke Greet\"".
      // We assert the substring rather than the whole string so the
      // test stays robust against trivial copy edits.
      const row = await screen.findByText(/Created command "Smoke Greet"/i);
      expect(row).toBeTruthy();
      // Sanity: the subject id in the row matches the created command.
      const recorded = eventBus.events[0];
      expect(recorded && historyEventSubjectId(recorded)).toBe(created.id);
    },
  );

  it("empty history shows the empty-state message", async () => {
    await act(async () => {
      render(<History />);
      await Promise.resolve();
    });
    expect(screen.getByText("No history yet.")).toBeTruthy();
  });
});
