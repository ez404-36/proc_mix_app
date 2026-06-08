// Secret redaction for captured command lines.
//
// Process Capture surfaces raw OS command lines, which can carry passwords
// and tokens (`mysql --password=hunter2`, `curl -H "Authorization: Bearer
// abc"`, `https://user:pw@host/...`). This module masks those values BEFORE
// they are shown in the UI and again BEFORE anything derived from them is
// saved (defence in depth). See `docs/process-capture.md`.
//
// PURE module: no IPC, no DOM — just string -> string. Fully unit-tested.
//
// Design notes:
//   - We redact VALUES, never the flag/key names, so the user can still
//     recognise the command shape (`--password=***` not `***`).
//   - Patterns are intentionally broad on the key side (password, passwd,
//     pwd, token, secret, apikey, api-key, auth) and conservative on the
//     value side (stop at whitespace) to avoid eating the rest of the line.
//   - This is a best-effort safety net, not a guarantee. Over-redaction is
//     acceptable; under-redaction is the failure we optimise against.

/** The string substituted in place of every detected secret value. */
export const REDACTION = "***";

/**
 * Key names (case-insensitive) whose associated value is treated as a
 * secret. Matched as whole words so `--password` matches but `--passive`
 * does not.
 */
const SECRET_KEYS = [
  "password",
  "passwd",
  "pwd",
  "token",
  "secret",
  "apikey",
  "api-key",
  "api_key",
  "auth",
  "access-token",
  "access_token",
  "client-secret",
  "client_secret",
];

const SECRET_KEY_ALTERNATION = SECRET_KEYS.join("|");

/**
 * `--key=value` / `--key:value` / `key=value` forms. The value runs to the
 * next whitespace; quoted values are captured whole (including quotes) so
 * the closing quote isn't left dangling.
 *
 * Group 1: the key + separator we keep. Group 2: the value we mask.
 */
const KEY_VALUE_RE = new RegExp(
  `((?:^|\\s)-{0,2}(?:${SECRET_KEY_ALTERNATION})\\s*[=:]\\s*)("[^"]*"|'[^']*'|\\S+)`,
  "gi",
);

/**
 * `--key value` / `-p value` space-separated forms for the same secret
 * keys, plus the short `-p` / `-P` password flags common to db/ssh tools.
 *
 * Group 1: the flag + the run of whitespace we keep. Group 2: the value.
 */
const FLAG_SPACE_RE = new RegExp(
  `((?:^|\\s)(?:-{1,2}(?:${SECRET_KEY_ALTERNATION})|-[pP])\\s+)("[^"]*"|'[^']*'|\\S+)`,
  "gi",
);

/** HTTP `Authorization: Bearer <token>` / `Basic <token>` header values. */
const BEARER_RE = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]+)/gi;

/** `scheme://user:password@host` — mask only the password component. */
const URL_CREDENTIALS_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@]+)(@)/gi;

/**
 * Mask secret values inside a single command-line string. Returns a new
 * string with every detected secret replaced by {@link REDACTION}; the
 * input is never mutated. Non-secret text is preserved verbatim.
 */
export function redactSecrets(commandLine: string): string {
  if (commandLine.length === 0) return commandLine;

  let out = commandLine;
  out = out.replace(KEY_VALUE_RE, (_m, keep: string) => `${keep}${REDACTION}`);
  out = out.replace(FLAG_SPACE_RE, (_m, keep: string) => `${keep}${REDACTION}`);
  out = out.replace(
    BEARER_RE,
    (_m, scheme: string) => `${scheme} ${REDACTION}`,
  );
  out = out.replace(
    URL_CREDENTIALS_RE,
    (_m, pre: string, _pw: string, at: string) => `${pre}${REDACTION}${at}`,
  );
  return out;
}
