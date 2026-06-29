// Static serving of the browser web UI bundle (B5).
//
// Embeds `app/web/dist` (the SPA built by `app/web`'s `npm run build`) into the
// binary at compile time via rust-embed, and serves it over the SAME axum
// server as the REST API — but on routes OUTSIDE the Bearer guard, because the
// login page itself cannot require a token. The DNS-rebinding `Host` check still
// applies (a static page is harmless, but the bundle should only be served to a
// legitimate host).
//
// Routing model:
//   - `/api/*` is handled by the API router (auth-gated) and never reaches here.
//   - `GET /` and any other non-API path is served from the embedded bundle.
//   - A path with no matching asset falls back to `index.html` so the SPA's
//     client-side navigation works on a hard refresh / deep link.
//   - When the bundle is EMPTY (dist not built), every static route 404s; the
//     REST API is unaffected.
//
// Mounting is gated by the `serve_web_ui` config flag in `router::build_router`;
// when off, none of this is reachable and the server is API-only.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;
use tauri::Runtime;

use super::auth;
use super::router::ApiState;

/// The embedded web UI bundle. Path is relative to the crate root (`src-tauri/`).
/// A fresh checkout has an empty `dist` (only `.gitkeep`), so the embed is empty
/// until `app/web` is built — the static routes then 404 gracefully.
#[derive(RustEmbed)]
#[folder = "../web/dist"]
struct WebAssets;

/// The SPA entry document, served for `/` and as the client-routing fallback.
const INDEX_HTML: &str = "index.html";

/// Serve a static asset for `uri`, or the SPA `index.html` fallback.
///
/// Applies the DNS-rebinding `Host` check first (mirroring the API guard's host
/// gate) — a forbidden host gets `403` with no body. Hashed asset files
/// (`/assets/*`) are served with a long immutable cache; `index.html` is served
/// `no-cache` so a new deploy is picked up.
pub async fn serve_web_asset<R: Runtime>(
    State(state): State<ApiState<R>>,
    headers: HeaderMap,
    ConnectInfo(_addr): ConnectInfo<SocketAddr>,
    uri: Uri,
) -> Response {
    // DNS-rebinding gate (no auth here — the login page must load tokenless).
    let host_header = headers.get("host").and_then(|v| v.to_str().ok());
    let lan_ip = state.server_state.lan_ip().await;
    if !auth::is_host_allowed(
        host_header,
        state.config.port,
        state.config.bind_lan,
        lan_ip,
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }

    // An unknown `/api/*` path must stay a 404 (a missing API route), NOT be
    // masked by the SPA shell. The API routes are matched before this fallback,
    // so reaching here with an `/api/` prefix means no such route exists.
    if uri.path().starts_with("/api/") {
        return StatusCode::NOT_FOUND.into_response();
    }

    // Normalise the request path into an embedded asset key. `/` → index.html;
    // otherwise strip the leading slash. `?query`/`#frag` are not part of the
    // path, so no stripping needed (axum's `Uri::path` excludes them).
    let path = uri.path().trim_start_matches('/');
    let key = if path.is_empty() { INDEX_HTML } else { path };

    if let Some(resp) = serve_embedded(key) {
        return resp;
    }

    // No direct asset match. If the path looks like a static file request that
    // genuinely does not exist (has a file extension, e.g. a missing `.png`),
    // return 404 rather than masking it with the SPA shell. Otherwise treat it
    // as a client-side route and serve the SPA entry document.
    if has_file_extension(key) {
        return StatusCode::NOT_FOUND.into_response();
    }
    serve_embedded(INDEX_HTML).unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
}

/// Look up `key` in the embedded bundle and build a response with the right
/// `Content-Type` + cache headers. `None` when the asset is absent.
fn serve_embedded(key: &str) -> Option<Response> {
    let asset = WebAssets::get(key)?;
    let mime = mime_for(key);
    let cache = cache_control_for(key);
    Some(
        (
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, cache),
            ],
            asset.data.into_owned(),
        )
            .into_response(),
    )
}

/// Whether the last path segment contains a `.` (a file extension). Used to
/// distinguish "missing static file" (→ 404) from "client-side route" (→ SPA
/// shell). A dotless path like `/library` is a route; `/assets/x.js` is a file.
fn has_file_extension(key: &str) -> bool {
    key.rsplit('/').next().is_some_and(|seg| seg.contains('.'))
}

/// Minimal extension → MIME mapping for the asset kinds the Vite build emits.
/// Kept local (no extra crate) since the set is small and fixed.
fn mime_for(key: &str) -> &'static str {
    let ext = key.rsplit('.').next().unwrap_or("");
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "map" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Cache policy. Vite emits content-hashed filenames under `assets/`, so those
/// are safe to cache immutably for a year. `index.html` is the un-hashed entry
/// and must be revalidated so a new deploy is seen.
fn cache_control_for(key: &str) -> &'static str {
    if key == INDEX_HTML {
        "no-cache"
    } else if key.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=3600"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_is_no_cache_hashed_assets_immutable() {
        assert_eq!(cache_control_for("index.html"), "no-cache");
        assert_eq!(
            cache_control_for("assets/index-abc123.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(cache_control_for("favicon.ico"), "public, max-age=3600");
    }

    #[test]
    fn mime_covers_spa_asset_kinds() {
        assert_eq!(mime_for("index.html"), "text/html; charset=utf-8");
        assert_eq!(mime_for("assets/x.js"), "text/javascript; charset=utf-8");
        assert_eq!(mime_for("assets/x.css"), "text/css; charset=utf-8");
        assert_eq!(mime_for("logo.svg"), "image/svg+xml");
        assert_eq!(mime_for("weird.unknownext"), "application/octet-stream");
    }

    #[test]
    fn file_extension_distinguishes_routes_from_assets() {
        assert!(has_file_extension("assets/index-abc.js"));
        assert!(has_file_extension("favicon.ico"));
        // Client-side routes have no extension on the last segment.
        assert!(!has_file_extension("library"));
        assert!(!has_file_extension("history/run/123"));
        assert!(!has_file_extension(""));
    }
}
