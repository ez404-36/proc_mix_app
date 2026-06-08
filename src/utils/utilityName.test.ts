import { describe, expect, it } from "vitest";

import {
  isSafeUtilityName,
  isSafeUtilityPath,
  parseLeadingCommand,
  parseUtilityName,
  parseUtilityNameWithRange,
  scriptReferencesEscalationTool,
} from "./utilityName";

// These cases intentionally mirror the Rust `core::utility_help::tests`
// for `parse_utility_name` / `is_safe_utility_name`. The two parsers
// MUST agree (see the module header), so when one set changes the other
// should change in lockstep.

describe("parseUtilityName", () => {
  it("extracts a plain utility ignoring flags/args", () => {
    expect(parseUtilityName("df -h /")).toBe("df");
  });

  it("strips an escalation prefix", () => {
    expect(parseUtilityName("sudo apt update")).toBe("apt");
    expect(parseUtilityName("doas pkg upgrade")).toBe("pkg");
    expect(parseUtilityName("pkexec id")).toBe("id");
  });

  it("strips leading env-assignment tokens", () => {
    expect(parseUtilityName("FOO=1 ls")).toBe("ls");
    expect(parseUtilityName("FOO=1 BAR=2 grep x")).toBe("grep");
  });

  it("strips env then escalation then env", () => {
    expect(parseUtilityName("FOO=1 sudo BAR=2 systemctl restart x")).toBe(
      "systemctl",
    );
  });

  it("skips blank, comment and shebang lines", () => {
    expect(parseUtilityName("  \n# a comment\nls -la")).toBe("ls");
    expect(parseUtilityName("#!/usr/bin/env bash\ndf")).toBe("df");
  });

  it("takes only the first command in a chain", () => {
    expect(parseUtilityName("df -h && du -sh *")).toBe("df");
    expect(parseUtilityName("git status | grep foo")).toBe("git");
    expect(parseUtilityName("ls || echo fail")).toBe("ls");
    expect(parseUtilityName("ls & disown")).toBe("ls");
  });

  it("treats separators consistently regardless of whitespace", () => {
    expect(parseUtilityName("ls;rm")).toBe("ls");
    expect(parseUtilityName("ls ; rm")).toBe("ls");
    expect(parseUtilityName("ls&&rm")).toBe("ls");
    expect(parseUtilityName("ls && rm")).toBe("ls");
    expect(parseUtilityName("cat|less")).toBe("cat");
  });

  it("combines separators with prefixes", () => {
    expect(parseUtilityName("sudo apt update && reboot")).toBe("apt");
    expect(parseUtilityName("FOO=1 ls; rm -rf x")).toBe("ls");
  });

  it("returns null for a leading separator", () => {
    expect(parseUtilityName("&& ls")).toBeNull();
    expect(parseUtilityName("| grep x")).toBeNull();
  });

  it("returns null for variable references", () => {
    expect(parseUtilityName("${tool} --version")).toBeNull();
    expect(parseUtilityName("$TOOL run")).toBeNull();
  });

  it("returns null for empty / comment-only input", () => {
    expect(parseUtilityName("")).toBeNull();
    expect(parseUtilityName("   \n\n  ")).toBeNull();
    expect(parseUtilityName("# only a comment")).toBeNull();
  });

  it("accepts safe executable paths", () => {
    expect(parseUtilityName("/usr/bin/df -h")).toBe("/usr/bin/df");
    expect(
      parseUtilityName("/opt/cprocsp/sbin/amd64/cpconfig -license -view"),
    ).toBe("/opt/cprocsp/sbin/amd64/cpconfig");
    expect(parseUtilityName("./script.sh")).toBe("./script.sh");
    expect(parseUtilityName("sudo /usr/local/bin/tool run")).toBe(
      "/usr/local/bin/tool",
    );
  });

  it("returns null for metachar tokens", () => {
    expect(parseUtilityName("$(whoami)")).toBeNull();
    expect(parseUtilityName("/usr/bin/$x")).toBeNull();
    expect(parseUtilityName("~/bin/tool")).toBeNull();
  });
});

