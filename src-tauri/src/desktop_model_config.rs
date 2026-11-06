//! Narrow, guarded model configuration for recent desktop clients.
use crate::configuration::{no_links, read_bytes, stage};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, String>;
const PROVIDER: &str = "cyapi-toolbox";
const KEY: &str = "CYAPI_TOOLBOX_API_KEY";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub revision: String,
    #[serde(default = "default_api")]
    pub api: String,
}

pub(crate) fn default_api() -> String {
    "openai-completions".into()
}

pub(crate) fn validate(input: &Input) -> Result<String> {
    if !matches!(input.api.as_str(), "openai-completions" | "openai-responses" | "anthropic-messages") {
        return Err("不支持的 API 协议".into());
    }
    let base = input.base_url.trim();
    let url = reqwest::Url::parse(base).map_err(|_| "API 地址无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || base.len() > 2048
        || base.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("API 地址无效".into());
    }
    if input.model.trim().is_empty()
        || input.model.len() > 512
        || input.model.chars().any(char::is_control)
        || input.api_key.len() > 8192
        || input.api_key.chars().any(char::is_control)
    {
        return Err("模型或 API Key 格式无效".into());
    }
    let base = base.trim_end_matches('/');
    let suffix = match input.api.as_str() {
        "openai-responses" => "/responses",
        "anthropic-messages" => "/messages",
        _ => "/chat/completions",
    };
    Ok(base.strip_suffix(suffix).unwrap_or(base).to_string())
}

pub(crate) fn version(tool: &str) -> Result<String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let name = match tool {
            "dsh" => "DeepSeek Harness",
            "workbuddy" => "WorkBuddy",
            "minimax" => "MiniMax Code",
            _ => return Err("未知工具".into()),
        };
        let script = format!(
            r#"$k=@('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'); $all=@(Get-ItemProperty $k -ErrorAction SilentlyContinue); $a=@($all | Where-Object {{ $_.DisplayName -is [string] -and ($_.DisplayName.Trim() -eq '{name}' -or $_.DisplayName.Trim() -match '^{name} [0-9]') }} | ForEach-Object {{ $_.DisplayVersion }} | Sort-Object -Unique); if($a.Count -eq 1) {{ $a[0] }} elseif ('{tool}' -eq 'dsh' -and @($all | Where-Object {{ $_.DisplayName -match '^DSH NEXT( |$)' }}).Count -gt 0) {{ 'community-next' }}"#
        );
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x08000000)
            .output()
            .map_err(|_| "无法检测桌面客户端版本")?;
        let found = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if found == "community-next" {
            return Err("检测到 DSH NEXT 社区版，目前仅支持 DeepSeek 官方桌面版".into());
        }
        if !output.status.success()
            || found.is_empty()
            || found.len() > 80
            || found.chars().any(char::is_control)
        {
            return Err("未检测到受支持的官方桌面客户端，或无法确认版本；暂不支持写入".into());
        }
        Ok(found)
    }
    #[cfg(target_os = "macos")]
    {
        let app = match tool {
            "dsh" => "DeepSeek Harness.app",
            "workbuddy" => "WorkBuddy.app",
            "minimax" => "MiniMax Code.app",
            _ => return Err("未知工具".into()),
        };
        let global = PathBuf::from(format!("/Applications/{app}/Contents/Info.plist"));
        let local = std::env::var_os("HOME").map(PathBuf::from).map(|h| h.join(format!("Applications/{app}/Contents/Info.plist")));
        let path = local.filter(|p| p.is_file()).unwrap_or(global);
        let output = std::process::Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", "Print CFBundleShortVersionString"])
            .arg(&path)
            .output()
            .map_err(|_| "无法检测桌面客户端版本")?;
        if !output.status.success() {
            if tool == "dsh" && Path::new("/Applications/DSH NEXT.app").exists() {
                return Err("检测到 DSH NEXT 社区版，目前仅支持 DeepSeek 官方桌面版".into());
            }
            return Err("未检测到受支持的官方桌面客户端，或无法确认版本；暂不支持写入".into());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = tool;
        Err("当前系统暂不支持检测此桌面客户端版本".into())
    }
}

