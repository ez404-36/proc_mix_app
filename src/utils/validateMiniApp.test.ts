import { describe, expect, it } from "vitest";

import type { MiniApp, MiniAppWidget, WidgetLayout } from "../types";
import {
  FIELD_ARTIFACT_NAME,
  FIELD_ARTIFACT_PERSIST,
  FIELD_ARTIFACT_VALUE,
  FIELD_LABEL,
  FIELD_NAME,
  FIELD_TEXT_CONTENT,
  FIELD_TEXT_FONT_SIZE,
  collectValidArtifactNames,
  findIssue,
  hasWidgetIssue,
  validateMiniApp,
} from "./validateMiniApp";

const LAYOUT: WidgetLayout = { x: 0, y: 0, w: 100, h: 40 };

function makeDraft(widgets: MiniAppWidget[] = [], name = "Panel"): MiniApp {
  const ts = "2026-07-31T00:00:00.000Z";
  return {
    id: "ma-1",
    name,
    widgets,
    tags: [],
    favorite: false,
    createdAt: ts,
    updatedAt: ts,
    runCount: 0,
    panelSize: { w: 400, h: 320 },
  };
}

function button(
  id: string,
  overrides: Partial<Extract<MiniAppWidget, { kind: "button" }>> = {},
): MiniAppWidget {
  return {
    id,
    kind: "button",
    layout: LAYOUT,
    label: "Connect",
    action: { kind: "commandRef", commandId: "cmd-1" },
    ...overrides,
  };
}

function artifact(
  id: string,
  overrides: Partial<Extract<MiniAppWidget, { kind: "artifact" }>> = {},
): MiniAppWidget {
  return {
    id,
    kind: "artifact",
    layout: LAYOUT,
    name: "configPath",
    label: "Config",
    value: "/etc/openvpn/client.ovpn",
    variant: "path",
    ...overrides,
  };
}

function statusWidget(
  id: string,
  overrides: Partial<Extract<MiniAppWidget, { kind: "status" }>> = {},
): MiniAppWidget {
  return {
    id,
    kind: "status",
    layout: LAYOUT,
    label: "VPN",
    source: { kind: "commandRef", commandId: "cmd-status" },
    intervalMs: 5000,
    mapping: { mode: "raw" },
    ...overrides,
  };
}

function toggle(
  id: string,
  overrides: Partial<Extract<MiniAppWidget, { kind: "toggle" }>> = {},
): MiniAppWidget {
  return {
    id,
    kind: "toggle",
    layout: LAYOUT,
    label: "VPN",
    onAction: { kind: "commandRef", commandId: "cmd-on" },
    offAction: { kind: "commandRef", commandId: "cmd-off" },
    ...overrides,
  };
}

function text(
  id: string,
  overrides: Partial<Extract<MiniAppWidget, { kind: "text" }>> = {},
): MiniAppWidget {
  return {
    id,
    kind: "text",
    layout: LAYOUT,
    label: "",
    content: "Hello",
    style: { fontSize: 14, bold: false, italic: false, align: "left" },
    ...overrides,
  };
}

describe("validateMiniApp — mini-app level", () => {
  it("accepts a fully-configured draft with no issues", () => {
    const draft = makeDraft([artifact("a1"), button("b1")]);
    expect(validateMiniApp(draft)).toEqual([]);
  });

  it("flags an empty mini-app name", () => {
    const issues = validateMiniApp(makeDraft([], ""));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      field: FIELD_NAME,
      messageKey: "miniapps.editor.nameRequired",
    });
    expect(issues[0].widgetId).toBeUndefined();
  });

  it("flags a whitespace-only mini-app name", () => {
    const issues = validateMiniApp(makeDraft([], "   "));
    expect(findIssue(issues, undefined, FIELD_NAME)).toBeDefined();
  });
});