describe("isSafeUtilityName", () => {
  it("accepts typical utility names", () => {
    for (const name of [
      "df",
      "ls",
      "git",
      "docker",
      "apt-get",
      "g++",
      "python3",
      "a.out",
      "7z",
    ]) {
      expect(isSafeUtilityName(name)).toBe(true);
    }
  });

  it("rejects dangerous inputs", () => {
    for (const name of [
      "",
      "-h",
      "--help",
      "rm;rm",
      "foo/bar",
      "..",
      "$(x)",
      "a b",
      "a|b",
      "a&b",
      "`x`",
      "'q'",
      '"q"',
      "~/x",
      "a>b",
      "$VAR",
    ]) {
      expect(isSafeUtilityName(name)).toBe(false);
    }
  });

  it("requires an alphanumeric first char but allows them mid-name", () => {
    expect(isSafeUtilityName("-x")).toBe(false);
    expect(isSafeUtilityName(".x")).toBe(false);
    expect(isSafeUtilityName("+x")).toBe(false);
    expect(isSafeUtilityName("_x")).toBe(false);
    expect(isSafeUtilityName("a_x")).toBe(true);
  });
});

describe("isSafeUtilityPath", () => {
  it("accepts absolute and relative executable paths", () => {
    for (const p of [
      "/usr/bin/df",
      "/opt/cprocsp/sbin/amd64/cpconfig",
      "./script.sh",
      "../bin/tool",
      "/a/b-c/d_e.f+g",
    ]) {
      expect(isSafeUtilityPath(p)).toBe(true);
    }
  });

  it("rejects non-paths and metachar-bearing paths", () => {
    for (const p of [
      "df",
      "apt-get",
      "usr/bin/df",
      "-/x",
      "~/bin/tool",
      "/usr/bin/$x",
      "/a/b c",
      "/a/b;c",
      "/a/b|c",
      "/a/*",
      "/a/`x`",
    ]) {
      expect(isSafeUtilityPath(p)).toBe(false);
    }
  });
});

describe("parseUtilityNameWithRange", () => {
  // The returned range must point at the exact characters in the
  // ORIGINAL string, so `script.slice(start, end) === name`.
  function check(script: string, name: string): void {
    const r = parseUtilityNameWithRange(script);
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.name).toBe(name);
    expect(script.slice(r.start, r.end)).toBe(name);
  }

  it("locates a plain leading utility", () => {
    const r = parseUtilityNameWithRange("df -h /");
    expect(r).toEqual({ name: "df", start: 0, end: 2 });
  });

  it("locates the utility after a sudo prefix", () => {
    // "sudo apt update" — range points at "apt" (chars 5..8).
    const r = parseUtilityNameWithRange("sudo apt update");
    expect(r).toEqual({ name: "apt", start: 5, end: 8 });
    expect("sudo apt update".slice(5, 8)).toBe("apt");
  });

  it("accounts for leading whitespace and env assignments", () => {
    check("   FOO=1 ls -la", "ls");
    const r = parseUtilityNameWithRange("   FOO=1 ls -la");
    expect(r?.start).toBe("   FOO=1 ".length);
  });

  it("accounts for skipped comment / blank lines before the command", () => {
    const script = "# comment\n\n  git status";
    const r = parseUtilityNameWithRange(script);
    expect(r?.name).toBe("git");
    expect(script.slice(r?.start ?? 0, r?.end ?? 0)).toBe("git");
  });

  it("cuts at the first command separator", () => {
    check("df && du", "df");
    expect(parseUtilityNameWithRange("ls;rm")?.name).toBe("ls");
  });

  it("locates a full path token in place", () => {
    const script = "/opt/cprocsp/sbin/amd64/cpconfig -license -view";
    const r = parseUtilityNameWithRange(script);
    expect(r?.name).toBe("/opt/cprocsp/sbin/amd64/cpconfig");
    expect(script.slice(r?.start ?? 0, r?.end ?? 0)).toBe(
      "/opt/cprocsp/sbin/amd64/cpconfig",
    );
    expect(r?.start).toBe(0);
  });

  it("returns null for the same cases as parseUtilityName", () => {
    expect(parseUtilityNameWithRange("")).toBeNull();
    expect(parseUtilityNameWithRange("${tool} x")).toBeNull();
    expect(parseUtilityNameWithRange("~/bin/tool")).toBeNull();
    expect(parseUtilityNameWithRange("&& ls")).toBeNull();
  });
});

