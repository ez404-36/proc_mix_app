import { useEffect, type RefObject } from "react";

/**
 * Forwards wheel events from a non-scrollable (or fully-scrolled) element
 * to the nearest scrollable ancestor.
 *
 * Attach this to any `textarea` or fixed-height element that sits inside a
 * scrollable panel. Without it, hovering over the element with the cursor
 * and scrolling does nothing — the browser delivers the wheel event to the
 * element but it has nowhere to go.
 */
export function useWheelPassthrough(
  ref: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onWheel = (e: WheelEvent): void => {
      const canScrollDown = el.scrollTop + el.clientHeight < el.scrollHeight;
      const canScrollUp = el.scrollTop > 0;

      const goingDown = e.deltaY > 0;
      const goingUp = e.deltaY < 0;

      // If the element can absorb the scroll in the intended direction, let it.
      if ((goingDown && canScrollDown) || (goingUp && canScrollUp)) return;

      // Otherwise find the nearest scrollable ancestor and forward the event.
      let parent = el.parentElement;
      while (parent) {
        const style = window.getComputedStyle(parent);
        const overflowY = style.overflowY;
        const isScrollable =
          (overflowY === "auto" || overflowY === "scroll") &&
          parent.scrollHeight > parent.clientHeight;
        if (isScrollable) {
          parent.scrollTop += e.deltaY;
          e.preventDefault();
          break;
        }
        parent = parent.parentElement;
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
}
