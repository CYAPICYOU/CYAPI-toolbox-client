use super::*;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

fn hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn executable(tool: &str) -> Result<PathBuf> {
    if tool == "codex" {
        if let Some(path) = crate::codex_models::local_cli_candidates()
            .into_iter()
            .find(|p| p.is_absolute() && p.is_file())
        {
            return Ok(path);
        }
    }
    let path = std::env::var_os("PATH").ok_or("PATH 不可用")?;
    for directory in std::env::split_paths(&path) {
        #[cfg(windows)]
        let names = [format!("{tool}.exe"), format!("{tool}.cmd")];
        #[cfg(not(windows))]
        let names = [tool.to_string()];
        for name in names {
            let path = directory.join(name);
            if path.is_absolute() && path.is_file() {
                return Ok(path);
            }
        }
    }
    Err(format!(
        "未找到可用的 {tool} 原生删除程序；仍可分析占用及清理日志、缓存和临时文件"
    ))
}

pub(super) fn session_capability(workspace: &str) -> std::result::Result<(), String> {
    if workspace == "claude" {
        return Ok(());
    }
    executable(workspace).map(|_| ())
}

fn command(tool: &str, args: &[&str], root: &Path) -> Result<Command> {
    let path = executable(tool)?;
    let mut cmd = launcher(path, args)?;
    hidden(&mut cmd);
    cmd.current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if tool == "codex" {
        cmd.env("CODEX_HOME", root);
    } else if tool == "opencode" {
        cmd.env(
            "XDG_DATA_HOME",
            root.parent().ok_or("OpenCode 数据目录无效")?,
        );
        cmd.env("OPENCODE_DB", root.join("opencode.db"));
        // Explicit private mode is required for V2; never honor an ambient remote URL.
        for key in ["OPENCODE_SERVER", "OPENCODE_SERVER_URL", "OPENCODE_ATTACH"] {
            cmd.env_remove(key);
        }
    }
    Ok(cmd)
}

