import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

/**
 * Resolve the application version string (from `tauri.conf.json` /
 * `Cargo.toml`) via the Tauri `app` API. Returns `null` until the async
 * lookup resolves, so callers can render a placeholder or hide the line.
 *
 * The lookup is read-only and never throws to the UI: if the Tauri API is
 * unavailable (e.g. a non-Tauri test/web context) the version stays `null`.
 */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const v = await getVersion();
        if (!cancelled) setVersion(v);
      } catch {
        // Non-Tauri context (tests/web preview) — leave the version unset
        // rather than surfacing an error for a purely informational label.
        if (!cancelled) setVersion(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}
