//! Turn Codex Desktop's shipped Chinese locale on without reaching the network.
//!
//! Codex Desktop always ships the locale bundles (`webview/assets/zh-CN-*.js`),
//! but its `LocaleProvider` only loads them when the remote Statsig layer
//! `72216192` reports `enable_i18n: true`:
//!
//! ```js
//! const layer = getLayer("72216192");
//! const enabled = layer?.get("enable_i18n", false);
//! ```
//!
//! With `ab.chatgpt.com` unreachable that evaluation never arrives, so the UI
//! stays English. Enabling therefore does two things: answer that evaluation
//! locally, and set `[desktop] localeOverride = "zh-CN"` in the user's
//! `config.toml` (respecting `CODEX_HOME`), so no manual switch in Codex's
//! settings is needed. The previous value is recorded and restored on stop.
//!
//! While this module's proxy is the system proxy, the `POST /v1/initialize`
//! call from the app's main process is answered locally with a minimal, valid
//! Statsig payload that contains the layer. Nothing inside the app is patched,
//! so a Codex update cannot undo it: only the endpoint and layer key have to
//! stay the same.
//!
//! The proxy only terminates TLS for `ab.chatgpt.com`; every other connection
//! is tunnelled through untouched (and chained through the proxy that was
//! configured before we took over). The certificate authority is generated on
//! first use, stored below the client data directory and trusted for the
//! current user only.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use toml_edit::{value, DocumentMut, Item, Table, TableLike};

type Result<T> = std::result::Result<T, String>;

/// Statsig layer that gates the localised UI.
const LAYER_KEY: &str = "72216192";
const TARGET_HOST: &str = "ab.chatgpt.com";
const PORTS: [u16; 4] = [9409, 9410, 9411, 9412];
const PROXY_STATE: &str = "proxy-state.json";
/// Codex only localises when `[desktop] localeOverride` asks for Chinese; the
/// proxy makes the flag report enabled, this setting makes Codex actually use
/// the shipped bundle.
const LOCALE_STATE: &str = "locale-state.json";
const LOCALE_KEY: &str = "localeOverride";
const LOCALE_VALUE: &str = "zh-CN";
const CA_CERT: &str = "ca-cert.pem";
const CA_KEY: &str = "ca-key.pem";
const CA_INSTALLED: &str = "ca-installed";

const INTERNET_SETTINGS: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";

struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
}

fn running() -> &'static Mutex<Option<Running>> {
    static STATE: OnceLock<Mutex<Option<Running>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

/// Data directory, kept for the restore performed when the app exits.
fn data_dir() -> &'static Mutex<Option<PathBuf>> {
    static DIR: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    DIR.get_or_init(|| Mutex::new(None))
}

fn remember(data: &Path) {
    if let Ok(mut guard) = data_dir().lock() {
        *guard = Some(data.to_path_buf());
    }
}

fn workdir(data: &Path) -> PathBuf {
    data.join("codex-i18n")
}

// ---------------------------------------------------------------------------
// public entry points
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub supported: bool,
    pub running: bool,
    pub port: Option<u16>,
    pub ca_trusted: bool,
    pub proxy_server: String,
    pub proxy_enabled: bool,
    pub captures: bool,
    pub codex_found: bool,
    pub codex_running: bool,
    /// Current `[desktop] localeOverride` in Codex's config.toml ("" if unset).
    pub locale_override: String,
    pub message: String,
}

pub fn run(data: &Path, action: &str) -> Result<serde_json::Value> {
    remember(data);
    if !cfg!(windows) {
        return Err("本地化代理目前只支持 Windows 版 Codex 桌面端。".into());
    }
    let status = match action {
        "codex-i18n-status" => status(data)?,
        "codex-i18n-start" => start(data)?,
        "codex-i18n-stop" => stop(data)?,
        "codex-i18n-restart" => {
            let (found, _) = codex_process()?;
            if !found {
                return Err("未找到 Codex 桌面版，请先安装 OpenAI Codex。".into());
            }
            restart_codex()?;
            status(data)?
        }
        other => return Err(format!("未知的本地化操作：{other}")),
    };
    serde_json::to_value(status).map_err(|error| error.to_string())
}

/// Restore the system proxy after an unclean exit, so the machine is never
/// left pointing at a proxy that no longer exists.
pub fn recover(data: &Path) {
    remember(data);
    if !cfg!(windows) {
        return;
    }
    let state = workdir(data).join(PROXY_STATE);
    if state.is_file() {
        crate::logging::event("info", "codex-i18n", "检测到上次未恢复的系统代理，正在还原");
        let _ = restore_proxy(&state);
    }
    // The locale override is ours too; drop it with the proxy when the last run
    // never got to clean up.
    restore_locale(&workdir(data));
}

/// Called when the client exits; keeps the system proxy usable.
pub fn shutdown() {
    let data = data_dir().lock().ok().and_then(|guard| guard.clone());
    if let Some(data) = data {
        let _ = halt(&data);
    }
}

fn status(data: &Path) -> Result<Status> {
    let dir = workdir(data);
    let running = running()
        .lock()
        .map_err(|_| "本地化代理状态不可用".to_string())?
        .as_ref()
        .map(|state| state.port);
    let proxy_server = proxy_server();
    let proxy_enabled = proxy_enabled();
    let (codex_found, codex_running) = codex_process().unwrap_or((false, false));
    let captures = running.is_some_and(|port| {
        proxy_enabled
            && proxy_server
                .trim()
                .eq_ignore_ascii_case(&format!("127.0.0.1:{port}"))
    });
    let ca_trusted = dir.join(CA_INSTALLED).is_file() && dir.join(CA_CERT).is_file();
    let locale_override = current_locale();
    let message = if captures {
        "已接管系统代理，Codex 语言已是 zh-CN，启动时会加载中文界面。".to_string()
    } else if running.is_some() {
        "代理已启动，但系统代理未指向它；点击“启用中文界面”可重新接管。".to_string()
    } else if proxy_enabled {
        format!("系统代理当前为 {proxy_server}，未启用本地化代理。")
    } else {
        "未启用。启用后 Codex 界面将使用中文。".to_string()
    };
    Ok(Status {
        supported: true,
        running: running.is_some(),
        port: running,
        ca_trusted,
        proxy_server,
        proxy_enabled,
        captures,
        codex_found,
        codex_running,
        locale_override,
        message,
    })
}

