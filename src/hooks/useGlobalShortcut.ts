import { useEffect, useRef } from "react";
import {
  isRegistered,
  register,
  unregister,
  type ShortcutEvent,
} from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUIStore } from "../stores/uiStore";

async function handleTogglePress(): Promise<void> {
  const win = getCurrentWindow();
  const visible = await win.isVisible();
  if (!visible) {
    await win.show();
    await win.unminimize();
    await win.setFocus();
    useUIStore.getState().setPaletteOpen(true);
    return;
  }
  const focused = await win.isFocused();
  if (!focused) {
    await win.unminimize();
    await win.setFocus();
    return;
  }
  await win.hide();
}

async function safeUnregister(accel: string): Promise<void> {
  try {
    if (await isRegistered(accel)) {
      await unregister(accel);
    }
  } catch (err) {
    console.warn("[global-shortcut] unregister failed", accel, err);
  }
}

// Serialize all register/unregister work onto a single promise chain. React 19
// dev double-invokes effects (mount → unmount → mount); without serialization,
// the second mount's register() can interleave with the first cycle's still
// in-flight register() and the OS reports "HotKey already registered". Chaining
// every operation guarantees one settles before the next begins.
let opChain: Promise<void> = Promise.resolve();

function runSerialized(op: () => Promise<void>): Promise<void> {
  const next = opChain.then(op, op);
  // Swallow rejection on the chain so one failed op doesn't poison the next;
  // individual ops already log their own errors.
  opChain = next.catch(() => undefined);
  return next;
}

export function useGlobalShortcut(): void {
  const accelerator = useUIStore((s) => s.toggleShortcut);
  const lastRegistered = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const apply = async (): Promise<void> => {
      const previous = lastRegistered.current;
      if (previous && previous !== accelerator) {
        await safeUnregister(previous);
        lastRegistered.current = null;
      }

      // Defensive: always unregister the target accelerator before
      // registering it. This makes the hook idempotent and StrictMode-safe:
      // React 19 dev double-invokes effects (mount → unmount → mount), and
      // the async register/unregister calls from the first cycle may not
      // have settled before the second mount's apply() runs. Forcing an
      // unregister first guarantees a clean slot.
      await safeUnregister(accelerator);

      if (cancelled) return;

      try {
        await register(accelerator, (event: ShortcutEvent) => {
          if (event.state === "Pressed") {
            void handleTogglePress().catch((err) => {
              console.error("[global-shortcut] toggle handler failed", err);
            });
          }
        });
        if (!cancelled) {
          lastRegistered.current = accelerator;
        } else {
          // Effect was cancelled while register() was in flight — clean up.
          await safeUnregister(accelerator);
        }
      } catch (err) {
        console.error(
          "[global-shortcut] failed to register",
          accelerator,
          err,
        );
      }
    };

    // Run apply() and the cleanup unregister on the shared serial chain so a
    // StrictMode mount/unmount/mount burst never overlaps register/unregister
    // calls (which the OS rejects as "already registered").
    void runSerialized(apply);

    return () => {
      cancelled = true;
      void runSerialized(async () => {
        const current = lastRegistered.current;
        if (!current) return;
        await safeUnregister(current);
        lastRegistered.current = null;
      });
    };
  }, [accelerator]);
}
