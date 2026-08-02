import { describe, expect, it } from "vitest";

import { resolveArtifactValues } from "./resolveArtifactValues";

// Helper: build the call args from a plain object of artifact values + a list
// of names, mirroring how the runner constructs them at render time.
function call(
  text: string,
  values: Record<string, string>,
  artifactNames: readonly string[],
): string {
  return resolveArtifactValues(
    text,
    new Map(Object.entries(values)),
    new Set(artifactNames),
  );
}

describe("resolveArtifactValues", () => {
  it("replaces an artifact reference with its value", () => {
    expect(call("config: ${configPath}", { configPath: "/etc/x.conf" }, ["configPath"])).toBe(
      "config: /etc/x.conf",
    );
  });

  it("leaves a non-artifact reference unchanged (command variable)", () => {
    // `someVar` is NOT in the artifactNames set, so the token must survive
    // verbatim — Rust will resolve it at run time via RunOptions.variableValues.
    expect(call("echo ${someVar}", { configPath: "/x" }, ["configPath"])).toBe(
      "echo ${someVar}",
    );
  });

  it("resolves an unset artifact to the empty string", () => {
    // No value provided for the artifact → empty (the user has not entered one
    // yet). Mirrors the spec: "use empty string for display".
    expect(call("config: [${configPath}]", {}, ["configPath"])).toBe("config: []");
  });

  it("uses an inline default when no value is supplied", () => {
    expect(
      call("config: ${configPath:/default/path}", {}, ["configPath"]),
    ).toBe("config: /default/path");
  });

  it("uses the supplied value over the inline default", () => {
    expect(
      call("config: ${configPath:/default/path}", { configPath: "/real.conf" }, ["configPath"]),
    ).toBe("config: /real.conf");
  });

  it("leaves a non-artifact inline-default token unchanged", () => {
    expect(call("echo ${someVar:fallback}", { configPath: "/x" }, ["configPath"])).toBe(
      "echo ${someVar:fallback}",
    );
  });

  it("expands $$ to a literal dollar", () => {
    expect(call("price: $$10", {}, [])).toBe("price: $10");
  });

  it("replaces multiple references in one string", () => {
    expect(
      call(
        "${host}:${port}/${path}",
        { host: "localhost", port: "8080", path: "api" },
        ["host", "port", "path"],
      ),
    ).toBe("localhost:8080/api");
  });

  it("leaves text with no references unchanged", () => {
    expect(call("plain old text", { configPath: "/x" }, ["configPath"])).toBe(
      "plain old text",
    );
  });

  it("leaves a malformed reference starting with a digit unchanged", () => {
    // `${1foo}` — name must start with a letter or underscore. The whole
    // token is preserved verbatim (mirrors the Rust grammar's rejection).
    expect(call("bad: ${1foo}", { configPath: "/x" }, ["configPath", "1foo"])).toBe(
      "bad: ${1foo}",
    );
  });

  it("leaves an empty-name reference unchanged", () => {
    expect(call("bad: ${}", {}, [])).toBe("bad: ${}");
  });

  it("leaves an unterminated reference unchanged", () => {
    expect(call("bad: ${configPath", { configPath: "/x" }, ["configPath"])).toBe(
      "bad: ${configPath",
    );
  });

  it("treats a lone dollar as a literal", () => {
    expect(call("echo $PATH", {}, [])).toBe("echo $PATH");
  });

  it("distinguishes artifacts from command variables that share a name space", () => {
    // `configPath` is an artifact (resolved here); `region` is a command
    // variable (left for Rust). Same `${name}` syntax, different resolver.
    expect(
      call("${configPath} → ${region}", { configPath: "/etc/c" }, ["configPath"]),
    ).toBe("/etc/c → ${region}");
  });

  it("allows a colon in the inline default body", () => {
    // The default is everything up to the closing `}`, so a `:` inside is fine.
    expect(call("v: ${url:http://x:8080}", {}, ["url"])).toBe("v: http://x:8080");
  });

  it("resolves an artifact whose value itself references another artifact", () => {
    // The resolver does NOT recurse — the caller layers values. Here the
    // artifact value was pre-resolved by the runner before being passed in,
    // so the nested reference is already gone. This locks the single-pass
    // contract down (the runner is responsible for ordering).
    expect(
      call("${display}", { display: "openvpn → /etc/x.conf" }, ["configPath", "display"]),
    ).toBe("openvpn → /etc/x.conf");
  });

  it("preserves multibyte UTF-8 around references", () => {
    expect(call("Привет, ${who}! 🚀", { who: "мир" }, ["who"])).toBe("Привет, мир! 🚀");
  });
});