fn start(data: &Path) -> Result<Status> {
    // Copy the port out of the guard: the mutex must never be held while the
    // status is read again below.
    let serving = running()
        .lock()
        .map_err(|_| "本地化代理状态不可用".to_string())?
        .as_ref()
        .map(|state| state.port);
    if let Some(port) = serving {
        // Already serving: just make sure the system proxy points here again.
        let saved = read_saved(&workdir(data).join(PROXY_STATE));
        take_over_proxy(&workdir(data), port, saved.as_ref())?;
        notify_proxy_changed();
        apply_locale(&workdir(data))?;
        return status(data);
    }

    let dir = workdir(data);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建代理目录：{error}"))?;
    let ca = ensure_authority(&dir)?;

    let mut listener = None;
    let mut chosen = 0;
    for port in PORTS {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(bound) => {
                listener = Some(bound);
                chosen = port;
                break;
            }
            Err(_) => continue,
        }
    }
    let listener = listener.ok_or("本地代理端口都被占用，请关闭占用 9409-9412 的程序后重试")?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("无法配置本地代理：{error}"))?;

    let config = Arc::new(server_config(&ca)?);
    let upstream = existing_upstream();
    let stop = Arc::new(AtomicBool::new(false));

    let state_path = dir.join(PROXY_STATE);
    let saved = read_saved(&state_path);

    // The listener exists before the system proxy points at it, so a takeover
    // never leaves the machine talking to a port that is not served.
    let flag = stop.clone();
    let handler = config.clone();
    thread::Builder::new()
        .name("codex-i18n-proxy".into())
        .spawn(move || serve(listener, flag, handler, upstream))
        .map_err(|error| format!("无法启动本地代理：{error}"))?;
    if let Err(error) = take_over_proxy(&dir, chosen, saved.as_ref()) {
        stop.store(true, Ordering::SeqCst);
        return Err(error);
    }
    // Codex only loads the Chinese bundle when config.toml asks for it; write
    // the override here so the user never has to touch the Codex settings.
    if let Err(error) = apply_locale(&dir) {
        stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", chosen));
        let state_path = dir.join(PROXY_STATE);
        if state_path.is_file() {
            let _ = restore_proxy(&state_path);
            notify_proxy_changed();
        }
        return Err(error);
    }

    *running()
        .lock()
        .map_err(|_| "本地化代理状态不可用".to_string())? = Some(Running { port: chosen, stop });
    notify_proxy_changed();
    crate::logging::event(
        "info",
        "codex-i18n",
        format!("本地化代理已启动：127.0.0.1:{chosen}，系统代理已接管"),
    );
    status(data)
}

fn stop(data: &Path) -> Result<Status> {
    halt(data)?;
    status(data)
}

/// Stop the listener and undo the system proxy change.
fn halt(data: &Path) -> Result<()> {
    let serving = running()
        .lock()
        .map_err(|_| "本地化代理状态不可用".to_string())?
        .take();
    if let Some(state) = serving {
        state.stop.store(true, Ordering::SeqCst);
        // Wake the blocking accept so the listener closes quickly.
        let _ = TcpStream::connect(("127.0.0.1", state.port));
        crate::logging::event("info", "codex-i18n", "本地化代理已停止");
    }
    let dir = workdir(data);
    // Undo the config change first: it must not be skipped if the proxy restore
    // below fails.
    restore_locale(&dir);
    if dir.join(PROXY_STATE).is_file() {
        restore_proxy(&dir.join(PROXY_STATE))?;
        notify_proxy_changed();
    } else if proxy_enabled() && proxy_server().starts_with("127.0.0.1:94") {
        // The state file was lost; never leave the machine pointing at a
        // proxy that is gone.
        set_dword("ProxyEnable", 0)?;
        notify_proxy_changed();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// certificate authority
// ---------------------------------------------------------------------------

struct Authority {
    cert_pem: String,
    key_pem: String,
}

fn ensure_authority(dir: &Path) -> Result<Authority> {
    let cert_path = dir.join(CA_CERT);
    let key_path = dir.join(CA_KEY);
    let authority = match (
        fs::read_to_string(&cert_path),
        fs::read_to_string(&key_path),
    ) {
        (Ok(cert_pem), Ok(key_pem))
            if !cert_pem.trim().is_empty() && !key_pem.trim().is_empty() =>
        {
            Authority { cert_pem, key_pem }
        }
        _ => {
            let (cert_pem, key_pem) = generate_authority()?;
            write_private(&cert_path, cert_pem.as_bytes())?;
            write_private(&key_path, key_pem.as_bytes())?;
            crate::logging::event("info", "codex-i18n", "已生成本地代理证书");
            Authority { cert_pem, key_pem }
        }
    };
    // Installing is idempotent and cheap; it also heals a certificate that was
    // removed from the store by hand.
    install_authority(&cert_path)?;
    write_private(&dir.join(CA_INSTALLED), b"1")?;
    Ok(authority)
}

fn generate_authority() -> Result<(String, String)> {
    use rcgen::{
        date_time_ymd, BasicConstraints, CertificateParams, DnType, IsCa, KeyPair, KeyUsagePurpose,
    };

    let key = KeyPair::generate().map_err(|error| format!("无法生成证书私钥：{error}"))?;
    let mut params = CertificateParams::new(Vec::<String>::new())
        .map_err(|error| format!("无法生成证书：{error}"))?;
    params
        .distinguished_name
        .push(DnType::CommonName, "CYAPI Codex Local Proxy");
    params
        .distinguished_name
        .push(DnType::OrganizationName, "CYAPI Toolbox");
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    // rcgen defaults to the year 4096, which some Windows stores reject.
    params.not_before = date_time_ymd(2024, 1, 1);
    params.not_after = date_time_ymd(2039, 1, 1);
    let cert = params
        .self_signed(&key)
        .map_err(|error| format!("无法签发证书：{error}"))?;
    Ok((cert.pem(), key.serialize_pem()))
}

/// Build the rustls server configuration with a leaf certificate for the
/// Statsig host, signed by the stored authority.
fn server_config(ca: &Authority) -> Result<rustls::ServerConfig> {
    use rcgen::{
        date_time_ymd, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose,
        KeyPair, KeyUsagePurpose,
    };
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

    let ca_key =
        KeyPair::from_pem(&ca.key_pem).map_err(|error| format!("本地证书不可用：{error}"))?;
    let ca_params = CertificateParams::from_ca_cert_pem(&ca.cert_pem)
        .map_err(|error| format!("本地证书不可用：{error}"))?;
    let ca_cert = ca_params
        .self_signed(&ca_key)
        .map_err(|error| format!("本地证书不可用：{error}"))?;

    let leaf_key = KeyPair::generate().map_err(|error| format!("无法生成站点证书：{error}"))?;
    let mut params = CertificateParams::new(vec![TARGET_HOST.to_string()])
        .map_err(|error| format!("无法生成站点证书：{error}"))?;
    params.distinguished_name = DistinguishedName::new();
    params
        .distinguished_name
        .push(DnType::CommonName, TARGET_HOST);
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    // Lets Windows match the leaf to the trusted root without guessing.
    params.use_authority_key_identifier_extension = true;
    params.not_before = date_time_ymd(2024, 1, 1);
    params.not_after = date_time_ymd(2039, 1, 1);
    let leaf = params
        .signed_by(&leaf_key, &ca_cert, &ca_key)
        .map_err(|error| format!("无法签发站点证书：{error}"))?;

    let chain = vec![CertificateDer::from(leaf.der().to_vec())];
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));
    // Pick the provider explicitly: the process default may be ambiguous when
    // another dependency enables a second crypto backend.
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("站点证书不可用：{error}"))?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(|error| format!("站点证书不可用：{error}"))?;
    // No ALPN: the client then falls back to HTTP/1.1, which this proxy speaks.
    config.alpn_protocols.clear();
    Ok(config)
}

