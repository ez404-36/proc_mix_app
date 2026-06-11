import type { Command } from "../types";
import type { Platform } from "../types/platform";

interface SeedScript {
  script: string;
  shell: NonNullable<Command["shell"]>;
}

interface SeedTemplate {
  nameKey: string;
  nameFallback: string;
  descriptionKey: string;
  descriptionFallback: string;
  tags: string[];
  favorite: boolean;
  scripts: Record<Platform, SeedScript>;
}

/**
 * Built-in demo commands shown on first launch. Each entry carries a
 * per-platform variant: the script and shell pair that is correct for the
 * host OS. The store picks the right variant once the platform has been
 * resolved via the Rust `get_platform` IPC command.
 *
 * Literal `nameFallback` / `descriptionFallback` mirror the i18n keys and
 * act as safety strings when translations have not loaded yet.
 */
const SEED_TEMPLATES: readonly SeedTemplate[] = [
  {
    nameKey: "seeds.listHomeDir.name",
    nameFallback: "List home directory",
    descriptionKey: "seeds.listHomeDir.description",
    descriptionFallback:
      "Show a detailed listing of files in your home directory.",
    tags: ["files", "demo"],
    favorite: true,
    scripts: {
      linux: { script: "ls -la ~", shell: "bash" },
      macos: { script: "ls -la ~", shell: "zsh" },
      windows: { script: "Get-ChildItem -Force ~", shell: "powershell" },
    },
  },
  {
    nameKey: "seeds.showDate.name",
    nameFallback: "Show date",
    descriptionKey: "seeds.showDate.description",
    descriptionFallback: "Print the current date and time.",
    tags: ["system", "demo"],
    favorite: false,
    scripts: {
      linux: { script: "date", shell: "bash" },
      macos: { script: "date", shell: "zsh" },
      windows: { script: "Get-Date", shell: "powershell" },
    },
  },
  {
    nameKey: "seeds.diskUsage.name",
    nameFallback: "Disk usage",
    descriptionKey: "seeds.diskUsage.description",
    descriptionFallback: "Show disk space usage in human-readable form.",
    tags: ["system", "disk", "demo"],
    favorite: false,
    scripts: {
      linux: { script: "df -h", shell: "bash" },
      macos: { script: "df -h", shell: "zsh" },
      windows: {
        script:
          "Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize",
        shell: "powershell",
      },
    },
  },
];

function makeId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `cmd-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Materialize the seed templates into concrete `Command` records for the
 * given host platform. Each call produces fresh ids and timestamps.
 */
export function buildSeedsForPlatform(platform: Platform): Command[] {
  const ts = new Date().toISOString();
  return SEED_TEMPLATES.map((tpl) => {
    const variant = tpl.scripts[platform];
    return {
      id: makeId(),
      name: tpl.nameFallback,
      nameKey: tpl.nameKey,
      description: tpl.descriptionFallback,
      descriptionKey: tpl.descriptionKey,
      script: variant.script,
      shell: variant.shell,
      tags: [...tpl.tags],
      favorite: tpl.favorite,
      createdAt: ts,
      updatedAt: ts,
      runCount: 0,
      // Seed commands ship non-elevated. Users can opt-in via the
      // edit form after they trust a particular seed enough.
      runAsAdmin: false,
    };
  });
}
