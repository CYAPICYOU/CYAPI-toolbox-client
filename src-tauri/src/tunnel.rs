//! Local CONNECT proxy that carries the platform traffic through Beijing.
//!
//! The mainland address of the Beijing host filters TLS handshakes whose SNI is
//! `*.cyapi.cyou`, and it filters plain HTTP requests carrying the same Host
//! header, so the domain cannot appear on the client-to-Beijing hop at all.
//!
//! The tunnel therefore nests the real TLS connection inside a second TLS
//! connection that is opened to the Beijing *IP address*.  No SNI is sent for
//! the outer layer, nginx on the Beijing host terminates only that outer layer
//! and forwards the inner bytes untouched to the Hong Kong origin, and the
//! Hong Kong origin answers with the genuine `api.cyapi.cyou` certificate.
//! The client keeps talking to `https://api.cyapi.cyou`; only the local socket
//! is redirected here.
//!
//! This is a loopback-only HTTP CONNECT proxy.  Requests for `*.cyapi.cyou`
//! are tunnelled; everything else is connected directly so a browser webview
//! that has this proxy configured still loads ordinary resources normally.

use std::{
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{Arc, OnceLock},
    time::Duration,
};

use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    ClientConfig, DigitallySignedStruct, SignatureScheme,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_rustls::TlsConnector;

const BEIJING_IP: Ipv4Addr = Ipv4Addr::new(101, 201, 221, 190);
const TUNNEL_PORT: u16 = 443;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_HEADER: usize = 16 * 1024;

static PORT: OnceLock<u16> = OnceLock::new();
static TLS_CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();

/// `http://127.0.0.1:<port>` for reqwest/WebView2, once the tunnel is running.
pub fn proxy_url() -> Option<String> {
    PORT.get().map(|port| format!("http://127.0.0.1:{port}"))
}

/// Start the loopback proxy once; later calls return the same port.
pub fn start() -> io::Result<u16> {
    if let Some(port) = PORT.get() {
        return Ok(*port);
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    if PORT.set(port).is_err() {
        return Ok(*PORT.get().expect("tunnel port"));
    }
    std::thread::Builder::new()
        .name("cyapi-tunnel".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    crate::logging::event(
                        "error",
                        "network",
                        format!("线路一隧道线程启动失败：{error}"),
                    );
                    return;
                }
            };
            runtime.block_on(async move {
                let listener = match TcpListener::from_std(listener) {
                    Ok(listener) => listener,
                    Err(error) => {
                        crate::logging::event(
                            "error",
                            "network",
                            format!("线路一隧道监听失败：{error}"),
                        );
                        return;
                    }
                };
                loop {
                    match listener.accept().await {
                        Ok((socket, _)) => {
                            tokio::spawn(async move {
                                let _ = serve(socket).await;
                            });
                        }
                        Err(error) => {
                            crate::logging::event(
                                "warn",
                                "network",
                                format!("线路一隧道接受连接失败：{error}"),
                            );
                            tokio::time::sleep(Duration::from_millis(200)).await;
                        }
                    }
                }
            });
        })?;
    Ok(port)
}

fn tls_config() -> Arc<ClientConfig> {
    TLS_CONFIG
        .get_or_init(|| {
            // The outer layer is only camouflage; the inner TLS still validates
            // the real api.cyapi.cyou certificate end to end.
            let _ = rustls::crypto::ring::default_provider().install_default();
            let config = ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(AcceptAnyCertificate))
                .with_no_client_auth();
            Arc::new(config)
        })
        .clone()
}

async fn serve(mut client: TcpStream) -> io::Result<()> {
    let _ = client.set_nodelay(true);
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        if let Some(position) = find(&buffer, b"\r\n\r\n") {
            break position + 4;
        }
        if buffer.len() > MAX_HEADER {
            return Ok(());
        }
        let read = client.read(&mut chunk).await?;
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let leftover = buffer[header_end..].to_vec();
    let first = head.lines().next().unwrap_or_default();
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    if !method.eq_ignore_ascii_case("CONNECT") {
        let _ = client
            .write_all(b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n")
            .await;
        return Ok(());
    }
    let Some((host, port)) = split_target(target) else {
        let _ = client
            .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            .await;
        return Ok(());
    };
    if !is_cyapi_host(host) {
        return forward_direct(client, host, port, leftover).await;
    }
    let address = SocketAddr::new(IpAddr::V4(BEIJING_IP), TUNNEL_PORT);
    let tcp = match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address)).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(error)) => {
            crate::logging::event(
                "warn",
                "network",
                format!("线路一隧道连接失败：{error}"),
            );
            let _ = client
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
                .await;
            return Ok(());
        }
        Err(_) => {
            crate::logging::event("warn", "network", "线路一隧道连接超时");
            let _ = client
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
                .await;
            return Ok(());
        }
    };
    let _ = tcp.set_nodelay(true);
    let name = ServerName::IpAddress(IpAddr::V4(BEIJING_IP).into());
    let connector = TlsConnector::from(tls_config());
    let handshake = tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(name, tcp)).await;
    let mut upstream = match handshake {
        Ok(Ok(stream)) => stream,
        Ok(Err(error)) => {
            crate::logging::event(
                "warn",
                "network",
                format!("线路一隧道加密握手失败：{error}"),
            );
            let _ = client
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
                .await;
            return Ok(());
        }
        Err(_) => {
            crate::logging::event("warn", "network", "线路一隧道加密握手超时");
            let _ = client
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
                .await;
            return Ok(());
        }
    };
    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;
    if !leftover.is_empty() {
        upstream.write_all(&leftover).await?;
        upstream.flush().await?;
    }
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    Ok(())
}

async fn forward_direct(
    mut client: TcpStream,
    host: &str,
    port: u16,
    leftover: Vec<u8>,
) -> io::Result<()> {
    let connect = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port))).await;
    let mut upstream = match connect {
        Ok(Ok(stream)) => stream,
        _ => {
            let _ = client
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
                .await;
            return Ok(());
        }
    };
    let _ = upstream.set_nodelay(true);
    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;
    if !leftover.is_empty() {
        upstream.write_all(&leftover).await?;
        upstream.flush().await?;
    }
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    Ok(())
}

fn is_cyapi_host(host: &str) -> bool {
    host == "cyapi.cyou" || host.ends_with(".cyapi.cyou")
}

fn split_target(target: &str) -> Option<(&str, u16)> {
    let (host, port) = target.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    Some((host.trim_matches(['[', ']']), port.parse().ok()?))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[derive(Debug)]
struct AcceptAnyCertificate;

impl ServerCertVerifier for AcceptAnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _certificate: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _certificate: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