describe("validateMiniApp — widget labels", () => {
  it("flags an empty label on every widget kind", () => {
    const draft = makeDraft([
      button("b1", { label: "" }),
      toggle("t1", { label: "" }),
      statusWidget("s1", { label: "" }),
      artifact("a1", { label: "" }),
    ]);
    const issues = validateMiniApp(draft);
    for (const id of ["b1", "t1", "s1", "a1"]) {
      expect(findIssue(issues, id, FIELD_LABEL)).toMatchObject({
        messageKey: "miniapps.editor.validation.labelRequired",
      });
    }
  });

  it("accepts a label interpolating a known artifact", () => {
    const draft = makeDraft([
      artifact("a1"),
      button("b1", { label: "Connect ${configPath}" }),
    ]);
    expect(validateMiniApp(draft)).toEqual([]);
  });

  it("flags a label interpolating an unknown artifact", () => {
    const draft = makeDraft([
      artifact("a1"),
      button("b1", { label: "Connect ${confgPath}" }),
    ]);
    const issue = findIssue(validateMiniApp(draft), "b1", FIELD_LABEL);
    expect(issue).toMatchObject({
      messageKey: "miniapps.editor.validation.unknownRef",
      params: { name: "confgPath" },
    });
  });
});

describe("validateMiniApp — button / toggle actions", () => {
  it("flags a commandRef action with an empty commandId", () => {
    const draft = makeDraft([
      button("b1", { action: { kind: "commandRef", commandId: "" } }),
    ]);
    expect(findIssue(validateMiniApp(draft), "b1", "action.commandId")).toMatchObject(
      { messageKey: "miniapps.editor.validation.commandRequired" },
    );
  });

  it("flags an inline action with an empty script", () => {
    const draft = makeDraft([
      button("b1", { action: { kind: "inline", name: "x", script: "  " } }),
    ]);
    expect(findIssue(validateMiniApp(draft), "b1", "action.script")).toMatchObject(
      { messageKey: "miniapps.editor.validation.scriptRequired" },
    );
  });

  it("flags both toggle actions independently", () => {
    const draft = makeDraft([
      toggle("t1", {
        onAction: { kind: "commandRef", commandId: "" },
        offAction: { kind: "inline", name: "", script: "" },
      }),
    ]);
    const issues = validateMiniApp(draft);
    expect(findIssue(issues, "t1", "onAction.commandId")).toBeDefined();
    expect(findIssue(issues, "t1", "offAction.script")).toBeDefined();
  });

  it("accepts an inline script referencing a panel artifact", () => {
    const draft = makeDraft([
      artifact("a1"),
      button("b1", {
        action: {
          kind: "inline",
          name: "connect",
          script: "openvpn3 --config ${configPath}",
        },
      }),
    ]);
    expect(validateMiniApp(draft)).toEqual([]);
  });

  it("flags an inline script referencing an unknown name", () => {
    const draft = makeDraft([
      artifact("a1"),
      button("b1", {
        action: {
          kind: "inline",
          name: "connect",
          script: "openvpn3 --config ${missingPath}",
        },
      }),
    ]);
    expect(findIssue(validateMiniApp(draft), "b1", "action.script")).toMatchObject({
      messageKey: "miniapps.editor.validation.unknownRef",
      params: { name: "missingPath" },
    });
  });

  it("accepts a reference declared as the action's own variable", () => {
    const draft = makeDraft([
      button("b1", {
        action: {
          kind: "inline",
          name: "greet",
          script: "echo ${who}",
          variables: [{ name: "who", defaultValue: "world" }],
        },
      }),
    ]);
    expect(validateMiniApp(draft)).toEqual([]);
  });

  it("scans workingDir, args, and env for unknown references", () => {
    const draft = makeDraft([
      button("b1", {
        action: {
          kind: "inline",
          name: "run",
          script: "echo ok",
          workingDir: "${wdRef}",
          args: ["--path", "${argRef}"],
          env: { KEY: "${envRef}" },
        },
      }),
    ]);
    const issues = validateMiniApp(draft);
    expect(findIssue(issues, "b1", "action.workingDir")).toBeDefined();
    expect(findIssue(issues, "b1", "action.args")).toBeDefined();
    expect(findIssue(issues, "b1", "action.env")).toBeDefined();
  });
});

