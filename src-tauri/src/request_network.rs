use serde::Serialize;
use serde_json::Value;
use std::net::{IpAddr, SocketAddr};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestIp {
    pub ip: String,
    pub port: Option<u16>,
    pub kind: String,
    pub source: String,
}

fn address(value: &str, kind: &str, source: &str) -> Option<RequestIp> {
    let value = value.trim();
    let (ip, port) = if let Ok(socket) = value.parse::<SocketAddr>() {
        (socket.ip(), Some(socket.port()))
    } else {
        (value.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>().ok()?, None)
    };
    Some(RequestIp { ip: ip.to_string(), port, kind: kind.into(), source: source.into() })
}

fn field_kind(key: &str) -> Option<&'static str> {
    match key {
        "remote_ip" | "remoteIp" | "remote_addr" | "remoteAddr" | "remote_address" | "remoteAddress"
        | "peer_ip" | "peerIp" | "peer_addr" | "peerAddr" | "peer_address" | "peerAddress"
        | "net.peer.ip" | "network.peer.address" | "socket.remoteAddress" => Some("remote"),
        "upstream_addr" | "upstreamAddr" | "upstream_ip" | "upstreamIp" => Some("upstream"),
        _ => None,
    }
}

pub(crate) fn from_fields<'a>(fields: impl IntoIterator<Item = (&'a str, &'a str)>) -> Vec<RequestIp> {
    let mut result = Vec::new();
    for (key, value) in fields {
        if let Some(kind) = field_kind(key) {
            if let Some(ip) = address(value, kind, key) { result.push(ip); }
        }
    }
    result.sort_by(|a, b| (&a.kind, &a.ip, a.port, &a.source).cmp(&(&b.kind, &b.ip, b.port, &b.source)));
    result.dedup();
    result
}

// Only transport metadata containers are visited. Chat content, tool output,
// arbitrary error text, DNS answers and client/forwarding headers are not peers.
pub(crate) fn from_value(value: &Value) -> Vec<RequestIp> {
    fn visit(value: &Value, path: &str, depth: u8, out: &mut Vec<RequestIp>) {
        if depth > 4 { return; }
        let Some(object) = value.as_object() else { return; };
        for (key, value) in object {
            let source = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
            if let (Some(kind), Some(value)) = (field_kind(key), value.as_str()) {
                if let Some(ip) = address(value, kind, &source) { out.push(ip); }
            }
            if ["response", "request", "error", "cause", "data", "metadata", "network", "connection", "socket", "transport", "http", "message"].contains(&key.as_str()) {
                visit(value, &source, depth + 1, out);
            }
        }
    }
    let mut out = Vec::new();
    visit(value, "", 0, &mut out);
    out
}

// This receives logfmt metadata, never the HTTP headers/body or conversation text.
pub(crate) fn from_logfmt(text: &str) -> Vec<RequestIp> {
    from_fields(text.split_whitespace().filter_map(|field| {
        let (key, value) = field.split_once('=')?;
        Some((key, value.trim_matches('"').trim_end_matches(',')))
    }))
}

pub(crate) fn target_url(url: &str) -> Option<RequestIp> {
    let url = reqwest::Url::parse(url).ok()?;
    address(url.host_str()?, "target", "请求 URL 中的 IP（连接未确认）")
        .map(|mut ip| { ip.port = url.port_or_known_default(); ip })
}

pub(crate) fn merge(into: &mut Vec<RequestIp>, other: &[RequestIp]) {
    for ip in other { if !into.contains(ip) { into.push(ip.clone()); } }
}

pub(crate) fn request_id(value: &Value) -> Option<String> {
    fn read(v: &Value, depth: u8) -> Option<String> {
        if depth > 4 { return None; }
        for key in ["requestId", "request_id", "request-id", "x-request-id"] {
            if let Some(id) = v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 160 && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-.:/".contains(&c))) {
                return Some(id.into());
            }
        }
        for key in ["response", "error", "data", "metadata", "headers", "responseHeaders"] {
            if let Some(id) = read(&v[key], depth + 1) { return Some(id); }
        }
        None
    }
    read(value, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_explicit_ipv4_ipv6_and_preserves_transport_roles() {
        let ips = from_value(&json!({"response":{"socket":{"remoteAddress":"[2001:db8::5]:443"}},"upstream_addr":"192.0.2.7:8080"}));
        assert_eq!(ips.len(), 2);
        assert!(ips.iter().any(|ip| ip.ip == "2001:db8::5" && ip.port == Some(443) && ip.kind == "remote"));
        assert!(ips.iter().any(|ip| ip.ip == "192.0.2.7" && ip.kind == "upstream"));
        assert_eq!(from_logfmt("remote_addr=\"192.0.2.9:443\" status=200")[0].ip, "192.0.2.9");
    }

    #[test]
    fn never_guesses_peers_from_content_client_headers_or_dns() {
        assert!(from_value(&json!({"content":[{"remote_ip":"192.0.2.1"}],"headers":{"x-forwarded-for":"192.0.2.2"},"client_ip":"192.0.2.3","resolved_ip":"192.0.2.4","remote_ip":"example.invalid","error":{"message":"remote_ip=192.0.2.5"}})).is_empty());
        assert!(target_url("https://example.invalid/v1").is_none());
        assert_eq!(target_url("https://[2001:db8::7]/v1").unwrap().kind, "target");
        assert!(from_fields([("remote_ip", "999.1.1.1")]).is_empty());
    }
}
