use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Scope {
    pub root: PathBuf,
    pub label: String,
    pub role: String,
}

#[derive(Clone)]
pub(super) enum Action {
    File { root: PathBuf, stamp: files::Stamp },
    Session(Item),
    Logs(logdb::LogDatabase),
}

pub(super) struct Analysis {
    pub scan: Scan,
    pub all: Vec<Item>,
    pub actions: HashMap<String, Action>,
    pub scopes: Vec<Scope>,
}

pub(super) fn scopes(workspace: &str, main: &Path) -> Result<Vec<Scope>> {
    let mut out = vec![Scope {
        root: main.into(),
        label: "工具数据".into(),
        role: "data".into(),
    }];
    let isolated = std::env::var_os("CYAPI_TOOLBOX_HOME_DIR").is_some();
    let env = |key: &str| {
        std::env::var_os(key)
            .filter(|_| !isolated)
            .map(PathBuf::from)
    };
    let home = diagnostics::home_path();
    if workspace == "opencode" {
        for (role, label, key, fallback) in [
            ("cache", "工具缓存", "XDG_CACHE_HOME", ".cache"),
            ("state", "服务状态", "XDG_STATE_HOME", ".local/state"),
            ("config", "工具配置", "XDG_CONFIG_HOME", ".config"),
        ] {
            out.push(Scope {
                root: env(key)
                    .unwrap_or_else(|| home.join(fallback))
                    .join("opencode"),
                label: label.into(),
                role: role.into(),
            });
        }
    }
    if workspace == "codex" {
        let config = main.join("config.toml");
        checked(&config)?;
        if fs::metadata(&config).is_ok_and(|m| m.len() <= 1_000_000) {
            if let Ok(doc) = fs::read_to_string(&config)
                .unwrap_or_default()
                .parse::<toml_edit::DocumentMut>()
            {
                for (key, label, role) in [
                    ("log_dir", "自定义日志", "logs"),
                    ("sqlite_home", "自定义数据库", "database"),
                ] {
                    if let Some(value) = doc.get(key).and_then(|v| v.as_str()) {
                        let path = PathBuf::from(value);
                        out.push(Scope {
                            root: if path.is_absolute() {
                                path
                            } else {
                                main.join(path)
                            },
                            label: label.into(),
                            role: role.into(),
                        });
                    }
                }
            }
        }
    }
    for scope in &out {
        checked(&scope.root)?;
        if scope.root == home || scope.root.parent().is_none() {
            return Err("工具目录配置过于宽泛，不能扫描用户主目录或磁盘根目录".into());
        }
    }
    normalize_scopes(out)
}

fn normalize_scopes(out: Vec<Scope>) -> Result<Vec<Scope>> {
    // Prefer the main data scope and never count overlapping roots twice.
    let mut unique: Vec<Scope> = Vec::new();
    for scope in out {
        if unique.iter().any(|s| scope.root.starts_with(&s.root)) {
            continue;
        }
        if unique.iter().any(|s| s.root.starts_with(&scope.root)) {
            return Err("工具数据目录相互覆盖，已停止扫描".into());
        }
        unique.push(scope);
    }
    Ok(unique)
}

