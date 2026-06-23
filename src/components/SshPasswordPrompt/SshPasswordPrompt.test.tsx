import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SshPasswordPrompt } from "./SshPasswordPrompt";
import {
  promptForSshPassword,
  _resetSshPasswordPromptHandler,
} from "../../utils/sshPasswordPrompt";
import "../../i18n";

beforeEach(() => {
  _resetSshPasswordPromptHandler();
});
afterEach(() => {
  _resetSshPasswordPromptHandler();
});

describe("SshPasswordPrompt", () => {
  it("does not render a dialog until prompted", () => {
    render(<SshPasswordPrompt />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on prompt, names the host, and resolves the typed password on submit", async () => {
    render(<SshPasswordPrompt />);
    const promise = promptForSshPassword("prod-web");
    await act(async () => {
      await Promise.resolve();
    });

    // The dialog is shown and names the host.
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText(/prod-web/)).toBeDefined();

    // Type a password and submit via the Run button.
    const input = screen.getByLabelText("Password");
    await act(async () => {
      fireEvent.change(input, { target: { value: "hunter2" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
    });

    const result = await promise;
    expect(result).toBe("hunter2");
  });

  it("resolves null on cancel", async () => {
    render(<SshPasswordPrompt />);
    const promise = promptForSshPassword("prod-web");
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    const result = await promise;
    expect(result).toBeNull();
  });

  it("does not submit an empty password (Run disabled)", async () => {
    render(<SshPasswordPrompt />);
    void promptForSshPassword("prod-web");
    await act(async () => {
      await Promise.resolve();
    });

    const runButton = screen.getByRole("button", {
      name: "Run",
    }) as HTMLButtonElement;
    expect(runButton.disabled).toBe(true);
  });

  it("resolves null when no component is mounted (fallback)", async () => {
    // No <SshPasswordPrompt> rendered → handler unregistered → treated as
    // cancel so triggerCommandRun aborts gracefully instead of hanging.
    const result = await promptForSshPassword("prod-web");
    expect(result).toBeNull();
  });
});