fn install_authority(cert_path: &Path) -> Result<()> {
    let output = hidden("certutil")
        .args(["-user", "-addstore", "-f", "Root"])
        .arg(cert_path)
        .output()
        .map_err(|error| format!("无法安装本地证书：{error}"))?;
    if !output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout);
        let detail = text.lines().last().unwrap_or("").trim().to_string();
        return Err(format!(
            "无法把本地证书加入当前用户的受信任根存储；{detail}。可手动导入 {}",
            cert_path.display()
        ));
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::write(path, bytes).map_err(|error| format!("无法写入 {}：{error}", path.display()))
}

// ---------------------------------------------------------------------------
// proxy server
// ---------------------------------------------------------------------------

fn serve(
    listener: TcpListener,
    stop: Arc<AtomicBool>,
    config: Arc<rustls::ServerConfig>,
    upstream: Option<String>,
) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                // Accepted sockets inherit the listener's non-blocking mode on
                // Windows; every connection is handled with blocking reads.
                let _ = stream.set_nonblocking(false);
                let config = config.clone();
                let upstream = upstream.clone();
                let _ = thread::Builder::new()
                    .name("codex-i18n-conn".into())
                    .spawn(move || {
                        let _ = handle(stream, &config, upstream.as_deref());
                    });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(40));
            }
            Err(_) => thread::sleep(Duration::from_millis(120)),
        }
    }
    // Dropping the listener releases the port.
    drop(listener);
}

fn handle(
    mut client: TcpStream,
    config: &rustls::ServerConfig,
    upstream: Option<&str>,
) -> Result<()> {
    let _ = client.set_read_timeout(Some(Duration::from_secs(15)));
    let mut head = Vec::new();
    if !read_head(&mut client, &mut head)? {
        return Ok(());
    }
    let request = String::from_utf8_lossy(&head).to_string();
    let line = request.lines().next().unwrap_or("");
    if let Some(rest) = line.strip_prefix("CONNECT ") {
        let target = rest.split_whitespace().next().unwrap_or("").to_string();
        let host = target
            .rsplit_once(':')
            .map(|(host, _)| host)
            .unwrap_or(target.as_str())
            .trim_matches(['[', ']'])
            .to_ascii_lowercase();
        if host == TARGET_HOST {
            let split = head_end(&head).unwrap_or(head.len());
            let leftover = head.split_off(split);
            client
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .map_err(|error| error.to_string())?;
            let _ = client.flush();
            return intercept(client, leftover, config);
        }
        return tunnel(client, &target, upstream, b"");
    }
    // Plain HTTP: only the Statsig host is answered locally.
    plain(client, &head, upstream)
}

