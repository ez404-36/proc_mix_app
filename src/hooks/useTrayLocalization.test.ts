import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { TFunction } from "i18next";
import type { TrayLabels } from "../utils/tray";

// A mutable language the mocked useTranslation reports, so re-rendering with a
// changed language re-runs the effect (accelerator dep).
let currentLanguage = "en";
const tFn = (key: string): string => key;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tFn, i18n: { language: currentLanguage } }),
}));

const sampleLabels: TrayLabels = {
  show: "tray.show",
  hide: "tray.hide",
  quit: "tray.quit",
  tooltip: "tray.tooltip",
  favorites: "tray.favorites",
  favoritesEmpty: "tray.favoritesEmpty",
  favoritesMore: "tray.favoritesMore",
  notifyTitle: "tray.notifyTitle",
  notifySuccess: "tray.notifySuccess",
  notifyError: "tray.notifyError",
  notifyMissingVariable: "tray.notifyMissingVariable",
  notifyNotFound: "tray.notifyNotFound",
};

const buildTrayLabelsMock = vi.fn<(t: TFunction) => TrayLabels>(
  () => sampleLabels,
);
const updateTrayMenuMock = vi.fn<(labels: TrayLabels) => Promise<void>>();
vi.mock("../utils/tray", () => ({
  buildTrayLabels: (t: TFunction) => buildTrayLabelsMock(t),
  updateTrayMenu: (labels: TrayLabels) => updateTrayMenuMock(labels),
}));

import { useTrayLocalization } from "./useTrayLocalization";

beforeEach(() => {
  currentLanguage = "en";
  buildTrayLabelsMock.mockReset().mockReturnValue(sampleLabels);
  updateTrayMenuMock.mockReset().mockResolvedValue(undefined);
});

describe("useTrayLocalization - initial build", () => {
  it("should build labels and push them to the tray on mount", () => {
    // Arrange + Act
    renderHook(() => useTrayLocalization());

    // Assert
    expect(buildTrayLabelsMock).toHaveBeenCalledTimes(1);
    expect(updateTrayMenuMock).toHaveBeenCalledTimes(1);
    expect(updateTrayMenuMock).toHaveBeenCalledWith(sampleLabels);
  });
});

describe("useTrayLocalization - failure handling", () => {
  it("should log a warning and not throw when updateTrayMenu rejects", async () => {
    // Arrange: the tray may be absent in headless/dev environments.
    updateTrayMenuMock.mockRejectedValue(new Error("no tray"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Act
    renderHook(() => useTrayLocalization());

    // Assert
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "Failed to update tray menu",
        expect.any(Error),
      );
    });
    warnSpy.mockRestore();
  });
});

describe("useTrayLocalization - language change", () => {
  it("should re-run the effect when the language changes", () => {
    // Arrange
    const { rerender } = renderHook(() => useTrayLocalization());
    expect(updateTrayMenuMock).toHaveBeenCalledTimes(1);

    // Act: change the reported language, then re-render.
    currentLanguage = "ru";
    rerender();

    // Assert: the effect fired again for the new language.
    expect(updateTrayMenuMock).toHaveBeenCalledTimes(2);
    expect(buildTrayLabelsMock).toHaveBeenCalledTimes(2);
  });
});
