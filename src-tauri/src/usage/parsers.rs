use super::{digest, Parsed, Record, MAX_FILE_BYTES, MAX_RECORDS};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Read},
    path::Path,
};

pub(super) const MAX_LINE: usize = 4 * 1024 * 1024;

fn relevant(format: &str, bytes: &[u8]) -> bool {
    // Claude can put message/usage before its top-level type, beyond the head.
    if format != "codex" {
        return true;
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    let kind = |input: &str| -> Option<String> {
        let (_, tail) = input.split_once("\"type\"")?;
        let tail = tail
            .trim_start()
            .strip_prefix(':')?
            .trim_start()
            .strip_prefix('"')?;
        Some(tail.split('"').next()?.to_string())
    };
    match kind(&head).as_deref() {
        // Some serializers place payload.type before the envelope's type.
        Some("session_meta" | "turn_context" | "token_count" | "thread_settings_applied") => true,
        Some("event_msg") => {
            head.contains("token_count") || head.contains("thread_settings_applied")
        }
        _ => false,
    }
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn count(value: &Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(1_000_000_000_000)
}
fn model(value: &str) -> String {
    if value.trim().is_empty() {
        "unknown".into()
    } else {
        value.chars().take(160).collect()
    }
}
fn timestamp(value: &Value) -> i64 {
    value
        .as_str()
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .map(|t| t.timestamp_millis())
        .or_else(|| {
            value.as_i64().map(|n| {
                if n < 100_000_000_000 {
                    n.saturating_mul(1000)
                } else {
                    n
                }
            })
        })
        .unwrap_or(0)
}

// [input, output, cache read, cache write, reasoning, one-hour cache write].
fn counters(value: &Value) -> Option<[u64; 6]> {
    if !value.is_object()
        || (!value.get("input_tokens").is_some_and(Value::is_number)
            && !value.get("output_tokens").is_some_and(Value::is_number))
    {
        return None;
    }
    let input = count(value, "input_tokens");
    let cache = count(value, "cached_input_tokens")
        .max(count(&value["input_tokens_details"], "cached_tokens"))
        .min(input);
    Some([
        input,
        count(value, "output_tokens"),
        cache,
        count(value, "cache_write_input_tokens").min(input - cache),
        count(value, "reasoning_output_tokens"),
        0,
    ])
}
fn apply(record: &mut Record, counts: [u64; 6]) {
    [
        record.input,
        record.output,
        record.cached_input,
        record.cache_write,
        record.reasoning_output,
        record.cache_write_1h,
    ] = counts;
    record.cached_input = record.cached_input.min(record.input);
    record.cache_write = record.cache_write.min(record.input - record.cached_input);
    record.cache_write_1h = record.cache_write_1h.min(record.cache_write);
    record.reasoning_output = record.reasoning_output.min(record.output);
}

struct Codex {
    parsed: Parsed,
    model: String,
    project: String,
    high_water: [u64; 6],
    previous: String,
    snapshots: HashMap<String, String>,
    sequence: usize,
    meta_seen: bool,
}
impl Codex {
    fn new(fallback: &str) -> Self {
        Self {
            parsed: Parsed {
                session_id: fallback.into(),
                ..Default::default()
            },
            model: "unknown".into(),
            project: String::new(),
            high_water: [0; 6],
            previous: String::new(),
            snapshots: HashMap::new(),
            sequence: 0,
            meta_seen: false,
        }
    }
    fn line(&mut self, value: &Value) {
        let payload = &value["payload"];
        match text(value, "type") {
            "session_meta" if !self.meta_seen => {
                self.meta_seen = true;
                for key in ["id", "thread_id", "threadId"] {
                    if !text(payload, key).is_empty() {
                        self.parsed.session_id = text(payload, key).into();
                        break;
                    }
                }
                self.project = text(payload, "cwd").chars().take(1000).collect();
                let parent = payload
                    .get("forked_from_id")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        payload
                            .pointer("/source/subagent/thread_spawn/parent_thread_id")
                            .and_then(Value::as_str)
                    });
                self.parsed.parent_id = parent
                    .filter(|s| !s.is_empty() && *s != self.parsed.session_id)
                    .map(str::to_string);
                self.parsed.fork_at = timestamp(&value["timestamp"]);
                if !text(payload, "model").is_empty() {
                    self.model = model(text(payload, "model"));
                }
            }
            "turn_context" => {
                if !text(payload, "model").is_empty() {
                    self.model = model(text(payload, "model"));
                }
                if !text(payload, "cwd").is_empty() {
                    self.project = text(payload, "cwd").chars().take(1000).collect();
                }
            }
            "event_msg" if text(payload, "type") == "thread_settings_applied" => {
                if !text(payload, "model").is_empty() {
                    self.model = model(text(payload, "model"));
                }
            }
            "event_msg" if text(payload, "type") == "token_count" => {
                let info = &payload["info"];
                let total = counters(&info["total_token_usage"]);
                let last = counters(&info["last_token_usage"]);
                if total.is_none() && last.is_none() {
                    return;
                }
                for candidate in [
                    text(info, "model"),
                    text(info, "model_name"),
                    text(payload, "model"),
                ] {
                    if !candidate.is_empty() {
                        self.model = model(candidate);
                        break;
                    }
                }
                let signature = format!("{total:?}:{last:?}");
                let lane = text(payload, "source").to_string();
                let duplicate = total.is_some()
                    && (self.previous == signature
                        || self.snapshots.get(&lane) == Some(&signature));
                self.previous = signature.clone();
                if total.is_some() {
                    self.snapshots.insert(lane, signature.clone());
                }
                let delta = last.unwrap_or_else(|| {
                    std::array::from_fn(|i| total.unwrap()[i].saturating_sub(self.high_water[i]))
                });
                if let Some(total) = total {
                    for (old, new) in self.high_water.iter_mut().zip(total) {
                        *old = (*old).max(new);
                    }
                }
                if duplicate {
                    return;
                }
                self.sequence += 1;
                let at = timestamp(&value["timestamp"]);
                let event_key = if total.is_some() {
                    format!("{at}:{signature}")
                } else {
                    format!("{at}:{signature}:{}", self.sequence)
                };
                let mut record = Record {
                    id: digest(&format!("codex:{}:{event_key}", self.parsed.session_id)),
                    session_id: self.parsed.session_id.clone(),
                    model: self.model.clone(),
                    project: self.project.clone(),
                    time: at,
                    signature: digest(&signature),
                    total_snapshot: total,
                    exact: last.is_some(),
                    ..Default::default()
                };
                apply(&mut record, delta);
                // Keep zero deltas as hidden baselines for continuation/fork reconciliation.
                if record.nonzero() || total.is_some() {
                    self.parsed.records.push(record);
                }
            }
            _ => {}
        }
    }
}