/// Read bytes until the end of the request head.
fn read_head<S: Read>(stream: &mut S, buffer: &mut Vec<u8>) -> Result<bool> {
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => return Ok(head_end(buffer).is_some()),
            Ok(count) => {
                buffer.extend_from_slice(&chunk[..count]);
                if head_end(buffer).is_some() {
                    return Ok(true);
                }
                if buffer.len() > 64 * 1024 {
                    return Err("请求头过大".into());
                }
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                return Ok(false)
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

/// Position just past the `CRLFCRLF` that ends a request head.
///
/// One read can deliver the head and the first body bytes together, so the
/// terminator has to be searched instead of compared with the buffer's end.
fn head_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

/// A stream that replays bytes read together with the previous message.
///
/// The request body can arrive in the same read as the head, and a client may
/// pipeline its TLS handshake right after `CONNECT`; replaying keeps both.
struct PrefixedStream {
    prefix: Vec<u8>,
    stream: TcpStream,
}

impl Read for PrefixedStream {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if !self.prefix.is_empty() {
            let count = self.prefix.len().min(buffer.len());
            buffer[..count].copy_from_slice(&self.prefix[..count]);
            self.prefix.drain(..count);
            return Ok(count);
        }
        self.stream.read(buffer)
    }
}

impl Write for PrefixedStream {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.stream.write(buffer)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

/// Terminate TLS for the Statsig host and answer its evaluation request.
fn intercept(client: TcpStream, leftover: Vec<u8>, config: &rustls::ServerConfig) -> Result<()> {
    let connection = rustls::ServerConnection::new(Arc::new(config.clone()))
        .map_err(|error| format!("无法建立本地 TLS：{error}"))?;
    let mut tls = rustls::StreamOwned::new(
        connection,
        PrefixedStream {
            prefix: leftover,
            stream: client,
        },
    );

    let mut buffer = Vec::new();
    if !read_head(&mut tls, &mut buffer)? {
        return Ok(());
    }
    let split = head_end(&buffer).unwrap_or(buffer.len());
    let body_seen = buffer.len() - split;
    let request = String::from_utf8_lossy(&buffer[..split]).to_string();
    let mut parts = request.lines().next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let path = parts.next().unwrap_or("/");
    let clean = path.split('?').next().unwrap_or(path).trim_end_matches('/');

    if clean == "/v1/sdk_exception" {
        // Error reports from the SDK are noise while offline.
        respond(&mut tls, "204 No Content", "", "")?;
        return Ok(());
    }
    if clean != "/v1/initialize" && clean != "/v1/initialize/ip" {
        respond(&mut tls, "404 Not Found", "application/json", "{}")?;
        return Ok(());
    }
    if method.eq_ignore_ascii_case("POST") {
        let length = content_length(&request).unwrap_or(0).min(2 * 1024 * 1024);
        if length > body_seen {
            let mut body = vec![0u8; length - body_seen];
            let _ = tls.read_exact(&mut body);
        }
    }
    respond(
        &mut tls,
        "200 OK",
        "application/json",
        &evaluation_payload(),
    )
}

fn content_length(head: &str) -> Option<usize> {
    head.lines()
        .find(|line| line.to_ascii_lowercase().starts_with("content-length:"))
        .and_then(|line| line.split(':').nth(1))
        .and_then(|value| value.trim().parse().ok())
}

fn respond<S: Write>(stream: &mut S, status: &str, content_type: &str, body: &str) -> Result<()> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n",
        body.len()
    );
    if !content_type.is_empty() {
        response.push_str(&format!("Content-Type: {content_type}\r\n"));
    }
    response.push_str("\r\n");
    response.push_str(body);
    stream
        .write_all(response.as_bytes())
        .map_err(|error| error.to_string())?;
    let _ = stream.flush();
    Ok(())
}

/// A minimal but valid `init-v1` evaluation response carrying the i18n layer.
fn evaluation_payload() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    format!(
        concat!(
            r#"{{"has_updates":true,"time":{now},"feature_gates":{{}},"#,
            r#""dynamic_configs":{{}},"layer_configs":{{"{layer}":{{"#,
            r#""name":"{layer}","rule_id":"default","id_type":"userID","#,
            r#""group_name":"default","value":{{"enable_i18n":true,"locale_source":"IDE"}},"#,
            r#""explicit_parameters":["enable_i18n","locale_source"],"#,
            r#""is_user_in_experiment":false}}}},"param_stores":{{}},"sdk_flags":{{}},"#,
            r#""response_format":"init-v1"}}"#
        ),
        layer = LAYER_KEY,
        now = now
    )
}

/// Forward an opaque CONNECT tunnel, optionally through the previous proxy.
fn tunnel(
    mut client: TcpStream,
    target: &str,
    upstream: Option<&str>,
    preamble: &[u8],
) -> Result<()> {
    let mut server = match upstream {
        Some(proxy) => connect_via(proxy, target)?,
        None => {
            TcpStream::connect(target).map_err(|error| format!("连接 {target} 失败：{error}"))?
        }
    };
    client
        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
        .map_err(|error| error.to_string())?;
    if !preamble.is_empty() {
        server
            .write_all(preamble)
            .map_err(|error| error.to_string())?;
    }
    let _ = client.set_read_timeout(None);
    let _ = client.set_write_timeout(None);
    let _ = server.set_read_timeout(None);
    let _ = server.set_write_timeout(None);
    relay(client, server)
}

/// Open a tunnel through an HTTP proxy by replaying our CONNECT request.
fn connect_via(proxy: &str, target: &str) -> Result<TcpStream> {
    let address = proxy
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/');
    let mut server = TcpStream::connect(address)
        .map_err(|error| format!("连接上游代理 {address} 失败：{error}"))?;
    let _ = server.set_read_timeout(Some(Duration::from_secs(15)));
    let request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n");
    server
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut head = Vec::new();
    if !read_head(&mut server, &mut head)? || !head.starts_with(b"HTTP/1.1 2") {
        return Err(format!("上游代理 {address} 拒绝了到 {target} 的连接"));
    }
    Ok(server)
}

/// Answer plain HTTP requests to the Statsig host; forward everything else.
fn plain(mut client: TcpStream, head: &[u8], upstream: Option<&str>) -> Result<()> {
    let request = String::from_utf8_lossy(head).to_string();
    let host = request
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with("host:"))
        .and_then(|line| line.split(':').nth(1))
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if host == TARGET_HOST {
        return respond(
            &mut client,
            "200 OK",
            "application/json",
            &evaluation_payload(),
        );
    }
    let target = if host.contains(':') {
        host.clone()
    } else {
        format!("{host}:80")
    };
    if host.is_empty() {
        return respond(&mut client, "400 Bad Request", "text/plain", "");
    }
    let server = match upstream {
        Some(proxy) => {
            let mut server = TcpStream::connect(proxy.trim_start_matches("http://"))
                .map_err(|error| format!("连接上游代理失败：{error}"))?;
            let _ = server.write_all(head);
            server
        }
        None => {
            let mut server = TcpStream::connect(&target)
                .map_err(|error| format!("连接 {target} 失败：{error}"))?;
            let _ = server.write_all(head);
            server
        }
    };
    let _ = client.set_read_timeout(None);
    let _ = server.set_read_timeout(None);
    relay(client, server)
}