fn supported(tool: &str, v: &str) -> Result<()> {
    match tool {
        // The official release is a prerelease; numeric-only comparison would
        // incorrectly accept older release candidates.
        "dsh" if v == "0.2.2-rc.1" => Ok(()),
        "workbuddy" if v == "5.9.3" || v == "5.11.0" => Ok(()),
        "dsh" | "workbuddy" => {
            let parts = |value: &str| -> Option<Vec<u64>> {
                value
                    .split('-')
                    .next()?
                    .split('.')
                    .map(str::parse)
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .ok()
            };
            let minimum = if tool == "dsh" { "0.2.2" } else { "5.9.3" };
            if parts(v)
                .zip(parts(minimum))
                .is_some_and(|(actual, min)| actual < min)
                || (tool == "dsh" && v.starts_with("0.2.2-rc.0"))
            {
                Err(format!(
                    "检测到版本 {v}，客户端版本过低，暂不支持；请更新到已适配版本"
                ))
            } else {
                Err(format!("检测到版本 {v}，该版本尚未适配，暂不支持写入"))
            }
        }
        _ => Err("未知工具".into()),
    }
}

pub(crate) fn check_official_dsh() -> Result<()> {
    supported("dsh", &version("dsh")?)
}
pub(crate) fn check_workbuddy() -> Result<()> {
    supported("workbuddy", &version("workbuddy")?)
}

fn paths(home: &Path, tool: &str) -> Result<Vec<PathBuf>> {
    match tool {
        "workbuddy" => Ok(vec![home.join(".workbuddy/models.json")]),
        "dsh" => {
            let root = std::env::var_os("DSH_HOME")
                .filter(|s| !s.is_empty())
                .filter(|_| {
                    std::env::var_os("CYAPI_TOOLBOX_HOME_DIR").is_none()
                        && crate::platform::is_default_home(home)
                })
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".dsh"));
            let root = root.strip_prefix("~").map(|rest| home.join(rest)).unwrap_or(root);
            if !root.is_absolute() || root.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
                return Err("DSH_HOME 不是绝对路径，暂不支持写入".into());
            }
            let manifest = root.join("profiles/desktop/package.json");
            no_links(&manifest)?;
            if read_bytes(&manifest)?.is_none() {
                return Err("尚未检测到已初始化的 DSH 桌面配置，请先启动官方桌面版".into());
            }
            let overlay = root.join("cordis.patch.yml");
            no_links(&overlay)?;
            if let Some(bytes) = read_bytes(&overlay)? {
                let text = std::str::from_utf8(&bytes).map_err(|_| "DSH 全局覆盖配置不是 UTF-8")?;
                if text.contains("llm-pi-ai") || text.contains("agent-default-model") {
                    return Err(
                        "DSH 全局覆盖可能覆盖模型配置，请先在 DSH 内处理，未写入文件".into(),
                    );
                }
            }
            Ok(vec![
                root.join("profiles/desktop/cordis.patch.yml"),
                root.join(".credentials.yaml"),
                overlay,
            ])
        }
        _ => Err("未知工具".into()),
    }
}

fn snapshot(home: &Path, tool: &str) -> Result<Vec<(PathBuf, Option<Vec<u8>>)>> {
    paths(home, tool)?
        .into_iter()
        .map(|p| {
            no_links(&p)?;
            Ok((p.clone(), read_bytes(&p)?))
        })
        .collect()
}
fn revision(files: &[(PathBuf, Option<Vec<u8>>)]) -> String {
    crate::service::hash(&serde_json::to_vec(files).unwrap_or_default())
}
fn json_file(bytes: Option<&[u8]>) -> Result<Value> {
    let value = match bytes {
        Some(b) => serde_json::from_slice::<crate::pi_model_config::Strict>(b).map_err(|_| "模型 JSON 格式无效或含重复字段，未覆盖文件")?.0,
        None => json!({}),
    };
    if !value.is_object() {
        return Err("模型配置必须是 JSON 对象".into());
    }
    Ok(value)
}
fn text(bytes: Option<&[u8]>) -> Result<&str> {
    std::str::from_utf8(bytes.unwrap_or_default()).map_err(|_| "配置文件不是 UTF-8".into())
}

