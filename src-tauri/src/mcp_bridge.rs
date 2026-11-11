//! Loopback MCP server owned by the desktop client.
//!
//! Agents talk to `http://127.0.0.1:<port>/mcp` with a capability token read
//! from a protected file, so the user's API Key never leaves the running
//! toolbox process. Every platform request goes through the same node
//! selection and tunnel as the desktop pages, and the model never submits a
//! billable run above the budget it declared.
use crate::network::{self, DownloadRequest, HttpRequest};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::Duration,
};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;

const MAX_HEADER: usize = 16 * 1024;
const MAX_BODY: usize = 16 * 1024 * 1024;
/// The hosted upload route accepts a 12 MB JSON body, and base64 inflates an
/// asset by about a third, so the raw file has to stay well below that.
const MAX_IMAGE: u64 = 8 * 1024 * 1024;
const PREFERRED_PORT: u16 = 18733;
const PORT_ATTEMPTS: u16 = 20;
const PROTOCOLS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// Everything the bridge writes stays inside this directory of the app data root.
const ROOT: &str = "CYAPI-Toolbox/mcp";

static SERVER: OnceLock<Arc<Server>> = OnceLock::new();

struct Server {
    root: PathBuf,
    server_url: String,
    token: String,
    port: u16,
    /// Held in memory only; the toolbox never writes the Key a second time.
    key: Mutex<Option<String>>,
}

fn private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建 MCP 目录：{error}"))?;
    }
    fs::write(path, bytes).map_err(|error| format!("无法写入 MCP 运行文件：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// A stable token survives restarts, so an agent configuration written once
/// keeps working. Writing it again is only needed after a manual reset.
fn token_at(root: &Path) -> Result<String> {
    let path = root.join("token");
    match fs::read_to_string(&path) {
        Ok(text) => {
            let token = text.trim().to_string();
            if token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Ok(token);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法读取 MCP 令牌：{error}")),
    }
    let token = format!(
        "{}{}",
        Uuid::new_v4().to_string().replace('-', ""),
        Uuid::new_v4().to_string().replace('-', "")
    );
    private_file(&path, format!("{token}\n").as_bytes())?;
    Ok(token)
}

/// Create the capability token if the app has not written it yet, so the
/// "connect" action still works when the loopback server could not start.
pub fn ensure_token(app_data: &Path) -> Result<String> {
    token_at(&app_data.join(ROOT))
}

fn listen() -> Result<TcpListener> {
    // A fixed port keeps an existing agent configuration valid across restarts.
    for offset in 0..PORT_ATTEMPTS {
        let port = PREFERRED_PORT.saturating_add(offset);
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            return Ok(listener);
        }
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("无法启动 MCP 本机服务：{error}"))?;
    Ok(listener)
}

/// Start the bridge once. Later calls return the port of the running one.
pub fn start(app_data: &Path, server_url: &str) -> Result<u16> {
    if let Some(server) = SERVER.get() {
        return Ok(server.port);
    }
    let root = app_data.join(ROOT);
    let token = token_at(&root)?;
    let listener = listen()?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("MCP 本机服务地址无效：{error}"))?
        .port();
    private_file(&root.join("port"), format!("{port}\n").as_bytes())?;
    let server = Arc::new(Server {
        root,
        server_url: server_url.to_string(),
        token,
        port,
        key: Mutex::new(None),
    });
    if SERVER.set(server.clone()).is_err() {
        return Ok(SERVER.get().map(|server| server.port).unwrap_or(port));
    }
    thread::Builder::new()
        .name("cyapi-mcp".into())
        .spawn(move || accept(listener, server))
        .map_err(|error| format!("无法启动 MCP 线程：{error}"))?;
    crate::logging::event("info", "mcp", format!("MCP 本机服务已就绪（端口 {port}）"));
    Ok(port)
}

/// The frontend pushes the Key it already holds. `None` clears it when the
/// workbench is locked or the Key is removed.
pub fn set_key(key: Option<String>) {
    let Some(server) = SERVER.get() else {
        return;
    };
    if let Some(value) = key.as_deref().filter(|value| !value.is_empty()) {
        crate::logging::register_secret(value);
    }
    if let Ok(mut current) = server.key.lock() {
        *current = key;
    }
}

/// Fill the fields the sidebar reports, without exposing the token or the Key.
pub fn status() -> Value {
    match SERVER.get() {
        Some(server) => {
            let has_key = server
                .key
                .lock()
                .map(|key| key.is_some())
                .unwrap_or(false);
            json!({"running":true,"port":server.port,"hasKey":has_key,"endpoint":format!("http://127.0.0.1:{}/mcp",server.port)})
        }
        None => json!({"running":false,"port":null,"hasKey":false,"endpoint":null}),
    }
}

fn accept(listener: TcpListener, server: Arc<Server>) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let server = server.clone();
        // One thread per connection keeps a slow agent from blocking another
        // without pulling an async runtime into an already single-threaded app.
        let _ = thread::Builder::new()
            .name("cyapi-mcp-conn".into())
            .spawn(move || {
                let _ = connection(stream, &server);
            });
    }
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

fn read_request(stream: &mut TcpStream) -> Result<Option<Request>> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut header_end = None;
    while header_end.is_none() {
        let read = stream
            .read(&mut chunk)
            .map_err(|error| format!("无法读取请求：{error}"))?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_HEADER {
            return Err("请求头过大".into());
        }
        header_end = buffer.windows(4).position(|part| part == b"\r\n\r\n");
    }
    let end = header_end.unwrap_or(0);
    let head = String::from_utf8_lossy(&buffer[..end]).to_string();
    let mut lines = head.split("\r\n");
    let mut start = lines.next().unwrap_or("").split_whitespace();
    let method = start.next().unwrap_or("").to_ascii_uppercase();
    let path = start.next().unwrap_or("").to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_string(), value.trim().to_string()))
        })
        .collect();
    let length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    if length > MAX_BODY {
        return Err("请求内容过大".into());
    }
    let chunked = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("transfer-encoding"))
        .is_some_and(|(_, value)| value.to_ascii_lowercase().contains("chunked"));
    let mut body = buffer[end + 4..].to_vec();
    if chunked {
        // Several agent HTTP clients stream JSON with chunked encoding instead
        // of declaring a length; decoding it here keeps those clients working.
        body = read_chunked(stream, body)?;
    } else {
        while body.len() < length {
            let read = stream
                .read(&mut chunk)
                .map_err(|error| format!("无法读取请求：{error}"))?;
            if read == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..read]);
        }
        body.truncate(length);
    }
    Ok(Some(Request {
        method,
        path,
        headers,
        body,
    }))
}