describe("validateMiniApp — status sources and mapping", () => {
  it("flags a status widget whose commandRef source is unset", () => {
    const draft = makeDraft([
      statusWidget("s1", { source: { kind: "commandRef", commandId: "" } }),
    ]);
    expect(findIssue(validateMiniApp(draft), "s1", "source.commandId")).toMatchObject(
      { messageKey: "miniapps.editor.validation.commandRequired" },
    );
  });

  it("flags a status widget whose inline source has no script", () => {
    const draft = makeDraft([
      statusWidget("s1", { source: { kind: "inline", script: "" } }),
    ]);
    expect(findIssue(validateMiniApp(draft), "s1", "source.script")).toMatchObject(
      { messageKey: "miniapps.editor.validation.scriptRequired" },
    );
  });

  it("flags an unknown reference in an inline status script", () => {
    const draft = makeDraft([
      statusWidget("s1", {
        source: { kind: "inline", script: "check ${nope}" },
      }),
    ]);
    expect(findIssue(validateMiniApp(draft), "s1", "source.script")).toMatchObject({
      messageKey: "miniapps.editor.validation.unknownRef",
      params: { name: "nope" },
    });
  });

  it("flags a toggle's status source and mapping", () => {
    const draft = makeDraft([
      toggle("t1", {
        status: {
          source: { kind: "commandRef", commandId: "" },
          mapping: { mode: "mapped", rules: [{ match: "", label: "On" }] },
        },
      }),
    ]);
    const issues = validateMiniApp(draft);
    expect(findIssue(issues, "t1", "source.commandId")).toBeDefined();
    expect(findIssue(issues, "t1", "mapping.rules.match")).toMatchObject({
      messageKey: "miniapps.editor.validation.ruleMatchRequired",
      params: { index: "1" },
    });
  });

  it("flags every mapping rule with an empty match", () => {
    const draft = makeDraft([
      statusWidget("s1", {
        mapping: {
          mode: "mapped",
          rules: [
            { match: "connected", label: "Connected" },
            { match: "", label: "Off" },
            { match: "  ", label: "Unknown" },
          ],
        },
      }),
    ]);
    const issues = validateMiniApp(draft).filter(
      (i) => i.field === "mapping.rules.match",
    );
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.params?.index)).toEqual(["2", "3"]);
  });

  it("ignores rules when the mapping mode is raw", () => {
    const draft = makeDraft([
      statusWidget("s1", {
        mapping: { mode: "raw", rules: [{ match: "", label: "" }] },
      }),
    ]);
    expect(validateMiniApp(draft)).toEqual([]);
  });

  it("flags a regex-mode rule whose pattern fails to compile", () => {
    const draft = makeDraft([
      statusWidget("s1", {
        mapping: {
          mode: "mapped",
          rules: [
            { match: "connected", label: "OK", matchMode: "contains" },
            { match: "(unclosed", label: "Bad", matchMode: "regex" },
          ],
        },
      }),
    ]);
    const issues = validateMiniApp(draft);
    expect(findIssue(issues, "s1", "mapping.rules.regex")).toMatchObject({
      messageKey: "miniapps.editor.validation.invalidRegex",
      params: { index: "2" },
    });
    // The valid contains-mode rule must not be flagged.
    expect(
      issues.filter((i) => i.field === "mapping.rules.regex"),
    ).toHaveLength(1);
  });

  it("accepts a syntactically valid regex pattern", () => {
    const draft = makeDraft([
      statusWidget("s1", {
        mapping: {
          mode: "mapped",
          rules: [
            {
              match: "Status:.*Client (connected|disconnected)",
              label: "OK",
              matchMode: "regex",
            },
          ],
        },
      }),
    ]);
    expect(validateMiniApp(draft)).toEqual([]);
  });

  it("does not regex-validate exact/contains rules even with regex-special characters", () => {
    const draft = makeDraft([
      statusWidget("s1", {
        mapping: {
          mode: "mapped",
          rules: [
            { match: "(unclosed", label: "OK", matchMode: "exact" },
            { match: "(also unclosed", label: "OK2", matchMode: "contains" },
          ],
        },
      }),
    ]);
    expect(
      validateMiniApp(draft).filter((i) => i.field === "mapping.rules.regex"),
    ).toEqual([]);
  });
});