fn claude(value: &Value, fallback: &str) -> Option<Record> {
    if text(value, "type") != "assistant" {
        return None;
    }
    let message = &value["message"];
    let usage = message.get("usage").filter(|v| v.is_object())?;
    if text(message, "model") == "<synthetic>" {
        return None;
    }
    let message_id = text(message, "id");
    if message_id.is_empty() {
        return None;
    }
    let session = if text(value, "sessionId").is_empty() {
        fallback
    } else {
        text(value, "sessionId")
    };
    let cached_input = count(usage, "cache_read_input_tokens");
    let cache_write = count(usage, "cache_creation_input_tokens");
    let cache_write_1h =
        count(&usage["cache_creation"], "ephemeral_1h_input_tokens").min(cache_write);
    let record = Record {
        // Same message may occur as several content blocks, or in resumed files.
        id: digest(&format!("claude:{message_id}")),
        session_id: session.into(),
        model: model(text(message, "model")),
        project: text(value, "cwd").chars().take(1000).collect(),
        time: timestamp(&value["timestamp"]),
        input: count(usage, "input_tokens") + cached_input + cache_write,
        output: count(usage, "output_tokens"),
        cached_input,
        cache_write,
        cache_write_1h,
        ..Default::default()
    };
    record.nonzero().then_some(record)
}

fn qwen(value: &Value, fallback: &str) -> Option<Record> {
    // `~/.qwen/usage/token-usage-YYYY-MM.jsonl` writes one line per API
    // response. inputTokens already includes the cached portion, so cached
    // tokens are reported as a subset rather than added to the input again.
    let id = text(value, "id");
    if id.is_empty() {
        return None;
    }
    let session = if text(value, "sessionId").is_empty() {
        fallback
    } else {
        text(value, "sessionId")
    };
    let input = count(value, "inputTokens");
    let cached = count(value, "cachedTokens").min(input);
    let reasoning = count(value, "thoughtsTokens");
    let record = Record {
        id: digest(&format!("qwen:{id}")),
        session_id: session.into(),
        model: model(text(value, "model")),
        // The record carries no working directory; usage.rs fills it from
        // the session summary when that is available.
        project: String::new(),
        time: timestamp(&value["timestamp"]),
        input,
        // Output includes reasoning so the numbers stay nested, matching
        // the contract every other workspace parser keeps.
        output: count(value, "outputTokens") + reasoning,
        cached_input: cached,
        reasoning_output: reasoning,
        ..Default::default()
    };
    record.nonzero().then_some(record)
}