/// Decode a `Transfer-Encoding: chunked` body. `buffer` already holds the bytes
/// read after the header block; more are read only when a chunk is incomplete.
fn read_chunked(stream: &mut TcpStream, mut buffer: Vec<u8>) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    let mut offset = 0;
    loop {
        // Read the chunk-size line, extending the buffer if it is incomplete.
        let line_end = loop {
            if let Some(position) = buffer[offset..]
                .windows(2)
                .position(|part| part == b"\r\n")
            {
                break offset + position;
            }
            let mut chunk = [0u8; 4096];
            let read = stream
                .read(&mut chunk)
                .map_err(|error| format!("无法读取请求：{error}"))?;
            if read == 0 {
                return Err("请求内容不完整".into());
            }
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.len() > MAX_BODY {
                return Err("请求内容过大".into());
            }
        };
        let size = size_line(&buffer[offset..line_end])?;
        offset = line_end + 2;
        // A declared chunk size is attacker-controlled. Reject one larger than
        // the total cap before it can overflow the offset arithmetic or grow
        // the buffer past the limit.
        if size > MAX_BODY - body.len() {
            return Err("请求内容过大".into());
        }
        if size == 0 {
            // Consume the optional trailers up to the final empty line.
            loop {
                let trailer_end = match buffer[offset..].windows(2).position(|part| part == b"\r\n") {
                    Some(position) => offset + position,
                    None => {
                        let mut chunk = [0u8; 4096];
                        let read = stream
                            .read(&mut chunk)
                            .map_err(|error| format!("无法读取请求：{error}"))?;
                        if read == 0 {
                            return Ok(body);
                        }
                        buffer.extend_from_slice(&chunk[..read]);
                        continue;
                    }
                };
                let empty = trailer_end == offset;
                offset = trailer_end + 2;
                if empty {
                    return Ok(body);
                }
            }
        }
        while buffer.len() < offset + size + 2 {
            let mut chunk = [0u8; 4096];
            let read = stream
                .read(&mut chunk)
                .map_err(|error| format!("无法读取请求：{error}"))?;
            if read == 0 {
                return Err("请求内容不完整".into());
            }
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.len() > MAX_BODY {
                return Err("请求内容过大".into());
            }
        }
        body.extend_from_slice(&buffer[offset..offset + size]);
        // Drop the chunk that was just consumed. Without this the buffer keeps
        // every byte of a streaming body and would reject a valid request that
        // happens to be split into many small chunks.
        buffer.drain(..offset + size + 2);
        offset = 0;
    }
}

fn size_line(line: &[u8]) -> Result<usize> {
    // `size;extension` is legal; only the hexadecimal size is used.
    let text = String::from_utf8_lossy(line);
    let digits = text.split(';').next().unwrap_or("").trim();
    usize::from_str_radix(digits, 16).map_err(|_| "请求分块格式无效".to_string())
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    keep_alive: bool,
) -> Result<()> {
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: {}\r\n\r\n",
        if status == 200 { "OK" } else { "Error" },
        body.len(),
        if keep_alive { "keep-alive" } else { "close" },
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(body))
        .and_then(|_| stream.flush())
        .map_err(|error| format!("无法写入响应：{error}"))
}

fn connection(mut stream: TcpStream, server: &Server) -> Result<()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(120)));
    loop {
        let request = match read_request(&mut stream) {
            Ok(Some(request)) => request,
            Ok(None) => return Ok(()),
            Err(message) => {
                // A malformed request still deserves a status line; an agent
                // client that only sees a closed socket reports a network error
                // instead of the actual reason.
                let body = json!({"error": message}).to_string();
                let _ = respond(
                    &mut stream,
                    400,
                    "application/json; charset=utf-8",
                    body.as_bytes(),
                    false,
                );
                return Ok(());
            }
        };
        let close = request
            .header("connection")
            .is_some_and(|value| value.eq_ignore_ascii_case("close"));
        if request.method != "POST" {
            respond(
                &mut stream,
                405,
                "application/json; charset=utf-8",
                br#"{"error":"Use POST for JSON-RPC"}"#,
                false,
            )?;
            return Ok(());
        }
        if request.path.split('?').next() != Some("/mcp") {
            respond(
                &mut stream,
                404,
                "application/json; charset=utf-8",
                br#"{"error":"Not found"}"#,
                false,
            )?;
            return Ok(());
        }
        let authorized = request
            .header("authorization")
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|value| same_token(value.trim(), &server.token));
        if !authorized {
            respond(
                &mut stream,
                401,
                "application/json; charset=utf-8",
                br#"{"error":"Invalid MCP token"}"#,
                false,
            )?;
            return Ok(());
        }
        let message: Value = match serde_json::from_slice(&request.body) {
            Ok(value) => value,
            Err(_) => {
                let body = json!({"jsonrpc":"2.0","id":Value::Null,"error":{"code":-32700,"message":"Parse error"}});
                respond(&mut stream, 200, "application/json; charset=utf-8", body.to_string().as_bytes(), !close)?;
                return Ok(());
            }
        };
        let Some(response) = dispatch(message, server) else {
            // Notifications have no response body.
            respond(&mut stream, 202, "application/json; charset=utf-8", b"", !close)?;
            if close {
                return Ok(());
            }
            continue;
        };
        let sse = request
            .header("accept")
            .is_some_and(|value| value.contains("text/event-stream"));
        let payload = response.to_string();
        let (content_type, body) = if sse {
            ("text/event-stream", format!("event: message\ndata: {payload}\n\n"))
        } else {
            ("application/json; charset=utf-8", payload)
        };
        respond(&mut stream, 200, content_type, body.as_bytes(), !close)?;
        if close {
            return Ok(());
        }
    }
}

fn same_token(provided: &str, expected: &str) -> bool {
    use sha2::{Digest, Sha256};
    let left = Sha256::digest(provided.as_bytes());
    let right = Sha256::digest(expected.as_bytes());
    left == right
}