fn relay(client: TcpStream, server: TcpStream) -> Result<()> {
    let mut upstream_reader = match server.try_clone() {
        Ok(clone) => clone,
        Err(error) => return Err(error.to_string()),
    };
    let mut client_writer = match client.try_clone() {
        Ok(clone) => clone,
        Err(error) => return Err(error.to_string()),
    };
    let forward = thread::spawn(move || {
        let mut client = client;
        let mut server = server;
        let _ = std::io::copy(&mut client, &mut server);
        let _ = server.shutdown(std::net::Shutdown::Write);
    });
    let client_reader = client_writer
        .try_clone()
        .map_err(|error| error.to_string())?;
    let _ = std::io::copy(&mut upstream_reader, &mut client_writer);
    let _ = client_reader.shutdown(std::net::Shutdown::Write);
    let _ = forward.join();
    Ok(())
}

// ---------------------------------------------------------------------------
// Codex config: [desktop] localeOverride
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SavedLocale {
    path: PathBuf,
    /// Value before the override was written; `None` means the key was absent.
    previous: Option<String>,
    /// Whether the `[desktop]` table itself had to be created.
    created_table: bool,
    /// Whether config.toml did not exist before we wrote it.
    #[serde(default)]
    created_file: bool,
    applied: String,
}

/// Codex's config directory, resolved the same way the Codex workspace does.
fn config_path() -> Option<PathBuf> {
    let root = std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(crate::platform::home_variable())
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".codex"))
        })?;
    Some(root.join("config.toml"))
}

fn parse_document(bytes: Option<&[u8]>) -> Result<DocumentMut> {
    let text = match bytes {
        Some(bytes) => std::str::from_utf8(bytes).map_err(|_| "config.toml 不是 UTF-8 文件")?,
        None => "",
    };
    if text.trim().is_empty() {
        return Ok(DocumentMut::new());
    }
    text.trim_start_matches('\u{feff}')
        .parse()
        .map_err(|_| "config.toml 格式无效，请先在 Codex 页修复后重试".to_string())
}

fn read_document(path: &Path) -> Result<DocumentMut> {
    match fs::read(path) {
        Ok(bytes) => parse_document(Some(&bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DocumentMut::new()),
        Err(error) => Err(format!("无法读取 config.toml：{error}")),
    }
}

fn locale_in(doc: &DocumentMut) -> Option<String> {
    doc.get("desktop")
        .and_then(Item::as_table_like)
        .and_then(|table| table.get(LOCALE_KEY))
        .and_then(Item::as_str)
        .map(str::to_string)
}

fn write_document(path: &Path, doc: &DocumentMut) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建 Codex 配置目录：{error}"))?;
    }
    fs::write(path, doc.to_string()).map_err(|error| format!("无法写入 config.toml：{error}"))
}

fn desktop_table(doc: &mut DocumentMut) -> Result<&mut dyn TableLike> {
    if !doc.contains_key("desktop") {
        doc.insert("desktop", Item::Table(Table::new()));
    }
    doc.get_mut("desktop")
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| "config.toml 的 desktop 不是表，无法写入 localeOverride".to_string())
}

fn read_saved_locale(path: &Path) -> Option<SavedLocale> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

/// Current override value, for the status card. Unreadable configs show empty.
fn current_locale() -> String {
    config_path()
        .and_then(|path| read_document(&path).ok())
        .and_then(|doc| locale_in(&doc))
        .unwrap_or_default()
}

/// Point Codex at the Chinese bundle, remembering what to restore later.
fn apply_locale(dir: &Path) -> Result<()> {
    let path = config_path().ok_or("无法定位 Codex 配置目录，请检查 CODEX_HOME 或用户目录")?;
    apply_locale_at(&path, dir)
}

fn apply_locale_at(path: &Path, dir: &Path) -> Result<()> {
    let mut doc = read_document(path)?;
    let state_path = dir.join(LOCALE_STATE);

    // Keep the first remembered value: a second enable (or a status refresh)
    // must not record our own override as the previous setting.
    let known = read_saved_locale(&state_path).is_some_and(|saved| saved.path == path);
    if !known {
        let saved = SavedLocale {
            path: path.to_path_buf(),
            previous: locale_in(&doc),
            created_table: doc.get("desktop").is_none(),
            created_file: !path.is_file(),
            applied: LOCALE_VALUE.to_string(),
        };
        let bytes = serde_json::to_vec_pretty(&saved)
            .map_err(|error| format!("无法保存语言设置：{error}"))?;
        fs::write(&state_path, bytes).map_err(|error| format!("无法保存语言设置：{error}"))?;
    }

    let table = desktop_table(&mut doc)?;
    if table.get(LOCALE_KEY).and_then(Item::as_str) == Some(LOCALE_VALUE) {
        return Ok(());
    }
    table.insert(LOCALE_KEY, value(LOCALE_VALUE));
    write_document(path, &doc)?;
    crate::logging::event(
        "info",
        "codex-i18n",
        format!("已把 Codex 语言设为 {LOCALE_VALUE}：{}", path.display()),
    );
    Ok(())
}

/// Undo the override, leaving any value the user set by hand afterwards.
fn restore_locale(dir: &Path) {
    let state_path = dir.join(LOCALE_STATE);
    let Some(saved) = read_saved_locale(&state_path) else {
        return;
    };
    let result = (|| -> Result<()> {
        let mut doc = read_document(&saved.path)?;
        let emptied = {
            let Some(table) = doc.get_mut("desktop").and_then(Item::as_table_like_mut) else {
                return Ok(());
            };
            if table.get(LOCALE_KEY).and_then(Item::as_str) != Some(saved.applied.as_str()) {
                return Ok(());
            }
            match &saved.previous {
                Some(previous) => {
                    table.insert(LOCALE_KEY, value(previous.as_str()));
                }
                None => {
                    table.remove(LOCALE_KEY);
                }
            }
            saved.created_table && table.is_empty()
        };
        if emptied {
            doc.remove("desktop");
        }
        // Do not leave an empty config.toml where Codex had none.
        if saved.created_file && doc.to_string().trim().is_empty() {
            fs::remove_file(&saved.path)
                .map_err(|error| format!("无法删除 config.toml：{error}"))?;
            return Ok(());
        }
        write_document(&saved.path, &doc)?;
        Ok(())
    })();
    let _ = fs::remove_file(&state_path);
    match result {
        Ok(()) => crate::logging::event("info", "codex-i18n", "Codex 语言设置已还原"),
        Err(error) => crate::logging::event(
            "warn",
            "codex-i18n",
            format!("无法还原 Codex 语言设置：{error}"),
        ),
    }
}

