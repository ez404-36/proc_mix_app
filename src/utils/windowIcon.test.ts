// Tests for the `MiniApp.icon` → PNG-bytes conversion used to brand a
// standalone mini-app runner window (`Window.setIcon`).
//
// ## Why the emoji / SVG cases assert `null` rather than bytes
//
// Rasterisation needs a real 2D canvas. jsdom ships only a stub: without the
// optional `canvas` native package (which this project does NOT depend on),
// `HTMLCanvasElement.getContext("2d")` returns `null` and `toBlob` is not
// implemented. That is precisely the environment the helper's `null` contract
// exists for, so these tests assert the graceful outcome — a resolved `null`,
// no rejection, no thrown error.
//
// We deliberately do NOT stub `getContext` / `toBlob` to force the "happy"
// path: mocking a DOM API purely so a test can reach code that cannot run in
// the test environment asserts the mock's behaviour, not the module's. The
// pixel-accuracy of a rasterised emoji is not something a unit test can
// meaningfully verify anyway; what matters at this boundary is that a
// non-rasterisable icon degrades to "keep the bundled ProcMix icon" instead of
// throwing into the caller's effect.

import { describe, expect, it } from "vitest";
import { miniAppIconToPngBytes } from "./windowIcon";

/** Minimal 1×1 transparent PNG, base64-encoded. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_DATA_URI = `data:image/png;base64,${PNG_BASE64}`;

/** The 8-byte PNG file signature every PNG must start with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("miniAppIconToPngBytes — no icon", () => {
  it("returns null for undefined", async () => {
    expect(await miniAppIconToPngBytes(undefined)).toBeNull();
  });

  it("returns null for an empty string", async () => {
    expect(await miniAppIconToPngBytes("")).toBeNull();
  });
});

describe("miniAppIconToPngBytes — PNG data URI", () => {
  it("decodes the base64 payload verbatim, without canvas re-encoding", async () => {
    const bytes = await miniAppIconToPngBytes(PNG_DATA_URI);

    expect(bytes).not.toBeNull();
    // Byte-for-byte equality with the source payload is the point: a PNG
    // upload must reach `setIcon` exactly as the user provided it.
    const expected = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));
    expect(Array.from(bytes as Uint8Array)).toEqual(Array.from(expected));
  });

  it("produces bytes carrying the PNG file signature", async () => {
    const bytes = await miniAppIconToPngBytes(PNG_DATA_URI);

    expect(Array.from((bytes as Uint8Array).slice(0, 8))).toEqual(
      PNG_SIGNATURE,
    );
  });
});

describe("miniAppIconToPngBytes — malformed input", () => {
  it("returns null for a corrupt base64 payload without throwing", async () => {
    // `%` is outside the base64 alphabet, so `atob` throws — the helper must
    // absorb that and report "no icon".
    await expect(
      miniAppIconToPngBytes("data:image/png;base64,!!!not-base64%%%"),
    ).resolves.toBeNull();
  });

  it("returns null for a data URI that is not base64-encoded", async () => {
    await expect(
      miniAppIconToPngBytes("data:image/png,rawbytes"),
    ).resolves.toBeNull();
  });

  it("returns null for a data URI with an unsupported MIME type", async () => {
    // `setIcon` only accepts PNG/ICO; a GIF could never be applied even if it
    // decoded cleanly.
    await expect(
      miniAppIconToPngBytes("data:image/gif;base64,R0lGODlhAQABAAAAACw="),
    ).resolves.toBeNull();
  });
});

describe("miniAppIconToPngBytes — rasterised shapes under jsdom", () => {
  // See the file header: jsdom has no 2D canvas, so both of these exercise the
  // "cannot rasterise" branch. The assertion is that it degrades to `null`
  // instead of rejecting — which is what keeps the caller's effect safe.
  it("returns null for an emoji glyph rather than rejecting", async () => {
    await expect(miniAppIconToPngBytes("🔌")).resolves.toBeNull();
  });

  it("returns null for a multi-codepoint emoji rather than rejecting", async () => {
    await expect(miniAppIconToPngBytes("⚙️")).resolves.toBeNull();
  });

  it("returns null for an SVG data URI rather than rejecting", async () => {
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(
      miniAppIconToPngBytes(`data:image/svg+xml;base64,${svg}`),
    ).resolves.toBeNull();
  });
});
