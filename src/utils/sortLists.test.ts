import { describe, expect, it } from "vitest";
import type { Command, Schedule, Workflow } from "../types";
import { sortCommands, sortSchedules, sortWorkflows } from "./sortLists";

function cmd(overrides: Partial<Command> = {}): Command {
  return {
    id: overrides.id ?? "c1",
    name: "Build",
    script: "echo build",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    runAsAdmin: false,
    ...overrides,
  };
}

function wf(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: overrides.id ?? "w1",
    name: "Deploy",
    nodes: [],
    edges: [],
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    ...overrides,
  };
}

function sched(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: overrides.id ?? "s1",
    name: "Nightly",
    enabled: true,
    targetKind: "command",
    targetId: "c1",
    cron: "0 0 * * *",
    variableValues: {},
    skipIfRunning: false,
    captureOutput: true,
    catchUpPolicy: "none",
    maxRetries: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    ...overrides,
  };
}

/** Identity name resolver: commands here use literal `name`. */
const literalName = (c: Command): string => c.name;

describe("sortCommands", () => {
  it("sorts by createdAt descending (newest first)", () => {
    const items = [
      cmd({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
      cmd({ id: "b", createdAt: "2026-03-01T00:00:00.000Z" }),
      cmd({ id: "c", createdAt: "2026-02-01T00:00:00.000Z" }),
    ];
    const sorted = sortCommands(
      items,
      { key: "createdAt", dir: "desc" },
      literalName,
    );
    expect(sorted.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts by createdAt ascending (oldest first)", () => {
    const items = [
      cmd({ id: "a", createdAt: "2026-03-01T00:00:00.000Z" }),
      cmd({ id: "b", createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const sorted = sortCommands(
      items,
      { key: "createdAt", dir: "asc" },
      literalName,
    );
    expect(sorted.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("sorts Cyrillic names А-Я (asc) case-insensitively", () => {
    const items = [
      cmd({ id: "a", name: "Яндекс" }),
      cmd({ id: "b", name: "база" }),
      cmd({ id: "c", name: "Алиса" }),
    ];
    const sorted = sortCommands(
      items,
      { key: "name", dir: "asc" },
      literalName,
    );
    expect(sorted.map((c) => c.name)).toEqual(["Алиса", "база", "Яндекс"]);
  });

  it("sorts names Я-А when descending", () => {
    const items = [
      cmd({ id: "a", name: "Алиса" }),
      cmd({ id: "b", name: "Яндекс" }),
    ];
    const sorted = sortCommands(
      items,
      { key: "name", dir: "desc" },
      literalName,
    );
    expect(sorted.map((c) => c.name)).toEqual(["Яндекс", "Алиса"]);
  });

  it("uses the nameOf resolver for name sorting (localized labels)", () => {
    const items = [
      cmd({ id: "a", name: "ignored-a", nameKey: "k.a" }),
      cmd({ id: "b", name: "ignored-b", nameKey: "k.b" }),
    ];
    const resolver = (c: Command): string => (c.id === "a" ? "Zebra" : "Apple");
    const sorted = sortCommands(items, { key: "name", dir: "asc" }, resolver);
    expect(sorted.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("breaks ties on equal key by name then id, independent of direction", () => {
    const items = [
      cmd({ id: "z", name: "Same", createdAt: "2026-01-01T00:00:00.000Z" }),
      cmd({ id: "a", name: "Same", createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const asc = sortCommands(
      items,
      { key: "createdAt", dir: "asc" },
      literalName,
    );
    const desc = sortCommands(
      items,
      { key: "createdAt", dir: "desc" },
      literalName,
    );
    expect(asc.map((c) => c.id)).toEqual(["a", "z"]);
    expect(desc.map((c) => c.id)).toEqual(["a", "z"]);
  });

  it("does not mutate the input array", () => {
    const items = [cmd({ id: "b" }), cmd({ id: "a" })];
    const snapshot = items.map((c) => c.id);
    sortCommands(items, { key: "name", dir: "asc" }, literalName);
    expect(items.map((c) => c.id)).toEqual(snapshot);
  });

  it("returns an empty array unchanged", () => {
    expect(sortCommands([], { key: "name", dir: "asc" }, literalName)).toEqual(
      [],
    );
  });
});

describe("sortWorkflows", () => {
  it("sorts by name ascending", () => {
    const items = [
      wf({ id: "a", name: "Build" }),
      wf({ id: "b", name: "Apply" }),
    ];
    const sorted = sortWorkflows(items, { key: "name", dir: "asc" });
    expect(sorted.map((w) => w.name)).toEqual(["Apply", "Build"]);
  });

  it("sorts by createdAt descending", () => {
    const items = [
      wf({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
      wf({ id: "b", createdAt: "2026-02-01T00:00:00.000Z" }),
    ];
    const sorted = sortWorkflows(items, { key: "createdAt", dir: "desc" });
    expect(sorted.map((w) => w.id)).toEqual(["b", "a"]);
  });
});

describe("sortSchedules", () => {
  it("sorts by runCount ascending", () => {
    const items = [
      sched({ id: "a", runCount: 5 }),
      sched({ id: "b", runCount: 1 }),
      sched({ id: "c", runCount: 3 }),
    ];
    const sorted = sortSchedules(items, { key: "runCount", dir: "asc" });
    expect(sorted.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts by runCount descending", () => {
    const items = [
      sched({ id: "a", runCount: 1 }),
      sched({ id: "b", runCount: 9 }),
    ];
    const sorted = sortSchedules(items, { key: "runCount", dir: "desc" });
    expect(sorted.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("sorts by name and falls back to id on equal runCount", () => {
    const items = [
      sched({ id: "z", name: "Same", runCount: 2 }),
      sched({ id: "a", name: "Same", runCount: 2 }),
    ];
    const sorted = sortSchedules(items, { key: "runCount", dir: "desc" });
    expect(sorted.map((s) => s.id)).toEqual(["a", "z"]);
  });
});
