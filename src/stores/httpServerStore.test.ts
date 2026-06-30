import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the service layer so the store's IPC calls are fully controlled.
const getStatusMock = vi.fn();
const getConfigMock = vi.fn();
const getTokenStatusMock = vi.fn();
const listLogMock = vi.fn();
const startMock = vi.fn();
const stopMock = vi.fn();
const setConfigMock = vi.fn();
const setLanguageMock = vi.fn();
const regenMock = vi.fn();
const clearMock = vi.fn();
const clearLogMock = vi.fn();

vi.mock("../services/httpServerService", () => ({
  getHttpServerStatus: () => getStatusMock(),
  getHttpServerConfig: () => getConfigMock(),
  getApiTokenStatus: () => getTokenStatusMock(),
  listRequestLog: () => listLogMock(),
  startHttpServer: () => startMock(),
  stopHttpServer: () => stopMock(),
  setHttpServerConfig: (cfg: unknown) => setConfigMock(cfg),
  setHttpServerLanguage: (lang: unknown) => setLanguageMock(lang),
  regenerateApiToken: () => regenMock(),
  clearApiToken: () => clearMock(),
  clearRequestLog: () => clearLogMock(),
}));

// The store reads the current app language from the UI store; force a stable
// value so `syncLanguage` pushes a known language.
vi.mock("./uiStore", () => ({
  useUIStore: { getState: () => ({ language: "ru" }) },
}));

import {
  REQUEST_LOG_LIMIT,
  useHttpServerStore,
} from "./httpServerStore";
import type { HttpServerConfig, RequestLogEntry } from "../types/httpServer";

function entry(n: number): RequestLogEntry {
  return {
    ts: `2026-06-24T00:00:${String(n).padStart(2, "0")}Z`,
    method: "POST",
    path: "/api/command/{ref}/run",
    status: 202,
    remoteAddr: "127.0.0.1:1",
  };
}

