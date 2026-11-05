//! Official CYAPI API routing for the desktop client.
//!
//! The browser must keep using the public hostname because it cannot safely
//! override DNS while preserving TLS SNI and cookies.  The native client can
//! do that safely with reqwest's `resolve`: the URL, Host header and TLS SNI
//! remain `api.cyapi.cyou`, while the connection is sent to the selected
//! address.
//!
//! The node itself is chosen once (see `service::route_priority`) and every
//! request reuses it, so a request normally costs exactly one connection.

use reqwest::{blocking::Client, redirect::Policy, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::Read,
    net::SocketAddr,
    time::{Duration, Instant},
};

use crate::service::{
    base_url_from,
    route_priority::{self, Route},
};

const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;

type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HttpRequest {
    pub path: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub body: Option<Value>,
    /// Long-running platform operations (workspace start/editor token) need a
    /// budget larger than the default API call. Clamped to 1s..=300s.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HttpResponse {
    pub status: u16,
    pub route: String,
    /// Parsed JSON for normal API responses.  A non-JSON response is exposed
    /// as null and retained in `text` for the caller's error message.
    pub body: Value,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub text: String,
}

/// Binary artifact download for the workflow results page.  Result URLs are
/// private (Bearer only), so the renderer cannot point an `<img>` at them.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadRequest {
    pub path: String,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadResponse {
    pub content_type: String,
    pub base64: String,
}

fn validate_path(path: &str) -> Result<()> {
    if !path.starts_with('/')
        || path.chars().any(char::is_control)
        || path.contains("\\")
        || path.contains("//")
    {
        return Err("API 路径无效".into());
    }
    Ok(())
}

fn parse_method(method: &str) -> Result<Method> {
    let method = method.trim().to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
        return Err("不支持的 API 请求方法".into());
    }
    Method::from_bytes(method.as_bytes()).map_err(|_| "API 请求方法无效".into())
}

fn client_for(route: Route, url: &Url, timeout: Duration) -> Result<Client> {
    let mut builder = Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(5).min(timeout))
        .redirect(Policy::none());
    if let Some(proxy) = route.proxy() {
        // Beijing is only reachable through the local tunnel proxy; reqwest
        // keeps the URL/SNI as the official hostname and the proxy carries the
        // connection through a nested TLS layer that the mainland filter lets
        // through.
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|error| error.to_string())?);
    } else if let Some(address) = route.address() {
        // `resolve` changes only the socket address.  reqwest still derives
        // Host and TLS SNI from `url`, so the certificate is checked for the
        // official hostname rather than for a bare IP address.
        builder = builder.no_proxy().resolve(
            route_priority::API_HOST,
            SocketAddr::new(address, url.port_or_known_default().unwrap_or(443)),
        );
    }
    builder.build().map_err(|error| error.to_string())
}

/// Distinguishes "this route is unreachable" from "the server is still working".
/// A slow response must not put a healthy route into the failure cooldown, or a
/// long workspace start would push every later request to the CDN route.
struct TransportError {
    message: String,
    route_failed: bool,
}

fn transport_error(error: reqwest::Error) -> TransportError {
    TransportError {
        route_failed: error.is_connect() || error.is_request(),
        message: error.to_string(),
    }
}

fn retryable_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 502 | 503 | 504)
}

struct RawResponse {
    status: u16,
    content_type: String,
    bytes: Vec<u8>,
}

fn send_raw(
    base: &Url,
    route: Route,
    request: &HttpRequest,
    timeout: Duration,
    max: u64,
) -> std::result::Result<RawResponse, TransportError> {
    let url = base
        .join(request.path.trim_start_matches('/'))
        .map_err(|_| TransportError {
            message: "API 地址无效".into(),
            route_failed: false,
        })?;
    let client = client_for(route, &url, timeout).map_err(|message| TransportError {
        message,
        route_failed: false,
    })?;
    let method = parse_method(&request.method).map_err(|message| TransportError {
        message,
        route_failed: false,
    })?;
    let mut outgoing = client.request(method, url);
    outgoing = outgoing.header("Accept", "application/json");
    if let Some(key) = request.key.as_deref().filter(|key| !key.is_empty()) {
        outgoing = outgoing.bearer_auth(key);
    }
    if let Some(body) = request.body.as_ref() {
        outgoing = outgoing.json(body);
    }
    let response = outgoing.send().map_err(transport_error)?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim()
        .to_string();
    if response
        .content_length()
        .is_some_and(|length| length > max)
    {
        return Err(TransportError {
            message: "API 响应过大".into(),
            route_failed: false,
        });
    }
    let mut bytes = Vec::new();
    response
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| TransportError {
            message: error.to_string(),
            route_failed: false,
        })?;
    if bytes.len() as u64 > max {
        return Err(TransportError {
            message: "API 响应过大".into(),
            route_failed: false,
        });
    }
    Ok(RawResponse {
        status,
        content_type,
        bytes,
    })
}

