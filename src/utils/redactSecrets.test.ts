import { describe, expect, it } from "vitest";

import { redactSecrets, REDACTION } from "./redactSecrets";

describe("redactSecrets", () => {
  it("returns empty string unchanged", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("leaves a command with no secrets untouched", () => {
    const cmd = "git commit -m 'fix: thing' --amend";
    expect(redactSecrets(cmd)).toBe(cmd);
  });

  it("masks --password=value but keeps the key", () => {
    expect(redactSecrets("mysql --password=hunter2 -u root")).toBe(
      `mysql --password=${REDACTION} -u root`,
    );
  });

  it("masks key=value without leading dashes", () => {
    expect(redactSecrets("connect token=abc123 host=db")).toBe(
      `connect token=${REDACTION} host=db`,
    );
  });

  it("masks colon-separated secrets", () => {
    expect(redactSecrets("--secret:topsecret")).toBe(`--secret:${REDACTION}`);
  });

  it("masks space-separated --token value", () => {
    expect(redactSecrets("api --token abcdef next")).toBe(
      `api --token ${REDACTION} next`,
    );
  });

  it("masks the short -p password flag", () => {
    expect(redactSecrets("mysql -p hunter2")).toBe(`mysql -p ${REDACTION}`);
  });

  it("masks quoted values whole", () => {
    expect(redactSecrets('login --password="pw with spaces" --user me')).toBe(
      `login --password=${REDACTION} --user me`,
    );
  });

  it("masks Authorization Bearer tokens", () => {
    expect(
      redactSecrets('curl -H "Authorization: Bearer eyJhbGciOi.J9.x"'),
    ).toContain(`Bearer ${REDACTION}`);
    expect(redactSecrets("Authorization: Bearer eyJhbGciOi.J9.x")).not.toContain(
      "eyJhbGciOi",
    );
  });

  it("masks the password in a URL with credentials", () => {
    const out = redactSecrets("psql postgres://user:s3cr3t@localhost/db");
    // `toBe` fully pins the output: the password is masked while the
    // username, host, and path are preserved verbatim.
    expect(out).toBe(`psql postgres://user:${REDACTION}@localhost/db`);
    expect(out).not.toContain("s3cr3t");
  });

  it("does not redact non-secret flags that merely contain a substring", () => {
    // `--passive` contains `pass` but is not a secret key.
    const cmd = "ftp --passive --port 21";
    expect(redactSecrets(cmd)).toBe(cmd);
  });

  it("masks multiple secrets in one line", () => {
    const out = redactSecrets("run --password=a --token b --user me");
    expect(out).toBe(
      `run --password=${REDACTION} --token ${REDACTION} --user me`,
    );
  });

  it("is case-insensitive on the key", () => {
    expect(redactSecrets("--PASSWORD=x")).toBe(`--PASSWORD=${REDACTION}`);
  });

  it("never leaks the original secret value", () => {
    const secret = "S3cr3tV@lue!";
    const inputs = [
      `--password=${secret}`,
      `--token ${secret}`,
      `-p ${secret}`,
      `Authorization: Bearer ${secret}`,
      `https://u:${secret}@h/p`,
    ];
    for (const input of inputs) {
      expect(redactSecrets(input)).not.toContain(secret);
    }
  });

  it("does not mutate its input", () => {
    const input = "--password=abc";
    redactSecrets(input);
    expect(input).toBe("--password=abc");
  });
});