function resetStore() {
  useHttpServerStore.setState({
    status: {
      running: false,
      port: 48610,
      bindLan: false,
      languageSnapshotMissing: false,
    },
    config: {
      enabled: false,
      port: 48610,
      bindLan: false,
      logToConsole: true,
      serveWebUi: false,
    },
    hasToken: false,
    log: [],
    isLoading: false,
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("appendLog", () => {
  it("appends entries in order", () => {
    const { appendLog } = useHttpServerStore.getState();
    appendLog(entry(1));
    appendLog(entry(2));
    const log = useHttpServerStore.getState().log;
    expect(log).toHaveLength(2);
    expect(log[0]?.ts).toContain(":01");
    expect(log[1]?.ts).toContain(":02");
  });

  it("caps the log at REQUEST_LOG_LIMIT, evicting the oldest", () => {
    const { appendLog } = useHttpServerStore.getState();
    for (let i = 0; i < REQUEST_LOG_LIMIT + 5; i += 1) {
      appendLog({ ...entry(0), status: i });
    }
    const log = useHttpServerStore.getState().log;
    expect(log).toHaveLength(REQUEST_LOG_LIMIT);
    // The first 5 were evicted; the oldest survivor has status 5.
    expect(log[0]?.status).toBe(5);
    expect(log[log.length - 1]?.status).toBe(REQUEST_LOG_LIMIT + 4);
  });
});

describe("clearLog", () => {
  it("calls the backend and empties the in-store log", async () => {
    clearLogMock.mockResolvedValue(undefined);
    const { appendLog } = useHttpServerStore.getState();
    appendLog(entry(1));
    appendLog(entry(2));
    expect(useHttpServerStore.getState().log).toHaveLength(2);

    await useHttpServerStore.getState().clearLog();

    expect(clearLogMock).toHaveBeenCalledTimes(1);
    expect(useHttpServerStore.getState().log).toHaveLength(0);
  });
});

describe("load", () => {
  it("populates status, config, token presence, and a trimmed log", async () => {
    getStatusMock.mockResolvedValue({ running: true, port: 50000, bindLan: true });
    const cfg: HttpServerConfig = {
      enabled: true,
      port: 50000,
      bindLan: true,
      logToConsole: false,
      serveWebUi: false,
    };
    getConfigMock.mockResolvedValue(cfg);
    getTokenStatusMock.mockResolvedValue(true);
    listLogMock.mockResolvedValue([entry(1), entry(2)]);

    await useHttpServerStore.getState().load();

    const s = useHttpServerStore.getState();
    expect(s.status).toEqual({ running: true, port: 50000, bindLan: true });
    expect(s.config).toEqual(cfg);
    expect(s.hasToken).toBe(true);
    expect(s.log).toHaveLength(2);
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("records an error message when a load call rejects", async () => {
    getStatusMock.mockRejectedValue(new Error("boom"));
    getConfigMock.mockResolvedValue({});
    getTokenStatusMock.mockResolvedValue(false);
    listLogMock.mockResolvedValue([]);

    await useHttpServerStore.getState().load();
    expect(useHttpServerStore.getState().error).toBe("boom");
    expect(useHttpServerStore.getState().isLoading).toBe(false);
  });
});

describe("start / stop", () => {
  it("start refreshes status after a successful start", async () => {
    startMock.mockResolvedValue(undefined);
    getStatusMock.mockResolvedValue({ running: true, port: 48610, bindLan: false });
    await useHttpServerStore.getState().start();
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(useHttpServerStore.getState().status.running).toBe(true);
  });

  it("start rethrows and records the error on failure", async () => {
    startMock.mockRejectedValue(new Error("PORT_IN_USE: 48610"));
    await expect(useHttpServerStore.getState().start()).rejects.toThrow(
      "PORT_IN_USE",
    );
    expect(useHttpServerStore.getState().error).toContain("PORT_IN_USE");
  });

  it("stop refreshes status after a successful stop", async () => {
    stopMock.mockResolvedValue(undefined);
    getStatusMock.mockResolvedValue({ running: false, port: 48610, bindLan: false });
    await useHttpServerStore.getState().stop();
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(useHttpServerStore.getState().status.running).toBe(false);
  });
});

describe("saveConfig", () => {
  it("persists then re-reads the authoritative status + config", async () => {
    const cfg: HttpServerConfig = {
      enabled: true,
      port: 50001,
      bindLan: false,
      logToConsole: true,
      serveWebUi: false,
    };
    setConfigMock.mockResolvedValue(undefined);
    getStatusMock.mockResolvedValue({ running: true, port: 50001, bindLan: false });
    getConfigMock.mockResolvedValue(cfg);

    await useHttpServerStore.getState().saveConfig(cfg);
    expect(setConfigMock).toHaveBeenCalledWith(cfg);
    expect(useHttpServerStore.getState().config).toEqual(cfg);
    expect(useHttpServerStore.getState().status.port).toBe(50001);
  });

  it("rejects (propagates) when the backend rejects the config", async () => {
    setConfigMock.mockRejectedValue(new Error("INVALID_PORT: ..."));
    await expect(
      useHttpServerStore.getState().saveConfig({
        enabled: true,
        port: 80,
        bindLan: false,
        logToConsole: true,
        serveWebUi: false,
      }),
    ).rejects.toThrow("INVALID_PORT");
  });
});

describe("syncLanguage", () => {
  it("pushes the current language and refreshes when the snapshot is missing", async () => {
    useHttpServerStore.setState({
      status: {
        running: true,
        port: 48610,
        bindLan: false,
        languageSnapshotMissing: true,
      },
    });
    setLanguageMock.mockResolvedValue(undefined);
    getStatusMock.mockResolvedValue({
      running: true,
      port: 48610,
      bindLan: false,
      languageSnapshotMissing: false,
    });

    await useHttpServerStore.getState().syncLanguage();

    expect(setLanguageMock).toHaveBeenCalledWith("ru");
    expect(getStatusMock).toHaveBeenCalledTimes(1);
    expect(useHttpServerStore.getState().status.languageSnapshotMissing).toBe(
      false,
    );
  });

  it("is a no-op when the snapshot is already present", async () => {
    useHttpServerStore.setState({
      status: {
        running: true,
        port: 48610,
        bindLan: false,
        languageSnapshotMissing: false,
      },
    });

    await useHttpServerStore.getState().syncLanguage();

    expect(setLanguageMock).not.toHaveBeenCalled();
    expect(getStatusMock).not.toHaveBeenCalled();
  });

  it("records an error when the backfill rejects", async () => {
    useHttpServerStore.setState({
      status: {
        running: true,
        port: 48610,
        bindLan: false,
        languageSnapshotMissing: true,
      },
    });
    setLanguageMock.mockRejectedValue(new Error("ipc down"));

    await useHttpServerStore.getState().syncLanguage();

    expect(useHttpServerStore.getState().error).toBe("ipc down");
  });
});

describe("token actions", () => {
  it("regenerateToken returns the value and flips hasToken on", async () => {
    regenMock.mockResolvedValue("new-token");
    const token = await useHttpServerStore.getState().regenerateToken();
    expect(token).toBe("new-token");
    expect(useHttpServerStore.getState().hasToken).toBe(true);
  });

  it("clearToken flips hasToken off", async () => {
    useHttpServerStore.setState({ hasToken: true });
    clearMock.mockResolvedValue(undefined);
    await useHttpServerStore.getState().clearToken();
    expect(useHttpServerStore.getState().hasToken).toBe(false);
  });
});