fn classify(workspace: &str, scope: &Scope, relative: &Path) -> (&'static str, bool, &'static str) {
    let parts: Vec<_> = relative.iter().filter_map(|s| s.to_str()).collect();
    let first = parts.first().copied().unwrap_or("");
    let name = parts.last().copied().unwrap_or("");
    // A custom log directory may also contain unrelated user data. Directory names
    // alone never authorize deletion of configuration, credentials, memory or code.
    if parts.iter().any(|p| {
        matches!(
            p.to_ascii_lowercase().as_str(),
            "memory"
                | "agent-memory"
                | "skills"
                | "plugins"
                | "auth.json"
                | "config.toml"
                | "settings.json"
                | "settings.local.json"
                | ".credentials.json"
                | "credentials.json"
                | "opencode.json"
                | "opencode.jsonc"
                | "agents.md"
                | "claude.md"
                | "config"
                | "credentials"
                | "secrets"
                | "auth"
                | ".env"
                | "node_modules"
                | "bin"
                | "runtime"
        )
    }) || [".pem", ".key", ".p12", ".pfx", ".exe", ".dll", ".msi"]
        .iter()
        .any(|ext| name.to_ascii_lowercase().ends_with(ext))
    {
        return ("other", false, "配置、凭据、记忆及安装资源，始终保留");
    }
    let database = name.ends_with(".db")
        || name.ends_with(".sqlite")
        || name.ends_with(".sqlite3")
        || name.ends_with("-wal")
        || name.ends_with("-shm")
        || name.ends_with("-journal");
    if workspace == "codex" && (name.starts_with("logs_") && database) {
        return (
            "logs",
            false,
            "日志数据库按记录时间清理，不能直接删除数据库文件",
        );
    }
    if scope.role == "config" || scope.role == "state" {
        return ("other", false, "配置、凭据及后台服务状态，始终保留");
    }
    if database {
        return (
            if workspace == "opencode" {
                "sessions"
            } else {
                "other"
            },
            false,
            "数据库、索引及共享页不能作为普通文件删除",
        );
    }
    if name.ends_with(".lock") || name == "lock" || name.ends_with(".lock.json") {
        return ("other", false, "锁文件和并发协调状态，始终保留");
    }
    if scope.role == "cache" {
        return ("cache", true, "可再生成的工具缓存；下次启动可能重新下载");
    }
    let log_file = name.ends_with(".log")
        || name.ends_with(".log.gz")
        || name.ends_with(".log.zst")
        || name
            .rsplit_once(".log.")
            .is_some_and(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    if scope.role == "logs" {
        return if log_file {
            ("logs", true, "独立日志文件")
        } else {
            ("other", false, "自定义日志目录中的未识别文件，保持只读")
        };
    }
    match workspace {
        "codex" => match first {
            "sessions" | "archived_sessions" => ("sessions", false, "按完整会话及关联关系清理"),
            "log" | "logs" if log_file => ("logs", true, "独立日志文件"),
            "tmp" | "shell_snapshots" => ("temporary", true, "临时工作文件；关闭工具后可清理"),
            "cache" => ("cache", true, "可再生成的缓存"),
            "models_cache.json" | "models_cache.etag" => {
                ("cache", true, "模型目录缓存，不是模型接入配置")
            }
            _ => ("other", false, "配置、安装资源、记忆或未识别数据，始终保留"),
        },
        "claude" => match first {
            "projects"
                if parts
                    .iter()
                    .any(|p| matches!(*p, "memory" | "agent-memory")) =>
            {
                ("other", false, "长期记忆，始终保留")
            }
            "projects" | "file-history" | "image-cache" | "uploads" => {
                ("sessions", false, "会话正文或附件，按完整会话清理")
            }
            "debug"
                if log_file
                    || (parts.len() == 2
                        && name.ends_with(".txt")
                        && uuid::Uuid::parse_str(name.trim_end_matches(".txt")).is_ok()) =>
            {
                ("logs", true, "调试/运行日志")
            }
            "logs" if log_file => ("logs", true, "独立运行日志"),
            "paste-cache" | "stats-cache.json" => {
                ("cache", true, "粘贴或统计缓存，清理后部分历史统计可能重建")
            }
            "cache" if relative == Path::new("cache/changelog.md") => {
                ("cache", true, "发行说明缓存")
            }
            "tmp" | "shell-snapshots" | "session-env" => {
                ("temporary", true, "临时文件/环境快照；关闭工具后可清理")
            }
            _ => (
                "other",
                false,
                "配置、插件、任务、计划、备份或未识别数据，始终保留",
            ),
        },
        "opencode" => match first {
            "log" | "logs" if log_file => ("logs", true, "独立运行日志"),
            "cache" => ("cache", true, "可再生成的缓存"),
            "tmp" | "temp" => ("temporary", true, "临时文件；关闭工具后可清理"),
            "storage" | "snapshot" | "tool-output" => (
                "sessions",
                false,
                "会话关联资源或撤销快照，不单独删除以免破坏历史",
            ),
            _ => ("other", false, "配置、凭据、安装资源或未识别数据，始终保留"),
        },
        _ => ("other", false, "未识别数据，保持只读"),
    }
}

struct Raw {
    scope: Scope,
    stamp: files::Stamp,
    category: String,
    deletable: bool,
    reason: String,
}

fn walk(
    workspace: &str,
    scope: &Scope,
    path: &Path,
    raw: &mut Vec<Raw>,
    notes: &mut Vec<String>,
    partial: &mut bool,
    depth: usize,
) {
    if raw.len() >= 100_000 || depth > 24 {
        *partial = true;
        return;
    }
    if checked(path).is_err() {
        *partial = true;
        if notes.len() < 20 {
            notes.push("已跳过符号链接、目录联接或无法安全检查的位置；未跟随到其他目录。".into());
        }
        return;
    }
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            *partial = true;
            return;
        }
    };
    if meta.is_dir() {
        let Ok(entries) = fs::read_dir(path) else {
            *partial = true;
            return;
        };
        for entry in entries {
            if let Ok(entry) = entry {
                walk(
                    workspace,
                    scope,
                    &entry.path(),
                    raw,
                    notes,
                    partial,
                    depth + 1,
                );
            } else {
                *partial = true;
            }
            if raw.len() >= 100_000 {
                *partial = true;
                break;
            }
        }
    } else if meta.is_file() {
        let relative = path.strip_prefix(&scope.root).unwrap_or(path);
        let (category, deletable, reason) = classify(workspace, scope, relative);
        match files::stamps(&scope.root, &[path.into()]) {
            Ok(stamps) => {
                for stamp in stamps {
                    raw.push(Raw {
                        scope: scope.clone(),
                        stamp,
                        category: category.into(),
                        deletable,
                        reason: reason.into(),
                    });
                }
            }
            Err(_) => *partial = true,
        }
    } else {
        *partial = true;
    }
}

