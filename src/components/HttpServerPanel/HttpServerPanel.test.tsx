// Focused tests for the QR quick-connect branches added to HttpServerPanel
// (docs/plans/http-server/03-qr-quick-connect-implementation-plan.md):
//   - the "Show QR" button only appears when the server is running, the web
//     UI is enabled, and a LAN-reachable host is known;
//   - clicking it opens the standalone HttpServerQrModal;
//   - the include-token toggle only appears during a `revealedToken` window.
// The component has no other test coverage yet — this covers only the new
// branches, not a full render/interaction suite for the whole panel.

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../../i18n";

vi.mock("qrcode", () => ({
  toCanvas: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/httpServerService", () => ({
  getHttpServerStatus: vi.fn(),
  startHttpServer: vi.fn(),
  setHttpServerLanguage: vi.fn(),
  stopHttpServer: vi.fn(),
  getHttpServerConfig: vi.fn(),
  setHttpServerConfig: vi.fn(),
  getApiTokenStatus: vi.fn(),
  regenerateApiToken: vi.fn().mockResolvedValue("fake-token-abc123"),
  clearApiToken: vi.fn(),
  listRequestLog: vi.fn(),
  clearRequestLog: vi.fn(),
  subscribeRequestLog: vi.fn(() => () => {}),
  HTTP_SERVER_LOG_EVENT: "http-server-log",
}));

import { HttpServerPanel } from "./HttpServerPanel";
import { useHttpServerStore } from "../../stores/httpServerStore";
import type { HttpServerConfig, HttpServerStatus } from "../../types/httpServer";

const BASE_CONFIG: HttpServerConfig = {
  enabled: true,
  port: 48610,
  bindLan: true,
  logToConsole: true,
  serveWebUi: true,
};

const RUNNING_STATUS_WITH_LAN: HttpServerStatus = {
  running: true,
  port: 48610,
  bindLan: true,
  lanAddress: "192.168.1.42",
  languageSnapshotMissing: false,
};

function setStoreState(overrides: {
  status: HttpServerStatus;
  config: HttpServerConfig;
  hasToken?: boolean;
}): void {
  useHttpServerStore.setState({
    status: overrides.status,
    config: overrides.config,
    hasToken: overrides.hasToken ?? false,
    log: [],
    isLoading: false,
    error: null,
  });
}

function openPanel(): void {
  fireEvent.click(screen.getByText("HTTP API"));
}

describe("HttpServerPanel — QR quick-connect gating", () => {
  it("shows no Show-QR button when the server is stopped", () => {
    setStoreState({
      status: { ...RUNNING_STATUS_WITH_LAN, running: false },
      config: BASE_CONFIG,
    });
    render(<HttpServerPanel />);
    openPanel();
    expect(screen.queryByLabelText(/Show QR/i)).toBeNull();
  });

  it("shows no Show-QR button when serveWebUi is disabled", () => {
    setStoreState({
      status: RUNNING_STATUS_WITH_LAN,
      config: { ...BASE_CONFIG, serveWebUi: false },
    });
    render(<HttpServerPanel />);
    openPanel();
    expect(screen.queryByLabelText(/Show QR/i)).toBeNull();
  });

  it("shows no Show-QR button when neither lanAddress nor mdnsHost is known", () => {
    setStoreState({
      status: { ...RUNNING_STATUS_WITH_LAN, lanAddress: undefined },
      config: BASE_CONFIG,
    });
    render(<HttpServerPanel />);
    openPanel();
    expect(screen.queryByLabelText(/Show QR/i)).toBeNull();
  });

  it("shows the Show-QR button and opens the standalone modal with the canvas on click", () => {
    setStoreState({
      status: RUNNING_STATUS_WITH_LAN,
      config: BASE_CONFIG,
    });
    render(<HttpServerPanel />);
    openPanel();

    const button = screen.getByLabelText(/Show QR/i);
    expect(screen.queryByRole("dialog", { name: /Scan/i })).toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: /Scan/i })).toBeTruthy();
    expect(screen.getByRole("img", { name: /QR code/i })).toBeTruthy();
  });

  it("does not offer the include-token toggle without a revealed token", () => {
    setStoreState({
      status: RUNNING_STATUS_WITH_LAN,
      config: BASE_CONFIG,
      hasToken: true,
    });
    render(<HttpServerPanel />);
    openPanel();
    expect(screen.queryByLabelText(/Include token in QR/i)).toBeNull();
  });
});

