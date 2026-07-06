import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import { useWheelPassthrough } from "./useWheelPassthrough";

/**
 * jsdom performs no layout, so `scrollTop`, `clientHeight` and `scrollHeight`
 * are all `0` on every element. To simulate a scrollable (or fully-scrolled)
 * element we redefine those properties per-element. Each is `configurable` so a
 * later `Object.defineProperty` on the same element (or a jsdom reset between
 * tests via fresh elements) works cleanly.
 */
function stub(
  el: HTMLElement,
  metrics: { scrollTop?: number; clientHeight?: number; scrollHeight?: number },
): void {
  if (metrics.scrollTop !== undefined) {
    Object.defineProperty(el, "scrollTop", {
      value: metrics.scrollTop,
      writable: true,
      configurable: true,
    });
  }
  if (metrics.clientHeight !== undefined) {
    Object.defineProperty(el, "clientHeight", {
      value: metrics.clientHeight,
      configurable: true,
    });
  }
  if (metrics.scrollHeight !== undefined) {
    Object.defineProperty(el, "scrollHeight", {
      value: metrics.scrollHeight,
      configurable: true,
    });
  }
}

/** Dispatch a cancelable wheel event and report whether it was defaultPrevented. */
function fireWheel(el: HTMLElement, deltaY: number): boolean {
  const ev = new WheelEvent("wheel", { deltaY, cancelable: true, bubbles: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

describe("useWheelPassthrough - no listener attached", () => {
  it("does nothing when ref.current is null (no element to attach to)", () => {
    // Arrange: a ref pointing at nothing.
    const ref = { current: null };

    // Act + Assert: mounting the hook must not throw, and there is no element
    // to dispatch on — the effect returns early before adding a listener.
    expect(() => {
      renderHook(() => useWheelPassthrough(ref));
    }).not.toThrow();
  });
});

describe("useWheelPassthrough - element absorbs the scroll", () => {
  it("lets the element scroll DOWN itself (no passthrough, no preventDefault) when it can scroll down", () => {
    // Arrange: element can scroll down (scrollTop + clientHeight < scrollHeight).
    const el = document.createElement("textarea");
    stub(el, { scrollTop: 0, clientHeight: 100, scrollHeight: 500 });
    const ancestor = document.createElement("div");
    ancestor.style.overflowY = "auto";
    stub(ancestor, { scrollTop: 10, clientHeight: 100, scrollHeight: 500 });
    ancestor.appendChild(el);
    container.appendChild(ancestor);
    const ref = { current: el as HTMLElement };
    renderHook(() => useWheelPassthrough(ref));

    // Act: scroll down.
    const prevented = fireWheel(el, 40);

    // Assert: element absorbs it — ancestor untouched, not prevented.
    expect(prevented).toBe(false);
    expect(ancestor.scrollTop).toBe(10);
  });

  it("lets the element scroll UP itself (no passthrough) when it can scroll up", () => {
    // Arrange: element is scrolled down so it can scroll up (scrollTop > 0).
    const el = document.createElement("textarea");
    stub(el, { scrollTop: 200, clientHeight: 100, scrollHeight: 500 });
    const ancestor = document.createElement("div");
    ancestor.style.overflowY = "auto";
    stub(ancestor, { scrollTop: 10, clientHeight: 100, scrollHeight: 500 });
    ancestor.appendChild(el);
    container.appendChild(ancestor);
    const ref = { current: el as HTMLElement };
    renderHook(() => useWheelPassthrough(ref));

    // Act: scroll up.
    const prevented = fireWheel(el, -40);

    // Assert: element absorbs it — ancestor untouched, not prevented.
    expect(prevented).toBe(false);
    expect(ancestor.scrollTop).toBe(10);
  });
});

describe("useWheelPassthrough - forwards to a scrollable ancestor", () => {
  it("forwards a DOWN scroll to the nearest scrollable ancestor and prevents default", () => {
    // Arrange: element cannot scroll down (fully scrolled / non-scrollable).
    const el = document.createElement("textarea");
    stub(el, { scrollTop: 0, clientHeight: 100, scrollHeight: 100 });
    const ancestor = document.createElement("div");
    ancestor.style.overflowY = "auto";
    stub(ancestor, { scrollTop: 0, clientHeight: 200, scrollHeight: 800 });
    ancestor.appendChild(el);
    container.appendChild(ancestor);
    const ref = { current: el as HTMLElement };
    renderHook(() => useWheelPassthrough(ref));

    // Act: scroll down; element cannot absorb → forward to ancestor.
    const prevented = fireWheel(el, 60);

    // Assert: ancestor scrolled by deltaY, default prevented.
    expect(ancestor.scrollTop).toBe(60);
    expect(prevented).toBe(true);
  });

  it("forwards an UP scroll (negative deltaY) to a scroll-type ancestor", () => {
    // Arrange: element cannot scroll up (scrollTop === 0).
    const el = document.createElement("textarea");
    stub(el, { scrollTop: 0, clientHeight: 100, scrollHeight: 100 });
    const ancestor = document.createElement("div");
    ancestor.style.overflowY = "scroll";
    stub(ancestor, { scrollTop: 300, clientHeight: 200, scrollHeight: 800 });
    ancestor.appendChild(el);
    container.appendChild(ancestor);
    const ref = { current: el as HTMLElement };
    renderHook(() => useWheelPassthrough(ref));

    // Act: scroll up.
    const prevented = fireWheel(el, -50);

    // Assert: ancestor.scrollTop += -50 → 250, prevented.
    expect(ancestor.scrollTop).toBe(250);
    expect(prevented).toBe(true);
  });

  it("skips a non-scrollable ancestor (overflowY visible) and forwards to the first scrollable one further up", () => {
    // Arrange: nearest ancestor has overflowY visible (not scrollable); the
    // next ancestor up is scrollable and should receive the event.
    const el = document.createElement("textarea");
    stub(el, { scrollTop: 0, clientHeight: 100, scrollHeight: 100 });

    const nonScrollable = document.createElement("div");
    nonScrollable.style.overflowY = "visible";
    stub(nonScrollable, { scrollTop: 0, clientHeight: 100, scrollHeight: 900 });

    const scrollable = document.createElement("div");
    scrollable.style.overflowY = "auto";
    stub(scrollable, { scrollTop: 0, clientHeight: 200, scrollHeight: 900 });

    nonScrollable.appendChild(el);
    scrollable.appendChild(nonScrollable);
    container.appendChild(scrollable);
    const ref = { current: el as HTMLElement };
    renderHook(() => useWheelPassthrough(ref));

    // Act.
    const prevented = fireWheel(el, 30);

    // Assert: the visible-overflow ancestor is skipped; the scrollable one gets it.
    expect(nonScrollable.scrollTop).toBe(0);
    expect(scrollable.scrollTop).toBe(30);
    expect(prevented).toBe(true);
  });

  it("skips an overflow-auto ancestor whose content does not overflow (scrollHeight <= clientHeight)", () => {
    // Arrange: ancestor is overflowY:auto but not actually scrollable
    // (scrollHeight === clientHeight), so it must be skipped.
    const el = document.createElement("textarea");
    stub(el, { scrollTop: 0, clientHeight: 100, scrollHeight: 100 });

    const notOverflowing = document.createElement("div");
    notOverflowing.style.overflowY = "auto";
    stub(notOverflowing, { scrollTop: 0, clientHeight: 300, scrollHeight: 300 });

    const scrollable = document.createElement("div");
    scrollable.style.overflowY = "auto";
    stub(scrollable, { scrollTop: 0, clientHeight: 200, scrollHeight: 900 });

    notOverflowing.appendChild(el);
    scrollable.appendChild(notOverflowing);
    container.appendChild(scrollable);
    const ref = { current: el as HTMLElement };
    renderHook(() => useWheelPassthrough(ref));

    // Act.
    const prevented = fireWheel(el, 25);

    // Assert.
    expect(notOverflowing.scrollTop).toBe(0);
    expect(scrollable.scrollTop).toBe(25);
    expect(prevented).toBe(true);
  });

  it("does nothing when no scrollable ancestor exists (loop ends without scroll or preventDefault)", () => {
    // Arrange: element cannot absorb and the only ancestor is non-scrollable.
    const el = document.createElement("textarea");
    stub(el, { scrollTop: 0, clientHeight: 100, scrollHeight: 100 });
    const ancestor = document.createElement("div");
    ancestor.style.overflowY = "visible";
    stub(ancestor, { scrollTop: 0, clientHeight: 100, scrollHeight: 900 });
    ancestor.appendChild(el);
    container.appendChild(ancestor);
    const ref = { current: el as HTMLElement };
    renderHook(() => useWheelPassthrough(ref));

    // Act.
    const prevented = fireWheel(el, 40);

    // Assert: nothing scrolled, default not prevented.
    expect(ancestor.scrollTop).toBe(0);
    expect(prevented).toBe(false);
  });
});

describe("useWheelPassthrough - cleanup", () => {
  it("removes the wheel listener on unmount (a later wheel does not forward to the ancestor)", () => {
    // Arrange: a passthrough-eligible element/ancestor pair.
    const el = document.createElement("textarea");
    stub(el, { scrollTop: 0, clientHeight: 100, scrollHeight: 100 });
    const ancestor = document.createElement("div");
    ancestor.style.overflowY = "auto";
    stub(ancestor, { scrollTop: 0, clientHeight: 200, scrollHeight: 800 });
    ancestor.appendChild(el);
    container.appendChild(ancestor);
    const ref = { current: el as HTMLElement };
    const { unmount } = renderHook(() => useWheelPassthrough(ref));

    // Sanity: while mounted the event forwards.
    fireWheel(el, 20);
    expect(ancestor.scrollTop).toBe(20);

    // Act: unmount removes the listener.
    unmount();
    const prevented = fireWheel(el, 20);

    // Assert: the ancestor is not scrolled again, nothing prevented.
    expect(ancestor.scrollTop).toBe(20);
    expect(prevented).toBe(false);
  });
});
