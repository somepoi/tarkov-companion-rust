//! Data-only map tiles, never scripts or private profile files.
use crate::{desktop::HostState, packs::LIGHTHOUSE_DRAWING};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tauri::{
    Manager, UriSchemeContext, UriSchemeResponder,
    http::{Request, Response},
};

static JOBS: AtomicUsize = AtomicUsize::new(0);
static IO: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);
struct Lease;
impl Drop for Lease {
    fn drop(&mut self) {
        JOBS.fetch_sub(1, Ordering::AcqRel);
    }
}
fn response(status: u16, mime: &str, bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(bytes)
        .expect("Static resource response headers")
}
pub fn serve(
    context: UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if !["main", "searchbar"].contains(&context.webview_label()) {
        responder.respond(response(403, "text/plain", vec![]));
        return;
    }
    let head = request.method() == "HEAD";
    if !head && request.method() != "GET" {
        responder.respond(response(405, "text/plain", vec![]));
        return;
    }
    let decoded = percent_encoding::percent_decode_str(request.uri().path()).decode_utf8();
    let Ok(decoded) = decoded else {
        responder.respond(response(400, "text/plain", vec![]));
        return;
    };
    let relative = decoded.strip_prefix('/').unwrap_or(&decoded).to_owned();
    let drawing = relative == LIGHTHOUSE_DRAWING;
    let origin = request
        .headers()
        .get("origin")
        .and_then(|origin| origin.to_str().ok())
        .filter(|origin| {
            matches!(
                *origin,
                "http://tauri.localhost" | "https://tauri.localhost"
            )
        })
        .map(str::to_owned);
    let mime = if drawing {
        "image/svg+xml"
    } else if relative.ends_with(".png") {
        "image/png"
    } else if relative.ends_with(".jpg") || relative.ends_with(".jpeg") {
        "image/jpeg"
    } else if relative.ends_with(".webp") {
        "image/webp"
    } else {
        ""
    };
    if relative.len() > 240
        || !relative.starts_with("tiles/lighthouse-re3mr/")
        || mime.is_empty()
        || request.uri().query().is_some()
        || !relative
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"/-._".contains(&b))
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == ".." || part.ends_with('.'))
    {
        responder.respond(response(400, "text/plain", vec![]));
        return;
    }
    if JOBS
        .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < 128).then_some(n + 1)
        })
        .is_err()
    {
        responder.respond(response(503, "text/plain", vec![]));
        return;
    }
    let app = context.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let _lease = Lease;
        let _permit = IO.acquire().await.expect("Resource semaphore remains open");
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let read = || -> Result<Option<Vec<u8>>, String> {
                let state = app
                    .try_state::<Arc<HostState>>()
                    .ok_or("Host state unavailable")?;
                if let Ok(packs) = &state.packs
                    && let Some(bytes) = packs.read_resource_limited(&relative, 8 * 1024 * 1024)?
                {
                    return Ok(Some(bytes));
                }
                #[cfg(feature = "custom-protocol")]
                {
                    // Avoid the asset resolver's SPA index fallback on missing paths.
                    if !app
                        .asset_resolver()
                        .iter()
                        .any(|(path, _)| path.as_ref().trim_start_matches('/') == relative)
                    {
                        return Ok(None);
                    }
                    Ok(app
                        .asset_resolver()
                        .get(relative.clone())
                        .map(|asset| asset.bytes))
                }
                #[cfg(not(feature = "custom-protocol"))]
                {
                    use std::{fs, io::Read, path::Path};
                    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../public")
                        .canonicalize()
                        .map_err(|e| e.to_string())?;
                    let path = match root.join(&relative).canonicalize() {
                        Ok(path) => path,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            return Ok(None);
                        }
                        Err(error) => return Err(error.to_string()),
                    };
                    if !path.starts_with(root) {
                        return Err("Resource outside public directory".into());
                    }
                    let mut bytes = Vec::new();
                    fs::File::open(path)
                        .map_err(|e| e.to_string())?
                        .take(8 * 1024 * 1024 + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|e| e.to_string())?;
                    Ok(Some(bytes))
                }
            };
            let mut result = match read() {
                Ok(Some(bytes)) if bytes.len() <= 8 * 1024 * 1024 => {
                    response(200, mime, if head { vec![] } else { bytes })
                }
                Ok(None) => response(404, "text/plain", vec![]),
                _ => response(500, "text/plain", vec![]),
            };
            if drawing {
                let headers = result.headers_mut();
                // The renderer fetches and sanitizes the drawing before adding it to Leaflet.
                // Keep direct SVG navigation inert and CORS limited to the app's own origin.
                headers.insert(
                    "Content-Security-Policy",
                    "default-src 'none'; sandbox"
                        .parse()
                        .expect("Static SVG policy"),
                );
                if let Some(origin) = origin {
                    headers.insert(
                        "Access-Control-Allow-Origin",
                        origin.parse().expect("Allowed origin"),
                    );
                }
            }
            responder.respond(result);
        })
        .await;
    });
}
