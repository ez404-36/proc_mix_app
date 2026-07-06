import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Update, DownloadEvent } from "@tauri-apps/plugin-updater";

const checkMock = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => checkMock() }));

const relaunchMock = vi.fn();
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunchMock() }));

import { useUpdateStore } from "./updateStore";

/**
 * Build a fake `Update` handle with a controllable `downloadAndInstall`.
 * The default `downloadAndInstall` resolves immediately without emitting any
 * progress events; individual tests override it.
 */
function makeUpdate(overrides: Partial<Update> = {}): Update {
  const base = {
    version: "1.2.3",
    body: "Release notes",
    date: "2026-07-06",
    downloadAndInstall: vi.fn(async () => undefined),
  };
  return { ...base, ...overrides } as unknown as Update;
}

beforeEach(() => {
  checkMock.mockReset();
  relaunchMock.mockReset();
  relaunchMock.mockResolvedValue(undefined);
  useUpdateStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkForUpdate", () => {
  it("returns busy without calling check when a check is already in flight", async () => {
    useUpdateStore.setState({ phase: "checking" });
    const result = await useUpdateStore.getState().checkForUpdate();
    expect(result).toEqual({ status: "busy" });
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("sets info and returns available when an update exists", async () => {
    checkMock.mockResolvedValueOnce(makeUpdate());
    const result = await useUpdateStore.getState().checkForUpdate();
    expect(result).toEqual({ status: "available" });
    expect(useUpdateStore.getState().info).toEqual({
      version: "1.2.3",
      body: "Release notes",
      date: "2026-07-06",
    });
    expect(useUpdateStore.getState().dismissed).toBe(false);
    expect(useUpdateStore.getState().phase).toBe("idle");
  });

  it("falls back to empty body and null date when the update omits them", async () => {
    checkMock.mockResolvedValueOnce(
      makeUpdate({ body: undefined, date: undefined }),
    );
    await useUpdateStore.getState().checkForUpdate();
    expect(useUpdateStore.getState().info).toEqual({
      version: "1.2.3",
      body: "",
      date: null,
    });
  });

  it("clears info and returns up-to-date when there is no update", async () => {
    useUpdateStore.setState({
      info: { version: "0.0.1", body: "old", date: null },
    });
    checkMock.mockResolvedValueOnce(null);
    const result = await useUpdateStore.getState().checkForUpdate();
    expect(result).toEqual({ status: "up-to-date" });
    expect(useUpdateStore.getState().info).toBeNull();
    expect(useUpdateStore.getState().phase).toBe("idle");
  });

  it("treats a 'Could not fetch a valid release' error as up-to-date", async () => {
    useUpdateStore.setState({
      info: { version: "0.0.1", body: "old", date: null },
    });
    checkMock.mockRejectedValueOnce(
      new Error("Could not fetch a valid release JSON from the remote"),
    );
    const result = await useUpdateStore.getState().checkForUpdate();
    expect(result).toEqual({ status: "up-to-date" });
    expect(useUpdateStore.getState().info).toBeNull();
    expect(useUpdateStore.getState().phase).toBe("idle");
  });

  it("returns error with the message for any other thrown error", async () => {
    checkMock.mockRejectedValueOnce(new Error("network down"));
    const result = await useUpdateStore.getState().checkForUpdate();
    expect(result).toEqual({ status: "error", message: "network down" });
    expect(useUpdateStore.getState().phase).toBe("idle");
  });

  it("stringifies a non-Error thrown value in the error message", async () => {
    checkMock.mockRejectedValueOnce("plain string failure");
    const result = await useUpdateStore.getState().checkForUpdate();
    expect(result).toEqual({ status: "error", message: "plain string failure" });
  });
});

describe("installUpdate", () => {
  it("early-returns while downloading", async () => {
    useUpdateStore.setState({ phase: "downloading" });
    await useUpdateStore.getState().installUpdate();
    expect(checkMock).not.toHaveBeenCalled();
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it("early-returns while installing", async () => {
    useUpdateStore.setState({ phase: "installing" });
    await useUpdateStore.getState().installUpdate();
    expect(checkMock).not.toHaveBeenCalled();
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it("re-checks when no pending update and resets to idle if none is found", async () => {
    // No prior checkForUpdate → pendingUpdate is null → re-check path.
    checkMock.mockResolvedValueOnce(null);
    await useUpdateStore.getState().installUpdate();
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().phase).toBe("idle");
    expect(useUpdateStore.getState().info).toBeNull();
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it("re-checks when no pending update and records the error if the re-check throws", async () => {
    checkMock.mockRejectedValueOnce(new Error("recheck failed"));
    await useUpdateStore.getState().installUpdate();
    expect(useUpdateStore.getState().phase).toBe("idle");
    expect(useUpdateStore.getState().error).toBe("recheck failed");
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it("re-checks when error is set, then downloads and relaunches on success", async () => {
    // Prime a pendingUpdate via checkForUpdate, but also set error → forces re-check.
    checkMock.mockResolvedValueOnce(makeUpdate());
    await useUpdateStore.getState().checkForUpdate();
    useUpdateStore.setState({ error: "previous download failed" });

    const download = vi.fn(async (cb: (e: DownloadEvent) => void) => {
      cb({ event: "Started", data: { contentLength: 100 } });
      cb({ event: "Progress", data: { chunkLength: 25 } });
    });
    checkMock.mockResolvedValueOnce(makeUpdate({ downloadAndInstall: download }));

    await useUpdateStore.getState().installUpdate();

    expect(checkMock).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().downloadProgress).toBe(0.25);
    expect(useUpdateStore.getState().phase).toBe("installing");
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("downloads with the existing pending update and computes progress", async () => {
    const download = vi.fn(async (cb: (e: DownloadEvent) => void) => {
      cb({ event: "Started", data: { contentLength: 200 } });
      cb({ event: "Progress", data: { chunkLength: 50 } });
      cb({ event: "Progress", data: { chunkLength: 50 } });
      cb({ event: "Finished" });
    });
    checkMock.mockResolvedValueOnce(makeUpdate({ downloadAndInstall: download }));
    await useUpdateStore.getState().checkForUpdate();

    await useUpdateStore.getState().installUpdate();

    // No re-check: pendingUpdate present and no error.
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().downloadProgress).toBe(0.5);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("caps progress at 1 when downloaded exceeds the content length", async () => {
    const download = vi.fn(async (cb: (e: DownloadEvent) => void) => {
      cb({ event: "Started", data: { contentLength: 10 } });
      cb({ event: "Progress", data: { chunkLength: 50 } });
    });
    checkMock.mockResolvedValueOnce(makeUpdate({ downloadAndInstall: download }));
    await useUpdateStore.getState().checkForUpdate();

    await useUpdateStore.getState().installUpdate();

    expect(useUpdateStore.getState().downloadProgress).toBe(1);
  });

  it("does not update progress when contentLength is 0 (guard)", async () => {
    const download = vi.fn(async (cb: (e: DownloadEvent) => void) => {
      cb({ event: "Started", data: { contentLength: 0 } });
      cb({ event: "Progress", data: { chunkLength: 25 } });
    });
    checkMock.mockResolvedValueOnce(makeUpdate({ downloadAndInstall: download }));
    await useUpdateStore.getState().checkForUpdate();

    await useUpdateStore.getState().installUpdate();

    expect(useUpdateStore.getState().downloadProgress).toBe(0);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults contentLength to 0 when the Started event omits it", async () => {
    const download = vi.fn(async (cb: (e: DownloadEvent) => void) => {
      cb({ event: "Started", data: { contentLength: undefined } });
      cb({ event: "Progress", data: { chunkLength: 25 } });
    });
    checkMock.mockResolvedValueOnce(makeUpdate({ downloadAndInstall: download }));
    await useUpdateStore.getState().checkForUpdate();

    await useUpdateStore.getState().installUpdate();

    expect(useUpdateStore.getState().downloadProgress).toBe(0);
  });

  it("records the error and resets phase when downloadAndInstall throws", async () => {
    const download = vi.fn(async () => {
      throw new Error("disk full");
    });
    checkMock.mockResolvedValueOnce(makeUpdate({ downloadAndInstall: download }));
    await useUpdateStore.getState().checkForUpdate();

    await useUpdateStore.getState().installUpdate();

    expect(useUpdateStore.getState().phase).toBe("idle");
    expect(useUpdateStore.getState().error).toBe("disk full");
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error thrown value from downloadAndInstall", async () => {
    const download = vi.fn(async () => {
      throw "raw failure";
    });
    checkMock.mockResolvedValueOnce(makeUpdate({ downloadAndInstall: download }));
    await useUpdateStore.getState().checkForUpdate();

    await useUpdateStore.getState().installUpdate();

    expect(useUpdateStore.getState().error).toBe("raw failure");
  });

  it("stringifies a non-Error thrown value from the re-check", async () => {
    checkMock.mockRejectedValueOnce("raw recheck failure");
    await useUpdateStore.getState().installUpdate();
    expect(useUpdateStore.getState().error).toBe("raw recheck failure");
  });
});

describe("modal + dismiss + reset", () => {
  it("openModal sets isModalOpen true", () => {
    useUpdateStore.getState().openModal();
    expect(useUpdateStore.getState().isModalOpen).toBe(true);
  });

  it("closeModal sets isModalOpen false", () => {
    useUpdateStore.setState({ isModalOpen: true });
    useUpdateStore.getState().closeModal();
    expect(useUpdateStore.getState().isModalOpen).toBe(false);
  });

  it("dismiss sets dismissed true", () => {
    useUpdateStore.getState().dismiss();
    expect(useUpdateStore.getState().dismissed).toBe(true);
  });

  it("reset returns every field to its default", () => {
    useUpdateStore.setState({
      info: { version: "9.9.9", body: "x", date: "2026-01-01" },
      phase: "downloading",
      downloadProgress: 0.7,
      error: "boom",
      dismissed: true,
      isModalOpen: true,
    });
    useUpdateStore.getState().reset();
    const s = useUpdateStore.getState();
    expect(s.info).toBeNull();
    expect(s.phase).toBe("idle");
    expect(s.downloadProgress).toBe(0);
    expect(s.error).toBeNull();
    expect(s.dismissed).toBe(false);
    expect(s.isModalOpen).toBe(false);
  });
});