fn send_once(
    base: &Url,
    route: Route,
    request: &HttpRequest,
    timeout: Duration,
) -> std::result::Result<HttpResponse, TransportError> {
    let raw = send_raw(base, route, request, timeout, MAX_RESPONSE_BYTES)?;
    let text = String::from_utf8_lossy(&raw.bytes).into_owned();
    let body = serde_json::from_slice(&raw.bytes).unwrap_or(Value::Null);
    let is_text_body = matches!(body, Value::Null);
    Ok(HttpResponse {
        status: raw.status,
        route: route.name().into(),
        body,
        text: if is_text_body { text } else { String::new() },
    })
}

/// Failure of one attempt on one node.
struct AttemptFailure {
    message: String,
    /// The node itself looked unreachable, as opposed to the server rejecting
    /// this particular request.
    route_failed: bool,
    /// A retryable HTTP status that can still be returned if no node works.
    response: Option<HttpResponse>,
}

fn attempt(
    base: &Url,
    route: Route,
    request: &HttpRequest,
    deadline: Instant,
) -> std::result::Result<HttpResponse, AttemptFailure> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        crate::logging::event(
            "warn",
            "network",
            format!("请求预算已用尽，未尝试{}", route.label()),
        );
        return Err(AttemptFailure {
            message: "请求预算已用尽".into(),
            route_failed: false,
            response: None,
        });
    }
    let started = Instant::now();
    match send_once(base, route, request, remaining) {
        Ok(response) if retryable_status(response.status) => {
            crate::logging::event(
                "warn",
                "network",
                format!(
                    "{} 返回 HTTP {}（{} ms），尝试下一条线路",
                    route.label(),
                    response.status,
                    started.elapsed().as_millis()
                ),
            );
            Err(AttemptFailure {
                message: format!("HTTP {}", response.status),
                route_failed: true,
                response: Some(response),
            })
        }
        Ok(response) => {
            crate::logging::event(
                "info",
                "network",
                format!(
                    "{} 响应 HTTP {}（{} ms）",
                    route.label(),
                    response.status,
                    started.elapsed().as_millis()
                ),
            );
            Ok(response)
        }
        Err(error) => {
            crate::logging::event(
                "warn",
                "network",
                format!(
                    "{} 请求失败（{} ms）：{}",
                    route.label(),
                    started.elapsed().as_millis(),
                    error.message
                ),
            );
            Err(AttemptFailure {
                message: error.message,
                route_failed: error.route_failed,
                response: None,
            })
        }
    }
}

fn official_base(base: &Url) -> bool {
    base.scheme() == "https"
        && base.host_str() == Some(route_priority::API_HOST)
        && base.port_or_known_default() == Some(443)
}

/// Sends one API operation through the node chosen at startup. The choice is
/// reused by every request; only when this node fails is the order probed
/// again (Beijing, then Hong Kong, then Cloudflare) and the request retried
/// once. Every attempt is logged so a failed launch can be diagnosed from the
/// in-app log instead of a generic network message.
pub(crate) fn request(server_url: &str, request: HttpRequest) -> Result<HttpResponse> {
    validate_path(&request.path)?;
    let base = base_url_from(server_url)?;
    // The caller's budget covers the whole operation, including the retry on
    // another node. A slow workspace start must fail once, not multiply the
    // wait by trying every route that ends in a timeout.
    let budget = Duration::from_millis(request.timeout_ms.unwrap_or(15_000).clamp(1_000, 300_000));
    let deadline = Instant::now() + budget;
    let official = official_base(&base);

    // Only the official API has alternate nodes; every other host keeps normal
    // DNS resolution (and any configured proxy).
    let first = if official {
        route_priority::PRIORITY
            .select(None, route_priority::probe)
            .unwrap_or(Route::Cloudflare)
    } else {
        Route::Cloudflare
    };

    let first_failure = match attempt(&base, first, &request, deadline) {
        Ok(response) => return Ok(response),
        Err(failure) => failure,
    };
    if first_failure.route_failed {
        route_priority::PRIORITY.demote(first);
    }
    if !official || !first_failure.route_failed {
        // Another node would answer a malformed or oversized request the same
        // way, so only a route failure is worth a retry.
        return match first_failure.response {
            Some(response) => Ok(response),
            None => Err(format!("CYAPI 请求失败：{}", first_failure.message)),
        };
    }

    let second = route_priority::PRIORITY
        .select(Some(first), route_priority::probe)
        .unwrap_or_else(|| first.next());
    crate::logging::event(
        "warn",
        "network",
        format!(
            "{}请求失败，已重新选择{}",
            first.label(),
            second.label()
        ),
    );

    match attempt(&base, second, &request, deadline) {
        Ok(response) => Ok(response),
        Err(second_failure) => {
            if second_failure.route_failed {
                route_priority::PRIORITY.demote(second);
            }
            if let Some(response) = second_failure.response {
                return Ok(response);
            }
            if let Some(response) = first_failure.response {
                return Ok(response);
            }
            let message = format!(
                "{}失败：{}；{}失败：{}",
                first.label(),
                first_failure.message,
                second.label(),
                second_failure.message
            );
            crate::logging::event("error", "network", &message);
            Err(message)
        }
    }
}

