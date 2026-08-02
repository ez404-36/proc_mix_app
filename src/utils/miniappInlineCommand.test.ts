import { describe, expect, it } from "vitest";

import type { Command, MiniAppWidget, VariableSpec } from "../types";
import {
  buildInlineCommand,
  collectArtifactSpecSources,
  mergeArtifactVariableSpecs,
  withArtifactVariableSpecs,
  type ArtifactSpecSource,
  type InlineAction,
} from "./miniappInlineCommand";

function inline(overrides: Partial<InlineAction> = {}): InlineAction {
  return {
    kind: "inline",
    name: "Connect",
    script: "openvpn3 --config ${configPath}",
    ...overrides,
  };
}

function artifactWidget(
  overrides: Partial<Extract<MiniAppWidget, { kind: "artifact" }>> = {},
): MiniAppWidget {
  return {
    id: "w-1",
    kind: "artifact",
    layout: { x: 0, y: 0, w: 200, h: 56 },
    name: "configPath",
    label: "Config",
    value: "/etc/openvpn/client.ovpn",
    variant: "path",
    ...overrides,
  };
}

function libraryCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: "cmd-1",
    name: "Connect",
    script: "openvpn3 --config ${configPath}",
    runAsAdmin: false,
    tags: [],
    favorite: false,
    createdAt: "2026-07-31T00:00:00Z",
    updatedAt: "2026-07-31T00:00:00Z",
    runCount: 0,
    ...overrides,
  };
}

describe("collectArtifactSpecSources", () => {
  it("keeps only artifact widgets", () => {
    const widgets: MiniAppWidget[] = [
      {
        id: "w-btn",
        kind: "button",
        layout: { x: 0, y: 0, w: 100, h: 40 },
        label: "Run",
        action: { kind: "commandRef", commandId: "c1" },
      },
      artifactWidget(),
    ];
    expect(collectArtifactSpecSources(widgets)).toEqual([
      {
        name: "configPath",
        value: "/etc/openvpn/client.ovpn",
        variant: "path",
      },
    ]);
  });

  it("drops an artifact with an empty name (it cannot be referenced)", () => {
    expect(collectArtifactSpecSources([artifactWidget({ name: "" })])).toEqual(
      [],
    );
  });

  it("drops an artifact whose name is not a valid identifier", () => {
    expect(
      collectArtifactSpecSources([
        artifactWidget({ name: "2foo" }),
        artifactWidget({ id: "w-2", name: "my-path" }),
        artifactWidget({ id: "w-3", name: "has space" }),
      ]),
    ).toEqual([]);
  });

  it("collapses a duplicate name to the FIRST occurrence", () => {
    const sources = collectArtifactSpecSources([
      artifactWidget({ value: "first" }),
      artifactWidget({ id: "w-2", value: "second" }),
    ]);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.value).toBe("first");
  });
});

describe("mergeArtifactVariableSpecs", () => {
  const artifacts: ArtifactSpecSource[] = [
    { name: "configPath", value: "/etc/a.ovpn", variant: "path" },
    { name: "token", value: "s3cr3t", variant: "secret" },
    { name: "region", value: "eu", variant: "text" },
  ];

  it("synthesizes one spec per artifact when nothing is declared", () => {
    expect(mergeArtifactVariableSpecs(undefined, artifacts)).toEqual([
      { name: "configPath", defaultValue: "/etc/a.ovpn" },
      { name: "token", defaultValue: "s3cr3t", sensitive: true },
      { name: "region", defaultValue: "eu" },
    ]);
  });

  it("marks ONLY a `secret` artifact as sensitive (drives Rust redaction)", () => {
    const specs = mergeArtifactVariableSpecs(undefined, artifacts);
    const bySensitivity = specs.filter((s) => s.sensitive === true);
    expect(bySensitivity.map((s) => s.name)).toEqual(["token"]);
  });

  it("does NOT clobber a spec the user already declared with the same name", () => {
    const declared: VariableSpec[] = [
      {
        name: "configPath",
        defaultValue: "/user/declared",
        promptAtRuntime: true,
        description: "Pick a config",
      },
    ];
    const specs = mergeArtifactVariableSpecs(declared, artifacts);
    expect(specs[0]).toEqual(declared[0]);
    expect(specs.map((s) => s.name)).toEqual([
      "configPath",
      "token",
      "region",
    ]);
  });

  it("does not mutate the declared array", () => {
    const declared: VariableSpec[] = [{ name: "other", defaultValue: "x" }];
    mergeArtifactVariableSpecs(declared, artifacts);
    expect(declared).toHaveLength(1);
  });

  it("preserves an empty-string default (a valid, prompt-free default)", () => {
    const specs = mergeArtifactVariableSpecs(undefined, [
      { name: "configPath", value: "", variant: "path" },
    ]);
    // `defaultValue: ""` must be PRESENT — `undefined` would trigger a
    // run-time prompt instead of degrading silently.
    expect(specs[0]).toEqual({ name: "configPath", defaultValue: "" });
    expect(specs[0]).toHaveProperty("defaultValue");
  });
});