// Isolate top-level patch rows without parsing unrelated Cordis custom YAML tags.
// Ambiguous/complex target rows fail closed instead of rewriting other plugins.
fn patch_row(
    source: &str,
    id: &str,
    edit: impl FnOnce(&mut Value) -> Result<()>,
) -> Result<String> {
    let source = if source.trim() == "[]" { "" } else { source };
    let starts: Vec<usize> = source
        .match_indices("\n- ")
        .map(|(i, _)| i + 1)
        .chain(source.starts_with("- ").then_some(0))
        .collect();
    let mut starts = starts;
    starts.sort_unstable();
    let mut hit = None;
    for (i, start) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(source.len());
        let row = &source[*start..end];
        let first = row.lines().next().unwrap_or("").trim();
        let row_id = first.strip_prefix("- id:").map(str::trim).unwrap_or("");
        let row_id = row_id
            .split('#')
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches(['\'', '"']);
        let parsed_id_matches = row_id != id && row.contains(id)
            && crate::harness_yaml::parse(row).ok().is_some_and(|v| {
                v.as_array().is_some_and(|items| items.len() == 1 && items[0]["id"].as_str() == Some(id))
            });
        if row_id == id || parsed_id_matches {
            if hit.is_some() {
                return Err("DSH 存在重复模型配置，未写入文件".into());
            }
            hit = Some((*start, end));
        }
    }
    if hit.is_none() && source.contains(id) {
        return Err("DSH 模型配置结构无法安全识别，请在 DSH 内编辑，未写入文件".into());
    }
    let (start, end) = hit.unwrap_or((source.len(), source.len()));
    let old = &source[start..end];
    let mut row: Value = if old.is_empty() {
        json!([{"id":id,"config":{}}])
    } else {
        crate::harness_yaml::parse(old)?
    };
    let entry = row
        .as_array_mut()
        .and_then(|rows| (rows.len() == 1).then(|| &mut rows[0]))
        .ok_or("DSH 配置结构无效")?;
    if !entry.is_object() {
        return Err("DSH 配置结构无效".into());
    }
    edit(entry)?;
    let encoded = if old.is_empty() {
        let mut fields = row[0].clone();
        fields.as_object_mut().unwrap().remove("id");
        let rest = serde_yaml_ng::to_string(&fields).map_err(|_| "无法生成 DSH 配置")?;
        format!("- id: {id}\n{}", rest.lines().map(|line| format!("  {line}\n")).collect::<String>())
    } else {
        let mapping: String = old.split_inclusive('\n').enumerate().map(|(i, line)| {
            if i == 0 { line.strip_prefix("- ").unwrap_or(line) }
            else { line.strip_prefix("  ").unwrap_or(line) }
        }).collect();
        let edited = crate::harness_yaml::update(&mapping, &row[0])?;
        edited.split_inclusive('\n').enumerate().map(|(i, line)| {
            format!("{}{line}", if i == 0 { "- " } else { "  " })
        }).collect()
    };
    let mut out = source[..start].to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&encoded);
    out.push_str(&source[end..]);
    Ok(out)
}

fn dsh_row(source: &str, input: &Input) -> Result<String> {
    patch_row(source, "llm-pi-ai", |entry| {
        let obj = entry.as_object_mut().ok_or("DSH 配置无效")?;
        let config = obj
            .entry("config")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or("DSH 提供商配置无效")?;
        let providers = config
            .entry("providers")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or("DSH 提供商列表无效")?;
        if providers
            .get(PROVIDER)
            .is_some_and(|p| p.get("apiKeyEnv").and_then(Value::as_str) != Some(KEY))
        {
            return Err("DSH 中已存在同名提供商，请先在 DSH 内处理，未覆盖原配置".into());
        }
        let provider = providers
            .entry(PROVIDER)
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or("DSH 线路配置无效")?;
        provider.insert("displayName".into(), json!("CYAPI Toolbox"));
        provider.insert("apiKeyEnv".into(), json!(KEY));
        provider.insert("api".into(), json!(input.api));
        provider.insert("baseURL".into(), json!(validate(input)?));
        let models = provider
            .entry("models")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("DSH 模型列表无效")?;
        if !models
            .iter()
            .any(|m| m.get("id").and_then(Value::as_str) == Some(input.model.trim()))
        {
            models.push(json!({"id":input.model.trim()}));
        }
        Ok(())
    })
    .and_then(|source| {
        patch_row(&source, "agent-default-model", |entry| {
            let obj = entry.as_object_mut().ok_or("DSH 配置无效")?;
            let cfg = obj
                .entry("config")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or("DSH 默认模型配置无效")?;
            cfg.insert("provider".into(), json!(PROVIDER));
            cfg.insert("model".into(), json!(input.model.trim()));
            cfg.remove("reasoningEffort");
            Ok(())
        })
    })
}

