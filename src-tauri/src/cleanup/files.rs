use super::*;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    time::UNIX_EPOCH,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Stamp {
    path: PathBuf,
    bytes: u64,
    modified: u128,
    hash: String,
    directory: bool,
}

fn walk(root: &Path, path: &Path, out: &mut Vec<Stamp>, depth: usize) -> Result<()> {
    if !path.starts_with(root) || path == root || depth > 24 || out.len() >= 100_000 {
        return Err("会话文件越界或超过扫描限额".into());
    }
    checked(path)?;
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("无法读取会话文件属性".into()),
    };
    if !meta.is_file() && !meta.is_dir() {
        return Err("会话包含不支持的特殊文件".into());
    }
    let stamp = Stamp {
        path: path.into(),
        bytes: if meta.is_file() { meta.len() } else { 0 },
        modified: meta
            .modified()
            .map_err(|_| "无法读取修改时间")?
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "会话修改时间无效")?
            .as_nanos(),
        // Metadata detects transcript/attachment writes without reading multi-GB bodies.
        hash: String::new(),
        directory: meta.is_dir(),
    };
    out.push(stamp);
    if meta.is_dir() {
        for entry in fs::read_dir(path).map_err(|_| "无法读取会话目录")? {
            walk(
                root,
                &entry.map_err(|_| "无法读取会话目录项")?.path(),
                out,
                depth + 1,
            )?;
        }
    }
    Ok(())
}

