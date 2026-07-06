import { describe, expect, it } from "vitest";
import { inferTsType, jsTemplate } from "./jsParserTemplate";

describe("inferTsType", () => {
  it("maps null/undefined to unknown", () => {
    expect(inferTsType(null)).toBe("unknown");
    expect(inferTsType(undefined)).toBe("unknown");
  });

  it("maps primitives", () => {
    expect(inferTsType("hi")).toBe("string");
    expect(inferTsType(42)).toBe("number");
    expect(inferTsType(true)).toBe("boolean");
  });

  it("maps an empty array to unknown[]", () => {
    expect(inferTsType([])).toBe("unknown[]");
  });

  it("maps a string array to string[] from the first element", () => {
    expect(inferTsType(["a", "b", "c"])).toBe("string[]");
  });

  it("maps an array of objects to a multi-line shaped element type", () => {
    expect(inferTsType([{ col0: "x", col1: 1 }])).toBe(
      "{\n    col0: string;\n    col1: number;\n}[]",
    );
  });

  it("maps an object with 2+ keys to a multi-line shaped label", () => {
    expect(inferTsType({ name: "a", age: 3, ok: true })).toBe(
      "{\n    name: string;\n    age: number;\n    ok: boolean;\n}",
    );
  });

  it("keeps a single-key object on one line", () => {
    expect(inferTsType({ id: 42 })).toBe("{ id: number }");
  });

  it("maps an empty object to object", () => {
    expect(inferTsType({})).toBe("object");
  });

  it("maps a non-JSON primitive (bigint) to unknown via the default branch", () => {
    expect(inferTsType(10n)).toBe("unknown");
  });
});

describe("jsTemplate", () => {
  it("embeds the inferred data type as a comment and a JS body", () => {
    const tpl = jsTemplate("string[]");
    expect(tpl).toContain("// type Data = string[]");
    expect(tpl).toContain("function parse(data) {");
    expect(tpl).toContain("return;");
  });

  it("uses the literal label it is given", () => {
    expect(jsTemplate("unknown")).toContain("// type Data = unknown");
  });

  it("formats a multi-line type with // prefixed continuation lines", () => {
    const multiLine = "{\n    col0: string;\n    col1: string;\n}[]";
    const tpl = jsTemplate(multiLine);
    expect(tpl).toContain("// type Data = {");
    expect(tpl).toContain("//     col0: string;");
    expect(tpl).toContain("//     col1: string;");
    expect(tpl).toContain("// }[]");
  });
});