/// Raw variant of `attempt`: a private artifact is bytes, not JSON.
fn attempt_download(
    base: &Url,
    route: Route,
    request: &HttpRequest,
    deadline: Instant,
    max: u64,
) -> std::result::Result<RawResponse, AttemptFailure> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(AttemptFailure {
            message: "请求预算已用尽".into(),
            route_failed: false,
            response: None,
        });
    }
    let started = Instant::now();
    match send_raw(base, route, request, remaining, max) {
        Ok(raw) if retryable_status(raw.status) => {
            crate::logging::event(
                "warn",
                "network",
                format!(
                    "{} 下载返回 HTTP {}（{} ms），尝试下一条线路",
                    route.label(),
                    raw.status,
                    started.elapsed().as_millis()
                ),
            );
            Err(AttemptFailure {
                message: format!("HTTP {}", raw.status),
                route_failed: true,
                response: None,
            })
        }
        Ok(raw) => {
            crate::logging::event(
                "info",
                "network",
                format!(
                    "{} 下载 HTTP {}（{} ms，{} 字节）",
                    route.label(),
                    raw.status,
                    started.elapsed().as_millis(),
                    raw.bytes.len()
                ),
            );
            Ok(raw)
        }
        Err(error) => {
            crate::logging::event(
                "warn",
                "network",
                format!(
                    "{} 下载失败（{} ms）：{}",
                    route.label(),
                    started.elapsed().as_millis(),
                    error.message
                ),
            );
            Err(AttemptFailure {
                message: error.message,
                route_failed: error.route_failed,
                response: None,
            })
        }
    }
}

/// Downloads a private workflow artifact.  Private result URLs only accept a
/// Bearer Key, so the renderer receives the bytes and turns them into a blob.
pub(crate) fn download(
    server_url: &str,
    request: DownloadRequest,
) -> Result<DownloadResponse> {
    use base64::Engine as _;
    validate_path(&request.path)?;
    let base = base_url_from(server_url)?;
    let max = request
        .max_bytes
        .unwrap_or(64 * 1024 * 1024)
        .clamp(1024, 256 * 1024 * 1024);
    let budget = Duration::from_millis(request.timeout_ms.unwrap_or(120_000).clamp(1_000, 300_000));
    let deadline = Instant::now() + budget;
    let http = HttpRequest {
        path: request.path,
        method: "GET".into(),
        key: request.key,
        body: None,
        timeout_ms: None,
    };
    let finish = |raw: RawResponse| -> Result<DownloadResponse> {
        if !(200..300).contains(&raw.status) {
            return Err(if raw.status == 401 || raw.status == 403 {
                "下载链接已失效或无权限，请重新登录".to_string()
            } else {
                format!("下载失败（HTTP {}）", raw.status)
            });
        }
        Ok(DownloadResponse {
            content_type: raw.content_type,
            base64: base64::engine::general_purpose::STANDARD.encode(raw.bytes),
        })
    };
    let official = official_base(&base);
    let first = if official {
        route_priority::PRIORITY
            .select(None, route_priority::probe)
            .unwrap_or(Route::Cloudflare)
    } else {
        Route::Cloudflare
    };
    let first_failure = match attempt_download(&base, first, &http, deadline, max) {
        Ok(raw) => return finish(raw),
        Err(failure) => failure,
    };
    if first_failure.route_failed {
        route_priority::PRIORITY.demote(first);
    }
    if !official || !first_failure.route_failed {
        return Err(first_failure.message);
    }
    let second = route_priority::PRIORITY
        .select(Some(first), route_priority::probe)
        .unwrap_or_else(|| first.next());
    match attempt_download(&base, second, &http, deadline, max) {
        Ok(raw) => finish(raw),
        Err(second_failure) => {
            if second_failure.route_failed {
                route_priority::PRIORITY.demote(second);
            }
            Err(format!(
                "{}失败：{}；{}失败：{}",
                first.label(),
                first_failure.message,
                second.label(),
                second_failure.message
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_official_host_is_routed_through_the_selected_node() {
        assert!(official_base(
            &Url::parse("https://api.cyapi.cyou/").unwrap()
        ));
        for value in [
            "http://api.cyapi.cyou/",
            "https://api.cyapi.cyou:8443/",
            "https://127.0.0.1:18733/",
            "https://example.test/",
        ] {
            assert!(!official_base(&Url::parse(value).unwrap()), "{value}");
        }
    }

    #[test]
    fn request_validation_rejects_ambiguous_paths_and_methods() {
        for path in ["api/catalog", "/api//catalog", "/api\\catalog", "/api\n"] {
            assert!(validate_path(path).is_err(), "{path:?}");
        }
        assert!(parse_method("OPTIONS").is_err());
        assert!(parse_method("POST").is_ok());
    }

    #[test]
    fn retryable_statuses_are_transport_like_only() {
        assert!(retryable_status(503));
        assert!(retryable_status(504));
        assert!(!retryable_status(401));
        assert!(!retryable_status(429));
    }
}
