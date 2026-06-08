import { describe, expect, it, vi } from "vitest";

import {
  resolveCaptureConsent,
  type ConsentStore,
} from "./processCaptureConsent";

/** In-memory store double mirroring the `useUIStore` slice. */
function makeStore(initial: boolean): ConsentStore & { value: boolean } {
  return {
    value: initial,
    isEnabled() {
      return this.value;
    },
    setEnabled(enabled: boolean) {
      this.value = enabled;
    },
  };
}

describe("resolveCaptureConsent", () => {
  it("grants immediately without prompting when already enabled", async () => {
    const store = makeStore(true);
    const requestConsent = vi.fn().mockResolvedValue(true);

    const result = await resolveCaptureConsent(store, requestConsent);

    expect(result).toEqual({
      granted: true,
      alreadyGranted: true,
      justGranted: false,
    });
    expect(requestConsent).not.toHaveBeenCalled();
  });

  it("prompts, persists, and grants when the user accepts", async () => {
    const store = makeStore(false);
    const requestConsent = vi.fn().mockResolvedValue(true);

    const result = await resolveCaptureConsent(store, requestConsent);

    expect(requestConsent).toHaveBeenCalledOnce();
    expect(store.value).toBe(true);
    expect(result).toEqual({
      granted: true,
      alreadyGranted: false,
      justGranted: true,
    });
  });

  it("does not grant or persist when the user declines", async () => {
    const store = makeStore(false);
    const requestConsent = vi.fn().mockResolvedValue(false);

    const result = await resolveCaptureConsent(store, requestConsent);

    expect(requestConsent).toHaveBeenCalledOnce();
    expect(store.value).toBe(false);
    expect(result).toEqual({
      granted: false,
      alreadyGranted: false,
      justGranted: false,
    });
  });

  it("never enables capture silently — the flag flips only on accept", async () => {
    const store = makeStore(false);
    // Decline first.
    await resolveCaptureConsent(store, vi.fn().mockResolvedValue(false));
    expect(store.value).toBe(false);
    // Then accept.
    await resolveCaptureConsent(store, vi.fn().mockResolvedValue(true));
    expect(store.value).toBe(true);
  });
});