// ---------------------------------------------------------------------------
// Windows system proxy
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SavedProxy {
    enable: u32,
    server: String,
    r#override: String,
    port: u16,
    /// A PAC script would take precedence over `ProxyServer`; it is removed
    /// while the proxy is active and restored afterwards.
    #[serde(default)]
    auto_config: String,
}

fn read_saved(path: &Path) -> Option<SavedProxy> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn take_over_proxy(dir: &Path, port: u16, saved: Option<&SavedProxy>) -> Result<()> {
    let state_path = dir.join(PROXY_STATE);
    let mut saved = saved.cloned().unwrap_or_else(|| SavedProxy {
        enable: if proxy_enabled() { 1 } else { 0 },
        server: proxy_server(),
        r#override: proxy_override(),
        port,
        auto_config: reg_query("AutoConfigURL").unwrap_or_default(),
    });
    // Remember the port that is actually being served: a later restore uses it
    // to tell our own takeover apart from a proxy the user configured.
    if saved.port != port {
        saved.port = port;
        let bytes = serde_json::to_vec_pretty(&saved).map_err(|error| error.to_string())?;
        fs::write(&state_path, bytes).map_err(|error| format!("无法保存代理设置：{error}"))?;
    } else if !state_path.is_file() {
        let bytes = serde_json::to_vec_pretty(&saved).map_err(|error| error.to_string())?;
        fs::write(&state_path, bytes).map_err(|error| format!("无法保存代理设置：{error}"))?;
    }
    if reg_query("AutoConfigURL").is_some() {
        let _ = hidden("reg")
            .args(["delete", INTERNET_SETTINGS, "/v", "AutoConfigURL", "/f"])
            .status();
    }
    set_string("ProxyServer", &format!("127.0.0.1:{port}"))?;
    if proxy_override().trim().is_empty() {
        set_string("ProxyOverride", "<local>")?;
    }
    set_dword("ProxyEnable", 1)?;
    Ok(())
}

fn restore_proxy(state_path: &Path) -> Result<()> {
    let saved = read_saved(state_path).ok_or("代理状态文件已损坏，已恢复为不使用代理")?;
    // Only undo the takeover while the machine still points at the proxy we
    // installed. If the user or another tool changed the setting in the
    // meantime, writing back the pre-takeover snapshot would silently disable
    // a proxy that is in active use, so their choice wins.
    let ours = format!("127.0.0.1:{}", saved.port);
    let current = proxy_server();
    if !current.trim().eq_ignore_ascii_case(&ours) {
        let _ = fs::remove_file(state_path);
        crate::logging::event(
            "info",
            "codex-i18n",
            format!(
                "系统代理已改为 {}，不是本次接管的设置，保留当前代理",
                if current.trim().is_empty() {
                    "（无）"
                } else {
                    current.trim()
                }
            ),
        );
        return Ok(());
    }
    let mut enable = saved.enable;
    if enable != 0 && !proxy_reachable(&saved.server) {
        // The proxy that was configured before the takeover is gone; restoring
        // it would leave the machine without a working connection.
        enable = 0;
        crate::logging::event(
            "warn",
            "codex-i18n",
            format!("原系统代理 {} 已不可用，保持不使用代理", saved.server),
        );
    }
    set_dword("ProxyEnable", enable)?;
    set_string("ProxyServer", &saved.server)?;
    set_string("ProxyOverride", &saved.r#override)?;
    if !saved.auto_config.trim().is_empty() {
        set_string("AutoConfigURL", &saved.auto_config)?;
    }
    let _ = fs::remove_file(state_path);
    crate::logging::event(
        "info",
        "codex-i18n",
        format!(
            "系统代理已还原：ProxyEnable={}，ProxyServer={}",
            enable, saved.server
        ),
    );
    Ok(())
}

/// Whether a saved proxy still accepts connections. Remote proxies are trusted:
/// they may only be reachable from another network, and a local probe must not
/// turn them off.
fn proxy_reachable(server: &str) -> bool {
    let entry = server.split(';').find(|entry| !entry.trim().is_empty());
    let Some(entry) = entry else {
        return false;
    };
    let value = entry.rsplit_once('=').map(|(_, value)| value).unwrap_or(entry);
    let Some((host, port)) = value.trim().rsplit_once(':') else {
        return false;
    };
    let Ok(port) = port.trim().parse::<u16>() else {
        return false;
    };
    let host = host.trim().trim_matches(['[', ']']);
    if !(host.eq_ignore_ascii_case("127.0.0.1") || host.eq_ignore_ascii_case("localhost")) {
        return true;
    }
    let Ok(address) = format!("127.0.0.1:{port}").parse() else {
        return false;
    };
    TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok()
}

fn proxy_enabled() -> bool {
    reg_query("ProxyEnable")
        .map(|value| {
            let value = value.trim();
            match value
                .strip_prefix("0x")
                .or_else(|| value.strip_prefix("0X"))
            {
                Some(hex) => u32::from_str_radix(hex, 16).unwrap_or(0) != 0,
                None => value.parse::<u32>().unwrap_or(0) != 0,
            }
        })
        .unwrap_or(false)
}

fn proxy_server() -> String {
    reg_query("ProxyServer").unwrap_or_default()
}

fn proxy_override() -> String {
    reg_query("ProxyOverride").unwrap_or_default()
}

/// The proxy that was configured and in use before we took over, if any.
fn existing_upstream() -> Option<String> {
    // A disabled proxy is not in use, so chaining through it could break every
    // other connection; the proxy is only reused while it is actually active.
    if !proxy_enabled() {
        return None;
    }
    let server = proxy_server();
    if server.trim().is_empty() || server.contains("127.0.0.1:94") {
        return None;
    }
    // "http=host:port;https=host:port" is also accepted.
    let entry = server
        .split(';')
        .find_map(|part| {
            let (scheme, address) = part.split_once('=')?;
            scheme
                .eq_ignore_ascii_case("https")
                .then(|| address.to_string())
        })
        .unwrap_or_else(|| server.split(';').next().unwrap_or("").to_string());
    let address = entry
        .split('=')
        .next_back()
        .unwrap_or("")
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_string();
    if address.is_empty() || !address.contains(':') {
        None
    } else {
        Some(address)
    }
}

fn reg_query(name: &str) -> Option<String> {
    let output = hidden("reg")
        .args(["query", INTERNET_SETTINGS, "/v", name])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        if parts.next() != Some(name) {
            continue;
        }
        // Skip the value type (REG_SZ / REG_DWORD).
        parts.next()?;
        let rest = parts.collect::<Vec<_>>().join(" ");
        return Some(rest);
    }
    None
}