fn launcher(path: PathBuf, args: &[&str]) -> Result<Command> {
    #[cfg(windows)]
    let cmd = if path.extension().is_some_and(|s| s == "cmd" || s == "bat") {
        use std::os::windows::process::CommandExt;
        let text = path.to_str().ok_or("CLI 路径不是有效文本")?;
        // Shell shims are needed for npm installations. No user-provided shell arguments.
        if text.chars().any(|c| "\"%!?&|<>^\r\n".contains(c))
            || args.iter().any(|s| {
                s.chars()
                    .any(|c| !c.is_ascii_alphanumeric() && !"-_/:.=".contains(c))
            })
        {
            return Err("CLI 启动路径或参数含不安全字符，请使用原生可执行文件".into());
        }
        let mut c = Command::new("cmd.exe");
        c.args(["/d", "/s", "/c"])
            .raw_arg(format!("\"\"{text}\" {}\"", args.join(" ")));
        c
    } else {
        let mut c = Command::new(path);
        c.args(args);
        c
    };
    #[cfg(not(windows))]
    let cmd = {
        let mut c = Command::new(path);
        c.args(args);
        c
    };
    Ok(cmd)
}

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        // Terminate only the child tree we created, including npm's wrapper.
        if self.0.try_wait().ok().flatten().is_none() {
            #[cfg(windows)]
            {
                let mut cmd = Command::new("taskkill.exe");
                hidden(&mut cmd);
                let _ = cmd
                    .args(["/pid", &self.0.id().to_string(), "/t", "/f"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

fn output(mut cmd: Command) -> Result<String> {
    let mut child = Process(cmd.spawn().map_err(|_| "无法启动清理辅助进程")?);
    let stdout = child.0.stdout.take().ok_or("无法读取 CLI 输出")?;
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes);
        let _ = tx.send((result, bytes));
    });
    let (result, bytes) = rx
        .recv_timeout(Duration::from_secs(45))
        .map_err(|_| "CLI 超时，已停止本次操作；请重新扫描确认结果")?;
    result.map_err(|_| "无法读取 CLI 输出")?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("CLI 输出超过限额".into());
    }
    let start = Instant::now();
    loop {
        if let Some(status) = child.0.try_wait().map_err(|_| "无法读取 CLI 状态")? {
            if !status.success() {
                return Err("原生 CLI 操作失败；未使用直接删库的回退方式".into());
            }
            break;
        }
        if start.elapsed() > Duration::from_secs(5) {
            return Err("CLI 未正常退出".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    String::from_utf8(bytes).map_err(|_| "CLI 输出不是 UTF-8".into())
}

pub(super) fn ensure_stopped(workspace: &str) -> Result<()> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("powershell.exe");
        // Do not expose command lines in errors or logs.
        c.args(["-NoProfile", "-NonInteractive", "-Command", r"$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(codex|claude|opencode)([-.].*)?(\.exe)?$' -or ($_.Name -match '^(node|bun|electron)(\.exe)?$' -and $_.CommandLine -match '(?i)([\\/](codex|claude|opencode)([\\/.\s]|$)|@openai[\\/]codex|@anthropic-ai[\\/]claude-code|@opencode[\\/]cli)') } | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress"]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("ps");
        c.args(["-axo", "comm=,args="]);
        c
    };
    hidden(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let text = output(cmd)
        .map_err(|_| "无法确认工具进程状态，已阻止清理")?
        .to_lowercase();
    let running = process_matches(workspace, &text);
    if running {
        Err(format!(
            "请完全关闭 {workspace}（含桌面端、编辑器扩展及后台服务）后重新扫描"
        ))
    } else {
        Ok(())
    }
}

fn process_matches(workspace: &str, text: &str) -> bool {
    let name = if workspace == "claude" {
        "claude"
    } else {
        workspace
    };
    #[cfg(windows)]
    {
        text.contains(name)
    }
    #[cfg(not(windows))]
    {
        text.lines().any(|line| {
            let mut parts = line.split_whitespace();
            let exe = parts.next().unwrap_or("").rsplit('/').next().unwrap_or("");
            exe == name
                || exe.starts_with(&format!("{name}-"))
                || (["node", "bun", "electron"].contains(&exe)
                    && (line.contains(&format!("/{name}/"))
                        || line.contains(&format!("/{name}."))
                        || line.contains(&format!("/{name} "))))
        })
    }
}

struct Rpc {
    process: Process,
    stdin: ChildStdin,
    lines: mpsc::Receiver<Value>,
    sequence: u64,
}

impl Rpc {
    fn start(root: &Path) -> Result<Self> {
        let mut cmd = command("codex", &["app-server", "--listen", "stdio://"], root)?;
        Self::with_command(&mut cmd)
    }
    fn with_command(cmd: &mut Command) -> Result<Self> {
        cmd.stdin(Stdio::piped());
        let mut process = Process(
            cmd.spawn()
                .map_err(|_| "无法启动 Codex app-server；需要支持 thread/delete 的新版 Codex")?,
        );
        let stdin = process.0.stdin.take().ok_or("无法连接 Codex stdin")?;
        let stdout = process.0.stdout.take().ok_or("无法连接 Codex stdout")?;
        let (tx, lines) = mpsc::sync_channel(32);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match reader
                    .by_ref()
                    .take(16 * 1024 * 1024 + 1)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if line.len() > 16 * 1024 * 1024 {
                            break;
                        }
                        if let Ok(v) = serde_json::from_slice(&line) {
                            if tx.send(v).is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        });
        let mut rpc = Self {
            process,
            stdin,
            lines,
            sequence: 0,
        };
        rpc.call("initialize", json!({"clientInfo":{"name":"cyapi_toolbox_cleanup","version":"1.0.0"},"capabilities":{"experimentalApi":true}}))?;
        rpc.write(json!({"method":"initialized"}))?;
        Ok(rpc)
    }
    fn write(&mut self, v: Value) -> Result<()> {
        writeln!(self.stdin, "{v}")
            .and_then(|_| self.stdin.flush())
            .map_err(|_| "Codex 协议写入失败".into())
    }
    fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.sequence += 1;
        self.write(json!({"id":self.sequence,"method":method,"params":params}))?;
        let start = Instant::now();
        loop {
            let remaining = Duration::from_secs(45)
                .checked_sub(start.elapsed())
                .ok_or("Codex 协议超时")?;
            let v = self
                .lines
                .recv_timeout(remaining)
                .map_err(|_| "Codex 协议超时或连接已关闭；请确认 CLI 版本")?;
            if v["id"].as_u64() == Some(self.sequence) {
                if !v["error"].is_null() {
                    return Err(format!("Codex {method} 被拒绝（可能版本不支持、会话被引用或仍在运行）；未直接修改数据库"));
                }
                return v
                    .get("result")
                    .cloned()
                    .ok_or("Codex 协议响应缺少 result".into());
            }
        }
    }
}

fn codex_threads(rpc: &mut Rpc, root: &Path) -> Result<Vec<Item>> {
    let canonical_root = fs::canonicalize(root).map_err(|_| "无法确认 Codex 数据目录")?;
    let mut out = Vec::new();
    for archived in [false, true] {
        let mut cursor = Value::Null;
        let mut seen = HashSet::new();
        loop {
            let result = rpc.call("thread/list", json!({"limit":100,"cursor":cursor,"archived":archived,
                "sourceKinds":["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"],"modelProviders":[],"useStateDbOnly":true}))?;
            let data = result["data"].as_array().ok_or("Codex 会话列表格式无效")?;
            for v in data {
                // Older versions without this field cannot prove a complete spawn tree.
                if v.get("parentThreadId").is_none() {
                    return Err("Codex 版本过旧，无法检查子会话关系，请升级 CLI".into());
                }
                let id = v["id"].as_str().ok_or("Codex 会话标识无效")?;
                let path = v["path"]
                    .as_str()
                    .map(PathBuf::from)
                    .ok_or("Codex 会话缺少本地 rollout 路径")?;
                checked(&path)?;
                let canonical_path =
                    fs::canonicalize(&path).map_err(|_| "无法确认 Codex 会话路径")?;
                if !canonical_path.starts_with(canonical_root.join("sessions"))
                    && !canonical_path.starts_with(canonical_root.join("archived_sessions"))
                {
                    return Err("Codex 会话文件位于预期目录之外，已停止清理".into());
                }
                let meta = fs::metadata(&path).map_err(|_| "无法读取 Codex 会话文件")?;
                let file_time = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|t| t.as_millis() as u64)
                    .unwrap_or(logging::now());
                out.push(Item {
                    id: id.into(),
                    title: v["name"].as_str().unwrap_or(id).chars().take(120).collect(),
                    updated_at: v["updatedAt"]
                        .as_u64()
                        .unwrap_or(0)
                        .saturating_mul(1000)
                        .max(file_time),
                    bytes: meta.len(),
                    sessions: 1,
                    parent: v["parentThreadId"].as_str().unwrap_or("").into(),
                    fork: v["forkedFromId"].as_str().unwrap_or("").into(),
                    references: Vec::new(),
                    files: Vec::new(),
                });
                if out.len() > LIMIT {
                    return Err("Codex 会话超过扫描限额".into());
                }
            }
            cursor = result["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
            if !seen.insert(cursor.to_string()) || seen.len() > LIMIT / 100 + 1 {
                return Err("Codex 分页游标重复或超过扫描限额".into());
            }
        }
    }
    Ok(out)
}

pub(super) fn codex_delete(
    root: &Path,
    id: &str,
    expected: &[Item],
    range: &TimeRange,
) -> Result<()> {
    if !valid_id(id) {
        return Err("Codex 会话标识无效".into());
    }
    let mut rpc = Rpc::start(root)?;
    codex_delete_using(&mut rpc, root, id, expected, range)
}

fn codex_delete_using(
    rpc: &mut Rpc,
    root: &Path,
    id: &str,
    expected: &[Item],
    range: &TimeRange,
) -> Result<()> {
    let before = codex_threads(rpc, root)?;
    let subtree = verify_session_tree(&before, expected, id, range)?;
    rpc.call("thread/delete", json!({"threadId":id}))?;
    if codex_threads(rpc, root)?
        .iter()
        .any(|i| subtree.contains(&i.id))
    {
        return Err("Codex 未确认完整会话树已删除，请重新扫描".into());
    }
    // Keep ownership explicit so the stdio server always terminates on return.
    let _ = rpc.process.0.id();
    Ok(())
}

fn db_path(root: &Path) -> Result<PathBuf> {
    let expected = root.join("opencode.db");
    checked(&expected)?;
    if let Some(path) = std::env::var_os("OPENCODE_DB")
        .filter(|_| std::env::var_os("CYAPI_TOOLBOX_HOME_DIR").is_none())
    {
        if PathBuf::from(path) != expected {
            return Err(
                "OPENCODE_DB 指向其他数据库；为避免跨目录误删，请在默认数据目录下清理".into(),
            );
        }
    }
    for suffix in ["-wal", "-shm"] {
        checked(&PathBuf::from(format!("{}{suffix}", expected.display())))?;
    }
    Ok(expected)
}

fn columns(db: &Connection, table: &str) -> Result<HashSet<String>> {
    let mut stmt = db
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|_| "无法读取数据库结构")?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|_| "无法读取数据库字段")?;
    rows.collect::<std::result::Result<_, _>>()
        .map_err(|_| "数据库字段无效".into())
}

