#!/usr/bin/env node
// `npm run askpass:status` — report whether the `procmix-askpass` SSH helper
// is built and where, so it's obvious at a glance whether remote password
// authentication will work in the current dev environment.
//
// The helper is gated behind the `ssh-askpass` Cargo feature (off by default),
// so a plain `cargo build` / `tauri dev` does NOT produce it. Without it, a
// remote command that prompts for an SSH password fails with
// `SSH_PASSWORD_BACKEND:askpass helper not found...`. This script makes that
// state explicit and tells you how to fix it.
//
// Cross-platform on purpose (a node script, not a shell one-liner) — though the
// feature itself is Unix-only.

import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// scripts/ lives at app/scripts; the cargo target dir is app/src-tauri/target.
const targetDir = join(here, "..", "src-tauri", "target");

// On Windows the helper isn't used at all (remote password auth is Unix-only);
// the binary would still carry no extension here because we never build it
// there, but check both names defensively.
const isWindows = process.platform === "win32";
const binName = isWindows ? "procmix-askpass.exe" : "procmix-askpass";

const profiles = ["debug", "release"];

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

console.log("procmix-askpass (SSH password helper) status\n");

if (isWindows) {
  console.log(
    yellow("  platform: Windows — remote password auth is unsupported."),
  );
  console.log(
    dim(
      "  Use SSH keys / the agent for remote commands. The helper is Unix-only.",
    ),
  );
  process.exit(0);
}

let foundAny = false;
for (const profile of profiles) {
  const p = join(targetDir, profile, binName);
  if (existsSync(p)) {
    foundAny = true;
    const { size, mtime } = statSync(p);
    const kb = (size / 1024).toFixed(0);
    console.log(
      `  ${green("✓")} ${profile.padEnd(7)} ${p} ${dim(`(${kb} KB, built ${mtime.toISOString()})`)}`,
    );
  } else {
    console.log(`  ${red("✗")} ${profile.padEnd(7)} ${dim(`${p} — not built`)}`);
  }
}

console.log("");
if (foundAny) {
  console.log(
    green(
      "  Remote SSH password authentication is available in this environment.",
    ),
  );
  console.log(
    dim(
      "  (The executor resolves the helper next to the running binary, or from the\n   app bundle's resource dir in an installed build.)",
    ),
  );
} else {
  console.log(
    yellow("  The helper is NOT built — remote password auth will fail."),
  );
  console.log("  Build it with one of:");
  console.log(dim("    npm run build:askpass          # debug, for tauri dev"));
  console.log(dim("    npm run build:askpass:release  # release, for bundling"));
  console.log(
    dim("    npm run dev:remote             # build helper + start tauri dev"),
  );
  // Non-zero so CI / scripts can detect the missing helper.
  process.exit(1);
}