describe("validateMiniApp — artifacts", () => {
  it("flags an empty artifact name", () => {
    const draft = makeDraft([artifact("a1", { name: "" })]);
    expect(findIssue(validateMiniApp(draft), "a1", FIELD_ARTIFACT_NAME)).toMatchObject(
      { messageKey: "miniapps.editor.validation.artifactNameRequired" },
    );
  });

  it.each(["2foo", "my-path", "with space", "π"])(
    "flags the invalid artifact name %s",
    (name) => {
      const draft = makeDraft([artifact("a1", { name })]);
      expect(
        findIssue(validateMiniApp(draft), "a1", FIELD_ARTIFACT_NAME),
      ).toMatchObject({ messageKey: "miniapps.editor.artifactNameInvalid" });
    },
  );

  it.each(["_foo", "foo", "Foo9", "a_B_2"])(
    "accepts the valid artifact name %s",
    (name) => {
      const draft = makeDraft([artifact("a1", { name })]);
      expect(validateMiniApp(draft)).toEqual([]);
    },
  );

  it("flags EVERY duplicate artifact name", () => {
    const draft = makeDraft([
      artifact("a1", { name: "path" }),
      artifact("a2", { name: "path" }),
      artifact("a3", { name: "other" }),
    ]);
    const issues = validateMiniApp(draft).filter(
      (i) => i.messageKey === "miniapps.editor.validation.duplicateArtifactName",
    );
    expect(issues.map((i) => i.widgetId)).toEqual(["a1", "a2"]);
    expect(issues[0].params).toEqual({ name: "path" });
  });

  it("does not report a duplicate as invalid-grammar too", () => {
    const draft = makeDraft([
      artifact("a1", { name: "path" }),
      artifact("a2", { name: "path" }),
    ]);
    const issues = validateMiniApp(draft);
    expect(
      issues.filter((i) => i.messageKey === "miniapps.editor.artifactNameInvalid"),
    ).toEqual([]);
  });

  it("flags an artifact value that references itself", () => {
    const draft = makeDraft([artifact("a1", { value: "${configPath}" })]);
    expect(
      findIssue(validateMiniApp(draft), "a1", FIELD_ARTIFACT_VALUE),
    ).toMatchObject({
      messageKey: "miniapps.editor.validation.unknownRef",
      params: { name: "configPath" },
    });
  });

  it("accepts an artifact value referencing another artifact", () => {
    const draft = makeDraft([
      artifact("a1", { name: "base", value: "/etc" }),
      artifact("a2", { name: "full", value: "${base}/client.ovpn" }),
    ]);
    expect(validateMiniApp(draft)).toEqual([]);
  });

  it("flags a secret artifact with persist: true", () => {
    const draft = makeDraft([
      artifact("a1", { variant: "secret", persist: true }),
    ]);
    expect(
      findIssue(validateMiniApp(draft), "a1", FIELD_ARTIFACT_PERSIST),
    ).toMatchObject({
      messageKey: "miniapps.editor.validation.secretCannotPersist",
    });
  });

  it.each([undefined, false])(
    "accepts a secret artifact with persist: %s",
    (persist) => {
      const draft = makeDraft([
        artifact("a1", { variant: "secret", persist }),
      ]);
      expect(
        findIssue(validateMiniApp(draft), "a1", FIELD_ARTIFACT_PERSIST),
      ).toBeUndefined();
    },
  );

  it.each(["path", "text"] as const)(
    "accepts a %s artifact with persist: true",
    (variant) => {
      const draft = makeDraft([artifact("a1", { variant, persist: true })]);
      expect(
        findIssue(validateMiniApp(draft), "a1", FIELD_ARTIFACT_PERSIST),
      ).toBeUndefined();
    },
  );

  it("treats a reference to an INVALIDLY-named artifact as unknown", () => {
    const draft = makeDraft([
      artifact("a1", { name: "2bad" }),
      button("b1", {
        action: { kind: "inline", name: "x", script: "echo ${2bad}" },
      }),
    ]);
    const issues = validateMiniApp(draft);
    // `${2bad}` isn't even a legal token, so no unknownRef is raised for it;
    // the artifact's own name is what gets flagged.
    expect(findIssue(issues, "a1", FIELD_ARTIFACT_NAME)).toMatchObject({
      messageKey: "miniapps.editor.artifactNameInvalid",
    });
  });
});