pub(super) fn opencode_list(root: &Path) -> Result<Vec<Item>> {
    let path = db_path(root)?;
    if !path.exists() {
        if root.join("storage/session").exists() {
            return Err("此 OpenCode 仍使用旧 JSON 存储，请先通过原生工具迁移后清理".into());
        }
        return Ok(Vec::new());
    }
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "无法只读打开 OpenCode 数据库")?;
    db.busy_timeout(Duration::from_secs(2))
        .map_err(|_| "无法设置数据库等待时间")?;
    db.execute_batch("PRAGMA query_only=ON; BEGIN;")
        .map_err(|_| "无法开始会话扫描事务")?;
    let v2 = columns(&db, "session_v2")?;
    let (table, cols, message) = if v2.contains("id") {
        ("session_v2", v2, "session_message")
    } else {
        ("session", columns(&db, "session")?, "message")
    };
    if !["id", "parent_id", "time_updated", "title"]
        .iter()
        .all(|c| cols.contains(*c))
    {
        return Err("不支持的 OpenCode 会话结构，未生成删除计划".into());
    }
    let fork = if cols.contains("fork_session_id") {
        "COALESCE(fork_session_id,'')"
    } else {
        "''"
    };
    let mc = columns(&db, message)?;
    if !["session_id", "data", "time_updated"]
        .iter()
        .all(|c| mc.contains(*c))
    {
        return Err("无法确认 OpenCode 消息更新时间，已停止清理".into());
    }
    let sql = format!("SELECT s.id, COALESCE(s.parent_id,''), {fork}, COALESCE(s.title,''), MAX(s.time_updated, COALESCE((SELECT MAX(m.time_updated) FROM {message} m WHERE m.session_id=s.id),0)), COALESCE((SELECT SUM(length(CAST(m.data AS BLOB))) FROM {message} m WHERE m.session_id=s.id),0) FROM {table} s LIMIT 20001");
    let mut stmt = db.prepare(&sql).map_err(|_| "无法读取 OpenCode 会话")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Item {
                id: r.get(0)?,
                parent: r.get(1)?,
                fork: r.get(2)?,
                references: Vec::new(),
                title: r.get::<_, String>(3)?.chars().take(120).collect(),
                updated_at: r.get::<_, i64>(4)?.max(0) as u64,
                bytes: r.get::<_, i64>(5)?.max(0) as u64,
                sessions: 1,
                files: Vec::new(),
            })
        })
        .map_err(|_| "无法读取 OpenCode 会话记录")?;
    let mut items = rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| "OpenCode 会话记录无效")?;
    // Legacy tool states can be newer than their containing message.
    if table == "session" {
        let pc = columns(&db, "part")?;
        if !["session_id", "data", "time_updated"]
            .iter()
            .all(|c| pc.contains(*c))
        {
            return Err("无法确认 OpenCode part 数据，已停止清理".into());
        }
        for item in &mut items {
            let (time, bytes): (i64, i64) = db.query_row("SELECT COALESCE(MAX(time_updated),0), COALESCE(SUM(length(CAST(data AS BLOB))),0) FROM part WHERE session_id=?1", [&item.id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|_| "无法读取 OpenCode part 数据")?;
            item.updated_at = item.updated_at.max(time.max(0) as u64);
            item.bytes += bytes.max(0) as u64;
        }
    }
    Ok(items)
}