/// Maps `sessionId` to the project directory recorded by the session summary.
/// The summary file is small and optional, so a missing file is not an error.
pub(super) fn qwen_session_projects(path: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(meta) = std::fs::metadata(path) else {
        return map;
    };
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return map;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return map;
    };
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let id = text_of(&value, "sessionId");
        let project = text_of(&value, "project");
        if !id.is_empty() && !project.is_empty() {
            map.insert(id.to_string(), project.chars().take(1000).collect());
        }
    }
    map
}

/// Reads the `cwd` envelope of every Qwen transcript under
/// `~/.qwen/projects/<dir>/chats/<sessionId>.jsonl`. Chat transcripts exist
/// for every session, while the summary ledger only covers some of them.
pub(super) fn qwen_transcript_projects(projects_dir: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(dirs) = std::fs::read_dir(projects_dir) else {
        return map;
    };
    for dir in dirs.flatten() {
        let chats = dir.path().join("chats");
        let Ok(files) = std::fs::read_dir(&chats) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let Some(id) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
                continue;
            };
            // Only the head matters, so a bounded read avoids loading a long
            // transcript. The envelope carries `cwd` on every record.
            let head = read_head(&path, 8 * 1024);
            for line in head.lines() {
                let Ok(value) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                let cwd = text_of(&value, "cwd");
                if !cwd.is_empty() {
                    map.insert(id, cwd.chars().take(1000).collect());
                    break;
                }
            }
        }
    }
    map
}

fn read_head(path: &Path, limit: u64) -> String {
    use std::io::Read as _;
    let Ok(file) = std::fs::File::open(path) else {
        return String::new();
    };
    let mut buffer = Vec::new();
    if file.take(limit).read_to_end(&mut buffer).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buffer).into_owned()
}


fn text_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

pub(super) fn opencode(
    value: &Value,
    fallback_id: &str,
    fallback_session: &str,
    fallback_time: i64,
    kind: &str,
) -> Option<Record> {
    if kind == "compaction" {
        if !matches!(text(value, "status"), "completed" | "failed") {
            return None;
        }
    } else if value
        .pointer("/time/completed")
        .filter(|v| v.is_number())
        .is_none()
    {
        return None;
    }
    let tokens = value.get("tokens").filter(|v| v.is_object())?;
    let session = if text(value, "sessionID").is_empty() {
        fallback_session
    } else {
        text(value, "sessionID")
    };
    let id = if text(value, "id").is_empty() {
        fallback_id
    } else {
        text(value, "id")
    };
    let model_id = value
        .get("modelID")
        .and_then(Value::as_str)
        .or_else(|| value.get("model").and_then(Value::as_str))
        .or_else(|| value.pointer("/model/id").and_then(Value::as_str))
        .unwrap_or("unknown");
    let cached_input = count(&tokens["cache"], "read");
    let cache_write = count(&tokens["cache"], "write");
    let reasoning = count(tokens, "reasoning");
    let time = value
        .pointer("/time/created")
        .map(timestamp)
        .filter(|n| *n > 0)
        .unwrap_or(fallback_time);
    let record = Record {
        id: digest(&format!("opencode:{session}:{id}")),
        session_id: session.into(),
        model: model(model_id),
        project: text(&value["path"], "cwd").chars().take(1000).collect(),
        time,
        input: count(tokens, "input") + cached_input + cache_write,
        output: count(tokens, "output") + reasoning,
        cached_input,
        cache_write,
        reasoning_output: reasoning,
        // Zero is commonly OpenCode's sentinel for unknown pricing, not a free request.
        reported_cost: value
            .get("cost")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v > 0.0),
        ..Default::default()
    };
    record.nonzero().then_some(record)
}

