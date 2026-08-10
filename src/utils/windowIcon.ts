/**
 * Convert a `MiniApp.icon` value into PNG bytes suitable for Tauri's
 * `Window.setIcon`.
 *
 * `MiniApp.icon` is a single field carrying one of three shapes (see
 * `utils/iconRenderer.tsx`, which switches on the same `startsWith("data:")`
 * test for the DOM rendering path, and `MiniApps/IconPicker.tsx`, which
 * produces them):
 *
 * - a `data:image/png;base64,…` URI (uploaded PNG),
 * - a `data:image/svg+xml;base64,…` URI (uploaded SVG),
 * - a bare emoji / glyph character.
 *
 * `Window.setIcon` accepts only PNG or ICO bytes (the Rust side is built with
 * the `image-png` Cargo feature — see `src-tauri/Cargo.toml`), so the SVG and
 * emoji shapes have to be rasterised in the webview before they can be handed
 * over. The PNG shape is decoded straight from base64 instead of being routed
 * through a canvas: that keeps the user's exact bytes rather than re-encoding
 * them at our canvas size.
 *
 * ## Why `null` (and never a throw) is the correct contract here
 *
 * Every failure path — malformed base64, an `<img>` that fails to decode, a
 * `toBlob` that yields nothing, a missing 2D context — collapses to `null`.
 * This is deliberate, and it is NOT an error being swallowed: a window icon is
 * purely cosmetic branding, and the caller MUST already be able to run without
 * one. macOS has no per-window icons whatsoever, and Wayland compositors
 * routinely ignore `set_icon`, so "no icon" is a first-class, expected outcome
 * on supported platforms rather than a degraded state to report. Returning
 * `null` lets the caller skip the `setIcon` call entirely and keep the bundled
 * ProcMix icon, which is exactly the desired fallback. Surfacing these as
 * exceptions would force every call site to write a `catch` whose only correct
 * body is "carry on regardless".
 */

/**
 * Edge length, in pixels, of the square canvas used to rasterise SVG and
 * emoji icons. 64px is the largest size a taskbar / window-switcher entry
 * realistically renders at on Windows and Linux, and keeps the encoded PNG
 * small enough to cross the IPC boundary as a plain byte array.
 */
const RASTER_SIZE = 64;

/**
 * Font size, in pixels, used when rasterising an emoji glyph. Slightly under
 * {@link RASTER_SIZE} so glyphs with tall ascenders or descenders are not
 * clipped by the canvas edge.
 */
const EMOJI_FONT_SIZE = 48;

/**
 * Font stack for emoji rasterisation. Names the platform colour-emoji fonts
 * explicitly (Windows / macOS / Linux respectively) so the canvas gets the
 * same glyph the DOM would render, with a generic `sans-serif` backstop for
 * non-emoji glyphs.
 */
const EMOJI_FONT_STACK =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

/** Decode the base64 payload of a `data:` URI into raw bytes. */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Split a `data:<mime>;base64,<payload>` URI into its MIME type and payload.
 * Returns `null` for anything that is not base64-encoded (a percent-encoded
 * or plain-text `data:` URI is not a shape `IconPicker` can produce).
 */
function parseBase64DataUri(
  uri: string,
): { mime: string; payload: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(uri);
  if (match === null) return null;
  return { mime: match[1], payload: match[2] };
}

/** Allocate a square canvas and its 2D context, or `null` when unavailable. */
function createRasterContext(): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null {
  const canvas = document.createElement("canvas");
  canvas.width = RASTER_SIZE;
  canvas.height = RASTER_SIZE;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  return { canvas, ctx };
}

/** Encode a drawn canvas to PNG bytes, or `null` if encoding is unavailable. */
async function canvasToPngBytes(
  canvas: HTMLCanvasElement,
): Promise<Uint8Array | null> {
  const blob = await new Promise<Blob | null>((resolve) => {
    // jsdom's `toBlob` is a no-op stub that never invokes the callback in some
    // versions and throws in others; the throw is caught by the caller, and a
    // never-resolving callback cannot happen in a real webview.
    canvas.toBlob((result) => {
      resolve(result);
    }, "image/png");
  });
  if (blob === null) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/** Load a `data:` URI into an `HTMLImageElement`, rejecting on decode failure. */
async function loadImage(dataUri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve(img);
    };
    img.onerror = () => {
      reject(new Error("failed to decode icon image"));
    };
    img.src = dataUri;
  });
}

/** Rasterise an SVG `data:` URI onto a square PNG. */
async function rasterizeSvg(dataUri: string): Promise<Uint8Array | null> {
  const raster = createRasterContext();
  if (raster === null) return null;
  const img = await loadImage(dataUri);
  raster.ctx.drawImage(img, 0, 0, RASTER_SIZE, RASTER_SIZE);
  return canvasToPngBytes(raster.canvas);
}

/** Rasterise an emoji / glyph character onto a square PNG. */
async function rasterizeGlyph(glyph: string): Promise<Uint8Array | null> {
  const raster = createRasterContext();
  if (raster === null) return null;
  raster.ctx.font = `${EMOJI_FONT_SIZE}px ${EMOJI_FONT_STACK}`;
  raster.ctx.textAlign = "center";
  raster.ctx.textBaseline = "middle";
  raster.ctx.fillText(glyph, RASTER_SIZE / 2, RASTER_SIZE / 2);
  return canvasToPngBytes(raster.canvas);
}

/**
 * Convert a `MiniApp.icon` value into PNG bytes for `Window.setIcon`.
 *
 * Returns `null` when there is no icon to show or when the value cannot be
 * turned into a PNG — see the module doc for why that is a normal outcome and
 * not an error the caller should report. Never throws.
 *
 * @param icon The mini-app's `icon` field: a base64 `data:` URI (PNG or SVG),
 *   an emoji / glyph character, or `undefined`.
 */
export async function miniAppIconToPngBytes(
  icon: string | undefined,
): Promise<Uint8Array | null> {
  if (icon === undefined || icon === "") return null;

  try {
    if (icon.startsWith("data:")) {
      const parsed = parseBase64DataUri(icon);
      if (parsed === null) return null;
      // A PNG upload is already in the exact format `setIcon` wants, so decode
      // it verbatim instead of round-tripping through a canvas.
      if (parsed.mime === "image/png") return decodeBase64(parsed.payload);
      // `return await` (not a bare `return`) is required: a promise returned
      // directly from a `try` settles AFTER the block exits, so a rejection
      // would escape this `catch` entirely.
      if (parsed.mime === "image/svg+xml") return await rasterizeSvg(icon);
      // Any other MIME cannot reach here from `IconPicker` (it only emits PNG
      // and SVG), and `setIcon` would reject it anyway.
      return null;
    }
    return await rasterizeGlyph(icon);
  } catch {
    return null;
  }
}
