import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

// Tauri / Arco mocks so the selector renders headless.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn() },
}));

// Platform is overridden per-test (default linux → Unix → password UI shown).
const getCachedPlatformMock = vi.fn().mockReturnValue("linux");
vi.mock("../../utils/platform", () => ({
  getCachedPlatform: () => getCachedPlatformMock(),
}));

// The persistent-password service is the boundary we assert against.
const hasSshPasswordMock = vi.fn();
const setSshPasswordMock = vi.fn();
const clearSshPasswordMock = vi.fn();
vi.mock("../../services/sshConnectionService", () => ({
  hasSshPassword: (...a: unknown[]) => hasSshPasswordMock(...a),
  setSshPassword: (...a: unknown[]) => setSshPasswordMock(...a),
  clearSshPassword: (...a: unknown[]) => clearSshPasswordMock(...a),
}));

import { TargetSelector } from "./TargetSelector";
import { useSshHostStore } from "../../stores/sshHostStore";
import type { ExecutionTarget } from "../../types";
import "../../i18n";

// Seed one host into the shared store so the "Remote host" mode has a concrete
// alias to manage a password for.
function seedHost(): void {
  useSshHostStore.setState({
    hosts: [
      {
        id: { source: "user-config", name: "prod" },
        name: "prod",
        hostName: "10.0.0.1",
      } as never,
    ],
    isLoading: false,
  });
}

function renderRemote() {
  const onChange = vi.fn();
  const value: ExecutionTarget = { kind: "remote", alias: "prod" };
  render(
    <TargetSelector
      value={value}
      onChange={onChange}
      promptSshPassword={false}
      onPromptSshPasswordChange={vi.fn()}
    />,
  );
}

beforeEach(() => {
  getCachedPlatformMock.mockReturnValue("linux");
  hasSshPasswordMock.mockReset().mockResolvedValue(false);
  setSshPasswordMock.mockReset().mockResolvedValue(undefined);
  clearSshPasswordMock.mockReset().mockResolvedValue(undefined);
  seedHost();
});
afterEach(() => {
  useSshHostStore.setState({ hosts: [], isLoading: false });
});

describe("TargetSelector persistent SSH password", () => {
  it("queries saved status for the selected host and shows 'not saved'", async () => {
    renderRemote();
    await act(async () => {
      await Promise.resolve();
    });
    expect(hasSshPasswordMock).toHaveBeenCalledWith("prod");
    expect(screen.getByText(/Not saved/)).toBeDefined();
  });

  it("saves a typed password via the service and flips to 'Saved'", async () => {
    renderRemote();
    await act(async () => {
      await Promise.resolve();
    });

    // Open the inline editor.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Set password…" }));
    });
    const input = screen.getByLabelText(/SSH password for prod/);
    await act(async () => {
      fireEvent.change(input, { target: { value: "hunter2" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(setSshPasswordMock).toHaveBeenCalledWith("prod", "hunter2");
    // The status flips to the exact "Saved ✓" indicator (not the section label).
    expect(screen.getByText("Saved ✓")).toBeDefined();
  });

  it("clears a saved password via the service", async () => {
    hasSshPasswordMock.mockResolvedValue(true);
    renderRemote();
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    });
    expect(clearSshPasswordMock).toHaveBeenCalledWith("prod");
  });

  it("hides the password section entirely on Windows", async () => {
    getCachedPlatformMock.mockReturnValue("windows");
    renderRemote();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/Saved SSH password/)).toBeNull();
    expect(hasSshPasswordMock).not.toHaveBeenCalled();
  });
});
