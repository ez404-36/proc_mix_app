import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/pluginService", () => ({
  listPlugins: vi.fn(),
  listPluginCatalog: vi.fn(),
  removePlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
  installPluginVersion: vi.fn(),
}));

import {
  installPluginVersion,
  listPluginCatalog,
  listPlugins,
  removePlugin,
  setPluginEnabled,
} from "../services/pluginService";
import type { CatalogPlugin, PluginView } from "../types/plugin";
import { usePluginStore } from "./pluginStore";

const listPluginsMock = vi.mocked(listPlugins);
const listPluginCatalogMock = vi.mocked(listPluginCatalog);
const removePluginMock = vi.mocked(removePlugin);
const setPluginEnabledMock = vi.mocked(setPluginEnabled);
const installPluginVersionMock = vi.mocked(installPluginVersion);

function pluginView(overrides: Partial<PluginView> = {}): PluginView {
  return {
    id: "acme.hello",
    name: "Hello",
    source: "user",
    status: "enabled",
    permissions: { network: false, fs: false, process: false },
    contributes: {
      parsers: 0,
      presets: 0,
      eventHandlers: 0,
      nodeKinds: 0,
      content: { commands: 0, workflows: 0 },
    },
    osCompatible: true,
    dir: "/plugins/user/hello",
    ...overrides,
  };
}

function catalogPlugin(overrides: Partial<CatalogPlugin> = {}): CatalogPlugin {
  return {
    name: "hello",
    id: "acme.hello",
    displayName: "Hello",
    versions: [],
    latestVersion: "1.0.0",
    ...overrides,
  };
}

beforeEach(() => {
  usePluginStore.setState({
    plugins: [],
    catalog: [],
    isLoading: false,
    installing: null,
    error: null,
  });
  listPluginsMock.mockReset();
  listPluginsMock.mockResolvedValue([]);
  listPluginCatalogMock.mockReset();
  listPluginCatalogMock.mockResolvedValue([]);
  removePluginMock.mockReset();
  removePluginMock.mockResolvedValue(undefined);
  setPluginEnabledMock.mockReset();
  setPluginEnabledMock.mockResolvedValue(undefined);
  installPluginVersionMock.mockReset();
  installPluginVersionMock.mockResolvedValue(pluginView());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pluginStore.load", () => {
  it("sets plugins and catalog, clears error and ends not loading on success", async () => {
    const plugins = [pluginView()];
    const catalog = [catalogPlugin()];
    listPluginsMock.mockResolvedValueOnce(plugins);
    listPluginCatalogMock.mockResolvedValueOnce(catalog);

    await usePluginStore.getState().load();

    const state = usePluginStore.getState();
    expect(state.plugins).toEqual(plugins);
    expect(state.catalog).toEqual(catalog);
    expect(state.error).toBeNull();
    expect(state.isLoading).toBe(false);
  });

  it("records an Error message and still ends not loading on rejection", async () => {
    listPluginsMock.mockRejectedValueOnce(new Error("boom"));

    await usePluginStore.getState().load();

    const state = usePluginStore.getState();
    expect(state.error).toBe("boom");
    expect(state.isLoading).toBe(false);
  });

  it("stringifies a non-Error rejection value", async () => {
    listPluginCatalogMock.mockRejectedValueOnce("catalog-down");

    await usePluginStore.getState().load();

    expect(usePluginStore.getState().error).toBe("catalog-down");
    expect(usePluginStore.getState().isLoading).toBe(false);
  });
});

describe("pluginStore.setEnabled", () => {
  it("toggles the plugin then reloads", async () => {
    const reloaded = [pluginView({ status: "disabled" })];
    listPluginsMock.mockResolvedValueOnce(reloaded);

    await usePluginStore.getState().setEnabled("acme.hello", false);

    expect(setPluginEnabledMock).toHaveBeenCalledWith("acme.hello", false);
    expect(usePluginStore.getState().plugins).toEqual(reloaded);
    expect(usePluginStore.getState().error).toBeNull();
  });

  it("records an error and skips reload when the toggle fails", async () => {
    setPluginEnabledMock.mockRejectedValueOnce(new Error("toggle-failed"));

    await usePluginStore.getState().setEnabled("acme.hello", true);

    expect(usePluginStore.getState().error).toBe("toggle-failed");
    expect(listPluginsMock).not.toHaveBeenCalled();
  });
});

describe("pluginStore.remove", () => {
  it("removes the plugin then reloads", async () => {
    listPluginsMock.mockResolvedValueOnce([]);

    await usePluginStore.getState().remove("acme.hello");

    expect(removePluginMock).toHaveBeenCalledWith("acme.hello");
    expect(usePluginStore.getState().plugins).toEqual([]);
    expect(usePluginStore.getState().error).toBeNull();
  });

  it("records an error and skips reload when removal fails", async () => {
    removePluginMock.mockRejectedValueOnce(new Error("remove-failed"));

    await usePluginStore.getState().remove("acme.hello");

    expect(usePluginStore.getState().error).toBe("remove-failed");
    expect(listPluginsMock).not.toHaveBeenCalled();
  });
});

describe("pluginStore.install", () => {
  it("sets installing, installs, reloads, then clears installing", async () => {
    const reloaded = [pluginView({ version: "2.0.0" })];
    listPluginsMock.mockResolvedValueOnce(reloaded);

    await usePluginStore.getState().install("hello", "2.0.0");

    expect(installPluginVersionMock).toHaveBeenCalledWith("hello", "2.0.0");
    expect(usePluginStore.getState().plugins).toEqual(reloaded);
    expect(usePluginStore.getState().installing).toBeNull();
    expect(usePluginStore.getState().error).toBeNull();
  });

  it("records an Error, re-throws, and clears installing on failure", async () => {
    installPluginVersionMock.mockRejectedValueOnce(new Error("install-failed"));

    await expect(
      usePluginStore.getState().install("hello", "2.0.0"),
    ).rejects.toThrow("install-failed");

    expect(usePluginStore.getState().error).toBe("install-failed");
    expect(usePluginStore.getState().installing).toBeNull();
    expect(listPluginsMock).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error rejection, re-throws, and clears installing", async () => {
    installPluginVersionMock.mockRejectedValueOnce("nope");

    await expect(
      usePluginStore.getState().install("hello", "2.0.0"),
    ).rejects.toBe("nope");

    expect(usePluginStore.getState().error).toBe("nope");
    expect(usePluginStore.getState().installing).toBeNull();
  });
});