fn opencode_args(execute: &mut impl FnMut(&[&str]) -> Result<String>) -> Result<Vec<&'static str>> {
    let help = execute(&["session", "delete", "--help"])?;
    if !help.contains("sessionID") && !help.contains("sessionId") {
        return Err("OpenCode CLI 不支持 session delete，请升级后重试".into());
    }
    if help.contains("--standalone") {
        Ok(vec!["--standalone"])
    } else {
        let version = execute(&["--version"])?;
        let major = version
            .trim()
            .trim_start_matches('v')
            .split('.')
            .next()
            .and_then(|s| s.parse::<u32>().ok());
        if major == Some(1) && help.contains("--pure") {
            Ok(vec!["--pure"])
        } else {
            Err(
                "此 OpenCode CLI 未提供可验证的本地独立删除模式，请升级至支持 --standalone 的版本"
                    .into(),
            )
        }
    }
}

pub(super) fn opencode_delete(
    root: &Path,
    id: &str,
    expected: &[Item],
    range: &TimeRange,
) -> Result<()> {
    opencode_delete_using(root, id, expected, range, |args| {
        output(command("opencode", args, root)?)
    })
}

fn opencode_delete_using(
    root: &Path,
    id: &str,
    expected: &[Item],
    range: &TimeRange,
    mut execute: impl FnMut(&[&str]) -> Result<String>,
) -> Result<()> {
    if !valid_id(id) {
        return Err("OpenCode 会话标识无效".into());
    }
    let path = db_path(root)?;
    let mode = opencode_args(&mut execute)?;
    // CLI path discovery must agree with the read-only scan before deletion.
    let paths = execute(&["debug", "paths"])?;
    let paths: Value =
        serde_json::from_str(paths.trim()).map_err(|_| "无法验证 OpenCode CLI 的本地数据目录")?;
    let data = paths["data"]
        .as_str()
        .ok_or("OpenCode CLI 未返回本地数据目录")?;
    checked(Path::new(data))?;
    let actual = fs::canonicalize(data).map_err(|_| "OpenCode CLI 数据目录不一致或不可访问")?;
    let expected_root = fs::canonicalize(root).map_err(|_| "扫描数据目录不可访问")?;
    if actual != expected_root || !path.is_file() {
        return Err("OpenCode CLI 与扫描数据目录不一致，已阻止删除".into());
    }
    let mut args = vec!["session", "delete", id];
    args.extend(mode);
    let before = opencode_list(root)?;
    let subtree = verify_session_tree(&before, expected, id, range)?;
    execute(&args)?;
    if opencode_list(root)?.iter().any(|i| subtree.contains(&i.id)) {
        return Err("原生 CLI 未确认会话树已删除，请重新扫描".into());
    }
    Ok(())
}

