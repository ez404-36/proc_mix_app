import { describe, expect, it } from "vitest";
import { detectAdminEscalation } from "./detectAdminEscalation";

describe("detectAdminEscalation — positive cases", () => {
  it("matches a plain `sudo` invocation", () => {
    expect(detectAdminEscalation("sudo apt update")).toBe(true);
  });

  it("matches `doas` (OpenBSD/Void Linux)", () => {
    expect(detectAdminEscalation("doas pkg_add curl")).toBe(true);
  });

  it("matches `pkexec` (PolicyKit on Linux)", () => {
    expect(detectAdminEscalation("pkexec systemctl restart docker")).toBe(true);
  });

  it("skips a leading shebang line and matches the next command", () => {
    const script = "#!/usr/bin/env bash\nsudo apt update";
    expect(detectAdminEscalation(script)).toBe(true);
  });

  it("skips multiple leading comment lines", () => {
    const script = [
      "# Update package list",
      "# Run as: ./this-script",
      "sudo apt update",
    ].join("\n");
    expect(detectAdminEscalation(script)).toBe(true);
  });

  it("skips blank lines before the first command", () => {
    const script = "\n\n  \n\nsudo apt update";
    expect(detectAdminEscalation(script)).toBe(true);
  });

  it("matches with leading whitespace before sudo", () => {
    // Some users indent their scripts; the shell doesn't care, neither
    // should we.
    expect(detectAdminEscalation("   sudo apt update")).toBe(true);
  });

  it("matches `sudo` followed by a tab (not just space)", () => {
    expect(detectAdminEscalation("sudo\tapt update")).toBe(true);
  });

  // Env-assignment prefix: the shell runs `sudo` as the command after
  // applying `FOO=1`. The detector strips leading `NAME=value` tokens
  // (shared with parseUtilityName) so this is correctly recognised as
  // escalation — otherwise it would run on the non-elevated null-stdin
  // path and the inline sudo would fail.
  it("matches when a single env-assignment precedes sudo", () => {
    expect(detectAdminEscalation("FOO=1 sudo apt update")).toBe(true);
  });

  it("matches when multiple env-assignments precede sudo", () => {
    expect(detectAdminEscalation("FOO=1 BAR=2 sudo systemctl restart x")).toBe(
      true,
    );
  });

  it("matches an env-assignment before sudo followed by one after sudo", () => {
    expect(detectAdminEscalation("FOO=1 sudo BAR=2 systemctl restart x")).toBe(
      true,
    );
  });

  // Only the FIRST command segment is inspected, but env-prefix
  // stripping still applies within it.
  it("matches env-prefixed sudo before a separator", () => {
    expect(detectAdminEscalation("FOO=1 sudo apt update && reboot")).toBe(true);
  });
});

describe("detectAdminEscalation — negative cases (false-positive guards)", () => {
  it("does not match an empty script", () => {
    expect(detectAdminEscalation("")).toBe(false);
  });

  it("does not match whitespace-only", () => {
    expect(detectAdminEscalation("   \n\n  \n")).toBe(false);
  });

  it("does not match a script that only contains comments", () => {
    expect(detectAdminEscalation("# just a note\n# nothing to do")).toBe(false);
  });

  // Critical: the word "sudo" appearing inside a quoted argument must
  // NOT trigger the detector. The first token is `echo`, not `sudo`.
  it("does not match `sudo` inside a quoted argument to another command", () => {
    expect(detectAdminEscalation('echo "do not use sudo here"')).toBe(false);
  });

  // Critical: a command whose name starts with the letters `sudo` but
  // continues with more characters (no whitespace separator) is a
  // DIFFERENT binary — `sudoers` etc.
  it("does not match a command whose name only starts with `sudo`", () => {
    expect(detectAdminEscalation("sudoers-check --all")).toBe(false);
    expect(detectAdminEscalation("sudoreplay --list")).toBe(false);
  });

  // Pipelines that pipe INTO sudo: the first command runs unelevated,
  // sudo only runs after the pipe. The user clearly intended this
  // partial-escalation pattern; we should not flip the whole command
  // to admin and double-wrap it.
  it("does not match when sudo appears after a pipe", () => {
    expect(detectAdminEscalation("echo y | sudo apt remove foo")).toBe(false);
  });

  // A bare word that merely CONTAINS `sudo` but is not an
  // env-assignment and not the escalation tool must not match.
  it("does not match when the leading command is a non-escalation word", () => {
    expect(detectAdminEscalation("mysudo apt update")).toBe(false);
  });

  // Compound/leading-other-command cases: the FIRST command of the
  // segment runs unelevated; escalation only happens later. We must NOT
  // auto-wrap the whole line (that would elevate the leading command
  // too). These intentionally stay false.
  it("does not match when another command precedes sudo via &&", () => {
    expect(detectAdminEscalation("cd /tmp && sudo apt update")).toBe(false);
  });

  it("does not match when another command precedes sudo via ;", () => {
    expect(detectAdminEscalation("true; sudo apt update")).toBe(false);
  });

  // After the first executable line we stop searching, by design. A
  // sudo on line 2 is not enough to flag the whole command — the
  // user's first action was unelevated. (Auto-flagging here would
  // wrap the whole script in another sudo and silently elevate the
  // first command too.)
  it("does not match when sudo appears on a later line", () => {
    const script = "echo starting\nsudo apt update";
    expect(detectAdminEscalation(script)).toBe(false);
  });
});

describe("detectAdminEscalation — edge cases", () => {
  it("handles CRLF line endings", () => {
    // Windows-pasted scripts often use \r\n; we split only on \n and
    // then trim, so the trailing \r is discarded.
    expect(detectAdminEscalation("#!/bin/bash\r\nsudo apt update\r\n")).toBe(
      true,
    );
  });

  it("handles a script consisting of `sudo` with no arguments", () => {
    // Rare but legal — `sudo` with no args prints usage but still
    // counts as escalation intent.
    expect(detectAdminEscalation("sudo")).toBe(true);
  });

  it("returns false for scripts that contain only a shebang", () => {
    expect(detectAdminEscalation("#!/usr/bin/env bash\n")).toBe(false);
  });
});
