import { describe, expect, it } from "vitest";

import { parseCompletionContext, resolveBaseDir } from "./parseLine";

describe("parseCompletionContext", () => {
  it("treats the first word as a command", () => {
    const ctx = parseCompletionContext("gre", 3);
    expect(ctx.kind).toBe("command");
    expect(ctx.wordStart).toBe(0);
    expect(ctx.namePrefix).toBe("gre");
    expect(ctx.dirPart).toBe("");
  });

  it("treats a later word as a path", () => {
    const ctx = parseCompletionContext("ls Doc", 6);
    expect(ctx.kind).toBe("path");
    expect(ctx.wordStart).toBe(3);
    expect(ctx.dirPart).toBe("");
    expect(ctx.namePrefix).toBe("Doc");
  });

  it("marks words after cd as dir-only", () => {
    const ctx = parseCompletionContext("cd ~/Pro", 8);
    expect(ctx.kind).toBe("dir");
    expect(ctx.dirPart).toBe("~/");
    expect(ctx.namePrefix).toBe("Pro");
  });

  it("marks a command after a separator as a command again", () => {
    const ctx = parseCompletionContext("ls | gre", 8);
    expect(ctx.kind).toBe("command");
    expect(ctx.wordStart).toBe(5);
    expect(ctx.namePrefix).toBe("gre");
  });

  it("keeps the command position after `;` and `&&` even with a space", () => {
    expect(parseCompletionContext("ls; gre", 7).kind).toBe("command");
    expect(parseCompletionContext("ls && gr", 8).kind).toBe("command");
    expect(parseCompletionContext("ls | gre", 8).kind).toBe("command");
    expect(parseCompletionContext("ls > f | gre", 12).kind).toBe("command");
  });

  it("keeps the command position after sudo and env assignments", () => {
    expect(parseCompletionContext("sudo apt", 8).kind).toBe("command");
    expect(parseCompletionContext("FOO=bar apt", 11).kind).toBe("command");
    expect(parseCompletionContext("sudo FOO=1 apt", 14).kind).toBe("command");
  });

  it("resolves backslash escapes in the word", () => {
    const ctx = parseCompletionContext("ls My\\ Fi", 9);
    expect(ctx.wordStart).toBe(3);
    expect(ctx.unquoted).toBe("My Fi");
    expect(ctx.namePrefix).toBe("My Fi");
    expect(ctx.quote).toBeNull();
  });

  it("tracks an open double quote", () => {
    const ctx = parseCompletionContext('ls "My Fi', 9);
    expect(ctx.word).toBe('"My Fi');
    expect(ctx.wordStart).toBe(3);
    expect(ctx.quote).toBe('"');
    expect(ctx.unquoted).toBe("My Fi");
  });

  it("tracks an open single quote without escapes inside", () => {
    const ctx = parseCompletionContext("ls 'My\\ Fi", 10);
    expect(ctx.quote).toBe("'");
    // Inside single quotes the backslash is literal text.
    expect(ctx.unquoted).toBe("My\\ Fi");
  });

  it("clears the quote once it closes inside the word", () => {
    const ctx = parseCompletionContext('ls "My Files"/su', 16);
    expect(ctx.quote).toBeNull();
    expect(ctx.unquoted).toBe("My Files/su");
    expect(ctx.dirPart).toBe("My Files/");
    expect(ctx.namePrefix).toBe("su");
  });

  it("splits dirPart and namePrefix on the last separator", () => {
    const ctx = parseCompletionContext("cd /usr/local/sha", 17);
    expect(ctx.dirPart).toBe("/usr/local/");
    expect(ctx.namePrefix).toBe("sha");
  });

  it("handles a trailing separator with an empty prefix", () => {
    const ctx = parseCompletionContext("cd /usr/", 8);
    expect(ctx.dirPart).toBe("/usr/");
    expect(ctx.namePrefix).toBe("");
  });

  it("completes an empty word after a separator as everything", () => {
    const ctx = parseCompletionContext("ls | ", 5);
    expect(ctx.word).toBe("");
    expect(ctx.wordStart).toBe(5);
    expect(ctx.kind).toBe("command");
    expect(ctx.namePrefix).toBe("");
  });

  it("completes the partial word under a mid-line cursor", () => {
    const ctx = parseCompletionContext("abcdef", 3);
    expect(ctx.namePrefix).toBe("abc");
    expect(ctx.wordStart).toBe(0);
  });

  it("completes a redirect target as a path, not a command", () => {
    const ctx = parseCompletionContext("echo hi > out", 13);
    expect(ctx.kind).toBe("path");
    expect(ctx.namePrefix).toBe("out");
  });

  it("completes a command-position word containing a separator as a path", () => {
    const ctx = parseCompletionContext("/usr/bin/ls", 11);
    expect(ctx.kind).toBe("path");
    expect(ctx.dirPart).toBe("/usr/bin/");
    expect(ctx.namePrefix).toBe("ls");
  });

  it("clamps an out-of-range cursor", () => {
    const ctx = parseCompletionContext("ls", 99);
    expect(ctx.namePrefix).toBe("ls");
    expect(ctx.wordStart).toBe(0);
  });
});

describe("resolveBaseDir", () => {
  const cwd = "/home/u/projects";
  const home = "/home/u";

  it("uses cwd for a bare word", () => {
    expect(resolveBaseDir("", cwd, home)).toBe(cwd);
  });

  it("joins a relative dirPart onto cwd", () => {
    expect(resolveBaseDir("sub/", cwd, home)).toBe("/home/u/projects/sub/");
  });

  it("expands ~ and ~/ against home", () => {
    expect(resolveBaseDir("~", cwd, home)).toBe(home);
    expect(resolveBaseDir("~/docs/", cwd, home)).toBe("/home/u/docs/");
  });

  it("passes absolute paths through unchanged", () => {
    expect(resolveBaseDir("/etc/", cwd, home)).toBe("/etc/");
  });

  it("rejects ~user syntax as unsupported", () => {
    expect(resolveBaseDir("~other/", cwd, home)).toBeNull();
  });

  it("returns null when neither cwd nor home is known", () => {
    expect(resolveBaseDir("", null, null)).toBeNull();
    expect(resolveBaseDir("~/", null, null)).toBeNull();
  });

  it("falls back to home when cwd is unavailable", () => {
    expect(resolveBaseDir("sub/", null, home)).toBe("/home/u/sub/");
  });
});