fn dispatch(message: Value, server: &Server) -> Option<Value> {
    fn error(id: &Value, code: i32, text: &str) -> Option<Value> {
        Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":text}}))
    }
    let incoming = message.get("id").cloned();
    if !message.is_object() || message["jsonrpc"] != "2.0" || !message["method"].is_string() {
        return error(&incoming.unwrap_or(Value::Null), -32600, "Invalid request");
    }
    let method = message["method"].as_str().unwrap_or_default().to_string();
    // A notification is answered by silence, so only requests reach a result.
    let id = incoming?;
    let result = match method.as_str() {
        "initialize" => {
            let Some(version) = message["params"]["protocolVersion"].as_str() else {
                return error(&id, -32602, "Missing protocolVersion");
            };
            let chosen = if PROTOCOLS.contains(&version) {
                version
            } else {
                PROTOCOLS[0]
            };
            json!({
                "protocolVersion": chosen,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "cyapi-toolbox", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "CYAPI 托管工作流。先读 cyapi_account_status 与 cyapi_workflow_list_templates；运行任务前先用 maxCostUsd 声明预算，报价超过预算不会执行。任务异步，用 cyapi_workflow_task 查询状态。"
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => {
            let Some(name) = message["params"]["name"].as_str() else {
                return error(&id, -32602, "Missing tool name");
            };
            let name = name.to_string();
            let empty = json!({});
            let arguments = message["params"].get("arguments").unwrap_or(&empty);
            match call(server, &name, arguments) {
                Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}],"isError":false}),
                Err(text) => json!({"content":[{"type":"text","text":text}],"isError":true}),
            }
        }
        _ => return error(&id, -32601, "Method not found"),
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}

fn schema(kind: &str, description: &str) -> Value {
    json!({ "type": kind, "description": description })
}
fn array(items: Value, description: &str) -> Value {
    json!({ "type": "array", "items": items, "description": description })
}

fn tools() -> Vec<Value> {
    vec![
        json!({
            "name": "cyapi_account_status",
            "description": "读取当前 Key 的额度、余额与用量摘要。",
            "inputSchema": {"type":"object","properties":{},"additionalProperties":false}
        }),
        json!({
            "name": "cyapi_workspace_status",
            "description": "读取当前用户托管的 ComfyUI 工作区状态（是否运行、启动时间、并发容量）。",
            "inputSchema": {"type":"object","properties":{},"additionalProperties":false}
        }),
        json!({
            "name": "cyapi_workspace_start",
            "description": "启动当前用户的工作区。首次启动需要等待容器就绪，通常 20 秒到 3 分钟。",
            "inputSchema": {"type":"object","properties":{},"additionalProperties":false}
        }),
        json!({
            "name": "cyapi_workspace_stop",
            "description": "停止当前用户的工作区。已保存的工作流与产物保留。",
            "inputSchema": {"type":"object","properties":{},"additionalProperties":false}
        }),
        json!({
            "name": "cyapi_workflow_list_templates",
            "description": "列出可运行的工作流模板：ID、标题、分类、transport、需要的素材与可调参数。transport=worker 的模板由托管 ComfyUI 执行完整工作流，素材需先在客户端编辑器中同步；transport=bridge 的模板可直接由本工具运行时传入图片或音频。不返回图数据。",
            "inputSchema": {"type":"object","properties":{
                "category": schema("string","只返回该分类的模板；省略表示全部")
            },"additionalProperties":false}
        }),
        json!({
            "name": "cyapi_workflow_quote",
            "description": "在不执行的情况下预览一次运行的价格。素材会先上传到用户自己的工作区，报价结束后立即清理草稿与素材。",
            "inputSchema": {"type":"object","properties":{
                "templateId": schema("string","工作流模板 ID"),
                "prompt": schema("string","画面或任务描述"),
                "images": array(schema("string","本机图片绝对路径"),"参考图/输入图路径，按模板要求提供（PNG/JPG/WebP，单张不超过 8 MB）"),
                "audio": schema("string","语音类模板的本机 PCM WAV 音频路径（不超过 8 MB）"),
                "params": {"type":"object","description":"模板声明的可选参数，只接受字符串、数字和布尔值","additionalProperties":true}
            },"required":["templateId"],"additionalProperties":false}
        }),
        json!({
            "name": "cyapi_workflow_run",
            "description": "提交一次工作流运行并立即返回任务 ID。报价（含执行费）超过 maxCostUsd 时不执行，只返回报价。任务异步，用 cyapi_workflow_task 轮询。",
            "inputSchema": {"type":"object","properties":{
                "templateId": schema("string","工作流模板 ID"),
                "prompt": schema("string","画面或任务描述"),
                "images": array(schema("string","本机图片绝对路径"),"参考图/输入图路径，按模板要求提供（PNG/JPG/WebP，单张不超过 8 MB）"),
                "audio": schema("string","语音类模板的本机 PCM WAV 音频路径（不超过 8 MB）"),
                "params": {"type":"object","description":"模板声明的可选参数，只接受字符串、数字和布尔值","additionalProperties":true},
                "maxCostUsd": {"type":"number","description":"本次运行允许的最高模型费用（美元，含执行费），必填；报价超出时拒绝执行"}
            },"required":["templateId","maxCostUsd"],"additionalProperties":false}
        }),
        json!({
            "name": "cyapi_workflow_list_tasks",
            "description": "列出最近的运行任务，含状态、费用与产物数量。",
            "inputSchema": {"type":"object","properties":{
                "limit": {"type":"integer","description":"返回条数，1-50，默认 10","minimum":1,"maximum":50}
            },"additionalProperties":false}
        }),
        json!({
            "name": "cyapi_workflow_task",
            "description": "读取单个任务的状态、报价、错误信息与产物列表（含可直接下载的产物 ID）。",
            "inputSchema": {"type":"object","properties":{
                "taskId": schema("string","任务 ID")
            },"required":["taskId"],"additionalProperties":false}
        }),
        json!({
            "name": "cyapi_workflow_cancel",
            "description": "取消排队或运行中的任务。已完成的任务不能取消。",
            "inputSchema": {"type":"object","properties":{
                "taskId": schema("string","任务 ID")
            },"required":["taskId"],"additionalProperties":false}
        }),
        json!({
            "name": "cyapi_workflow_download",
            "description": "把任务产物下载到本机固定目录，返回文件绝对路径。图片、视频、音频按产物类型保存。",
            "inputSchema": {"type":"object","properties":{
                "taskId": schema("string","任务 ID"),
                "outputId": schema("string","cyapi_workflow_task 返回的产物 ID")
            },"required":["taskId","outputId"],"additionalProperties":false}
        }),
    ]
}

fn text_argument<'a>(arguments: &'a Value, name: &str, limit: usize) -> Result<&'a str> {
    let value = arguments
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少 {name}"))?
        .trim();
    if value.is_empty() || value.len() > limit || value.chars().any(char::is_control) {
        return Err(format!("{name} 格式无效"));
    }
    Ok(value)
}