fn set_dword(name: &str, value: u32) -> Result<()> {
    let status = hidden("reg")
        .args([
            "add",
            INTERNET_SETTINGS,
            "/v",
            name,
            "/t",
            "REG_DWORD",
            "/d",
            &value.to_string(),
            "/f",
        ])
        .status()
        .map_err(|error| format!("无法写入代理设置：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("无法写入代理设置 {name}"))
    }
}

fn set_string(name: &str, value: &str) -> Result<()> {
    let status = hidden("reg")
        .args([
            "add",
            INTERNET_SETTINGS,
            "/v",
            name,
            "/t",
            "REG_SZ",
            "/d",
            value,
            "/f",
        ])
        .status()
        .map_err(|error| format!("无法写入代理设置：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("无法写入代理设置 {name}"))
    }
}

fn notify_proxy_changed() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Networking::WinInet::{
            InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
        };
        // Chromium watches the registry, but WinINet clients need the hint.
        unsafe {
            InternetSetOptionW(
                std::ptr::null_mut(),
                INTERNET_OPTION_SETTINGS_CHANGED,
                std::ptr::null_mut(),
                0,
            );
            InternetSetOptionW(
                std::ptr::null_mut(),
                INTERNET_OPTION_REFRESH,
                std::ptr::null_mut(),
                0,
            );
        }
    }
}