describe("HttpServerPanel — include-token toggle lives inside the QR modal", () => {
  // Regression: the toggle used to live in the panel body, which is hidden
  // behind the QR modal once open — making it unreachable without closing the
  // modal first. It must now be flippable FROM INSIDE the modal.
  it("shows the include-token toggle inside the token QR modal, off by default, with no warning", async () => {
    setStoreState({
      status: RUNNING_STATUS_WITH_LAN,
      config: BASE_CONFIG,
    });
    render(<HttpServerPanel />);
    openPanel();
    fireEvent.click(screen.getByText("Generate token"));
    await waitFor(() => screen.getByText("Show QR"));

    fireEvent.click(screen.getByText("Show QR"));
    const dialog = screen.getByRole("dialog", { name: /Scan/i });
    const toggle = screen.getByRole("switch", { name: /Include token in QR/i });
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // The toggle's own label mentions "token", but the security warning
    // (only shown once the toggle is ON) must not.
    expect(dialog.textContent).not.toMatch(/scans or photographs/i);
  });

  it("flips the toggle without closing the modal, revealing the warning", async () => {
    setStoreState({
      status: RUNNING_STATUS_WITH_LAN,
      config: BASE_CONFIG,
    });
    render(<HttpServerPanel />);
    openPanel();
    fireEvent.click(screen.getByText("Generate token"));
    await waitFor(() => screen.getByText("Show QR"));
    fireEvent.click(screen.getByText("Show QR"));

    const toggle = screen.getByRole("switch", { name: /Include token in QR/i });
    fireEvent.click(toggle);

    // The modal is still open (not closed by the toggle) and now shows the
    // security warning plus the checked state.
    const dialog = screen.getByRole("dialog", { name: /Scan/i });
    expect(dialog).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(dialog.textContent).toMatch(/scans or photographs/i);
  });

  it("does not show the include-token toggle on the address-only QR modal", () => {
    setStoreState({
      status: RUNNING_STATUS_WITH_LAN,
      config: BASE_CONFIG,
    });
    render(<HttpServerPanel />);
    openPanel();

    fireEvent.click(screen.getByLabelText(/Show QR/i));
    expect(screen.getByRole("dialog", { name: /Scan/i })).toBeTruthy();
    expect(
      screen.queryByRole("switch", { name: /Include token in QR/i }),
    ).toBeNull();
  });
});

describe("HttpServerPanel — LAN address visibility follows bindLan", () => {
  // Regression: the backend detects the LAN IP / mDNS name and previews them
  // in the status regardless of `bindLan` (best-effort, so the UI can show
  // them before a LAN-enabled start) — but the socket only accepts non-
  // loopback connections when `bindLan` is on. Showing procmix.local / the LAN
  // IP as "reachable" while bindLan is off previously advertised addresses
  // nothing was listening on.
  it("hides mDNS/LAN address rows and the QR button when bindLan is off, even with a detected LAN address", () => {
    setStoreState({
      status: { ...RUNNING_STATUS_WITH_LAN, bindLan: false, mdnsHost: "procmix.local" },
      config: BASE_CONFIG,
    });
    render(<HttpServerPanel />);
    openPanel();

    expect(screen.getByText(/^http:\/\/127\.0\.0\.1:48610$/)).toBeTruthy();
    expect(screen.queryByText(/192\.168\.1\.42/)).toBeNull();
    expect(screen.queryByText(/procmix\.local/)).toBeNull();
    expect(screen.queryByLabelText(/Show QR/i)).toBeNull();
  });

  it("shows mDNS/LAN address rows and the QR button when bindLan is on", () => {
    setStoreState({
      status: { ...RUNNING_STATUS_WITH_LAN, bindLan: true, mdnsHost: "procmix.local" },
      config: BASE_CONFIG,
    });
    render(<HttpServerPanel />);
    openPanel();

    expect(screen.getByText(/192\.168\.1\.42/)).toBeTruthy();
    expect(screen.getByText(/procmix\.local/)).toBeTruthy();
    expect(screen.getByLabelText(/Show QR/i)).toBeTruthy();
  });
});

describe("HttpServerPanel — address row format", () => {
  // Regression test: the displayed/copied address rows must NOT change shape
  // when the "Connect web interface" (serveWebUi) switch is toggled — only
  // the QR-encoded URL (which needs a routable SPA path) gets a trailing `/`.
  it("never adds a trailing slash to address rows, regardless of serveWebUi", () => {
    setStoreState({
      status: RUNNING_STATUS_WITH_LAN,
      config: { ...BASE_CONFIG, serveWebUi: true },
    });
    const { rerender } = render(<HttpServerPanel />);
    openPanel();
    expect(screen.getByText("http://192.168.1.42:48610")).toBeTruthy();
    expect(screen.queryByText("http://192.168.1.42:48610/")).toBeNull();

    act(() => {
      setStoreState({
        status: RUNNING_STATUS_WITH_LAN,
        config: { ...BASE_CONFIG, serveWebUi: false },
      });
    });
    rerender(<HttpServerPanel />);
    expect(screen.getByText("http://192.168.1.42:48610")).toBeTruthy();
    expect(screen.queryByText("http://192.168.1.42:48610/")).toBeNull();
  });
});
