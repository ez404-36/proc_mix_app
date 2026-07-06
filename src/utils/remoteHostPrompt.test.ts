import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetRemoteHostPromptHandler,
  promptForRemoteHost,
  registerRemoteHostPromptHandler,
} from "./remoteHostPrompt";

beforeEach(() => {
  _resetRemoteHostPromptHandler();
});

describe("promptForRemoteHost", () => {
  it("resolves to null when no handler is registered", async () => {
    await expect(promptForRemoteHost()).resolves.toBeNull();
  });

  it("delegates to the registered handler and returns its result", async () => {
    const handler = vi.fn().mockResolvedValue("prod-host");
    registerRemoteHostPromptHandler(handler);

    await expect(promptForRemoteHost()).resolves.toBe("prod-host");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns null again after the handler is reset", async () => {
    registerRemoteHostPromptHandler(vi.fn().mockResolvedValue("host"));

    _resetRemoteHostPromptHandler();

    await expect(promptForRemoteHost()).resolves.toBeNull();
  });
});