fn current_key(server: &Server) -> Result<String> {
    server
        .key
        .lock()
        .map_err(|_| "MCP 状态不可用".to_string())?
        .clone()
        .ok_or_else(|| {
            "工具箱尚未载入工作流 API Key：请打开 CYAPI 工具箱并在「工作流」页添加 Key".to_string()
        })
}

/// A platform call that failed. `status` is `Some` only when the server itself
/// answered, which is what distinguishes a definite rejection (no task was
/// created) from a transport failure (the outcome is unknown).
struct Failure {
    message: String,
    status: Option<u16>,
}

impl From<Failure> for String {
    fn from(failure: Failure) -> String {
        failure.message
    }
}

fn platform_request(
    server: &Server,
    method: &str,
    path: &str,
    body: Option<Value>,
    timeout_ms: u64,
    key: Option<String>,
) -> std::result::Result<Value, Failure> {
    let response = network::request(
        &server.server_url,
        HttpRequest {
            path: path.to_string(),
            method: method.to_string(),
            key,
            body,
            timeout_ms: Some(timeout_ms),
        },
    )
    .map_err(|message| Failure {
        message,
        status: None,
    })?;
    if response.status >= 400 {
        return Err(Failure {
            message: platform_error(&response.body, response.status, &response.text),
            status: Some(response.status),
        });
    }
    Ok(response.body)
}

fn platform_api(server: &Server, method: &str, path: &str, body: Option<Value>, timeout_ms: u64) -> std::result::Result<Value, Failure> {
    let key = current_key(server).map_err(|message| Failure {
        message,
        status: None,
    })?;
    platform_request(server, method, path, body, timeout_ms, Some(key))
}

/// The published template catalog is public, so listing templates does not
/// need the user's Key.
fn platform_public(server: &Server, method: &str, path: &str, body: Option<Value>, timeout_ms: u64) -> std::result::Result<Value, Failure> {
    platform_request(server, method, path, body, timeout_ms, None)
}

fn platform_error(body: &Value, status: u16, text: &str) -> String {
    if let Some(message) = body.get("error").and_then(|error| {
        error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| error.as_str())
    }) {
        return format!("{message}（HTTP {status}）");
    }
    if let Some(code) = body.get("code").and_then(Value::as_str) {
        if let Some(message) = body.get("error").and_then(Value::as_str) {
            return format!("{message}（{code}）");
        }
    }
    let trimmed: String = text.trim().chars().take(300).collect();
    if trimmed.is_empty() {
        format!("请求失败（HTTP {status}）")
    } else {
        format!("{trimmed}（HTTP {status}）")
    }
}

fn workspace(value: &Value) -> Value {
    let workspace = value.get("workspace").cloned().unwrap_or(Value::Null);
    json!({
        "status": workspace.get("status").cloned().unwrap_or(Value::Null),
        "running": workspace.get("running").cloned().unwrap_or(json!(false)),
        "startedAt": workspace.get("startedAt").cloned().unwrap_or(Value::Null),
        "capacity": value.get("workspaceCapacity").cloned().unwrap_or(Value::Null),
        "backend": value.get("backend").cloned().unwrap_or(Value::Null),
    })
}

