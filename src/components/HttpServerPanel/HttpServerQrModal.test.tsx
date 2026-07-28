// Unit tests for HttpServerQrModal: mounts only when a URL is given, shows the
// scan hint, closes on the explicit button and on backdrop click, but NOT on
// Escape (project convention — modals close only via an explicit action).

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "../../i18n";

vi.mock("qrcode", () => ({
  toCanvas: vi.fn().mockResolvedValue(undefined),
}));

import { HttpServerQrModal } from "./HttpServerQrModal";

describe("HttpServerQrModal", () => {
  it("renders nothing when url is null", () => {
    render(<HttpServerQrModal url={null} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the dialog with the scan hint and a QR canvas when a url is given", () => {
    render(
      <HttpServerQrModal url="http://192.168.1.42:48610/" onClose={vi.fn()} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(screen.getByRole("img", { name: /QR code/i })).toBeTruthy();
    // The scan hint mentions scanning with a camera.
    expect(dialog.textContent).toMatch(/camera/i);
  });

  it("closes via the explicit close button", () => {
    const onClose = vi.fn();
    render(
      <HttpServerQrModal url="http://192.168.1.42:48610/" onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop click but NOT on Escape", () => {
    const onClose = vi.fn();
    render(
      <HttpServerQrModal url="http://192.168.1.42:48610/" onClose={onClose} />,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = dialog.parentElement as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("omits the include-token toggle and warning entirely when the prop is not passed", () => {
    render(
      <HttpServerQrModal url="http://192.168.1.42:48610/" onClose={vi.fn()} />,
    );
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("renders a controlled include-token toggle when the prop is passed, reporting toggles to the caller", () => {
    const onChange = vi.fn();
    render(
      <HttpServerQrModal
        url="http://192.168.1.42:48610/?token=abc"
        onClose={vi.fn()}
        includeToken={{ checked: false, onChange }}
      />,
    );
    const toggle = screen.getByRole("switch", { name: /Include token in QR/i });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("note")).toBeNull();

    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
    // The modal renders `checked` as given by the caller — flipping it is the
    // CALLER's responsibility (controlled component), so the toggle and
    // warning here still reflect the (unchanged) prop, not an internal state.
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("shows the security warning when includeToken.checked is true", () => {
    render(
      <HttpServerQrModal
        url="http://192.168.1.42:48610/?token=abc"
        onClose={vi.fn()}
        includeToken={{ checked: true, onChange: vi.fn() }}
      />,
    );
    expect(screen.getByRole("note").textContent).toMatch(
      /scans or photographs/i,
    );
  });
});