describe("validateMiniApp — text widgets", () => {
  it("accepts a text widget with content and a blank (editor-internal) label", () => {
    const draft = makeDraft([text("x1", { label: "", content: "Ready" })]);
    expect(validateMiniApp(draft)).toEqual([]);
  });

  it("does NOT require a label on a text widget", () => {
    const draft = makeDraft([text("x1", { label: "" })]);
    expect(findIssue(validateMiniApp(draft), "x1", FIELD_LABEL)).toBeUndefined();
  });

  it("flags an empty text content", () => {
    const draft = makeDraft([text("x1", { content: "" })]);
    expect(findIssue(validateMiniApp(draft), "x1", FIELD_TEXT_CONTENT)).toMatchObject(
      { messageKey: "miniapps.editor.validation.textContentRequired" },
    );
  });

  it("flags whitespace-only text content", () => {
    const draft = makeDraft([text("x1", { content: "   " })]);
    expect(
      findIssue(validateMiniApp(draft), "x1", FIELD_TEXT_CONTENT),
    ).toBeDefined();
  });

  it("accepts content interpolating a known artifact", () => {
    const draft = makeDraft([
      artifact("a1"),
      text("x1", { content: "Config: ${configPath}" }),
    ]);
    expect(validateMiniApp(draft)).toEqual([]);
  });

  it("flags content interpolating an unknown artifact", () => {
    const draft = makeDraft([
      artifact("a1"),
      text("x1", { content: "Config: ${confgPath}" }),
    ]);
    expect(findIssue(validateMiniApp(draft), "x1", FIELD_TEXT_CONTENT)).toMatchObject(
      {
        messageKey: "miniapps.editor.validation.unknownRef",
        params: { name: "confgPath" },
      },
    );
  });

  it.each([7, 0, -4, 97, 200, Number.NaN])(
    "flags an out-of-range font size %s",
    (fontSize) => {
      const draft = makeDraft([
        text("x1", {
          style: { fontSize, bold: false, italic: false, align: "left" },
        }),
      ]);
      expect(
        findIssue(validateMiniApp(draft), "x1", FIELD_TEXT_FONT_SIZE),
      ).toMatchObject({
        messageKey: "miniapps.editor.validation.fontSizeRange",
        params: { min: "8", max: "96" },
      });
    },
  );

  it.each([8, 14, 42, 96])("accepts the in-range font size %s", (fontSize) => {
    const draft = makeDraft([
      text("x1", {
        style: { fontSize, bold: false, italic: false, align: "left" },
      }),
    ]);
    expect(
      findIssue(validateMiniApp(draft), "x1", FIELD_TEXT_FONT_SIZE),
    ).toBeUndefined();
  });
});

describe("collectValidArtifactNames", () => {
  it("returns only grammar-valid, non-empty names", () => {
    const names = collectValidArtifactNames([
      artifact("a1", { name: "good" }),
      artifact("a2", { name: "" }),
      artifact("a3", { name: "2bad" }),
      button("b1"),
    ]);
    expect([...names]).toEqual(["good"]);
  });
});

describe("hasWidgetIssue / findIssue", () => {
  it("hasWidgetIssue reports per-widget problems", () => {
    const draft = makeDraft([button("b1", { label: "" }), button("b2")]);
    const issues = validateMiniApp(draft);
    expect(hasWidgetIssue(issues, "b1")).toBe(true);
    expect(hasWidgetIssue(issues, "b2")).toBe(false);
  });

  it("findIssue matches on widgetId + field", () => {
    const draft = makeDraft([button("b1", { label: "" })], "");
    const issues = validateMiniApp(draft);
    expect(findIssue(issues, undefined, FIELD_NAME)).toBeDefined();
    expect(findIssue(issues, "b1", FIELD_LABEL)).toBeDefined();
    expect(findIssue(issues, "b1", FIELD_NAME)).toBeUndefined();
  });
});

describe("validateMiniApp — VAR_RE statefulness", () => {
  it("produces the same result across repeated calls", () => {
    const draft = makeDraft([
      artifact("a1"),
      button("b1", {
        action: {
          kind: "inline",
          name: "c",
          script: "run ${configPath} ${missing}",
        },
      }),
    ]);
    const first = validateMiniApp(draft);
    const second = validateMiniApp(draft);
    expect(second).toEqual(first);
    expect(first).toHaveLength(1);
  });
});