fn task_summary(task: &Value) -> Value {
    let outputs = task
        .get("outputs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|output| {
                    json!({
                        "id": output.get("id").cloned().unwrap_or(Value::Null),
                        "kind": output.get("kind").cloned().unwrap_or(Value::Null),
                        "filename": output.get("filename").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({
        "taskId": task.get("id").cloned().unwrap_or(Value::Null),
        "name": task.get("name").cloned().unwrap_or(Value::Null),
        "status": task.get("status").cloned().unwrap_or(Value::Null),
        "message": task.get("message").cloned().unwrap_or(Value::Null),
        "createdAt": task.get("createdAt").cloned().unwrap_or(Value::Null),
        "finishedAt": task.get("finishedAt").cloned().unwrap_or(Value::Null),
        "billing": task.get("billing").cloned().unwrap_or(Value::Null),
        "outputs": outputs,
    })
}

/// Read a local image without expanding the file into memory twice.
fn image_data(path: &str) -> Result<Value> {
    use base64::Engine;
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return Err(format!("只接受 PNG、JPG 或 WebP 图片：{path}")),
    };
    let file = fs::File::open(path).map_err(|_| format!("无法读取图片：{path}"))?;
    if file.metadata().map_err(|_| format!("无法读取图片：{path}"))?.len() > MAX_IMAGE {
        return Err(format!("图片超过 8 MB：{path}"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("无法读取图片：{path}"))?;
    if bytes.len() as u64 > MAX_IMAGE {
        return Err(format!("图片超过 8 MB：{path}"));
    }
    Ok(json!({
        "type": kind,
        "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
    }))
}

fn scalar_params(arguments: &Value) -> Result<Value> {
    let Some(params) = arguments.get("params") else {
        return Ok(json!({}));
    };
    let Some(map) = params.as_object() else {
        return Err("params 必须是对象".into());
    };
    if map.len() > 32 {
        return Err("params 项数过多".into());
    }
    let mut clean = serde_json::Map::new();
    for (name, value) in map {
        let valid_name = name.len() <= 64
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        let valid_value = match value {
            Value::String(text) => text.len() <= 200,
            Value::Number(_) | Value::Bool(_) => true,
            _ => false,
        };
        if !valid_name || !valid_value {
            return Err(format!("params.{name} 格式无效"));
        }
        clean.insert(name.clone(), value.clone());
    }
    Ok(Value::Object(clean))
}

/// The server-side objects a quote created. A successful run keeps them; a
/// quote or a refused run discards them so repeated checks cannot fill the
/// user's draft and storage quota.
struct Prepared {
    draft: Value,
    quote: Value,
    /// `worker` runs the whole graph on the hosted ComfyUI; `bridge` calls the
    /// model directly. They use different quote and run routes.
    transport: String,
    discard: Vec<(&'static str, String)>,
}

impl Prepared {
    fn cleanup(&self, server: &Server) {
        discard_all(server, &self.discard);
    }
}

/// The order in which a failed or temporary call's objects are deleted. The
/// server refuses to delete an upload that a live draft still references, so
/// drafts go first; otherwise the assets would be left behind forever.
fn discard_plan<'a>(discard: &'a [(&'static str, String)]) -> Vec<(&'static str, &'a str)> {
    let mut plan = Vec::new();
    for kind in ["drafts", "uploads"] {
        for (current, id) in discard {
            if *current == kind {
                plan.push((*current, id.as_str()));
            }
        }
    }
    plan
}

fn discard_all(server: &Server, discard: &[(&'static str, String)]) {
    for (kind, id) in discard_plan(discard) {
        let _ = delete_object(server, kind, id);
    }
}

fn delete_object(server: &Server, kind: &str, id: &str) -> Result<Value> {
    let path = match kind {
        "drafts" | "uploads" => format!("/api/workflows/{kind}/{id}"),
        _ => return Err("未知对象类型".into()),
    };
    platform_api(server, "DELETE", &path, None, 30_000).map_err(String::from)
}

/// Create a draft with the user's inputs and return the draft plus its quote.
fn prepare(server: &Server, arguments: &Value) -> Result<Prepared> {
    let mut discard: Vec<(&'static str, String)> = Vec::new();
    let result = fill(server, arguments, &mut discard);
    if result.is_err() {
        // A failure part way through must not leave the uploaded images behind.
        discard_all(server, &discard);
    }
    result
}

/// WAV is the only audio container the hosted service accepts for speech
/// templates; it carries the same base64 envelope as an image.
fn audio_data(path: &str) -> Result<Value> {
    use base64::Engine;
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension != "wav" {
        return Err(format!("只接受 PCM WAV 音频：{path}"));
    }
    let file = fs::File::open(path).map_err(|_| format!("无法读取音频：{path}"))?;
    if file.metadata().map_err(|_| format!("无法读取音频：{path}"))?.len() > MAX_IMAGE {
        return Err(format!("音频超过 8 MB：{path}"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("无法读取音频：{path}"))?;
    if bytes.len() as u64 > MAX_IMAGE {
        return Err(format!("音频超过 8 MB：{path}"));
    }
    Ok(json!({
        "type": "audio/wav",
        "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
    }))
}

/// Templates are either executed by the hosted ComfyUI (`worker`) or call the
/// model directly from the Bridge (`bridge`). Their quote and run routes differ,
/// and so do the assets a draft needs, so both are read before a draft is made.
struct Template {
    transport: String,
    requires_images: bool,
    requires_audio: bool,
    requires_prompt: bool,
}

fn template_info(server: &Server, template_id: &str) -> Result<Template> {
    let catalog = platform_public(
        server,
        "GET",
        "/workflow/platform/api/public/catalog",
        None,
        60_000,
    )?;
    let templates = catalog
        .get("items")
        .and_then(Value::as_array)
        .ok_or("工作流目录格式无效")?;
    let item = templates
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(template_id))
        .ok_or_else(|| {
            format!(
                "模板 {template_id} 不在公共模板目录中；个人工作流与未发布模板请在 CYAPI 工具箱的编辑器中运行"
            )
        })?;
    let transport = item
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or("worker")
        .to_string();
    let file = item.get("form").and_then(|form| form.get("file"));
    let accept = file
        .and_then(|file| file.get("accept"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let required = file
        .and_then(|file| file.get("required"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let prompt = item
        .get("form")
        .and_then(|form| form.get("prompt"))
        .and_then(|prompt| prompt.get("required"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(Template {
        transport: if transport == "bridge" {
            transport
        } else {
            "worker".into()
        },
        requires_images: required && !accept.starts_with("audio/"),
        requires_audio: required && accept.starts_with("audio/"),
        requires_prompt: prompt,
    })
}

fn quote_path(transport: &str, id: &str) -> String {
    if transport == "bridge" {
        format!("/api/workflows/drafts/{id}/quote")
    } else {
        format!("/api/workflows/drafts/{id}/pipeline-quote")
    }
}

fn run_path(transport: &str, id: &str) -> String {
    if transport == "bridge" {
        format!("/api/workflows/drafts/{id}/run")
    } else {
        format!("/api/workflows/drafts/{id}/pipeline-run")
    }
}

fn fill(
    server: &Server,
    arguments: &Value,
    discard: &mut Vec<(&'static str, String)>,
) -> Result<Prepared> {
    let template_id = text_argument(arguments, "templateId", 120)?;
    let prompt = arguments
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(4000)
        .collect::<String>();
    let params = scalar_params(arguments)?;
    let images: Vec<&str> = arguments
        .get("images")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if images.len() > 16 {
        return Err("参考图最多 16 张".into());
    }
    let audio = arguments
        .get("audio")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let template = template_info(server, template_id)?;
    // Reject a missing required asset before a draft is created, so a bad call
    // does not cost an upload and a cleanup round trip.
    if template.requires_images && images.is_empty() {
        return Err(format!(
            "模板 {template_id} 需要输入图片；请通过 images 提供本机图片路径"
        ));
    }
    if template.requires_audio && audio.is_none() {
        return Err(format!(
            "模板 {template_id} 需要 PCM WAV 音频；请通过 audio 提供本机音频路径"
        ));
    }
    if template.requires_prompt && prompt.trim().is_empty() {
        return Err(format!(
            "模板 {template_id} 需要 prompt（描述要生成或处理的内容）"
        ));
    }
    // Worker templates execute the whole graph inside the hosted ComfyUI, which
    // only receives assets through the editor. The service rejects any draft
    // that still references an upload, so name the real remedy here instead of
    // uploading assets that cannot be used.
    if template.transport != "bridge" && (!images.is_empty() || audio.is_some()) {
        return Err(format!(
            "模板 {template_id} 由 Worker ComfyUI 执行完整工作流，参考图与音频需要先在 CYAPI 工具箱的编辑器中同步；Agent 直接运行时请改用 transport=bridge 的模板"
        ));
    }
    let transport = template.transport;
    let draft = platform_api(
        server,
        "POST",
        "/api/workflows/drafts",
        Some(json!({ "templateId": template_id })),
        60_000,
    )?;
    let id = draft
        .get("id")
        .and_then(Value::as_str)
        .ok_or("服务端没有返回草稿 ID")?
        .to_string();
    // Tracked before any later step can fail, so the draft is always reclaimed.
    discard.push(("drafts", id.clone()));
    let revision = draft.get("revision").and_then(Value::as_u64).unwrap_or(1);
    let mut references = Vec::new();
    for path in images {
        let upload = platform_api(
            server,
            "POST",
            "/api/workflows/uploads/base64",
            Some(image_data(path)?),
            180_000,
        )?;
        if let Some(upload_id) = upload.get("id").and_then(Value::as_str) {
            references.push(upload_id.to_string());
            discard.push(("uploads", upload_id.to_string()));
        }
    }
    let audio_upload = match audio {
        Some(path) => {
            let upload = platform_api(
                server,
                "POST",
                "/api/workflows/uploads/base64",
                Some(audio_data(path)?),
                180_000,
            )?;
            let upload_id = upload
                .get("id")
                .and_then(Value::as_str)
                .ok_or("服务端没有返回音频 ID")?
                .to_string();
            discard.push(("uploads", upload_id.clone()));
            Some(upload_id)
        }
        None => None,
    };
    let unchanged = references.is_empty()
        && audio_upload.is_none()
        && prompt.is_empty()
        && params.as_object().is_some_and(|map| map.is_empty());
    if !unchanged {
        let mut body = json!({ "revision": revision, "description": prompt, "params": params });
        if !references.is_empty() {
            body["references"] = json!(references);
        }
        if let Some(audio) = &audio_upload {
            body["audio"] = json!(audio);
        }
        platform_api(
            server,
            "PUT",
            &format!("/api/workflows/drafts/{id}"),
            Some(body),
            60_000,
        )?;
    }
    let quote = platform_api(server, "GET", &quote_path(&transport, &id), None, 180_000)?;
    Ok(Prepared {
        draft,
        quote,
        transport,
        discard: std::mem::take(discard),
    })
}

fn quote_view(quote: &Value, draft: &Value) -> Value {
    // A template without CYAPI nodes is billed by the run, and the run fee is
    // reported separately from the per-node model amount; the budget a caller
    // declares must cover both. A Bridge quote reports neither, so both stay 0
    // and the charged amount is still the Bridge's own quoted amount.
    let amount = quote.get("amount").and_then(Value::as_f64).unwrap_or(0.0);
    let run_fee = quote.get("runFee").and_then(Value::as_f64).unwrap_or(0.0);
    json!({
        "draftId": draft.get("id").cloned().unwrap_or(Value::Null),
        "revision": quote.get("revision").cloned().unwrap_or(Value::Null),
        "amount": amount,
        "runFee": run_fee,
        "total": amount + run_fee,
        "unit": quote.get("unit").cloned().unwrap_or(Value::Null),
        "nodes": quote.get("nodes").cloned().unwrap_or(Value::Null),
        "items": quote.get("items").cloned().unwrap_or(Value::Null),
    })
}

/// Reject a name that could escape the output directory or confuse the user.
fn safe_filename(name: &str) -> Option<&str> {
    let valid = !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'));
    valid.then_some(name)
}

fn call(server: &Server, name: &str, arguments: &Value) -> Result<Value> {
    match name {
        "cyapi_account_status" => {
            let usage = platform_api(server, "GET", "/workflow/platform/api/usage", None, 30_000)?;
            Ok(json!({"usage": usage, "endpoint": server.server_url}))
        }
        "cyapi_workspace_status" => {
            let value = platform_api(server, "GET", "/workflow/platform/api/workspace", None, 60_000)?;
            Ok(workspace(&value))
        }
        "cyapi_workspace_start" => {
            let value = platform_api(
                server,
                "POST",
                "/workflow/platform/api/workspace/start",
                None,
                240_000,
            )?;
            Ok(workspace(&value))
        }
        "cyapi_workspace_stop" => {
            let value = platform_api(
                server,
                "POST",
                "/workflow/platform/api/workspace/stop",
                None,
                120_000,
            )?;
            Ok(workspace(&value))
        }
        "cyapi_workflow_list_templates" => {
            // The public catalog carries the form metadata (prompt fields,
            // required assets and option ranges) that /api/workflows/catalog
            // does not, and it needs no credential.
            let catalog = platform_public(
                server,
                "GET",
                "/workflow/platform/api/public/catalog",
                None,
                60_000,
            )?;
            let wanted = arguments.get("category").and_then(Value::as_str);
            let templates = catalog
                .get("items")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter(|item| {
                            wanted.is_none_or(|category| {
                                item.get("category").and_then(Value::as_str) == Some(category)
                            })
                        })
                        .map(|item| {
                            json!({
                                "templateId": item.get("id").cloned().unwrap_or(Value::Null),
                                "title": item.get("title").cloned().unwrap_or(Value::Null),
                                "summary": item.get("description").cloned().unwrap_or(Value::Null),
                                "category": item.get("category").cloned().unwrap_or(Value::Null),
                                "transport": item.get("transport").cloned().unwrap_or(Value::Null),
                                "input": item.get("input").cloned().unwrap_or(Value::Null),
                                "output": item.get("output").cloned().unwrap_or(Value::Null),
                                "price": item.get("price").cloned().unwrap_or(Value::Null),
                                "form": item.get("form").cloned().unwrap_or(Value::Null),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Ok(json!({ "templates": templates }))
        }
        "cyapi_workflow_quote" => {
            // Fail fast with an actionable message before any draft is created.
            current_key(server)?;
            // A quote is a read: the draft and its uploads are removed again so
            // repeated price checks cannot fill the user's draft and quota.
            let prepared = prepare(server, arguments)?;
            let view = quote_view(&prepared.quote, &prepared.draft);
            prepared.cleanup(server);
            Ok(view)
        }
        "cyapi_workflow_run" => {
            let budget = arguments
                .get("maxCostUsd")
                .and_then(Value::as_f64)
                .ok_or("缺少 maxCostUsd（本次运行允许的最高模型费用）")?;
            if !(0.0..=1_000.0).contains(&budget) {
                return Err("maxCostUsd 必须在 0 到 1000 之间".into());
            }
            current_key(server)?;
            let prepared = prepare(server, arguments)?;
            let view = quote_view(&prepared.quote, &prepared.draft);
            let total = view.get("total").and_then(Value::as_f64).unwrap_or(f64::INFINITY);
            if total > budget {
                prepared.cleanup(server);
                return Ok(json!({
                    "status": "quote_exceeded",
                    "message": format!("报价 {total:.4} USD（含执行费）超过 maxCostUsd {budget:.4}，未执行。请与用户确认后再调用。"),
                    "quote": view,
                }));
            }
            let draft_id = view["draftId"].as_str().unwrap_or_default().to_string();
            let transport = prepared.transport.clone();
            let task = match platform_api(
                server,
                "POST",
                &run_path(&transport, &draft_id),
                Some(json!({
                    "revision": prepared.quote.get("revision").cloned().unwrap_or(Value::Null),
                    "quote": prepared.quote,
                })),
                180_000,
            ) {
                Ok(task) => task,
                Err(failure) => {
                    // A server-side rejection (4xx) proves the draft was never
                    // started, so it is safe to reclaim. A transport failure
                    // leaves the outcome unknown: the task may already be
                    // queued, and deleting the draft would destroy a live run.
                    if failure.status.is_some_and(|status| status < 500) {
                        prepared.cleanup(server);
                    }
                    return Err(failure.message);
                }
            };
            // A submitted run keeps the draft and its uploads: the worker still
            // resolves the assets while the task is queued or running.
            Ok(json!({ "status": "submitted", "quote": view, "task": task_summary(&task) }))
        }
        "cyapi_workflow_list_tasks" => {
            let limit = arguments
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(10)
                .clamp(1, 50);
            let value = platform_api(
                server,
                "GET",
                &format!("/api/workflows/tasks?limit={limit}"),
                None,
                60_000,
            )?;
            let tasks = value
                .get("tasks")
                .and_then(Value::as_array)
                .map(|items| items.iter().map(task_summary).collect::<Vec<_>>())
                .unwrap_or_default();
            Ok(json!({ "total": value.get("total").cloned().unwrap_or(Value::Null), "tasks": tasks }))
        }
        "cyapi_workflow_task" => {
            let id = text_argument(arguments, "taskId", 120)?;
            let task = platform_api(
                server,
                "GET",
                &format!("/api/workflows/tasks/{id}"),
                None,
                60_000,
            )?;
            Ok(task_summary(&task))
        }
        "cyapi_workflow_cancel" => {
            let id = text_argument(arguments, "taskId", 120)?;
            let task = platform_api(
                server,
                "POST",
                &format!("/api/workflows/tasks/{id}/cancel"),
                Some(json!({})),
                60_000,
            )?;
            Ok(task_summary(&task))
        }
        "cyapi_workflow_download" => {
            let task_id = text_argument(arguments, "taskId", 120)?;
            let output_id = text_argument(arguments, "outputId", 200)?;
            if !task_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            {
                return Err("taskId 格式无效".into());
            }
            let task = platform_api(
                server,
                "GET",
                &format!("/api/workflows/tasks/{task_id}"),
                None,
                60_000,
            )?;
            let output = task
                .get("outputs")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| item.get("id").and_then(Value::as_str) == Some(output_id))
                })
                .ok_or_else(|| format!("任务 {task_id} 没有产物 {output_id}"))?;
            let path = output
                .get("download")
                .and_then(Value::as_str)
                .or_else(|| output.get("url").and_then(Value::as_str))
                .ok_or("产物没有下载地址")?
                .to_string();
            // Worker outputs carry no `filename`; the last URL segment is the
            // only place their name is still visible, and it must be read
            // before the path is moved into the download request.
            let filename = output
                .get("filename")
                .and_then(Value::as_str)
                .and_then(safe_filename)
                .map(str::to_string)
                .or_else(|| {
                    path.split('?')
                        .next()
                        .and_then(|path| path.rsplit('/').next())
                        .and_then(safe_filename)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| format!("artifact-{}", output_id.replace(['/', '\\'], "_")));
            let key = server
                .key
                .lock()
                .map_err(|_| "MCP 状态不可用".to_string())?
                .clone()
                .ok_or("工具箱尚未载入工作流 API Key")?;
            let downloaded = network::download(
                &server.server_url,
                DownloadRequest {
                    path,
                    key: Some(key),
                    timeout_ms: Some(180_000),
                    // The bytes travel as base64 inside one JSON value, so the
                    // cap also bounds the process memory this tool may use.
                    max_bytes: Some(64 * 1024 * 1024),
                },
            )?;
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(downloaded.base64.as_bytes())
                .map_err(|_| "产物数据无效")?;
            let directory = server.root.join("outputs").join(task_id);
            fs::create_dir_all(&directory).map_err(|error| format!("无法创建产物目录：{error}"))?;
            // Never overwrite a previous download: a second call for the same
            // artifact keeps both files instead of silently replacing one.
            let mut target = directory.join(&filename);
            if target.exists() {
                let stem = Path::new(&filename)
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("artifact");
                let extension = Path::new(&filename)
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| format!(".{value}"))
                    .unwrap_or_default();
                for index in 1..=999u32 {
                    let candidate = directory.join(format!("{stem}-{index}{extension}"));
                    if !candidate.exists() {
                        target = candidate;
                        break;
                    }
                }
            }
            fs::write(&target, &bytes).map_err(|error| format!("无法保存产物：{error}"))?;
            Ok(json!({
                "path": target.to_string_lossy(),
                "bytes": bytes.len(),
                "contentType": downloaded.content_type,
            }))
        }
        _ => Err(format!("未知工具：{name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> Server {
        Server {
            root: std::path::PathBuf::from("."),
            server_url: "http://127.0.0.1:47821".into(),
            token: "a".repeat(64),
            port: 18733,
            key: Mutex::new(None),
        }
    }

    #[test]
    fn lifecycle_matches_the_mcp_contract() {
        let server = server();
        let init = dispatch(
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}),
            &server,
        )
        .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["capabilities"]["tools"]["listChanged"], false);
        // A notification must not produce a response.
        assert!(dispatch(
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            &server
        )
        .is_none());
        let list = dispatch(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}), &server).unwrap();
        let names: Vec<&str> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names.len(), 11);
        assert!(names.contains(&"cyapi_workflow_run"));
        assert!(names.contains(&"cyapi_workflow_download"));
        let unknown = dispatch(
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"missing","arguments":{}}}),
            &server,
        )
        .unwrap();
        assert_eq!(unknown["result"]["isError"], true);
        assert_eq!(
            dispatch(json!({"jsonrpc":"2.0","id":4,"method":"missing"}), &server).unwrap()["error"]["code"],
            -32601
        );
    }

    #[test]
    fn a_run_without_a_key_fails_instead_of_calling_the_platform() {
        let server = server();
        let error = call(
            &server,
            "cyapi_workflow_run",
            &json!({"templateId":"idea","maxCostUsd":1.0}),
        )
        .unwrap_err();
        assert!(error.contains("API Key"));
        // The budget gate runs before any request leaves the process.
        let error = call(
            &server,
            "cyapi_workflow_run",
            &json!({"templateId":"idea","maxCostUsd":-1}),
        )
        .unwrap_err();
        assert!(error.contains("maxCostUsd"), "{error}");
    }

    #[test]
    fn parameters_and_image_paths_are_bounded() {
        assert!(scalar_params(&json!({"params":{"seed":12,"flag":true}})).is_ok());
        assert!(scalar_params(&json!({"params":{"nested":{}}})).is_err());
        assert!(scalar_params(&json!({"params":{"bad-name":1}})).is_err());
        assert!(image_data("missing.txt").is_err());
        assert!(image_data("missing.exe").is_err());
        assert!(audio_data("missing.wav").is_err());
        assert!(audio_data("missing.mp3").is_err());
    }

    #[test]
    fn artifact_names_cannot_escape_the_output_directory() {
        assert_eq!(safe_filename("result.png"), Some("result.png"));
        assert_eq!(safe_filename("../../secret.txt"), None);
        assert_eq!(safe_filename(".hidden"), None);
        assert_eq!(safe_filename(""), None);
        assert_eq!(safe_filename("a b.png"), None);
    }

    /// The quote and run routes differ between the two template transports, so
    /// selecting the wrong one would silently quote a different endpoint.
    #[test]
    fn transports_select_the_matching_quote_and_run_routes() {
        assert_eq!(
            quote_path("worker", "abc"),
            "/api/workflows/drafts/abc/pipeline-quote"
        );
        assert_eq!(run_path("worker", "abc"), "/api/workflows/drafts/abc/pipeline-run");
        assert_eq!(quote_path("bridge", "abc"), "/api/workflows/drafts/abc/quote");
        assert_eq!(run_path("bridge", "abc"), "/api/workflows/drafts/abc/run");
    }

    /// A quote must budget the run fee of a graph without CYAPI nodes.
    #[test]
    fn the_budget_covers_the_execution_fee() {
        let draft = json!({"id":"d"});
        let view = quote_view(&json!({"amount":0,"runFee":0.25,"unit":"USD"}), &draft);
        assert_eq!(view["total"], 0.25);
        let view = quote_view(&json!({"amount":1.5,"runFee":0,"unit":"USD"}), &draft);
        assert_eq!(view["total"], 1.5);
    }

    /// Uploads referenced by a live draft are rejected by the server, so the
    /// cleanup plan has to delete every draft before any of its uploads.
    #[test]
    fn cleanup_deletes_drafts_before_their_uploads() {
        let discard = vec![
            ("drafts", "draft-a".to_string()),
            ("uploads", "upload-1".to_string()),
            ("uploads", "upload-2".to_string()),
        ];
        let plan = discard_plan(&discard);
        let kinds = plan.iter().map(|(kind, _)| *kind).collect::<Vec<_>>();
        assert_eq!(kinds, vec!["drafts", "uploads", "uploads"]);
        assert_eq!(plan[0].1, "draft-a");
        assert_eq!(plan[1].1, "upload-1");
        assert_eq!(plan[2].1, "upload-2");
        // Both uploads are kept in their original order, so a failure deleting
        // one does not reorder the rest.
        let discard = vec![
            ("uploads", "upload-1".to_string()),
            ("drafts", "draft-a".to_string()),
            ("uploads", "upload-2".to_string()),
        ];
        let plan = discard_plan(&discard);
        assert_eq!(plan[0], ("drafts", "draft-a"));
        assert_eq!(plan[1], ("uploads", "upload-1"));
        assert_eq!(plan[2], ("uploads", "upload-2"));
    }

    #[test]
    fn the_capability_token_compares_without_early_exit() {
        let server = server();
        assert!(same_token(&server.token, &server.token));
        assert!(!same_token("b", &server.token));
    }

    #[test]
    fn the_token_file_is_stable_and_reusable() {
        let root = std::env::temp_dir().join(format!("cyapi-token-{}", uuid::Uuid::new_v4()));
        let first = ensure_token(&root).unwrap();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        // A second read returns the same token, so an existing agent
        // configuration keeps working after a restart.
        assert_eq!(ensure_token(&root).unwrap(), first);
        let _ = std::fs::remove_dir_all(root);
    }

    /// A real loopback request proves the framing, authentication and JSON-RPC
    /// handling that a unit-level `dispatch` call cannot.
    #[test]
    fn a_real_loopback_request_is_authenticated_and_answered() {
        use std::io::Read;
        let root = std::env::temp_dir().join(format!("cyapi-bridge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let token = ensure_token(&root).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = Arc::new(Server {
            root,
            server_url: "http://127.0.0.1:1".into(),
            token: token.clone(),
            port,
            key: Mutex::new(None),
        });
        let serving = server.clone();
        // Accept the two connections this test makes, then end the thread; an
        // infinite accept loop would block `join` forever.
        let handle = thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let Ok(stream) = stream else { continue };
                let _ = connection(stream, &serving);
            }
        });
        let request = |authorization: &str| {
            let body = json!({"jsonrpc":"2.0","id":7,"method":"tools/list"}).to_string();
            format!(
                "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nAuthorization: {authorization}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
        };
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(request(&format!("Bearer {token}")).as_bytes())
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("cyapi_workflow_run"));
        // A wrong token is refused before any JSON-RPC parsing happens.
        let mut rejected = TcpStream::connect(("127.0.0.1", port)).unwrap();
        rejected.write_all(request("Bearer wrong").as_bytes()).unwrap();
        let mut answer = String::new();
        rejected.read_to_string(&mut answer).unwrap();
        assert!(answer.starts_with("HTTP/1.1 401"), "{answer}");
        // Dropping the listener releases the port and ends the accept loop.
        drop(client);
        drop(rejected);
        let _ = handle.join();
    }

    /// Some agent HTTP clients stream the JSON body with chunked encoding and
    /// declare no length, which must not be read as an empty request.
    #[test]
    fn a_chunked_request_body_is_decoded() {
        use std::io::Read;
        let root = std::env::temp_dir().join(format!("cyapi-chunked-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let token = ensure_token(&root).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = Arc::new(Server {
            root,
            server_url: "http://127.0.0.1:1".into(),
            token: token.clone(),
            port,
            key: Mutex::new(None),
        });
        let serving = server.clone();
        let handle = thread::spawn(move || {
            if let Some(Ok(stream)) = listener.incoming().next() {
                let _ = connection(stream, &serving);
            }
        });
        let payload = json!({"jsonrpc":"2.0","id":9,"method":"tools/list"}).to_string();
        // Split into two chunks to prove the decoder reassembles a body that
        // arrives in more than one HTTP chunk.
        let (first, rest) = payload.split_at(payload.len() / 2);
        let request = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nAuthorization: Bearer {token}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{first}\r\n{:x}\r\n{rest}\r\n0\r\n\r\n",
            first.len(),
            rest.len(),
        );
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("cyapi_workflow_run"), "{response}");
        drop(client);
        let _ = handle.join();
    }

    #[test]
    fn chunk_sizes_accept_hex_and_extensions() {
        assert_eq!(size_line(b"1a").unwrap(), 0x1a);
        assert_eq!(size_line(b"5;ext=1").unwrap(), 5);
        assert!(size_line(b"xyz").is_err());
    }
}
