// Unit test for HttpServerQrCode: mocks the `qrcode` package and asserts it is
// invoked with the expected URL, and that a rejected render surfaces a
// localized error instead of throwing.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "../../i18n";

const toCanvasMock = vi.fn();
vi.mock("qrcode", () => ({
  toCanvas: (...args: unknown[]) => toCanvasMock(...args),
}));

import { HttpServerQrCode } from "./HttpServerQrCode";

beforeEach(() => {
  toCanvasMock.mockReset();
});

describe("HttpServerQrCode", () => {
  it("renders a canvas and calls QRCode.toCanvas with the given URL", async () => {
    toCanvasMock.mockResolvedValue(undefined);
    render(<HttpServerQrCode url="http://192.168.1.42:48610/" />);

    await waitFor(() => expect(toCanvasMock).toHaveBeenCalledTimes(1));
    const [canvasArg, urlArg, optsArg] = toCanvasMock.mock.calls[0] as [
      HTMLCanvasElement,
      string,
      { width: number },
    ];
    expect(canvasArg).toBeInstanceOf(HTMLCanvasElement);
    expect(urlArg).toBe("http://192.168.1.42:48610/");
    expect(optsArg.width).toBe(160);
  });

  it("respects a custom size", async () => {
    toCanvasMock.mockResolvedValue(undefined);
    render(<HttpServerQrCode url="http://192.168.1.42:48610/" size={220} />);

    await waitFor(() => expect(toCanvasMock).toHaveBeenCalledTimes(1));
    const optsArg = toCanvasMock.mock.calls[0][2] as { width: number };
    expect(optsArg.width).toBe(220);
  });

  it("shows a localized error when rendering fails", async () => {
    toCanvasMock.mockRejectedValue(new Error("boom"));
    render(<HttpServerQrCode url="http://192.168.1.42:48610/" />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toBe("");
  });
});