pub(super) fn session_entries(
    all: &[Item],
    capability: &std::result::Result<(), String>,
) -> Result<Vec<(Entry, Option<Action>)>> {
    // candidates(MAX) validates the full graph and identifies fork/missing-parent protection.
    let eligible: HashSet<_> = candidates(all, u64::MAX)?
        .into_iter()
        .map(|i| i.id)
        .collect();
    let map: HashMap<_, _> = all.iter().map(|i| (i.id.as_str(), i)).collect();
    let mut groups: HashMap<&str, Vec<&Item>> = HashMap::new();
    for item in all {
        let mut node = item;
        while let Some(parent) = map.get(node.parent.as_str()) {
            node = parent;
        }
        groups.entry(&node.id).or_default().push(item);
    }
    let mut result = Vec::new();
    for (id, members) in groups {
        let mut item = map[id].clone();
        item.bytes = members.iter().map(|i| i.bytes).sum();
        item.sessions = members.len();
        item.updated_at = members.iter().map(|i| i.updated_at).max().unwrap_or(0);
        let min = members.iter().map(|i| i.updated_at).min().unwrap_or(0);
        let reason = capability.as_ref().err().cloned().unwrap_or_else(|| {
            if eligible.contains(id) {
                String::new()
            } else {
                "有其他会话引用、父会话缺失或时间未知，不能安全删除".into()
            }
        });
        let entry = Entry {
            id: format!("session:{id}"),
            title: item.title.clone(),
            category: "sessions".into(),
            kind: "session".into(),
            path: String::new(),
            bytes: item.bytes,
            files: members
                .iter()
                .map(|i| i.files.iter().filter(|s| !s.directory).count())
                .sum(),
            sessions: item.sessions,
            records: 0,
            min_updated_at: min,
            updated_at: item.updated_at,
            deletable: reason.is_empty(),
            reason,
            estimated: item.files.is_empty(),
        };
        let action = entry.deletable.then_some(Action::Session(item));
        result.push((entry, action));
    }
    Ok(result)
}

pub(super) fn build(workspace: &str, root: &Path) -> Result<Analysis> {
    let scopes = scopes(workspace, root)?;
    build_scopes(
        workspace,
        root,
        scopes,
        native::session_capability(workspace),
    )
}