fn stamps(root: &Path, paths: &[PathBuf]) -> Result<Vec<Stamp>> {
    let mut out = Vec::new();
    for path in paths {
        walk(root, path, &mut out, 0)?;
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn session_paths(root: &Path, transcript: &Path, id: &str) -> Vec<PathBuf> {
    let mut paths = vec![transcript.into(), transcript.with_extension("")];
    for dir in ["file-history", "image-cache", "uploads"] {
        paths.push(root.join(dir).join(id));
    }
    paths
}

fn read_json(path: &Path) -> Result<Value> {
    serde_json::from_slice(&read_index(path)?).map_err(|_| "会话索引格式无效".into())
}

fn read_index(path: &Path) -> Result<Vec<u8>> {
    checked(path)?;
    if fs::metadata(path).map_err(|_| "无法读取会话索引")?.len() > 16 * 1024 * 1024 {
        return Err("会话索引超过 16 MB，已停止清理".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "无法打开会话索引")?
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取会话索引")?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("会话索引超过读取限额".into());
    }
    Ok(bytes)
}

pub(super) fn claude(root: &Path) -> Result<Vec<Item>> {
    let projects = root.join("projects");
    checked(&projects)?;
    if !projects.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut scanned_files = 0usize;
    for project in fs::read_dir(&projects).map_err(|_| "无法读取 Claude 项目目录")? {
        let project = project.map_err(|_| "无法读取 Claude 项目")?.path();
        checked(&project)?;
        if !project.is_dir() {
            continue;
        }
        let index_path = project.join("sessions-index.json");
        let index = if index_path.exists() {
            let v = read_json(&index_path)?;
            if v.get("version").and_then(Value::as_u64) != Some(1) || !v["entries"].is_array() {
                return Err("Claude 会话索引版本不受支持，未生成删除计划".into());
            }
            Some(v)
        } else {
            None
        };
        let shared_index = if index.is_some() {
            let mut shared = stamps(root, std::slice::from_ref(&index_path))?;
            shared.first_mut().ok_or("会话索引已变化，请重新扫描")?.hash =
                format!("{:x}", Sha256::digest(read_index(&index_path)?));
            shared
        } else {
            Vec::new()
        };
        for entry in fs::read_dir(&project).map_err(|_| "无法读取 Claude 会话目录")? {
            let path = entry.map_err(|_| "无法读取 Claude 会话")?.path();
            if path.extension().is_none_or(|s| s != "jsonl") {
                continue;
            }
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if uuid::Uuid::parse_str(id).is_err() {
                continue;
            }
            let paths = session_paths(root, &path, id);
            let mut files = stamps(root, &paths)?;
            scanned_files += files.len();
            if scanned_files > 200_000 {
                return Err("Claude 会话附件超过扫描限额，未生成删除计划".into());
            }
            let mut updated_at = files
                .iter()
                .map(|s| (s.modified / 1_000_000) as u64)
                .max()
                .unwrap_or(0);
            let bytes = files.iter().map(|s| s.bytes).sum();
            // Bind the shared index to this plan too, but never count/delete it as an attachment.
            files.extend(shared_index.iter().cloned());
            let indexed = index
                .as_ref()
                .and_then(|v| v["entries"].as_array())
                .and_then(|entries| entries.iter().find(|v| v["sessionId"].as_str() == Some(id)));
            if let Some(time) = indexed
                .and_then(|v| v.get("modified"))
                .filter(|v| !v.is_null())
            {
                let modified = time
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .and_then(|t| u64::try_from(t.timestamp_millis()).ok())
                    .unwrap_or_else(logging::now);
                updated_at = updated_at.max(modified);
            }
            let title = indexed
                .and_then(|v| v["summary"].as_str())
                .unwrap_or(id)
                .chars()
                .take(120)
                .collect();
            out.push(Item {
                id: id.into(),
                title,
                updated_at,
                bytes,
                sessions: 1,
                parent: String::new(),
                fork: String::new(),
                files,
            });
            if out.len() > LIMIT {
                return Err("Claude 会话超过扫描限额".into());
            }
        }
    }
    Ok(out)
}

fn remove(stamp: &Stamp) -> Result<()> {
    checked(&stamp.path)?;
    if stamp.directory {
        fs::remove_dir(&stamp.path).map_err(|_| "无法删除会话目录（可能已被占用或发生变化）".into())
    } else {
        fs::remove_file(&stamp.path).map_err(|_| "无法删除会话文件（可能已被占用）".into())
    }
}

pub(super) fn delete_claude(root: &Path, item: &Item) -> Result<u64> {
    let transcript = item
        .files
        .iter()
        .find(|s| {
            s.path.extension().is_some_and(|e| e == "jsonl")
                && s.path.file_stem().is_some_and(|s| s == item.id.as_str())
        })
        .ok_or("找不到会话正文")?
        .path
        .clone();
    let paths = session_paths(root, &transcript, &item.id);
    let index = transcript
        .parent()
        .ok_or("会话路径无效")?
        .join("sessions-index.json");
    let expected: Vec<_> = item
        .files
        .iter()
        .filter(|s| s.path != index)
        .cloned()
        .collect();
    if stamps(root, &paths)? != expected {
        return Err("会话文件已变化，请重新扫描".into());
    }
    // Stage a replacement before removing anything, and reject concurrent index edits.
    let original_index = if index.exists() {
        Some(read_index(&index)?)
    } else {
        None
    };
    let mut updated_index: Option<Value> = original_index
        .as_ref()
        .map(|bytes| serde_json::from_slice(bytes).map_err(|_| "会话索引格式无效".to_string()))
        .transpose()?;
    if let Some(v) = &mut updated_index {
        v["entries"]
            .as_array_mut()
            .ok_or("会话索引格式无效")?
            .retain(|v| v["sessionId"].as_str() != Some(&item.id));
    }
    let temporary = index.with_file_name(format!(".cleanup-{}.tmp", uuid::Uuid::new_v4()));
    let result: Result<()> = (|| {
        if let Some(v) = &updated_index {
            checked(&temporary)?;
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| "无法暂存会话索引")?;
            f.write_all(&serde_json::to_vec(&v).map_err(|_| "无法编码会话索引")?)
                .map_err(|_| "无法写入会话索引")?;
            f.sync_all().map_err(|_| "无法保存会话索引")?;
            drop(f);
        }
        let check_index = || -> Result<()> {
            let current = if index.exists() {
                Some(read_index(&index)?)
            } else {
                None
            };
            if current != original_index {
                return Err("共享会话索引已变化，已停止清理；请重新扫描".into());
            }
            Ok(())
        };
        check_index()?;
        // Descendants first; transcript last, so an attachment error keeps it discoverable.
        let mut ordered = expected;
        ordered.sort_by_key(|s| {
            (
                s.path == transcript,
                std::cmp::Reverse(s.path.components().count()),
            )
        });
        for stamp in &ordered {
            remove(stamp)?;
        }
        if updated_index.is_some() {
            check_index()?;
            checked(&index)?;
            fs::rename(&temporary, &index).map_err(|_| "会话已删除，但索引更新失败".to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(item.bytes)
}

pub(super) fn toolbox_cache(data: &Path) -> Result<Outcome> {
    checked(data)?;
    let cache = data.join("cache");
    checked(&cache)?;
    let mut result = Outcome::default();
    if !cache.exists() {
        return Ok(result);
    }
    // Only complete content-addressed installer downloads, never backups, runtimes,
    // catalogs, settings, logs, active partial downloads or third-party tool data.
    for entry in fs::read_dir(&cache).map_err(|_| "无法读取工具箱缓存")? {
        let path = entry.map_err(|_| "无法读取工具箱缓存项")?.path();
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name.len() < 64
            || !name.as_bytes()[..64].iter().all(u8::is_ascii_hexdigit)
            || !["", ".exe", ".skillpack.json", ".zip", ".tar.gz", ".tar.xz"].contains(&&name[64..])
        {
            continue;
        }
        let attempt = (|| {
            let entries = stamps(data, std::slice::from_ref(&path))?;
            let Some(stamp) = entries.first() else {
                return Ok(0);
            };
            if stamp.directory
                || logging::now().saturating_sub((stamp.modified / 1_000_000) as u64) < DAY
            {
                return Ok(0);
            }
            remove(stamp)?;
            Ok(stamp.bytes)
        })();
        match attempt {
            Ok(bytes) => result.reclaimed_bytes += bytes,
            Err(e) => result.errors.push(e),
        }
    }
    result.notes.push(
        "仅清理超过 24 小时的工具箱安装包缓存；保留备份、运行环境、安装记录及所有工具会话。".into(),
    );
    Ok(result)
}
