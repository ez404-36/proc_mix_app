// Portrait-phone breakpoint detector — mirrors the `(max-width: 640px)` media
// query used by the web layout (web.css). Components that must change BEHAVIOUR
// (not just style) at that breakpoint use this; pure styling stays in CSS.
//
// In portrait the console docks to the TOP of the screen, so the resize handle
// sits on the panel's bottom edge and the drag direction is inverted relative
// to the desktop bottom dock — Console reads this flag to flip the delta.

import { useEffect, useState } from "react";

const PORTRAIT_PHONE_QUERY = "(max-width: 640px)";

function matchesPortraitPhone(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(PORTRAIT_PHONE_QUERY).matches;
}

export function usePortraitPhone(): boolean {
  const [isPortraitPhone, setIsPortraitPhone] = useState<boolean>(() =>
    matchesPortraitPhone(),
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia(PORTRAIT_PHONE_QUERY);
    const handler = (e: MediaQueryListEvent): void => {
      setIsPortraitPhone(e.matches);
    };
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  return isPortraitPhone;
}
