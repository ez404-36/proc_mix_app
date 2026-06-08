import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// react-i18next is mocked so we can fully control i18n.language and
// changeLanguage without booting the real i18next instance.
const changeLanguageMock = vi.fn();
const i18nState = { language: "en" };
vi.mock("react-i18next", () => ({
  // Stub init plugin so i18n/index.ts side-effect import doesn't crash.
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({
    i18n: {
      get language() {
        return i18nState.language;
      },
      changeLanguage: (lang: string) => {
        changeLanguageMock(lang);
        i18nState.language = lang;
        return Promise.resolve();
      },
    },
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useI18nBridge } from "./useI18nBridge";
import { useUIStore } from "../stores/uiStore";

beforeEach(() => {
  changeLanguageMock.mockReset();
  i18nState.language = "en";
  document.documentElement.removeAttribute("lang");
  useUIStore.setState({ language: "en" });
});

describe("useI18nBridge", () => {
  it("should set documentElement[lang] to the store language on mount", () => {
    useUIStore.setState({ language: "ru" });
    i18nState.language = "ru"; // already matches – no changeLanguage call
    renderHook(() => useI18nBridge());
    expect(document.documentElement.getAttribute("lang")).toBe("ru");
  });

  it("should NOT call i18n.changeLanguage when i18n already matches the store", () => {
    useUIStore.setState({ language: "en" });
    i18nState.language = "en";
    renderHook(() => useI18nBridge());
    expect(changeLanguageMock).not.toHaveBeenCalled();
  });

  it("should call i18n.changeLanguage when the store language differs from i18n", () => {
    useUIStore.setState({ language: "ru" });
    i18nState.language = "en";
    renderHook(() => useI18nBridge());
    expect(changeLanguageMock).toHaveBeenCalledTimes(1);
    expect(changeLanguageMock).toHaveBeenCalledWith("ru");
  });

  it("should re-sync when the store language changes after mount", () => {
    useUIStore.setState({ language: "en" });
    const { rerender } = renderHook(() => useI18nBridge());
    expect(changeLanguageMock).not.toHaveBeenCalled();

    act(() => {
      useUIStore.setState({ language: "ru" });
    });
    rerender();

    expect(changeLanguageMock).toHaveBeenCalledWith("ru");
    expect(document.documentElement.getAttribute("lang")).toBe("ru");
  });
});
