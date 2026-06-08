import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  promptForAdminPassword,
  registerAdminPasswordPromptHandler,
  _resetAdminPasswordPromptHandler,
} from "./adminPasswordPrompt";

beforeEach(() => {
  _resetAdminPasswordPromptHandler();
});
afterEach(() => {
  _resetAdminPasswordPromptHandler();
  vi.restoreAllMocks();
});

describe("promptForAdminPassword (singleton dispatch)", () => {
  // No mounted modal in tests → must resolve to null, NOT throw or hang.
  // This is the contract triggerCommandRun's retry loop relies on: a
  // missing handler means "user effectively cancelled" so the loop
  // bails cleanly instead of throwing into the user's face.
  it("resolves to null when no handler is registered", async () => {
    const result = await promptForAdminPassword();
    expect(result).toBeNull();
  });

  it("forwards to the registered handler and returns its value", async () => {
    const handler = vi
      .fn()
      .mockResolvedValue({ password: "hunter2", remember: true });
    registerAdminPasswordPromptHandler(handler);

    const result = await promptForAdminPassword();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ password: "hunter2", remember: true });
  });

  // The one-shot "Continue" flow resolves with remember=false. The
  // caller (triggerCommandRun) MUST NOT call setAdminPassword in this
  // branch — a regression here would silently leak the password into
  // the OS keychain. Locking the wire shape with a dedicated test
  // makes that contract explicit.
  it("propagates a remember=false result for the one-shot Continue flow", async () => {
    const handler = vi
      .fn()
      .mockResolvedValue({ password: "ephemeral", remember: false });
    registerAdminPasswordPromptHandler(handler);

    const result = await promptForAdminPassword();

    expect(result).toEqual({ password: "ephemeral", remember: false });
  });

  it("propagates a null resolution (user cancelled)", async () => {
    const handler = vi.fn().mockResolvedValue(null);
    registerAdminPasswordPromptHandler(handler);

    expect(await promptForAdminPassword()).toBeNull();
  });

  // Deregistration via `register(null)` restores the no-handler
  // behavior — important because the modal's unmount cleanup uses
  // exactly this pattern.
  it("treats register(null) as deregistration", async () => {
    const handler = vi.fn().mockResolvedValue("hunter2");
    registerAdminPasswordPromptHandler(handler);
    registerAdminPasswordPromptHandler(null);

    const result = await promptForAdminPassword();
    expect(handler).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  // Last-write-wins: re-registering replaces the previous handler.
  // The component re-mounts under React StrictMode would otherwise
  // leave a stale handler bound to a destroyed render tree.
  it("re-registering a handler replaces the previous one", async () => {
    const first = vi
      .fn()
      .mockResolvedValue({ password: "first", remember: true });
    const second = vi
      .fn()
      .mockResolvedValue({ password: "second", remember: true });
    registerAdminPasswordPromptHandler(first);
    registerAdminPasswordPromptHandler(second);

    const result = await promptForAdminPassword();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ password: "second", remember: true });
  });
});