describe("parseLeadingCommand", () => {
  it("reports the leading command and no escalation for a plain command", () => {
    expect(parseLeadingCommand("df -h /")).toEqual({
      command: "df",
      escalated: false,
    });
  });

  it("reports escalation and the post-prefix command for leading sudo", () => {
    expect(parseLeadingCommand("sudo apt update")).toEqual({
      command: "apt",
      escalated: true,
    });
  });

  it("strips env-assignments before detecting the escalation prefix", () => {
    expect(parseLeadingCommand("FOO=1 sudo systemctl restart x")).toEqual({
      command: "systemctl",
      escalated: true,
    });
  });

  it("reports escalation with no command for a bare sudo", () => {
    expect(parseLeadingCommand("sudo")).toEqual({
      command: undefined,
      escalated: true,
    });
  });

  it("returns null when there is no executable line", () => {
    expect(parseLeadingCommand("# only a comment")).toBeNull();
  });
});

describe("scriptReferencesEscalationTool", () => {
  // Leading-position escalation (also caught by detectAdminEscalation).
  it("detects a leading sudo", () => {
    expect(scriptReferencesEscalationTool("sudo apt update")).toBe(true);
  });

  // Class B positions that detectAdminEscalation deliberately ignores.
  it("detects sudo after &&", () => {
    expect(scriptReferencesEscalationTool("cd /tmp && sudo apt update")).toBe(
      true,
    );
  });

  it("detects sudo after a pipe", () => {
    expect(scriptReferencesEscalationTool("echo y | sudo apt remove foo")).toBe(
      true,
    );
  });

  it("detects sudo after a semicolon", () => {
    expect(scriptReferencesEscalationTool("true; sudo reboot")).toBe(true);
  });

  it("detects sudo on a later line", () => {
    expect(
      scriptReferencesEscalationTool("echo starting\nsudo apt update"),
    ).toBe(true);
  });

  it("detects env-prefixed sudo in a non-leading segment", () => {
    expect(
      scriptReferencesEscalationTool("ls && FOO=1 sudo systemctl restart x"),
    ).toBe(true);
  });

  it("detects doas and pkexec too", () => {
    expect(scriptReferencesEscalationTool("ls && doas pkg_add curl")).toBe(true);
    expect(scriptReferencesEscalationTool("ls; pkexec id")).toBe(true);
  });

  // Negative cases: no escalation tool in any command position.
  it("does not match a script without an escalation tool", () => {
    expect(scriptReferencesEscalationTool("ls -la && rm -rf /tmp/x")).toBe(
      false,
    );
  });

  it("does not match sudo inside a quoted argument (segment-leading is echo)", () => {
    expect(scriptReferencesEscalationTool('echo "use sudo to run this"')).toBe(
      false,
    );
  });

  it("does not match a binary that merely starts with sudo", () => {
    expect(scriptReferencesEscalationTool("sudoers-check --all")).toBe(false);
  });

  it("does not match comments or blank lines", () => {
    expect(scriptReferencesEscalationTool("# sudo apt update\n\n")).toBe(false);
  });

  it("returns false for an empty script", () => {
    expect(scriptReferencesEscalationTool("")).toBe(false);
  });
});