fn hidden(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

// ---------------------------------------------------------------------------
// Codex Desktop process
// ---------------------------------------------------------------------------

/// Locate the installed Codex desktop package and report whether it runs.
///
/// Only processes started from the package directory count: the CLI also
/// ships a `codex.exe`, which must never be mistaken for the desktop app.
fn codex_process() -> Result<(bool, bool)> {
    let script = concat!(
        "$ErrorActionPreference='Stop';",
        "$pkg=Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1;",
        "if (-not $pkg) { 'none'; exit 0 };",
        "$root=$pkg.InstallLocation;",
        "$p=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { ",
        "$_.Path -and $_.Path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) });",
        "if ($p.Count -gt 0) { 'found running' } else { 'found stopped' }"
    );
    let output = hidden("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|error| format!("无法检查 Codex 进程：{error}"))?;
    if !output.status.success() {
        return Err("无法检查 Codex 进程".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim();
    Ok((text.starts_with("found"), text.contains("running")))
}

fn restart_codex() -> Result<()> {
    let script = concat!(
        "$ErrorActionPreference='Stop';",
        "$pkg=Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1;",
        "if (-not $pkg) { throw '未找到 Codex 桌面版（OpenAI.Codex）' };",
        "$root=$pkg.InstallLocation;",
        "Get-Process -ErrorAction SilentlyContinue | Where-Object { ",
        "$_.Path -and $_.Path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) } | ",
        "Stop-Process -Force -ErrorAction SilentlyContinue;",
        "Start-Sleep -Milliseconds 1200;",
        "Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\\' + ",
        "$pkg.PackageFamilyName + '!App');",
        "'restarted'"
    );
    let output = hidden("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|error| format!("无法重启 Codex：{error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "无法重启 Codex：{}",
            detail.trim().lines().last().unwrap_or("未知错误")
        ));
    }
    crate::logging::event("info", "codex-i18n", "已重启 Codex 桌面版");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    fn locale_fixture(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "cyapi-locale-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        let data = root.join("data");
        let config = root.join("config.toml");
        fs::create_dir_all(&data).unwrap();
        (root, data, config)
    }

    #[test]
    fn the_locale_override_keeps_comments_and_other_keys() {
        let (root, data, config) = locale_fixture("keep");
        fs::write(
            &config,
            "# header stays\nmodel = \"gpt-5\"\n\n[desktop]\nlocaleOverride = \"en-US\"\nlocaleSource = \"system\"\n",
        )
        .unwrap();
        apply_locale_at(&config, &data).unwrap();
        let text = fs::read_to_string(&config).unwrap();
        assert!(text.contains("# header stays"));
        assert!(text.contains("localeOverride = \"zh-CN\""));
        assert!(text.contains("localeSource = \"system\""));
        assert!(!text.contains("en-US"));
        restore_locale(&data);
        let text = fs::read_to_string(&config).unwrap();
        assert!(text.contains("# header stays"));
        assert!(text.contains("localeOverride = \"en-US\""));
        assert!(text.contains("localeSource = \"system\""));
        assert!(!data.join(LOCALE_STATE).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_added_desktop_table_is_removed_again() {
        let (root, data, config) = locale_fixture("create");
        fs::write(&config, "model = \"gpt-5\"\n").unwrap();
        apply_locale_at(&config, &data).unwrap();
        let text = fs::read_to_string(&config).unwrap();
        assert!(text.contains("[desktop]"));
        assert!(text.contains("localeOverride = \"zh-CN\""));
        restore_locale(&data);
        assert_eq!(fs::read_to_string(&config).unwrap(), "model = \"gpt-5\"\n");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_config_file_created_for_the_override_is_removed_again() {
        let (root, data, config) = locale_fixture("missing");
        assert!(!config.exists());
        apply_locale_at(&config, &data).unwrap();
        assert!(fs::read_to_string(&config)
            .unwrap()
            .contains("localeOverride = \"zh-CN\""));
        restore_locale(&data);
        assert!(!config.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_manual_locale_change_after_enabling_is_kept() {
        let (root, data, config) = locale_fixture("manual");
        fs::write(&config, "[desktop]\nlocaleOverride = \"zh-CN\"\n").unwrap();
        apply_locale_at(&config, &data).unwrap();
        fs::write(&config, "[desktop]\nlocaleOverride = \"ja-JP\"\n").unwrap();
        restore_locale(&data);
        assert!(fs::read_to_string(&config)
            .unwrap()
            .contains("localeOverride = \"ja-JP\""));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_invalid_config_is_reported_not_overwritten() {
        let (root, data, config) = locale_fixture("invalid");
        fs::write(&config, "key = \"unterminated\n").unwrap();
        let error = apply_locale_at(&config, &data).unwrap_err();
        assert!(error.contains("config.toml 格式无效"));
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            "key = \"unterminated\n"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_payload_carries_the_i18n_layer() {
        let payload = evaluation_payload();
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(value["has_updates"], true);
        assert_eq!(
            value["layer_configs"]["72216192"]["value"]["enable_i18n"],
            true
        );
        assert!(value["time"].as_u64().unwrap() > 0);
    }

    #[test]
    fn the_head_end_is_found_before_a_request_body() {
        assert_eq!(head_end(b"GET / HTTP/1.1\r\n\r\n"), Some(18));
        assert_eq!(head_end(b"POST / HTTP/1.1\r\n\r\n{}"), Some(19));
        assert_eq!(head_end(b"GET / HTTP/1.1\r\n"), None);
        assert_eq!(head_end(b"GET / HTTP/1.1\r\n\r"), None);
    }

    #[test]
    fn the_content_length_is_read_case_insensitively() {
        let head = "POST /v1/initialize HTTP/1.1\r\nHost: x\r\nContent-Length: 42\r\n\r\n";
        assert_eq!(content_length(head), Some(42));
        assert_eq!(content_length("GET / HTTP/1.1\r\n\r\n"), None);
    }

    #[test]
    fn the_previous_proxy_is_reused_as_upstream() {
        // Only host:port strings are accepted; anything else falls back to a
        // direct connection.
        assert_eq!(
            existing_upstream_for("http://127.0.0.1:9408"),
            Some("127.0.0.1:9408".to_string())
        );
        assert_eq!(existing_upstream_for(""), None);
    }

    fn existing_upstream_for(server: &str) -> Option<String> {
        let entry = server
            .split(';')
            .find_map(|part| {
                let (scheme, address) = part.split_once('=')?;
                scheme
                    .eq_ignore_ascii_case("https")
                    .then(|| address.to_string())
            })
            .unwrap_or_else(|| server.split(';').next().unwrap_or("").to_string());
        let address = entry
            .split('=')
            .next_back()
            .unwrap_or("")
            .trim()
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .to_string();
        if address.is_empty() || !address.contains(':') {
            None
        } else {
            Some(address)
        }
    }

    /// The whole path Codex uses: CONNECT through our proxy, TLS terminated
    /// with a certificate signed by the generated authority, and a Statsig
    /// payload that enables the localised UI.
    #[test]
    fn the_proxy_answers_the_statsig_request_over_tls() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let (cert_pem, key_pem) = generate_authority().unwrap();
        let ca = Authority { cert_pem, key_pem };
        let config = Arc::new(server_config(&ca).unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        thread::spawn(move || serve(listener, flag, config, None));

        let client = reqwest::blocking::Client::builder()
            .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).unwrap())
            .add_root_certificate(reqwest::Certificate::from_pem(ca.cert_pem.as_bytes()).unwrap())
            .build()
            .unwrap();
        let response = client
            .post("https://ab.chatgpt.com/v1/initialize?k=test")
            .body("{}")
            .send()
            .unwrap();
        assert!(response.status().is_success());
        let text = response.text().unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            value["layer_configs"]["72216192"]["value"]["enable_i18n"],
            true
        );
        stop.store(true, Ordering::SeqCst);
    }

    /// Exercises the real takeover: the certificate is trusted for the current
    /// user, the registry is pointed at the listener and restored afterwards.
    /// Ignored by default because it changes the machine's system proxy.
    #[test]
    #[ignore = "changes the current user's system proxy"]
    fn the_system_proxy_round_trip_restores_the_previous_setting() {
        let dir = std::env::temp_dir().join(format!("cyapi-codex-i18n-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let before_enable = proxy_enabled();
        let before_server = proxy_server();
        let started = start(&dir).unwrap();
        assert!(started.running);
        assert!(started.ca_trusted);
        assert!(started.captures);
        assert!(started.port.is_some());
        let stopped = stop(&dir).unwrap();
        assert!(!stopped.running);
        assert_eq!(proxy_enabled(), before_enable);
        assert_eq!(proxy_server(), before_server);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Full browser path: system proxy, generated certificate and TLS
    /// interception, checked with a throw-away Edge profile. Ignored by
    /// default because it changes the system proxy and starts a browser.
    #[test]
    #[ignore = "changes the current user's system proxy and launches Edge"]
    fn edge_reaches_the_statsig_endpoint_through_the_system_proxy() {
        let edge = Path::new(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe");
        if !edge.is_file() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("cyapi-i18n-edge-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        start(&dir).unwrap();
        // Chromium detaches from an inherited pipe, so the DOM is written to a
        // real file handle instead of stdout.
        let dom_path = dir.join("dom.html");
        let dom = fs::File::create(&dom_path).unwrap();
        let status = Command::new(edge)
            .args(["--headless=new", "--disable-gpu", "--no-first-run"])
            .arg(format!(
                "--user-data-dir={}",
                dir.join("edge-profile").display()
            ))
            .args(["--dump-dom", "https://ab.chatgpt.com/v1/initialize"])
            .stdout(Stdio::from(dom))
            .status()
            .unwrap();
        let _ = stop(&dir);
        let stdout = fs::read_to_string(&dom_path).unwrap_or_default();
        assert!(
            status.success() && stdout.contains("\"enable_i18n\":true"),
            "edge did not reach the local proxy ({status:?}): {stdout}"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
