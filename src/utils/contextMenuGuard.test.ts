import { describe, expect, it } from "vitest";
import { installContextMenuGuard } from "./contextMenuGuard";

describe("installContextMenuGuard", () => {
  it("prevents the default on a dispatched contextmenu event", () => {
    installContextMenuGuard();

    const event = new Event("contextmenu", { cancelable: true, bubbles: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
