import { describe, expect, it } from "vitest";
import { assembleScript } from "./flagBuilderUtils";
import type { ParsedFlag } from "../../types";

function boolFlag(flags: string[], description = ""): ParsedFlag {
  return { flags, takesValue: false, valueHint: "", description, required: false };
}

function valueFlag(flags: string[], valueHint: string, description = ""): ParsedFlag {
  return { flags, takesValue: true, valueHint, description, required: false };
}

describe("assembleScript", () => {
  it("returns just the utility when no args or flags", () => {
    expect(assembleScript("ls", [], "", [])).toBe("ls");
  });

  it("appends named positional arg values in order", () => {
    const argRows = [
      { name: "SOURCE", description: "", required: true, value: "/foo" },
      { name: "DEST", description: "", required: true, value: "/bar" },
    ];
    expect(assembleScript("cp", argRows, "", [])).toBe("cp /foo /bar");
  });

  it("appends free-text positional args", () => {
    expect(assembleScript("ls", [], "/tmp /home", [])).toBe("ls /tmp /home");
  });

  it("emits multiple free-text tokens as separate args", () => {
    expect(assembleScript("ls", [], "/my /other", [])).toBe("ls /my /other");
  });

  it("skips named positional args with empty values", () => {
    const argRows = [
      { name: "SOURCE", description: "", required: true, value: "" },
      { name: "DEST", description: "", required: true, value: "/bar" },
    ];
    expect(assembleScript("cp", argRows, "", [])).toBe("cp /bar");
  });

  it("emits long form when useShort=false", () => {
    const flagRows = [
      { rowId: "1", flag: boolFlag(["-v", "--verbose"]), value: "", useShort: false },
    ];
    expect(assembleScript("ls", [], "", flagRows)).toBe("ls --verbose");
  });

  it("emits short form when useShort=true", () => {
    const flagRows = [
      { rowId: "1", flag: boolFlag(["-v", "--verbose"]), value: "", useShort: true },
    ];
    expect(assembleScript("ls", [], "", flagRows)).toBe("ls -v");
  });

  it("groups multiple boolean short flags into a single token", () => {
    const flagRows = [
      { rowId: "1", flag: boolFlag(["-c", "--create"]), value: "", useShort: true },
      { rowId: "2", flag: boolFlag(["-z", "--gzip"]), value: "", useShort: true },
      { rowId: "3", flag: boolFlag(["-v", "--verbose"]), value: "", useShort: true },
    ];
    expect(assembleScript("tar", [], "", flagRows)).toBe("tar -czv");
  });

  it("does not group long-form boolean flags", () => {
    const flagRows = [
      { rowId: "1", flag: boolFlag(["-c", "--create"]), value: "", useShort: false },
      { rowId: "2", flag: boolFlag(["-z", "--gzip"]), value: "", useShort: false },
    ];
    expect(assembleScript("tar", [], "", flagRows)).toBe("tar --create --gzip");
  });

  it("appends value flags with their values", () => {
    const flagRows = [
      { rowId: "1", flag: valueFlag(["-o", "--output"], "FILE"), value: "out.txt", useShort: false },
    ];
    expect(assembleScript("grep", [], "", flagRows)).toBe("grep --output out.txt");
  });

  it("uses short form for value flags when useShort=true", () => {
    const flagRows = [
      { rowId: "1", flag: valueFlag(["-o", "--output"], "FILE"), value: "out.txt", useShort: true },
    ];
    expect(assembleScript("grep", [], "", flagRows)).toBe("grep -o out.txt");
  });

  it("quotes values with spaces", () => {
    const flagRows = [
      { rowId: "1", flag: valueFlag(["-o", "--output"], "FILE"), value: "my file.txt", useShort: false },
    ];
    expect(assembleScript("grep", [], "", flagRows)).toBe('grep --output "my file.txt"');
  });

  it("handles combined scenario: named args + positional raw + short grouped + value flag", () => {
    const argRows = [
      { name: "ARCHIVE", description: "", required: true, value: "archive.tar.gz" },
    ];
    const flagRows = [
      { rowId: "1", flag: boolFlag(["-c", "--create"]), value: "", useShort: true },
      { rowId: "2", flag: boolFlag(["-z", "--gzip"]), value: "", useShort: true },
      { rowId: "3", flag: valueFlag(["-f", "--file"], "ARCHIVE"), value: "archive.tar.gz", useShort: false },
    ];
    const result = assembleScript("tar", argRows, "/data", flagRows);
    expect(result).toBe("tar archive.tar.gz /data -cz --file archive.tar.gz");
  });

  it("handles utility with no flags and one free-text arg", () => {
    expect(assembleScript("ls", [], "/tmp", [])).toBe("ls /tmp");
  });
});
