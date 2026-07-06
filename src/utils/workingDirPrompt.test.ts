import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetWorkingDirPromptHandler,
  promptForWorkingDir,
  registerWorkingDirPromptHandler,
} from "./workingDirPrompt";

beforeEach(() => {
  _resetWorkingDirPromptHandler();
});

describe("promptForWorkingDir", () => {
  it("resolves to null when no handler is registered", async () => {
    await expect(promptForWorkingDir("/tmp")).resolves.toBeNull();
  });

  it("passes the default value through and returns the handler result", async () => {
    const handler = vi.fn().mockResolvedValue("/home/user/project");
    registerWorkingDirPromptHandler(handler);

    await expect(promptForWorkingDir("/default/dir")).resolves.toBe(
      "/home/user/project",
    );
    expect(handler).toHaveBeenCalledWith("/default/dir");
  });

  it("returns null again after the handler is reset", async () => {
    registerWorkingDirPromptHandler(vi.fn().mockResolvedValue("/x"));

    _resetWorkingDirPromptHandler();

    await expect(promptForWorkingDir("/y")).resolves.toBeNull();
  });
});
