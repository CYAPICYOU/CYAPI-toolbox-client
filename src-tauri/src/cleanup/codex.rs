use super::*;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};

// Metadata-only discovery must not require or start a CLI/app-server.
pub(super) fn list(root: &Path) -> Result<Vec<Item>> {
    let mut paths = Vec::new();
    for directory in ["sessions", "archived_sessions"] {
        collect(&root.join(directory), &mut paths, 0)?;
    }
    let mut sessions: HashMap<String, Item> = HashMap::new();
    for path in paths {
        let file = fs::File::open(&path).map_err(|_| "无法读取 Codex 会话元数据")?;
        let reader: Box<dyn Read> = if path.extension().is_some_and(|s| s == "zst") {
            Box::new(zstd::stream::read::Decoder::new(file).map_err(|_| "无法读取压缩会话")?)
        } else {
            Box::new(file)
        };
        let mut line = Vec::new();
        BufReader::new(reader)
            .take(2 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| "无法读取 Codex 会话首条元数据")?;
        if line.len() > 2 * 1024 * 1024 {
            return Err("Codex 会话元数据超过限额".into());
        }
        let value: Value =
            serde_json::from_slice(&line).map_err(|_| "Codex 会话元数据损坏；其他占用仍会展示")?;
        if value["type"] != "session_meta" {
            return Err("无法确认 Codex 会话关联关系".into());
        }
        let meta = &value["payload"];
        let id = meta["id"]
            .as_str()
            .filter(|s| valid_id(s))
            .ok_or("Codex 会话 ID 无效")?;
        let stamps = files::stamps(root, std::slice::from_ref(&path))?;
        let time = stamps.iter().map(files::Stamp::time).max().unwrap_or(0);
        let parent = meta["parent_thread_id"]
            .as_str()
            .or_else(|| {
                meta.pointer("/source/subagent/thread_spawn/parent_thread_id")
                    .and_then(Value::as_str)
            })
            .unwrap_or("");
        let fork = meta["forked_from_id"]
            .as_str()
            .or_else(|| {
                meta.pointer("/history_base/thread_id")
                    .and_then(Value::as_str)
            })
            .unwrap_or("");
        let references: Vec<String> = [
            meta["forked_from_id"].as_str(),
            meta.pointer("/history_base/thread_id")
                .and_then(Value::as_str),
        ]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
        let item = sessions.entry(id.into()).or_insert_with(|| Item {
            id: id.into(),
            title: id.into(),
            updated_at: 0,
            bytes: 0,
            sessions: 1,
            parent: parent.into(),
            fork: fork.into(),
            references: references.clone(),
            files: Vec::new(),
        });
        if item.parent != parent || item.fork != fork || item.references != references {
            return Err("同一 Codex 会话的多个副本关联关系不一致".into());
        }
        item.updated_at = item.updated_at.max(time);
        item.bytes += stamps.iter().map(|s| s.bytes).sum::<u64>();
        item.files.extend(stamps);
    }
    // Optional name index. A damaged index must not block disk usage discovery.
    let index = root.join("session_index.jsonl");
    checked(&index)?;
    if let Ok(file) = fs::File::open(index) {
        for line in BufReader::new(file.take(8 * 1024 * 1024))
            .lines()
            .map_while(std::result::Result::ok)
        {
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(item) = v["id"].as_str().and_then(|id| sessions.get_mut(id)) {
                if let Some(name) = v["thread_name"].as_str() {
                    item.title = name.chars().take(120).collect();
                }
                if let Some(t) = v["updated_at"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                {
                    item.updated_at = item.updated_at.max(t.timestamp_millis().max(0) as u64);
                }
            }
        }
    }
    let mut items: Vec<_> = sessions.into_values().collect();
    items.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(items)
}

fn collect(directory: &Path, out: &mut Vec<PathBuf>, depth: usize) -> Result<()> {
    checked(directory)?;
    if !directory.exists() {
        return Ok(());
    }
    if depth > 12 {
        return Err("Codex 会话目录超过扫描深度".into());
    }
    for entry in fs::read_dir(directory).map_err(|_| "无法读取 Codex 会话目录")? {
        let path = entry.map_err(|_| "无法读取 Codex 会话目录项")?.path();
        checked(&path)?;
        if path.is_dir() {
            collect(&path, out, depth + 1)?;
        } else if path.extension().is_some_and(|s| s == "jsonl")
            || path.to_string_lossy().ends_with(".jsonl.zst")
        {
            out.push(path);
            if out.len() > LIMIT * 2 {
                return Err("Codex 会话文件超过扫描限额".into());
            }
        }
    }
    Ok(())
}
