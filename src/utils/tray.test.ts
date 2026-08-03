import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import { buildTrayLabels, updateTrayMenu, type TrayLabels } from "./tray";

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/**
 * Fake i18next translator. Keys carrying the product name embed the literal
 * "ProcMix"; the notify bodies echo the `{{name}}` placeholder so we can
 * verify it survives translation.
 */
const fakeT = vi.fn((key: string, opts?: { name?: string }) => {
  const map: Record<string, string> = {
    "tray.show": "Показать ProcMix",
    "tray.hide": "Скрыть ProcMix",
    "tray.quit": "Выйти из ProcMix",
    "tray.tooltip": "ProcMix",
    "tray.favorites": "Избранное",
    "tray.favoritesEmpty": "Пусто",
    "tray.favoritesMore": "Ещё…",
    "tray.miniApps": "Мини-приложения",
    "tray.miniAppsEmpty": "Нет избранных мини-приложений",
    "tray.notifyTitle": "ProcMix",
    "tray.notifySuccess": `Готово: ${opts?.name ?? ""}`,
    "tray.notifyError": `Ошибка: ${opts?.name ?? ""}`,
    "tray.notifyMissingVariable": `Нет переменной: ${opts?.name ?? ""}`,
    "tray.notifyNotFound": "Не найдено",
  };
  return map[key] ?? key;
}) as unknown as TFunction;

describe("buildTrayLabels", () => {
  it("builds all labels and keeps the {{name}} placeholder in production", () => {
    vi.stubEnv("DEV", false);

    const labels = buildTrayLabels(fakeT);

    expect(labels).toEqual<TrayLabels>({
      show: "Показать ProcMix",
      hide: "Скрыть ProcMix",
      quit: "Выйти из ProcMix",
      tooltip: "ProcMix",
      favorites: "Избранное",
      favoritesEmpty: "Пусто",
      favoritesMore: "Ещё…",
      miniApps: "Мини-приложения",
      miniAppsEmpty: "Нет избранных мини-приложений",
      notifyTitle: "ProcMix",
      notifySuccess: "Готово: {{name}}",
      notifyError: "Ошибка: {{name}}",
      notifyMissingVariable: "Нет переменной: {{name}}",
      notifyNotFound: "Не найдено",
    });
  });

  it("appends ' (dev)' to the product name in a dev build", () => {
    vi.stubEnv("DEV", true);

    const labels = buildTrayLabels(fakeT);

    expect(labels.show).toBe("Показать ProcMix (dev)");
    expect(labels.hide).toBe("Скрыть ProcMix (dev)");
    expect(labels.quit).toBe("Выйти из ProcMix (dev)");
    expect(labels.tooltip).toBe("ProcMix (dev)");
    expect(labels.notifyTitle).toBe("ProcMix (dev)");
    // Labels without the product token pass through unchanged.
    expect(labels.favorites).toBe("Избранное");
    expect(labels.notifySuccess).toBe("Готово: {{name}}");
    expect(labels.miniApps).toBe("Мини-приложения");
    expect(labels.miniAppsEmpty).toBe("Нет избранных мини-приложений");
  });
});

describe("updateTrayMenu", () => {
  it("invokes update_tray_menu with the labels payload", async () => {
    invokeMock.mockResolvedValue(undefined);
    const labels: TrayLabels = {
      show: "s",
      hide: "h",
      quit: "q",
      tooltip: "t",
      favorites: "f",
      favoritesEmpty: "fe",
      favoritesMore: "fm",
      miniApps: "ma",
      miniAppsEmpty: "mae",
      notifyTitle: "nt",
      notifySuccess: "ns",
      notifyError: "ne",
      notifyMissingVariable: "nmv",
      notifyNotFound: "nnf",
    };

    await updateTrayMenu(labels);

    expect(invokeMock).toHaveBeenCalledWith("update_tray_menu", { labels });
  });

  it("propagates a rejection from the IPC call", async () => {
    const error = new Error("tray failed");
    invokeMock.mockRejectedValue(error);
    const labels = buildTrayLabels(fakeT);

    await expect(updateTrayMenu(labels)).rejects.toBe(error);
  });
});