pub(super) fn build_scopes(
    workspace: &str,
    root: &Path,
    scopes: Vec<Scope>,
    capability: std::result::Result<(), String>,
) -> Result<Analysis> {
    let scopes = normalize_scopes(scopes)?;
    let mut notes = vec!["占用按文件逻辑大小统计，只扫描本工具的数据目录，不扫描项目文件或整个磁盘。SQLite/WAL 只计入一次；会话列表中的数据库记录大小是逻辑估算，不能与磁盘总量再次相加。".into()];
    let mut partial = false;
    let mut raw = Vec::new();
    for scope in &scopes {
        walk(
            workspace,
            scope,
            &scope.root,
            &mut raw,
            &mut notes,
            &mut partial,
            0,
        );
    }
    let mut categories: Vec<Category> = [
        ("logs", "日志"),
        ("sessions", "会话与附件"),
        ("cache", "缓存"),
        ("temporary", "临时文件"),
        ("other", "配置、资源及其他（保留）"),
    ]
    .into_iter()
    .map(|(id, title)| Category {
        id: id.into(),
        title: title.into(),
        bytes: 0,
        files: 0,
    })
    .collect();
    for file in &raw {
        let category = categories
            .iter_mut()
            .find(|c| c.id == file.category)
            .unwrap();
        category.bytes += file.stamp.bytes;
        category.files += 1;
    }
    let mut items = Vec::new();
    let mut actions = HashMap::new();
    let mut consumed = HashSet::new();
    let all = match inventory(workspace, root) {
        Ok(all) => {
            match session_entries(&all, &capability) {
                Ok(entries) => {
                    for (entry, action) in entries {
                        if let Some(action) = action {
                            actions.insert(entry.id.clone(), action);
                        }
                        items.push(entry);
                    }
                    for item in &all {
                        for file in &item.files {
                            if file
                                .path
                                .file_name()
                                .is_none_or(|n| n != "sessions-index.json")
                            {
                                consumed.insert(file.path.clone());
                            }
                        }
                    }
                }
                Err(e) => {
                    notes.push(e);
                    partial = true;
                }
            }
            all
        }
        Err(e) => {
            notes.push(format!(
                "会话元数据不可解析：{e}。磁盘占用仍已统计，日志、缓存和临时文件不受影响。"
            ));
            Vec::new()
        }
    };
    if let Err(e) = capability {
        notes.push(e);
    }
    if workspace == "codex" {
        for file in &raw {
            let name = file
                .stamp
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            let log_db = name
                .strip_prefix("logs_")
                .and_then(|n| n.strip_suffix(".sqlite"))
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
            if log_db
                && file.stamp.path.parent() == Some(file.scope.root.as_path())
                && matches!(file.scope.role.as_str(), "data" | "database" | "logs")
            {
                if let Ok(db) = logdb::inspect(&file.stamp.path) {
                    let id = uuid::Uuid::new_v4().to_string();
                    items.push(Entry {
                        id: id.clone(),
                        title: "日志数据库（按记录时间清理）".into(),
                        category: "logs".into(),
                        kind: "logDatabase".into(),
                        path: db.path.to_string_lossy().into(),
                        bytes: db.bytes,
                        files: 1,
                        sessions: 0,
                        records: db.records,
                        min_updated_at: db.first,
                        updated_at: db.last,
                        deletable: db.records > 0,
                        reason: if db.records == 0 {
                            "日志表为空".into()
                        } else {
                            "仅删除所选时间范围内的日志记录；保留数据库和其他数据表".into()
                        },
                        estimated: true,
                    });
                    for path in [
                        &db.path,
                        &PathBuf::from(format!("{}-wal", db.path.display())),
                        &PathBuf::from(format!("{}-shm", db.path.display())),
                    ] {
                        consumed.insert(path.clone());
                    }
                    actions.insert(id, Action::Logs(db));
                }
            }
        }
    }
    let mut protected: HashMap<(String, String), Entry> = HashMap::new();
    for file in raw {
        if consumed.contains(&file.stamp.path) {
            continue;
        }
        let relative = file
            .stamp
            .path
            .strip_prefix(&file.scope.root)
            .unwrap_or(&file.stamp.path);
        if file.deletable {
            let id = uuid::Uuid::new_v4().to_string();
            let time = file.stamp.time();
            items.push(Entry {
                id: id.clone(),
                title: relative.to_string_lossy().into(),
                category: file.category,
                kind: "file".into(),
                path: file.stamp.path.to_string_lossy().into(),
                bytes: file.stamp.bytes,
                files: 1,
                sessions: 0,
                records: 0,
                min_updated_at: time,
                updated_at: time,
                deletable: time > 0,
                reason: file.reason,
                estimated: false,
            });
            actions.insert(
                id,
                Action::File {
                    root: file.scope.root,
                    stamp: file.stamp,
                },
            );
        } else {
            let top = relative
                .iter()
                .next()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let path = file.scope.root.join(top).to_string_lossy().into_owned();
            let entry = protected
                .entry((file.category.clone(), path.clone()))
                .or_insert_with(|| Entry {
                    id: uuid::Uuid::new_v4().to_string(),
                    title: relative
                        .iter()
                        .next()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into(),
                    category: file.category,
                    kind: "protected".into(),
                    path,
                    bytes: 0,
                    files: 0,
                    sessions: 0,
                    records: 0,
                    min_updated_at: u64::MAX,
                    updated_at: 0,
                    deletable: false,
                    reason: file.reason,
                    estimated: false,
                });
            entry.bytes += file.stamp.bytes;
            entry.files += 1;
            entry.updated_at = entry.updated_at.max(file.stamp.time());
            entry.min_updated_at = entry.min_updated_at.min(file.stamp.time());
        }
    }
    items.extend(protected.into_values());
    items.sort_by(|a, b| b.bytes.cmp(&a.bytes).then(a.id.cmp(&b.id)));
    notes.sort();
    notes.dedup();
    if partial {
        notes.push(
            "存在无法访问的位置、链接或扫描限额：总量仅代表已扫描部分，未读取的位置不会被清理。"
                .into(),
        );
    }
    let scan = Scan {
        token: uuid::Uuid::new_v4().to_string(),
        workspace: workspace.into(),
        root: root.to_string_lossy().into(),
        roots: scopes
            .iter()
            .map(|s| RootView {
                path: s.root.to_string_lossy().into(),
                label: s.label.clone(),
                exists: s.root.exists(),
            })
            .collect(),
        total_bytes: categories.iter().map(|c| c.bytes).sum(),
        categories,
        items,
        partial,
        notes,
    };
    Ok(Analysis {
        scan,
        all,
        actions,
        scopes,
    })
}