pub fn view(home: &Path, tool: &str) -> Result<Value> {
    let ver = version(tool)?;
    supported(tool, &ver)?;
    let files = snapshot(home, tool)?;
    let mut base_url = String::new();
    let mut model = String::new();
    let mut configured = false;
    let mut api = default_api();
    let mut known_models = Vec::new();
    if tool == "workbuddy" {
        let value = json_file(files[0].1.as_deref())?;
        if let Some(models) = value.get("models") {
            let models = models.as_array().ok_or("WorkBuddy 模型列表格式无效")?;
            known_models = models.iter().filter(|m| managed_model(m)).filter_map(|m| m["id"].as_str().map(str::to_string)).collect();
            if let Some(item) = models.iter().find(|m| managed_model(m)) {
                model = item["id"].as_str().unwrap_or("").to_string();
                base_url = item["url"]
                    .as_str()
                    .unwrap_or("")
                    .trim_end_matches("/chat/completions")
                    .to_string();
                configured = item["apiKey"].as_str().is_some_and(|s| !s.is_empty());
            }
        }
    } else {
        let source = text(files[0].1.as_deref())?;
        // Parse only the provider row, leaving unrelated YAML untouched.
        let _ = patch_row(source, "llm-pi-ai", |entry| {
            if let Some(p) = entry.pointer("/config/providers/cyapi-toolbox") {
                known_models = p.get("models").and_then(Value::as_array).into_iter().flatten().filter_map(|m| m["id"].as_str().map(str::to_string)).collect();
                api = p["api"].as_str().unwrap_or("openai-completions").to_string();
                base_url = p["baseURL"].as_str().unwrap_or("").to_string();
                model = p
                    .pointer("/models/0/id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
            }
            Ok(())
        })?;
        let _ = patch_row(source, "agent-default-model", |entry| {
            if entry.pointer("/config/provider").and_then(Value::as_str) == Some(PROVIDER) {
                model = entry
                    .pointer("/config/model")
                    .and_then(Value::as_str)
                    .unwrap_or(&model)
                    .to_string();
            }
            Ok(())
        })?;
        let credentials = crate::harness_yaml::parse(text(files[1].1.as_deref())?)?;
        configured = credentials.get("refs").and_then(|refs| refs.get(KEY)).or_else(|| credentials.get(KEY))
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty());
    }
    Ok(
        json!({"version":ver,"revision":revision(&files),"baseUrl":base_url,"model":model,"models":known_models,"api":api,"apiKeyConfigured":configured,"configPath":files[0].0}),
    )
}

pub fn save(home: &Path, tool: &str, input: &Input) -> Result<()> {
    supported(tool, &version(tool)?)?;
    save_checked(home, tool, input)
}

fn managed_model(item: &Value) -> bool {
    item.get("id").and_then(Value::as_str).is_some_and(|id| {
        item.get("name").and_then(Value::as_str) == Some(format!("CYAPI · {id}").as_str())
    }) && item.get("vendor").and_then(Value::as_str) == Some("Custom")
}

