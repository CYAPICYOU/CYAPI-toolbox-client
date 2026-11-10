use super::*;

/// Qwen Code keeps three separate local record families:
///
/// - `~/.qwen/usage/token-usage-YYYY-MM.jsonl` — one line per API response,
///   carrying prompt/candidate/cached/thoughts token counts and the duration.
/// - `~/.qwen/projects/<slug>/chats/<sessionId>.jsonl` — the transcript, whose
///   `ui_telemetry` records repeat the same numbers but without a stable id.
/// - `~/.qwen/debug/daemon/daemon.log` — plain `time [LEVEL] [MODULE] k=v` lines.
///
/// The usage log is the single authority for tokens, so a transcript replay can
/// never double count; the transcript only supplies session titles, projects and
/// user turns. Only the runtime log feeds level/status diagnostics.
pub(super) fn analyze(root: &Path, b: &mut Builder) {
    usage(&root.join("usage"), b);
    transcripts(&root.join("projects"), b);
    runtime::analyze(&root.join("debug"), "qwen", b);
    b.snapshot.notes.push(
        "Qwen Code：用量取自 usage/token-usage-*.jsonl，每条对应一次 API 响应。".into(),
    );
    b.snapshot.notes.push(
        "Qwen 的 inputTokens 已包含缓存命中量，缓存数按子集展示；输出包含推理 token，推理子项不再重复相加。"
            .into(),
    );
}

fn usage(dir: &Path, b: &mut Builder) {
    let mut coverage = source(dir, "usage", "JSONL");
    if let Err(error) = no_links(dir) {
        coverage.status = "error".into();
        coverage.note = error;
        b.snapshot.sources.push(coverage);
        return;
    }
    let (mut paths, limited) = files(dir, "jsonl");
    paths.retain(|p| modified(p) >= b.snapshot.since);
    paths.sort_by(|a, c| modified(c).cmp(&modified(a)).then_with(|| a.cmp(c)));
    coverage.partial = limited || paths.len() > MAX_FILES;
    coverage.note = format!(
        "发现 {} 份用量文件，最多读取最近 {MAX_FILES} 份，每份尾部 8 MB。",
        paths.len()
    );
    for path in paths.iter().take(MAX_FILES) {
        let bytes = fs::metadata(path)
            .map(|m| m.len().min(JSON_BYTES))
            .unwrap_or(0);
        if bytes > b.bytes_left {
            coverage.partial = true;
            coverage.note.push_str(" 总读取预算已用完，部分用量记录未读取。");
            break;
        }
        b.bytes_left = b.bytes_left.saturating_sub(bytes);
        let mut src = source(path, "usage", "JSONL");
        let mut records = 0;
        let result = json_lines(path, JSON_BYTES, |value, offset| {
            let n = b.events.len();
            usage_event(&value, path, &src, offset, b);
            if b.events.len() > n {
                records += b.events.len() - n;
            }
        });
        match result {
            Ok((_, partial, bad)) => {
                src.records = records;
                src.partial = partial || bad > 0;
                if partial {
                    src.note.push_str("仅解析尾部 8 MB；");
                }
                if bad > 0 {
                    src.note
                        .push_str(&format!("{bad} 行缺少有效时间或无法识别；"));
                }
            }
            Err(error) => {
                src.status = "error".into();
                src.note = error;
            }
        }
        coverage.records += src.records;
        b.snapshot.sources.push(src);
    }
    b.snapshot.sources.push(coverage);
}

fn usage_event(value: &Value, path: &Path, src: &Source, offset: u64, b: &mut Builder) {
    let time = at(&value["timestamp"]);
    if time == 0 {
        return;
    }
    let id = text(value, "id");
    if id.is_empty() {
        return;
    }
    let input = count(value, "inputTokens");
    let output = count(value, "outputTokens");
    let reasoning = count(value, "thoughtsTokens");
    if input == 0 && output == 0 && reasoning == 0 {
        return;
    }
    // `cachedTokens` is a subset of `inputTokens`; `thoughtsTokens` is a subset
    // of the reported output total, so neither is added on top.
    let cache_read = count(value, "cachedTokens").min(input);
    let session = text(value, "sessionId");
    let model = text(value, "model");
    let auth = text(value, "authType");
    let origin = if text(value, "source").is_empty() {
        "main"
    } else {
        text(value, "source")
    };
    let event = Event {
        id: String::new(),
        time,
        level: "INFO".into(),
        kind: "response".into(),
        target: origin.chars().take(80).collect(),
        session_id: (!session.is_empty()).then(|| session.to_string()),
        message_id: Some(id.to_string()),
        model: model.chars().take(80).collect(),
        provider: auth.chars().take(80).collect(),
        summary: format!(
            "{origin} {} in={input} out={} cached={cache_read}",
            if model.is_empty() { "unknown" } else { model },
            output + reasoning
        ),
        duration_ms: value["apiDurationMs"].as_u64(),
        usage: Some(Tokens {
            input,
            output: output + reasoning,
            cache_read,
            reasoning,
            ..Default::default()
        }),
        location: locate(src, path, format!("line:{offset}")),
        ..Default::default()
    };
    b.add(format!("qwen-usage:{id}"), event);
}

/// Reads only the transcript envelope: token usage is ignored here because the
/// usage log already owns it.
fn transcripts(dir: &Path, b: &mut Builder) {
    let mut coverage = source(dir, "conversation", "JSONL");
    if let Err(error) = no_links(dir) {
        coverage.status = "error".into();
        coverage.note = error;
        b.snapshot.sources.push(coverage);
        return;
    }
    let (mut paths, limited) = files(dir, "jsonl");
    paths.sort_by(|a, c| modified(c).cmp(&modified(a)).then_with(|| a.cmp(c)));
    coverage.partial = limited || paths.len() > MAX_FILES;
    coverage.note = format!(
        "发现 {} 份会话记录，最多读取最近 {MAX_FILES} 份；仅取 cwd、标题与用户轮次。",
        paths.len()
    );
    let mut projects = BTreeMap::new();
    let mut read = 0;
    for path in paths.iter().take(MAX_FILES) {
        let Some(id) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        let mut title = String::new();
        let mut project = String::new();
        let mut turns = 0;
        if json_lines(path, JSON_BYTES, |value, _offset| {
            if project.is_empty() {
                let cwd = text(&value, "cwd");
                if !cwd.is_empty() {
                    project = cwd.chars().take(1000).collect();
                }
            }
            match text(&value, "type") {
                "user" => turns += 1,
                "system" => {
                    let custom = text(&value["systemPayload"], "customTitle");
                    if !custom.is_empty() {
                        title = custom.chars().take(200).collect();
                    }
                }
                _ => {}
            }
        })
        .is_err()
        {
            continue;
        }
        if project.is_empty() && title.is_empty() && turns == 0 {
            continue;
        }
        read += 1;
        if !project.is_empty() {
            projects.insert(id.clone(), project.clone());
        }
        if turns > 0 {
            let session = b.session(&id);
            if !title.is_empty() {
                session.title = title;
            }
            if !project.is_empty() {
                session.project = project;
            }
            session.stats.user_turns += turns;
            session.updated_at = session.updated_at.max(modified(path));
        }
    }
    coverage.records = read;
    // Sessions that only appear in the usage log still get their project, so
    // the usage view can group by directory.
    for (id, project) in projects {
        if let Some(session) = b.sessions.get_mut(&id) {
            if session.project.is_empty() {
                session.project = project;
            }
        }
    }
    b.snapshot.sources.push(coverage);
}