pub(super) fn opencode_file(path: &Path) -> Result<Parsed, String> {
    let bytes = std::fs::read(path).map_err(|_| "无法读取消息文件")?;
    if bytes.len() > MAX_LINE {
        return Err("消息文件超过 4 MB，已跳过".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "消息 JSON 无效")?;
    let mut parsed = Parsed::default();
    if text(&value, "role") == "assistant" {
        let id = path.file_stem().unwrap_or_default().to_string_lossy();
        let session = path
            .parent()
            .and_then(Path::file_name)
            .unwrap_or_default()
            .to_string_lossy();
        if let Some(record) = opencode(&value, &id, &session, 0, "assistant") {
            parsed.records.push(record);
        }
    }
    Ok(parsed)
}

pub(super) fn jsonl(path: &Path, format: &str) -> Result<Parsed, String> {
    let file = File::open(path).map_err(|_| "无法只读打开会话文件")?;
    let input: Box<dyn Read> = if path.extension().is_some_and(|e| e == "zst") {
        Box::new(zstd::stream::read::Decoder::new(file).map_err(|_| "无法解压会话记录")?)
    } else {
        Box::new(file)
    };
    // Bound the decompressed stream as well as the on-disk file.
    let mut reader = BufReader::with_capacity(64 * 1024, input.take(MAX_FILE_BYTES));
    let fallback = path.file_stem().unwrap_or_default().to_string_lossy();
    let mut codex = Codex::new(&fallback);
    let mut parsed = Parsed {
        session_id: fallback.into(),
        ..Default::default()
    };
    let mut bytes = Vec::new();
    let mut malformed = 0;
    let mut oversized = 0;
    loop {
        bytes.clear();
        let read = (&mut reader)
            .take(MAX_LINE as u64 + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|_| "读取会话文件失败")?;
        if read == 0 {
            break;
        }
        if bytes.len() > MAX_LINE {
            if !bytes.ends_with(b"\n") {
                loop {
                    let buffer = reader.fill_buf().map_err(|_| "跳过过大记录失败")?;
                    if buffer.is_empty() {
                        break;
                    }
                    let end = buffer.iter().position(|b| *b == b'\n');
                    let consumed = end.map_or(buffer.len(), |n| n + 1);
                    reader.consume(consumed);
                    if end.is_some() {
                        break;
                    }
                }
            }
            // Huge tool output is deliberately irrelevant to usage. Only report
            // incomplete data when a skipped line could actually carry usage.
            oversized += usize::from(relevant(format, &bytes));
            continue;
        }
        let line = String::from_utf8_lossy(&bytes);
        let line = line.trim_start_matches('\u{feff}');
        if !relevant(format, &bytes) {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(value) => {
                if format == "codex" {
                    codex.line(&value);
                } else if format == "qwen" {
                    if let Some(record) = qwen(&value, &parsed.session_id) {
                        parsed.records.push(record);
                    }
                } else if let Some(record) = claude(&value, &parsed.session_id) {
                    parsed.records.push(record);
                }
            }
            Err(_) => malformed += 1,
        }
        if parsed.records.len().max(codex.parsed.records.len()) >= MAX_RECORDS {
            parsed
                .warnings
                .push(format!("单文件超过 {MAX_RECORDS} 条用量，已停止读取"));
            break;
        }
    }
    if format == "codex" {
        codex.parsed.warnings.append(&mut parsed.warnings);
        parsed = codex.parsed;
    }
    if reader.get_ref().limit() == 0 {
        parsed
            .warnings
            .push("解压后内容达到 512 MB 上限，结果不完整".into());
    }
    if malformed > 0 {
        parsed
            .warnings
            .push(format!("{malformed} 条用量行无效或尚未写完，刷新时重试"));
    }
    if oversized > 0 {
        parsed
            .warnings
            .push(format!("{oversized} 行超过 4 MB，已跳过"));
    }
    let missing_time = parsed.records.iter().filter(|r| r.time <= 0).count();
    if missing_time > 0 {
        parsed
            .warnings
            .push(format!("{missing_time} 条用量缺少有效时间，未计入统计"));
    }
    parsed.records.retain(|r| r.time > 0);
    Ok(parsed)
}

pub(super) fn reconcile(record: &mut Record, high: &mut [u64; 6]) {
    if let Some(total) = record.total_snapshot {
        if !record.exact {
            apply(
                record,
                std::array::from_fn(|i| total[i].saturating_sub(high[i])),
            );
        }
        for (old, new) in high.iter_mut().zip(total) {
            *old = (*old).max(new);
        }
    }
}