fn save_checked(home: &Path, tool: &str, input: &Input) -> Result<()> {
    let base_url = validate(input)?;
    if tool == "workbuddy" && input.api != "openai-completions" {
        return Err("WorkBuddy 当前支持 OpenAI Chat Completions 接口".into());
    }
    let files = snapshot(home, tool)?;
    if revision(&files) != input.revision {
        return Err("配置已变化，请重新读取后保存".into());
    }
    let mut output = Vec::new();
    if tool == "workbuddy" {
        let mut value = json_file(files[0].1.as_deref())?;
        let models = value
            .as_object_mut()
            .unwrap()
            .entry("models")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("WorkBuddy 模型列表格式无效")?;
        let id = input.model.trim();
        let managed: Vec<_> = models
            .iter()
            .enumerate()
            .filter(|(_, m)| managed_model(m))
            .map(|(i, _)| i)
            .collect();
        if managed.len() > 1 {
            return Err("存在多个 CYAPI 模型，请先在 WorkBuddy 内整理，未写入文件".into());
        }
        let old = managed.first().copied();
        let old_id = old.and_then(|i| models[i]["id"].as_str()).map(str::to_string);
        if models
            .iter()
            .enumerate()
            .any(|(i, m)| Some(i) != old && m["id"].as_str() == Some(id))
        {
            return Err(
                "该模型 ID 已存在于 WorkBuddy，请先在 WorkBuddy 内处理，未覆盖原配置".into(),
            );
        }
        let mut item = old.map(|i| models[i].clone()).unwrap_or_else(|| json!({}));
        let item_obj = item.as_object_mut().ok_or("WorkBuddy 模型配置无效")?;
        let saved = item_obj
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let key = if input.api_key.is_empty() {
            &saved
        } else {
            &input.api_key
        };
        if key.is_empty() {
            return Err("请填写 API Key".into());
        }
        item_obj.insert("id".into(), json!(id));
        item_obj.insert("name".into(), json!(format!("CYAPI · {id}")));
        item_obj.insert("vendor".into(), json!("Custom"));
        item_obj.insert("apiKey".into(), json!(key));
        item_obj.insert(
            "url".into(),
            json!(format!("{base_url}/chat/completions")),
        );
        item_obj.entry("supportsToolCall").or_insert(json!(true));
        if let Some(i) = old {
            models[i] = item;
        } else {
            models.push(item);
        }
        if let Some(available) = value.get_mut("availableModels") {
            let available = available
                .as_array_mut()
                .ok_or("WorkBuddy 可用模型列表格式无效")?;
            if let Some(old_id) = old_id.filter(|old_id| old_id != id) {
                for entry in available.iter_mut() {
                    if entry.as_str() == Some(&old_id) { *entry = json!(id); }
                }
                let mut seen = std::collections::HashSet::new();
                available.retain(|entry| entry.as_str().is_none_or(|id| seen.insert(id.to_string())));
            }
            if !available.iter().any(|v| v.as_str() == Some(id)) {
                available.push(json!(id));
            }
        }
        output.push(serde_json::to_vec_pretty(&value).map_err(|_| "无法生成模型配置")?);
    } else {
        let profile = text(files[0].1.as_deref())?;
        let raw = text(files[1].1.as_deref())?;
        let mut credentials = crate::harness_yaml::parse(raw)?;
        let document = credentials.as_object_mut().ok_or("DSH 凭据文件格式无效")?;
        if document.get("version").is_some_and(|v| v.as_u64() != Some(1)) {
            return Err("DSH 凭据文件版本不支持".into());
        }
        document.insert("version".into(), json!(1));
        // Recover the key written at the wrong level by earlier toolbox builds.
        let legacy = document.remove(KEY);
        let creds = document.entry("refs").or_insert_with(|| json!({})).as_object_mut().ok_or("DSH 凭据 refs 格式无效")?;
        if !input.api_key.is_empty() {
            creds.insert(KEY.into(), json!(input.api_key));
        } else if !creds.contains_key(KEY) {
            if let Some(key) = legacy { creds.insert(KEY.into(), key); }
        }
        if !creds
            .get(KEY)
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
        {
            return Err("请填写 API Key".into());
        }
        output.push(dsh_row(profile, input)?.into_bytes());
        output.push(crate::harness_yaml::update(raw, &credentials)?.into_bytes());
    }
    if output.iter().any(|v| v.len() > 1_000_000) {
        return Err("生成的配置过大".into());
    }
    let mut staged = Vec::new();
    for ((path, _), bytes) in files.iter().zip(&output) {
        match stage(path, bytes) {
            Ok(p) => staged.push(p),
            Err(e) => {
                for p in staged {
                    let _ = fs::remove_file(p);
                }
                return Err(e);
            }
        }
    }
    let mut committed = 0;
    let result = (|| {
        if snapshot(home, tool)? != files {
            return Err("配置已被其他程序修改，请重新读取".into());
        }
        for (((path, original), data), temp) in files.iter().zip(&output).zip(&staged) {
            no_links(path)?;
            if &read_bytes(path)? != original {
                return Err("配置已被其他程序修改，请重新读取".into());
            }
            fs::rename(temp, path).map_err(|_| "无法替换配置文件，请检查是否被占用")?;
            let _ = data;
            committed += 1;
        }
        Ok(())
    })();
    let mut rollback_failed = false;
    if result.is_err() {
        for ((path, original), written) in files.iter().zip(&output).take(committed).rev() {
            if read_bytes(path).ok().flatten().as_ref() != Some(written) {
                rollback_failed = true;
                continue;
            }
            let restored = match original {
                Some(b) => {
                    stage(path, b).and_then(|p| fs::rename(p, path).map_err(|_| "恢复失败".into()))
                }
                None => fs::remove_file(path).map_err(|_| "恢复失败".into()),
            };
            rollback_failed |= restored.is_err();
        }
    }
    for p in staged {
        let _ = fs::remove_file(p);
    }
    if rollback_failed {
        return Err("保存中断，部分文件未能恢复，请检查本地配置".into());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "cyapi-desktop-config-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(p.join(".dsh/profiles/desktop")).unwrap();
        fs::write(p.join(".dsh/profiles/desktop/package.json"), "{}").unwrap();
        p
    }
    fn input(home: &Path, tool: &str, model: &str) -> Input {
        Input {
            base_url: "https://example.invalid/v1".into(),
            api_key: "fictional-test-key".into(),
            model: model.into(),
            revision: revision(&snapshot(home, tool).unwrap()),
            api: default_api(),
        }
    }
    #[test]
    fn versions_are_exact_and_old_versions_fail() {
        assert!(supported("dsh", "0.2.2-rc.1").is_ok());
        assert!(supported("dsh", "0.2.1-rc.5").is_err());
        assert!(supported("dsh", "2.0.21-next").is_err());
        assert!(supported("workbuddy", "5.9.3").is_ok());
        assert!(supported("workbuddy", "5.2.5").is_err());
        assert!(supported("workbuddy", "6.0.0").is_err());
    }
    #[test]
    fn dsh_preserves_unrelated_rows_providers_and_model_metadata() {
        let home = fixture();
        let paths = paths(&home, "dsh").unwrap();
        fs::create_dir_all(paths[0].parent().unwrap()).unwrap();
        let existing = "- id: other\n  config:\n    value: !!js something\n- id: llm-pi-ai\n  config:\n    providers:\n      another:\n        baseURL: https://example.invalid\n      cyapi-toolbox:\n        apiKeyEnv: CYAPI_TOOLBOX_API_KEY\n        models:\n          - id: older\n            contextWindow: 20000\n- id: agent-default-model\n  config:\n    provider: other\n    model: old\n";
        fs::write(&paths[0], existing).unwrap();
        save_checked(&home, "dsh", &input(&home, "dsh", "new-model")).unwrap();
        let result = fs::read_to_string(&paths[0]).unwrap();
        assert!(result.contains("value: !!js something"));
        assert!(result.contains("another:"));
        assert!(result.contains("contextWindow: 20000"));
        let _ = patch_row(&result, "llm-pi-ai", |row| {
            assert_eq!(row["config"]["providers"][PROVIDER]["models"][1]["id"], "new-model");
            Ok(())
        }).unwrap();
        assert!(!result.contains("fictional-test-key"));
        assert!(fs::read_to_string(&paths[1])
            .unwrap()
            .contains("fictional-test-key"));
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn dsh_preserves_comments_and_refuses_duplicate_target_rows() {
        let req = Input {
            base_url: "https://example.invalid/v1".into(),
            api_key: "test".into(),
            model: "test-model".into(),
            revision: "".into(),
            api: default_api(),
        };
        assert!(dsh_row("- id: llm-pi-ai # important\n  config: {}\n", &req).unwrap().contains("# important"));
        assert!(dsh_row(
            "- id: llm-pi-ai\n  config: {}\n- id: llm-pi-ai\n  config: {}\n",
            &req
        )
        .is_err());
    }
    #[test]
    fn workbuddy_preserves_other_models_and_rejects_collision_and_stale_revision() {
        let home = fixture();
        let path = paths(&home, "workbuddy").unwrap().remove(0);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"models":[{"id":"existing","name":"Existing","extra":42}],"other":true}"#,
        )
        .unwrap();
        let collision = input(&home, "workbuddy", "existing");
        assert!(save_checked(&home, "workbuddy", &collision).is_err());
        let change = input(&home, "workbuddy", "fictional-model");
        save_checked(&home, "workbuddy", &change).unwrap();
        assert!(save_checked(&home, "workbuddy", &change).is_err());
        let value = json_file(Some(&fs::read(&path).unwrap())).unwrap();
        assert_eq!(value["other"], true);
        assert_eq!(value["models"][0]["extra"], 42);
        assert_eq!(
            value["models"][1]["url"],
            "https://example.invalid/v1/chat/completions"
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn dsh_uses_versioned_refs_and_migrates_legacy_toolbox_key() {
        let home = fixture();
        let files = paths(&home, "dsh").unwrap();
        fs::write(&files[0], "[]\n").unwrap();
        let original = "# credentials\nversion: 1\nrefs:\n  OTHER_KEY: 'other#key' # keep\nrecords:\n  llm-pi-ai/other:\n    kind: grant\n    payload: {access: fictional, refresh: fictional-refresh}\nCYAPI_TOOLBOX_API_KEY: legacy-test-key\n";
        fs::write(&files[1], original).unwrap();
        let mut request = input(&home, "dsh", "model-b");
        request.api_key.clear();
        request.api = "anthropic-messages".into();
        request.base_url = "https://example.invalid/v1/messages/".into();
        save_checked(&home, "dsh", &request).unwrap();
        let credentials = fs::read_to_string(&files[1]).unwrap();
        let value = crate::harness_yaml::parse(&credentials).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["refs"][KEY], "legacy-test-key");
        assert!(value.get(KEY).is_none());
        assert!(credentials.contains("OTHER_KEY: 'other#key' # keep"));
        assert!(credentials.contains("payload: {access: fictional, refresh: fictional-refresh}"));
        let profile = fs::read_to_string(&files[0]).unwrap();
        patch_row(&profile, "llm-pi-ai", |row| {
            assert_eq!(row["config"]["providers"][PROVIDER]["api"], "anthropic-messages");
            assert_eq!(row["config"]["providers"][PROVIDER]["baseURL"], "https://example.invalid/v1");
            Ok(())
        }).unwrap();
        request.revision = revision(&snapshot(&home, "dsh").unwrap());
        save_checked(&home, "dsh", &request).unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn workbuddy_renames_available_model_references_and_keeps_key() {
        let home = fixture();
        let path = paths(&home, "workbuddy").unwrap().remove(0);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"models":[{"id":"old","name":"CYAPI · old","vendor":"Custom","apiKey":"saved-key","extra":true}],"availableModels":["other","old","new"]}"#).unwrap();
        let mut request = input(&home, "workbuddy", "new");
        request.api_key.clear();
        save_checked(&home, "workbuddy", &request).unwrap();
        let doc = json_file(Some(&fs::read(&path).unwrap())).unwrap();
        assert_eq!(doc["availableModels"], json!(["other", "new"]));
        assert_eq!(doc["models"][0]["apiKey"], "saved-key");
        assert_eq!(doc["models"][0]["extra"], true);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn validates_protocol_and_normalizes_endpoint_suffixes() {
        let home = fixture();
        let mut request = input(&home, "workbuddy", "model");
        for (api, suffix) in [("openai-completions", "chat/completions"), ("openai-responses", "responses"), ("anthropic-messages", "messages")] {
            request.api = api.into();
            request.base_url = format!("https://example.invalid/v1/{suffix}/");
            assert_eq!(validate(&request).unwrap(), "https://example.invalid/v1");
        }
        request.api = "unknown".into();
        assert!(validate(&request).is_err());
        assert!(json_file(Some(br#"{"models":[],"models":[]}"#)).is_err());
        fs::remove_dir_all(home).unwrap();
    }
}