fn db_bytes(path: &Path) -> u64 {
    [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
    ]
    .iter()
    .filter_map(|p| fs::metadata(p).ok())
    .map(|m| m.len())
    .sum()
}

pub(super) fn compact(root: &Path) -> Result<u64> {
    ensure_stopped("opencode")?;
    let path = db_path(root)?;
    compact_path(&path)
}

pub(super) fn compact_path(path: &Path) -> Result<u64> {
    checked(path)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        checked(&PathBuf::from(format!("{}{suffix}", path.display())))?;
    }
    let before = db_bytes(path);
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| "无法打开数据库进行空间回收")?;
    db.busy_timeout(Duration::from_secs(2))
        .map_err(|_| "无法设置数据库等待时间")?;
    let busy: i64 = db
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))
        .map_err(|_| "数据库 checkpoint 失败")?;
    if busy != 0 {
        return Err("数据库仍被占用，未执行压缩".into());
    }
    db.execute_batch("VACUUM;")
        .map_err(|_| "SQLite VACUUM 失败（可能空间不足或仍被占用）")?;
    let busy: i64 = db
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))
        .map_err(|_| "压缩后 checkpoint 失败")?;
    if busy != 0 {
        return Err("压缩后数据库仍被占用".into());
    }
    drop(db);
    Ok(before.saturating_sub(db_bytes(path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_filter_distinguishes_tools() {
        #[cfg(windows)]
        let listing = r#"["codex.exe","opencode.exe"]"#;
        #[cfg(not(windows))]
        let listing = "codex /opt/bin/codex app-server\nopencode /opt/bin/opencode serve";
        assert!(process_matches("codex", listing));
        assert!(process_matches("opencode", listing));
        assert!(!process_matches("claude", listing));
        assert!(!process_matches("codex", ""));
    }

    #[test]
    fn vacuum_reclaims_deleted_pages_without_removing_retained_data() {
        let root =
            std::env::temp_dir().join(format!("cyapi-cleanup-vacuum-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("opencode.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE fixture(id INTEGER PRIMARY KEY, body BLOB);
            INSERT INTO fixture VALUES(1,zeroblob(1048576)),(2,x'616263'); DELETE FROM fixture WHERE id=1;").unwrap();
        drop(db);
        assert!(compact_path(&path).unwrap() > 500_000);
        let db = Connection::open(&path).unwrap();
        assert_eq!(
            db.query_row("SELECT body FROM fixture WHERE id=2", [], |r| r
                .get::<_, Vec<u8>>(0))
                .unwrap(),
            b"abc"
        );
        assert_eq!(
            db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn codex_stdio_handshake_and_delete_protocol_with_mock_process() {
        let mut cmd = Command::new("powershell.exe");
        hidden(&mut cmd);
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", r#"
            $ErrorActionPreference='Stop'
            $ready=$false
            while ($null -ne ($line=[Console]::ReadLine())) {
                $v=$line | ConvertFrom-Json
                switch ($v.method) {
                    'initialize' {
                        if ($v.params.clientInfo.name -ne 'cyapi_toolbox_cleanup' -or !$v.params.capabilities.experimentalApi) { exit 2 }
                        [Console]::WriteLine('{"id":'+$v.id+',"result":{}}')
                    }
                    'initialized' { $ready=$true }
                    'thread/delete' {
                        if (!$ready -or $v.params.threadId -ne 'fixture-thread') { exit 3 }
                        [Console]::WriteLine('{"method":"thread/deleted","params":{"threadId":"fixture-thread"}}')
                        [Console]::WriteLine('{"id":'+$v.id+',"result":{}}')
                    }
                    'thread/list' { [Console]::WriteLine('{"id":'+$v.id+',"result":{"data":[],"nextCursor":null}}') }
                    default { exit 4 }
                }
            }
        "#]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut rpc = Rpc::with_command(&mut cmd).unwrap();
        assert_eq!(
            rpc.call("thread/delete", json!({"threadId":"fixture-thread"}))
                .unwrap(),
            json!({})
        );
        let result = rpc.call("thread/list", json!({})).unwrap();
        assert_eq!(result["data"], json!([]));
    }

    #[cfg(windows)]
    #[test]
    fn codex_native_delete_checks_actual_subtree_before_sending_delete() {
        let root = std::env::temp_dir().join(format!("cyapi-codex-tree-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("sessions")).unwrap();
        let mut threads = Vec::new();
        for (id, parent) in [("fixture-root", ""), ("fixture-child", "fixture-root")] {
            let path = root.join("sessions").join(format!("{id}.jsonl"));
            fs::write(
                &path,
                format!(
                    "{}\n",
                    json!({"type":"session_meta","payload":{"id":id,"parent_thread_id":parent}})
                ),
            )
            .unwrap();
            threads.push(json!({"id":id,"path":path,"parentThreadId":if parent.is_empty() { Value::Null } else { json!(parent) },"updatedAt":1}));
        }
        let marker = root.join("mock-delete-called");
        let start = || {
            let mut cmd = Command::new("powershell.exe");
            hidden(&mut cmd);
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", r#"
                $ErrorActionPreference='Stop'; $deleted=$false
                while ($null -ne ($line=[Console]::ReadLine())) {
                    $v=$line | ConvertFrom-Json
                    switch ($v.method) {
                        'initialize' { [Console]::WriteLine('{"id":'+$v.id+',"result":{}}') }
                        'initialized' { }
                        'thread/list' {
                            if (!$v.params.useStateDbOnly) { exit 5 }
                            $data=if ($deleted -or $v.params.archived) { '[]' } else { $env:CYAPI_TEST_THREADS }
                            [Console]::WriteLine('{"id":'+$v.id+',"result":{"data":'+$data+',"nextCursor":null}}')
                        }
                        'thread/delete' {
                            [IO.File]::WriteAllText($env:CYAPI_TEST_MARKER,'fixture'); $deleted=$true
                            [Console]::WriteLine('{"id":'+$v.id+',"result":{}}')
                        }
                        default { exit 4 }
                    }
                }
            "#]).env("CYAPI_TEST_THREADS", json!(threads).to_string()).env("CYAPI_TEST_MARKER", &marker)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
            Rpc::with_command(&mut cmd).unwrap()
        };
        let expected = codex::list(&root).unwrap();
        let root_only: Vec<_> = expected
            .iter()
            .filter(|i| i.id == "fixture-root")
            .cloned()
            .collect();
        assert!(codex_delete_using(
            &mut start(),
            &root,
            "fixture-root",
            &root_only,
            &TimeRange::default()
        )
        .is_err());
        assert!(!marker.exists());
        assert!(codex_delete_using(
            &mut start(),
            &root,
            "fixture-root",
            &expected,
            &TimeRange {
                since: None,
                until: Some(2)
            }
        )
        .is_err());
        assert!(!marker.exists());
        codex_delete_using(
            &mut start(),
            &root,
            "fixture-root",
            &expected,
            &TimeRange::default(),
        )
        .unwrap();
        assert!(marker.exists());
        // The fake app-server only acknowledges protocol operations; local fixtures remain.
        assert_eq!(codex::list(&root).unwrap().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn npm_shim_with_spaces_uses_cmd_quoting_and_rejects_shell_injection() {
        let root = std::env::temp_dir()
            .join(format!("cyapi-cleanup-shim-{}", uuid::Uuid::new_v4()))
            .join("cli with spaces");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("fixture.cmd");
        fs::write(&path, "@echo off\r\necho %1\r\n").unwrap();
        let mut cmd = launcher(path.clone(), &["fixture-value"]).unwrap();
        hidden(&mut cmd);
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        assert_eq!(output(cmd).unwrap().trim(), "fixture-value");
        assert!(launcher(path, &["fixture&injected"]).is_err());
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn opencode_adapters_require_private_v2_or_pure_legacy_mode() {
        assert_eq!(
            opencode_args(&mut |_| Ok("sessionID --standalone".into())).unwrap(),
            ["--standalone"]
        );
        assert_eq!(
            opencode_args(&mut |args| Ok(if args == ["--version"] {
                "1.2.0"
            } else {
                "sessionID --pure"
            }
            .into()))
            .unwrap(),
            ["--pure"]
        );
        assert!(opencode_args(&mut |args| Ok(if args == ["--version"] {
            "2.0.0"
        } else {
            "sessionID --pure"
        }
        .into()))
        .is_err());
        assert!(opencode_args(&mut |_| Ok("unknown CLI".into())).is_err());
    }

    #[test]
    fn opencode_native_delete_adapter_verifies_scope_and_actual_subtree_removal() {
        let root =
            std::env::temp_dir().join(format!("cyapi-cleanup-adapter-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("opencode.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,time_updated INTEGER);
            CREATE TABLE session_message(id TEXT,session_id TEXT,data TEXT,time_updated INTEGER);
            INSERT INTO session_v2 VALUES('root',NULL,'Fixture',1),('child','root','Fixture child',1),('grandchild','child','Fixture grandchild',1);").unwrap();
        let mut deletes = 0;
        let expected = opencode_list(&root).unwrap();
        let result = opencode_delete_using(
            &root,
            "root",
            &expected,
            &TimeRange::default(),
            |args| match args {
                ["session", "delete", "--help"] => Ok("sessionID --standalone".into()),
                ["debug", "paths"] => Ok(json!({"data":root}).to_string()),
                ["session", "delete", "root", "--standalone"] => {
                    deletes += 1;
                    // A broken CLI deleting only the first two levels must not report success.
                    db.execute("DELETE FROM session_v2 WHERE id IN ('root','child')", [])
                        .unwrap();
                    Ok(String::new())
                }
                _ => panic!("unexpected native operation"),
            },
        );
        assert!(result.unwrap_err().contains("未确认"));
        assert_eq!(deletes, 1);
        db.execute_batch("INSERT INTO session_v2 VALUES('root',NULL,'Fixture',1),('child','root','Fixture child',1);").unwrap();
        opencode_delete_using(
            &root,
            "root",
            &expected,
            &TimeRange::default(),
            |args| match args {
                ["session", "delete", "--help"] => Ok("sessionID --standalone".into()),
                ["debug", "paths"] => Ok(json!({"data":root}).to_string()),
                ["session", "delete", "root", "--standalone"] => {
                    db.execute("DELETE FROM session_v2", []).unwrap();
                    Ok(String::new())
                }
                _ => panic!("unexpected native operation"),
            },
        )
        .unwrap();
        drop(db);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn opencode_target_mismatch_never_reaches_delete_command() {
        let root =
            std::env::temp_dir().join(format!("cyapi-cleanup-mismatch-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let result =
            opencode_delete_using(
                &root,
                "fixture",
                &[],
                &TimeRange::default(),
                |args| match args {
                    ["session", "delete", "--help"] => Ok("sessionID --standalone".into()),
                    ["debug", "paths"] => Ok(json!({"data":root.join("other")}).to_string()),
                    _ => panic!("must never call native delete for a mismatched data root"),
                },
            );
        assert!(result.unwrap_err().contains("不一致"));
        fs::remove_dir_all(&root).unwrap();
    }
}
