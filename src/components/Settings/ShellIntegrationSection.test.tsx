// Behaviour test for the Settings → System "Explorer integration" section.
// The shell-integration service (the Tauri boundary) and Arco's Message are
// mocked; the component, i18n, and ToggleSwitch run real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getShellIntegrationStatus: vi.fn(),
  setShellIntegration: vi.fn(),
}));

vi.mock("../../services/shellIntegrationService", () => ({
  getShellIntegrationStatus: mocks.getShellIntegrationStatus,
  setShellIntegration: mocks.setShellIntegration,
}));

// Arco's Message uses ReactDOM.render which is gone in React 19's jsdom env.
vi.mock("@arco-design/web-react", () => ({
  Message: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { ShellIntegrationSection } from "./ShellIntegrationSection";
import "../../i18n";

const TOGGLE_LABEL = "Show ProcMix in the file-manager menu";

beforeEach(() => {
  mocks.getShellIntegrationStatus.mockReset();
  mocks.setShellIntegration.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ShellIntegrationSection", () => {
  it("shows the toggle on a supported platform and reflects the live enabled state", async () => {
    mocks.getShellIntegrationStatus.mockResolvedValue({
      supported: true,
      enabled: true,
    });

    render(<ShellIntegrationSection />);

    const toggle = await screen.findByRole("switch", { name: TOGGLE_LABEL });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    // The path-variable hint is shown on supported platforms.
    expect(screen.getByText(/PROCMIX_SELECTED_PATH/)).toBeTruthy();
  });

  it("toggling on calls setShellIntegration(true)", async () => {
    mocks.getShellIntegrationStatus.mockResolvedValue({
      supported: true,
      enabled: false,
    });
    mocks.setShellIntegration.mockResolvedValue(undefined);

    render(<ShellIntegrationSection />);

    const toggle = await screen.findByRole("switch", { name: TOGGLE_LABEL });
    // Wait for the initial load so the toggle is enabled (not disabled).
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);

    expect(mocks.setShellIntegration).toHaveBeenCalledWith(true);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("hides the toggle and shows an explanation on an unsupported platform", async () => {
    mocks.getShellIntegrationStatus.mockResolvedValue({
      supported: false,
      enabled: false,
    });

    render(<ShellIntegrationSection />);

    await screen.findByText(
      "File-manager integration is available on Windows and Linux only.",
    );
    expect(
      screen.queryByRole("switch", { name: TOGGLE_LABEL }),
    ).toBeNull();
  });

  it("reverts the toggle when the backend call fails", async () => {
    mocks.getShellIntegrationStatus
      .mockResolvedValueOnce({ supported: true, enabled: false })
      // The post-failure reload re-reports the unchanged OS state.
      .mockResolvedValueOnce({ supported: true, enabled: false });
    mocks.setShellIntegration.mockRejectedValue(new Error("boom"));

    render(<ShellIntegrationSection />);

    const toggle = await screen.findByRole("switch", { name: TOGGLE_LABEL });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);

    // After the failure + reload, the toggle reflects the OS state (off).
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
  });
});