describe("buildInlineCommand", () => {
  it("synthesizes VariableSpecs from the panel's artifacts", () => {
    const cmd = buildInlineCommand(inline(), [
      { name: "configPath", value: "/etc/a.ovpn", variant: "path" },
    ]);
    expect(cmd.variables).toEqual([
      { name: "configPath", defaultValue: "/etc/a.ovpn" },
    ]);
  });

  it("marks a secret artifact sensitive so Rust redacts it", () => {
    const cmd = buildInlineCommand(inline(), [
      { name: "token", value: "s3cr3t", variant: "secret" },
    ]);
    expect(cmd.variables).toEqual([
      { name: "token", defaultValue: "s3cr3t", sensitive: true },
    ]);
  });

  it("keeps the action's own spec and appends the rest", () => {
    const declared: VariableSpec[] = [
      { name: "configPath", defaultValue: "/declared" },
    ];
    const cmd = buildInlineCommand(inline({ variables: declared }), [
      { name: "configPath", value: "/artifact", variant: "path" },
      { name: "region", value: "eu", variant: "text" },
    ]);
    expect(cmd.variables).toEqual([
      { name: "configPath", defaultValue: "/declared" },
      { name: "region", defaultValue: "eu" },
    ]);
  });

  it("omits `variables` entirely when there is nothing to declare", () => {
    const cmd = buildInlineCommand(inline(), []);
    expect(cmd).not.toHaveProperty("variables");
  });

  it("copies the execution contract verbatim and mints a fresh id", () => {
    const action = inline({
      shell: "bash",
      args: ["-l"],
      workingDir: "/tmp",
      env: { A: "1" },
      runAsAdmin: true,
    });
    const a = buildInlineCommand(action);
    const b = buildInlineCommand(action);
    expect(a.script).toBe(action.script);
    expect(a.shell).toBe("bash");
    expect(a.args).toEqual(["-l"]);
    expect(a.workingDir).toBe("/tmp");
    expect(a.env).toEqual({ A: "1" });
    expect(a.runAsAdmin).toBe(true);
    expect(a.id).not.toBe(b.id);
  });

  it("defaults runAsAdmin to false when the action omits it", () => {
    expect(buildInlineCommand(inline()).runAsAdmin).toBe(false);
  });
});

describe("withArtifactVariableSpecs", () => {
  it("returns the SAME reference when there are no artifacts", () => {
    const cmd = libraryCommand();
    expect(withArtifactVariableSpecs(cmd, [])).toBe(cmd);
  });

  it("returns the SAME reference when every artifact name is declared", () => {
    const cmd = libraryCommand({
      variables: [{ name: "configPath", defaultValue: "/declared" }],
    });
    expect(
      withArtifactVariableSpecs(cmd, [
        { name: "configPath", value: "/artifact", variant: "path" },
      ]),
    ).toBe(cmd);
  });

  it("returns a COPY carrying the merged specs, never mutating the stored command", () => {
    const cmd = libraryCommand();
    const merged = withArtifactVariableSpecs(cmd, [
      { name: "configPath", value: "/artifact", variant: "path" },
    ]);
    expect(merged).not.toBe(cmd);
    expect(cmd.variables).toBeUndefined();
    expect(merged.variables).toEqual([
      { name: "configPath", defaultValue: "/artifact" },
    ]);
  });

  it("keeps the command's own declared spec ahead of a synthesized one", () => {
    const cmd = libraryCommand({
      variables: [{ name: "region", defaultValue: "us" }],
    });
    const merged = withArtifactVariableSpecs(cmd, [
      { name: "configPath", value: "/artifact", variant: "path" },
    ]);
    expect(merged.variables).toEqual([
      { name: "region", defaultValue: "us" },
      { name: "configPath", defaultValue: "/artifact" },
    ]);
  });
});
