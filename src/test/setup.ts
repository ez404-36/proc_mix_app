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

// jsdom does not implement Blob.prototype.arrayBuffer (nor File's inherited
// copy). `IconPicker` reads an uploaded SVG/PNG through it to build the
// base64 `data:` URI stored in `MiniApp.icon`, so any upload test would throw
// `file.arrayBuffer is not a function`.
//
// Unlike the two stubs above, this is NOT a no-op: it is a faithful
// implementation delegating to jsdom's working `FileReader`, so the bytes the
// component encodes are the real bytes of the blob. Stubbing it out would
// make the encoding path untestable, which is precisely the part that can be
// wrong.
if (
  typeof Blob !== "undefined" &&
  typeof Blob.prototype.arrayBuffer !== "function"
) {
  Blob.prototype.arrayBuffer = function arrayBuffer(
    this: Blob,
  ): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          reject(new Error("FileReader did not produce an ArrayBuffer"));
        }
      };
      reader.onerror = () =>
        reject(reader.error ?? new Error("failed to read blob"));
      reader.readAsArrayBuffer(this);
    });
  };
}

afterEach(() => {
  cleanup();
});
