import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import * as QRCode from "qrcode";

interface HttpServerQrCodeProps {
  /** The URL to encode. */
  url: string;
  /** Canvas side length in CSS pixels. Defaults to 160. */
  size?: number;
}

/**
 * Renders a QR code for `url` into a `<canvas>` via `QRCode.toCanvas` — never
 * a `data:` URI, so the app's CSP `img-src` list doesn't need to change
 * (`tauri.conf.json`). Re-renders whenever `url` or `size` changes; the canvas
 * is local to this component and nothing is persisted to disk or the store.
 */
export function HttpServerQrCode({
  url,
  size = 160,
}: HttpServerQrCodeProps): ReactElement {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setError(null);
    let cancelled = false;
    QRCode.toCanvas(canvas, url, { width: size, margin: 1 }).catch(() => {
      if (!cancelled) setError(t("httpServer.qr.renderError"));
    });
    return () => {
      cancelled = true;
    };
  }, [url, size, t]);

  return (
    <div className="http-server-panel__qr">
      <canvas
        ref={canvasRef}
        className="http-server-panel__qr-canvas"
        width={size}
        height={size}
        role="img"
        aria-label={t("httpServer.qr.altText", { url })}
      />
      {error !== null ? (
        <p className="http-server-panel__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
