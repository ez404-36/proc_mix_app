import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import {
  clearApiToken,
  getApiTokenStatus,
  getHttpServerConfig,
  getHttpServerStatus,
  listRequestLog,
  regenerateApiToken,
  setHttpServerConfig,
  startHttpServer,
  stopHttpServer,
  subscribeRequestLog,
} from "./httpServerService";
import type { HttpServerConfig, RequestLogEntry } from "../types/httpServer";

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
});

describe("httpServerService command wrappers", () => {
  it("getHttpServerStatus invokes http_server_status", async () => {
    invokeMock.mockResolvedValue({ running: true, port: 48610, bindLan: false });
    const status = await getHttpServerStatus();
    expect(invokeMock).toHaveBeenCalledWith("http_server_status");
    expect(status).toEqual({ running: true, port: 48610, bindLan: false });
  });

  it("startHttpServer / stopHttpServer invoke their commands", async () => {
    invokeMock.mockResolvedValue(undefined);
    await startHttpServer();
    await stopHttpServer();
    expect(invokeMock).toHaveBeenNthCalledWith(1, "start_http_server");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "stop_http_server");
  });

  it("getHttpServerConfig invokes get_http_server_config", async () => {
    const cfg: HttpServerConfig = {
      enabled: true,
      port: 50000,
      bindLan: true,
      logToConsole: false,
    };
    invokeMock.mockResolvedValue(cfg);
    expect(await getHttpServerConfig()).toEqual(cfg);
    expect(invokeMock).toHaveBeenCalledWith("get_http_server_config");
  });

  it("setHttpServerConfig passes the config under the `config` key", async () => {
    invokeMock.mockResolvedValue(undefined);
    const cfg: HttpServerConfig = {
      enabled: false,
      port: 48610,
      bindLan: false,
      logToConsole: true,
    };
    await setHttpServerConfig(cfg);
    expect(invokeMock).toHaveBeenCalledWith("set_http_server_config", { config: cfg });
  });

  it("token wrappers map to their commands", async () => {
    invokeMock.mockResolvedValueOnce(true);
    expect(await getApiTokenStatus()).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("api_token_status");

    invokeMock.mockResolvedValueOnce("the-secret-token");
    expect(await regenerateApiToken()).toBe("the-secret-token");
    expect(invokeMock).toHaveBeenCalledWith("regenerate_api_token");

    invokeMock.mockResolvedValueOnce(undefined);
    await clearApiToken();
    expect(invokeMock).toHaveBeenCalledWith("clear_api_token");
  });

  it("listRequestLog returns the entries from list_request_log", async () => {
    const entries: RequestLogEntry[] = [
      {
        ts: "2026-06-24T00:00:00Z",
        method: "POST",
        path: "/api/command/{ref}/run",
        status: 202,
        remoteAddr: "127.0.0.1:1",
        entityName: "Deploy",
      },
    ];
    invokeMock.mockResolvedValue(entries);
    expect(await listRequestLog()).toEqual(entries);
    expect(invokeMock).toHaveBeenCalledWith("list_request_log");
  });
});

describe("subscribeRequestLog", () => {
  it("subscribes to http-server-log and forwards the payload", async () => {
    let captured: ((event: { payload: RequestLogEntry }) => void) | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementation(
      (_name: string, handler: (e: { payload: RequestLogEntry }) => void) => {
        captured = handler;
        return Promise.resolve(unlisten);
      },
    );

    const received: RequestLogEntry[] = [];
    const cleanup = subscribeRequestLog((entry) => received.push(entry));

    expect(listenMock).toHaveBeenCalledWith(
      "http-server-log",
      expect.any(Function),
    );
    // Fire one event through the captured Tauri handler.
    const entry: RequestLogEntry = {
      ts: "2026-06-24T00:00:01Z",
      method: "GET",
      path: "/api/commands",
      status: 200,
      remoteAddr: "127.0.0.1:2",
    };
    captured?.({ payload: entry });
    expect(received).toEqual([entry]);

    // Cleanup awaits the (resolved) listener and detaches it.
    cleanup();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
