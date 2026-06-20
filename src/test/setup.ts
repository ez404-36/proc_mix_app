// Vitest setup file: runs before every test file.
// Cleans up DOM between tests and exposes commonly used globals.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom does not implement ResizeObserver, which @xyflow/react's core requires
// on mount. Any test that renders a real @xyflow/react canvas (e.g. the
// read-only WorkflowView preview shown when double-clicking a Library card)
// would throw `ResizeObserver is not defined`. A no-op stub is enough: jsdom
// never lays out elements, so there is nothing to observe — tests that care
// about canvas internals mock @xyflow/react outright; this just keeps the
// mount from crashing.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom does not implement Element.prototype.scrollIntoView. The custom
// Dropdown calls it to keep the active option visible during keyboard
// navigation; any test that opens a Dropdown (e.g. the CommandForm
// category picker) would otherwise throw `scrollIntoView is not a
// function`. A no-op stub is sufficient — jsdom has no real layout.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

afterEach(() => {
  cleanup();
});
