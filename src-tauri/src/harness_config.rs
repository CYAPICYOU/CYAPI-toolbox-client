//! Local model adapters. Each save is revision-checked, staged and recoverable.
use crate::configuration::{no_links, read_bytes, stage};
use base64::{engine::general_purpose::STANDARD, Engine};
use jsonc_parser::cst::{CstInputValue, CstObject, CstRootNode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, String>;
const PROVIDER: &str = "cyapi-toolbox";
const NAME: &str = "CYAPI Toolbox";
const KEY: &str = "CYAPI_TOOLBOX_API_KEY";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub api: String,
    pub revision: String,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
struct File {
    path: PathBuf,
    format: String,
    bytes: Option<String>,
}
impl File {
    fn text(&self) -> Result<String> {
        let bytes = self
            .bytes
            .as_deref()
            .map(|s| STANDARD.decode(s))
            .transpose()
            .map_err(|_| "配置快照无效")?
            .unwrap_or_default();
        if bytes.len() > 1_000_000 {
            return Err("配置文件过大".into());
        }
        String::from_utf8(bytes)
            .map(|s| s.trim_start_matches('\u{feff}').to_string())
            .map_err(|_| "配置文件不是 UTF-8".into())
    }
    fn value(&self) -> Result<Value> {
        let source = self.text()?;
        let value = match self.format.as_str() {
            "yaml" => crate::harness_yaml::parse(&source)?,
            "toml" => toml_value(
                &source
                    .parse::<toml_edit::DocumentMut>()
                    .map_err(|_| "TOML 配置无效，未覆盖文件")?
                    .as_item(),
            )?,
            "env" => env_parse(&source)?,
            _ if source.trim().is_empty() => json!({}),
            _ => {
                jsonc_parser::parse_to_serde_value::<crate::pi_model_config::Strict>(
                    &source,
                    &Default::default(),
                )
                .map_err(|_| "JSON 配置无效或含重复字段，未覆盖文件")?
                .0
            }
        };
        if !value.is_object() {
            return Err("配置文件必须是对象".into());
        }
        Ok(value)
    }
    fn edited(&self, next: &Value) -> Result<Self> {
        let source = self.text()?;
        let old = self.value()?;
        if old == *next {
            return Ok(self.clone());
        }
        let output = match self.format.as_str() {
            "yaml" => crate::harness_yaml::update(&source, next)?,
            "toml" => {
                let mut doc = source
                    .parse::<toml_edit::DocumentMut>()
                    .map_err(|_| "TOML 配置无效")?;
                patch_toml(doc.as_item_mut(), &old, next)?;
                doc.to_string()
            }
            "env" => env_update(&source, &old, next)?,
            _ => {
                let root = CstRootNode::parse(
                    if source.trim().is_empty() {
                        "{}"
                    } else {
                        &source
                    },
                    &Default::default(),
                )
                .map_err(|_| "JSON 配置无效")?;
                patch_json(&root.object_value_or_set(), &old, next)?;
                root.to_string()
            }
        };
        if output.len() > 1_000_000 {
            return Err("生成的配置过大".into());
        }
        let result = Self {
            bytes: Some(STANDARD.encode(output)),
            ..self.clone()
        };
        if result.value()? != *next {
            return Err("无法保留配置结构，未写入文件".into());
        }
        Ok(result)
    }
}

fn toml_value(item: &toml_edit::Item) -> Result<Value> {
    if let Some(table) = item.as_table_like() {
        return table
            .iter()
            .map(|(k, v)| Ok((k.to_string(), toml_value(v)?)))
            .collect::<Result<Map<_, _>>>()
            .map(Value::Object);
    }
    if let Some(tables) = item.as_array_of_tables() {
        return tables
            .iter()
            .map(|t| toml_value(&toml_edit::Item::Table(t.clone())))
            .collect::<Result<Vec<_>>>()
            .map(Value::Array);
    }
    if let Some(value) = item.as_value() {
        if let Some(s) = value.as_str() {
            return Ok(json!(s));
        }
        if let Some(n) = value.as_integer() {
            return Ok(json!(n));
        }
        if let Some(b) = value.as_bool() {
            return Ok(json!(b));
        }
        if let Some(n) = value.as_float() {
            return Ok(json!(n));
        }
        if let Some(d) = value.as_datetime() {
            return Ok(json!(d.to_string()));
        }
        if let Some(a) = value.as_array() {
            return a
                .iter()
                .map(|v| toml_value(&toml_edit::Item::Value(v.clone())))
                .collect::<Result<Vec<_>>>()
                .map(Value::Array);
        }
    }
    Err("不支持的 TOML 值".into())
}
fn toml_input(value: &Value) -> Result<toml_edit::Value> {
    Ok(match value {
        Value::String(s) => s.as_str().into(),
        Value::Bool(b) => (*b).into(),
        Value::Number(n) => n.as_i64().ok_or("TOML 数字无效")?.into(),
        Value::Array(a) => {
            let mut result = toml_edit::Array::new();
            for v in a {
                result.push(toml_input(v)?);
            }
            result.into()
        }
        Value::Object(o) => {
            let mut result = toml_edit::InlineTable::new();
            for (k, v) in o {
                result.insert(k, toml_input(v)?);
            }
            result.into()
        }
        _ => return Err("不支持的 TOML 值".into()),
    })
}
fn patch_toml(item: &mut toml_edit::Item, old: &Value, next: &Value) -> Result<()> {
    let table = item.as_table_like_mut().ok_or("TOML 配置结构冲突")?;
    for key in old.as_object().ok_or("配置结构无效")?.keys() {
        if next.get(key).is_none() {
            table.remove(key);
        }
    }
    for (key, value) in next.as_object().ok_or("配置结构无效")? {
        if old.get(key) == Some(value) {
            continue;
        }
        if value.is_object() {
            if !table.contains_key(key) {
                table.insert(key, toml_edit::Item::Table(toml_edit::Table::new()));
            }
            patch_toml(
                table.get_mut(key).ok_or("配置结构无效")?,
                old.get(key).unwrap_or(&json!({})),
                value,
            )?;
        } else {
            let mut replacement = toml_input(value)?;
            if let Some(previous) = table.get(key).and_then(toml_edit::Item::as_value) {
                *replacement.decor_mut() = previous.decor().clone();
            }
            table.insert(key, toml_edit::Item::Value(replacement));
        }
    }
    Ok(())
}
fn cst_input(value: &Value) -> CstInputValue {
    match value {
        Value::Null => CstInputValue::Null,
        Value::Bool(b) => CstInputValue::Bool(*b),
        Value::Number(n) => CstInputValue::Number(n.to_string()),
        Value::String(s) => CstInputValue::String(s.clone()),
        Value::Array(a) => CstInputValue::Array(a.iter().map(cst_input).collect()),
        Value::Object(o) => {
            CstInputValue::Object(o.iter().map(|(k, v)| (k.clone(), cst_input(v))).collect())
        }
    }
}
fn patch_json(object: &CstObject, old: &Value, next: &Value) -> Result<()> {
    for key in old.as_object().ok_or("配置结构无效")?.keys() {
        if next.get(key).is_none() {
            if let Some(p) = object.get(key) {
                p.remove();
            }
        }
    }
    for (key, value) in next.as_object().ok_or("配置结构无效")? {
        if old.get(key) == Some(value) {
            continue;
        }
        if old.get(key).is_some_and(Value::is_object) && value.is_object() {
            patch_json(
                &object.object_value(key).ok_or("JSON 配置结构冲突")?,
                &old[key],
                value,
            )?;
        } else if let Some(p) = object.get(key) {
            p.set_value(cst_input(value));
        } else {
            object.append(key, cst_input(value));
        }
    }
    Ok(())
}
fn env_pair(line: &str) -> Option<(&str, &str)> {
    let line = line.trim().strip_prefix("export ").unwrap_or(line.trim());
    let (key, value) = line.split_once('=')?;
    Some((key.trim(), value.trim()))
}
fn env_blocks(source: &str) -> Result<Vec<&str>> {
    let mut blocks = Vec::new();
    let mut start = 0;
    let mut end = 0;
    let mut quote = None;
    for line in source.split_inclusive('\n') {
        end += line.len();
        let raw = if quote.is_some() {
            Some(line)
        } else {
            env_pair(line).and_then(|(key, raw)| {
                if key.starts_with('#') {
                    return None;
                }
                let first = raw.chars().next()?;
                if matches!(first, '\'' | '"' | '`') {
                    quote = Some(first);
                    Some(&raw[1..])
                } else {
                    None
                }
            })
        };
        if let Some(raw) = raw {
            if raw
                .char_indices()
                .any(|(i, c)| Some(c) == quote && (i == 0 || raw.as_bytes()[i - 1] != b'\\'))
            {
                quote = None;
            }
        }
        if quote.is_none() {
            blocks.push(&source[start..end]);
            start = end;
        }
    }
    if quote.is_some() {
        return Err(".env 中有未闭合的多行引号，请先整理".into());
    }
    Ok(blocks)
}
fn env_parse(source: &str) -> Result<Value> {
    let mut result = Map::new();
    for line in env_blocks(source)? {
        let Some((key, raw)) = env_pair(line) else {
            continue;
        };
        // Keep multiline values of unrelated variables as a single untouched block.
        if !["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"].contains(&key) {
            continue;
        }
        if result.contains_key(key) {
            return Err(".env 中存在重复的 Gemini 变量，请先整理".into());
        }
        let value =
            if let Some(quote) = raw.chars().next().filter(|c| matches!(c, '\'' | '"' | '`')) {
                let rest = &raw[1..];
                let end = rest
                    .char_indices()
                    .find(|(i, c)| *c == quote && (*i == 0 || rest.as_bytes()[*i - 1] != b'\\'))
                    .map(|(i, _)| i)
                    .ok_or(".env 引号无效")?;
                let value = &rest[..end];
                let tail = &rest[end + 1..];
                if !tail.trim().is_empty() && !tail.trim().starts_with('#') {
                    return Err(".env 值无效".into());
                }
                if quote == '"' {
                    value.replace("\\n", "\n").replace("\\r", "\r")
                } else {
                    value.to_string()
                }
            } else {
                raw.split('#').next().unwrap_or("").trim().to_string()
            };
        result.insert(key.into(), json!(value));
    }
    Ok(Value::Object(result))
}
fn env_literal(value: &Value) -> Result<String> {
    let value = value.as_str().ok_or("环境配置必须是字符串")?;
    for quote in ['\'', '`', '"'] {
        if !value.contains(quote)
            && !value.ends_with('\\')
            && (quote != '"' || (!value.contains("\\n") && !value.contains("\\r")))
        {
            return Ok(format!("{quote}{value}{quote}"));
        }
    }
    Err("该值无法无损写入 Gemini .env，请调整其中的引号或反斜杠".into())
}
fn env_update(source: &str, old: &Value, next: &Value) -> Result<String> {
    let mut result = String::new();
    let mut seen = std::collections::HashSet::new();
    for line in env_blocks(source)? {
        if let Some((key, _)) = env_pair(line) {
            if old.get(key).is_some() {
                seen.insert(key.to_string());
                if old.get(key) == next.get(key) {
                    result.push_str(line);
                } else if let Some(value) = next.get(key) {
                    result.push_str(&format!("{key}={}\n", env_literal(value)?));
                }
                continue;
            }
        }
        result.push_str(line);
    }
    for (key, value) in next.as_object().ok_or("环境配置结构无效")? {
        if !seen.contains(key) {
            if !result.is_empty() && !result.ends_with('\n') {
                result.push('\n');
            }
            result.push_str(&format!("{key}={}\n", env_literal(value)?));
        }
    }
    Ok(result)
}

fn root(home: &Path, env: &str, fallback: &str) -> Result<PathBuf> {
    let path = if crate::platform::is_default_home(home)
        && std::env::var_os("CYAPI_TOOLBOX_HOME_DIR").is_none()
    {
        std::env::var_os(env)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(fallback))
    } else {
        home.join(fallback)
    };
    let path = path
        .strip_prefix("~")
        .map(|rest| home.join(rest))
        .unwrap_or(path);
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("工具配置目录必须是绝对路径".into());
    }
    no_links(&path)?;
    Ok(path)
}
fn locations(home: &Path, data: &Path, tool: &str) -> Result<Vec<(PathBuf, &'static str)>> {
    Ok(match tool {
        "cline" => {
            let cline = root(home, "CLINE_DIR", ".cline")?;
            let dir = root(
                home,
                "CLINE_DATA_DIR",
                &cline.join("data").to_string_lossy(),
            )?
            .join("settings");
            vec![
                (dir.join("providers.json"), "json"),
                (dir.join("models.json"), "json"),
            ]
        }
        "kilo" => {
            let dir = root(home, "XDG_CONFIG_HOME", ".config")?.join("kilo");
            let file = if dir.join("kilo.jsonc").exists() {
                dir.join("kilo.jsonc")
            } else if dir.join("kilo.json").exists() {
                dir.join("kilo.json")
            } else {
                dir.join("kilo.jsonc")
            };
            vec![(file, "json")]
        }
        "qwen" => vec![(home.join(".qwen/settings.json"), "json")],
        "kimi" => vec![(home.join(".kimi/config.toml"), "toml")],
        "continue" => vec![(home.join(".continue/config.yaml"), "yaml")],
        "roo" => vec![(
            data.join("harness-config/roo/roo-code-settings.json"),
            "json",
        )],
        "aider" => vec![(home.join(".aider.conf.yml"), "yaml")],
        "gemini" => vec![
            (home.join(".gemini/settings.json"), "json"),
            (home.join(".gemini/.env"), "env"),
        ],
        "grok" => vec![(
            root(home, "GROK_HOME", ".grok")?.join("config.toml"),
            "toml",
        )],
        _ => return Err("不支持的 Harness 工具".into()),
    })
}
fn snapshot(home: &Path, data: &Path, tool: &str) -> Result<Vec<File>> {
    locations(home, data, tool)?
        .into_iter()
        .map(|(path, format)| {
            no_links(&path)?;
            let bytes = read_bytes(&path)?.map(|b| STANDARD.encode(b));
            Ok(File {
                path,
                format: format.into(),
                bytes,
            })
        })
        .collect()
}
fn revision(files: &[File]) -> String {
    crate::service::hash(&serde_json::to_vec(files).unwrap_or_default())
}
fn str_at<'a>(value: &'a Value, path: &str) -> &'a str {
    value.pointer(path).and_then(Value::as_str).unwrap_or("")
}
fn managed_qwen_model(value: &Value) -> bool {
    value["envKey"]
        .as_str()
        .is_some_and(|key| key == KEY || key.starts_with(&format!("{KEY}_")))
}
fn obj<'a>(value: &'a mut Value, path: &[&str]) -> Result<&'a mut Map<String, Value>> {
    let mut node = value;
    for key in path {
        node = node
            .as_object_mut()
            .ok_or("配置字段与已有内容结构冲突")?
            .entry(*key)
            .or_insert_with(|| json!({}));
    }
    node.as_object_mut().ok_or("配置字段必须是对象".into())
}
fn put(value: &mut Value, path: &[&str], field: &str, data: Value) -> Result<()> {
    obj(value, path)?.insert(field.into(), data);
    Ok(())
}
fn schema(value: &mut Value) -> Result<()> {
    if value.get("version").is_some_and(|v| v.as_u64() != Some(1)) {
        return Err("该配置版本尚未适配".into());
    }
    put(value, &[], "version", json!(1))
}
fn protocol(tool: &str, api: &str) -> Result<&'static str> {
    match (tool, api) {
        ("gemini", "gemini") => Ok("gemini"),
        ("gemini", _) | (_, "gemini") => Err("该工具不支持此 API 协议".into()),
        ("aider" | "roo", "openai-completions") => Ok("openai-completions"),
        ("aider" | "roo", _) => Err("该适配器支持 OpenAI Chat Completions".into()),
        (_, "openai-completions") => Ok("openai-completions"),
        (_, "openai-responses") => Ok("openai-responses"),
        (_, "anthropic-messages") => Ok("anthropic-messages"),
        _ => Err("不支持的 API 协议".into()),
    }
}

#[derive(Default)]
struct Selection {
    base: String,
    key: String,
    model: String,
    api: String,
    context: Option<u64>,
    output: Option<u64>,
}
fn selection(tool: &str, docs: &[Value]) -> Result<Selection> {
    let v = &docs[0];
    let mut out = Selection {
        api: if tool == "gemini" {
            "gemini"
        } else {
            "openai-completions"
        }
        .into(),
        ..Default::default()
    };
    let (p, base, key, model) = match tool {
        "cline" => (
            v.pointer("/providers/cyapi-toolbox/settings")
                .unwrap_or(&Value::Null),
            "baseUrl",
            "apiKey",
            "model",
        ),
        "kilo" => (
            v.pointer("/provider/cyapi-toolbox/options")
                .unwrap_or(&Value::Null),
            "baseURL",
            "apiKey",
            "",
        ),
        "kimi" => (
            v.pointer("/providers/cyapi-toolbox")
                .unwrap_or(&Value::Null),
            "base_url",
            "api_key",
            "",
        ),
        "grok" => (
            v.pointer("/model/cyapi-toolbox").unwrap_or(&Value::Null),
            "base_url",
            "api_key",
            "model",
        ),
        "roo" => (
            v.pointer("/providerProfiles/apiConfigs/CYAPI Toolbox")
                .unwrap_or(&Value::Null),
            "openAiBaseUrl",
            "openAiApiKey",
            "openAiModelId",
        ),
        "aider" => (v, "openai-api-base", "openai-api-key", "model"),
        "continue" => (
            v.get("models")
                .and_then(Value::as_array)
                .and_then(|a| a.iter().find(|m| m["name"].as_str() == Some(NAME)))
                .unwrap_or(&Value::Null),
            "apiBase",
            "apiKey",
            "model",
        ),
        _ => (&Value::Null, "", "", ""),
    };
    out.base = p[base].as_str().unwrap_or("").into();
    out.key = p[key].as_str().unwrap_or("").into();
    out.model = p[model].as_str().unwrap_or("").into();
    match tool {
        "cline" => {
            out.api = match p["protocol"].as_str() {
                Some("anthropic") => "anthropic-messages",
                Some("openai-responses") => "openai-responses",
                _ => "openai-completions",
            }
            .into();
        }
        "kilo" => {
            out.model = str_at(v, "/model")
                .strip_prefix("cyapi-toolbox/")
                .unwrap_or("")
                .into();
            let provider = &v["provider"][PROVIDER];
            if out.model.is_empty() {
                out.model = provider["models"]
                    .as_object()
                    .and_then(|m| m.keys().next())
                    .cloned()
                    .unwrap_or_default();
            }
            out.api = match provider["npm"].as_str() {
                Some("@ai-sdk/anthropic") => "anthropic-messages",
                Some("@ai-sdk/openai") => "openai-responses",
                _ => "openai-completions",
            }
            .into();
            let m = &provider["models"][&out.model];
            out.context = m["limit"]["context"].as_u64();
            out.output = m["limit"]["output"].as_u64();
        }
        "qwen" => {
            let selected = str_at(v, "/model/name");
            let selected_kind = str_at(v, "/security/auth/selectedType");
            let entries = v["modelProviders"]
                .as_object()
                .into_iter()
                .flat_map(|o| o.iter())
                .flat_map(|(kind, a)| a.as_array().into_iter().flatten().map(move |m| (kind, m)));
            let managed: Vec<_> = entries.filter(|(_, m)| managed_qwen_model(m)).collect();
            if let Some((kind, m)) = managed
                .iter()
                .find(|(kind, m)| {
                    kind.as_str() == selected_kind && m["id"].as_str() == Some(selected)
                })
                .or_else(|| {
                    managed
                        .iter()
                        .find(|(kind, _)| kind.as_str() == selected_kind)
                })
                .or_else(|| managed.first())
            {
                out.model = m["id"].as_str().unwrap_or("").into();
                out.base = m["baseUrl"].as_str().unwrap_or("").into();
                out.api = if kind.as_str() == "anthropic" {
                    "anthropic-messages"
                } else if m["wireApi"].as_str() == Some("responses") {
                    "openai-responses"
                } else {
                    "openai-completions"
                }
                .into();
                out.key = v["env"][m["envKey"].as_str().unwrap_or(KEY)]
                    .as_str()
                    .unwrap_or("")
                    .into();
            }
        }
        "kimi" => {
            out.model = str_at(v, "/models/cyapi-toolbox/model").into();
            out.context = v["models"][PROVIDER]["max_context_size"].as_u64();
            out.api = match p["type"].as_str() {
                Some("anthropic") => "anthropic-messages",
                Some("openai_responses") => "openai-responses",
                _ => "openai-completions",
            }
            .into();
        }
        "grok" => {
            out.api = match p["api_backend"].as_str() {
                Some("messages") => "anthropic-messages",
                Some("responses") => "openai-responses",
                _ => "openai-completions",
            }
            .into();
            out.context = p["context_window"].as_u64();
            out.output = p["max_completion_tokens"].as_u64();
        }
        "continue" => {
            out.api = if p["provider"].as_str() == Some("anthropic") {
                "anthropic-messages"
            } else if p["useResponsesApi"].as_bool() == Some(true) {
                "openai-responses"
            } else {
                "openai-completions"
            }
            .into();
        }
        "aider" => {
            out.model = out
                .model
                .strip_prefix("openai/")
                .unwrap_or(&out.model)
                .to_string();
        }
        "gemini" => {
            out.model = str_at(v, "/model/name").into();
            out.key = docs[1]["GEMINI_API_KEY"].as_str().unwrap_or("").into();
            out.base = docs[1]["GOOGLE_GEMINI_BASE_URL"]
                .as_str()
                .unwrap_or("https://generativelanguage.googleapis.com")
                .into();
        }
        _ => {}
    }
    Ok(out)
}

fn validate(tool: &str, input: &Input) -> Result<String> {
    protocol(tool, &input.api)?;
    let copy = crate::desktop_model_config::Input {
        base_url: input.base_url.clone(),
        api_key: input.api_key.clone(),
        model: input.model.clone(),
        revision: input.revision.clone(),
        api: if input.api == "gemini" {
            "openai-completions".into()
        } else {
            input.api.clone()
        },
    };
    let base = crate::desktop_model_config::validate(&copy)?;
    if input.api_key.chars().any(char::is_whitespace) {
        return Err("API Key 不能包含空白字符".into());
    }
    for n in [input.context_window, input.max_tokens]
        .into_iter()
        .flatten()
    {
        if n == 0 || n > 9_007_199_254_740_991 {
            return Err("请填写有效的 token 上限".into());
        }
    }
    if matches!(tool, "kilo" | "kimi" | "grok") && input.context_window.is_none() {
        return Err("请填写模型实际支持的上下文窗口".into());
    }
    if matches!(tool, "kilo" | "grok") && input.max_tokens.is_none() {
        return Err("请填写模型实际支持的最大输出".into());
    }
    if input
        .context_window
        .zip(input.max_tokens)
        .is_some_and(|(c, o)| o > c)
    {
        return Err("最大输出不能超过上下文窗口".into());
    }
    if tool == "gemini"
        && (base.ends_with("/v1") || base.ends_with("/v1beta") || base.contains(":generateContent"))
    {
        return Err("Gemini 请填写 API 根地址，不含 /v1、/v1beta 或 generateContent 路径".into());
    }
    Ok(base)
}

fn prepare(tool: &str, current: &[File], input: &Input) -> Result<Vec<File>> {
    let base = validate(tool, input)?;
    let mut docs = current
        .iter()
        .map(File::value)
        .collect::<Result<Vec<_>>>()?;
    let previous = selection(tool, &docs)?;
    let key = if input.api_key.is_empty() {
        if previous.base.trim_end_matches('/') != base || previous.api != input.api {
            return Err("更换 API 地址或协议时请重新填写 API Key".into());
        }
        if previous.key.is_empty() {
            return Err("请填写 API Key".into());
        }
        previous.key
    } else {
        input.api_key.clone()
    };
    let model = input.model.trim();
    let v = &mut docs[0];
    match tool {
        "cline" => {
            schema(v)?;
            let (wire, client) = match input.api.as_str() {
                "anthropic-messages" => ("anthropic", "anthropic"),
                "openai-responses" => ("openai-responses", "openai"),
                _ => ("openai-chat", "openai-compatible"),
            };
            let path = ["providers", PROVIDER, "settings"];
            for (field, value) in [
                ("provider", PROVIDER),
                ("baseUrl", &base),
                ("apiKey", &key),
                ("model", model),
                ("protocol", wire),
                ("client", client),
            ] {
                put(v, &path, field, json!(value))?;
            }
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "系统时间无效")?
                .as_secs();
            let stamp = chrono::DateTime::from_timestamp(stamp as i64, 0)
                .ok_or("系统时间无效")?
                .to_rfc3339();
            put(v, &["providers", PROVIDER], "updatedAt", json!(stamp))?;
            put(v, &["providers", PROVIDER], "tokenSource", json!("manual"))?;
            // Leave other clients' selected provider intact; this channel is available in the picker.
            if v.get("lastUsedProvider").is_none() {
                put(v, &[], "lastUsedProvider", json!(PROVIDER))?;
            }
            let registry = &mut docs[1];
            schema(registry)?;
            let path = ["providers", PROVIDER, "provider"];
            for (field, value) in [
                ("name", NAME),
                ("baseUrl", &base),
                ("defaultModelId", model),
                ("protocol", wire),
                ("client", client),
            ] {
                put(registry, &path, field, json!(value))?;
            }
            put(registry, &path, "capabilities", json!(["tools"]))?;
            put(
                registry,
                &["providers", PROVIDER, "models", model],
                "id",
                json!(model),
            )?;
            put(
                registry,
                &["providers", PROVIDER, "models", model],
                "name",
                json!(model),
            )?;
        }
        "kilo" => {
            let npm = match input.api.as_str() {
                "anthropic-messages" => "@ai-sdk/anthropic",
                "openai-responses" => "@ai-sdk/openai",
                _ => "@ai-sdk/openai-compatible",
            };
            put(v, &["provider", PROVIDER], "name", json!(NAME))?;
            put(v, &["provider", PROVIDER], "npm", json!(npm))?;
            put(
                v,
                &["provider", PROVIDER, "options"],
                "baseURL",
                json!(base),
            )?;
            put(v, &["provider", PROVIDER, "options"], "apiKey", json!(key))?;
            let path = ["provider", PROVIDER, "models", model];
            put(v, &path, "name", json!(model))?;
            put(v, &path, "tool_call", json!(true))?;
            put(
                v,
                &["provider", PROVIDER, "models", model, "limit"],
                "context",
                json!(input.context_window.unwrap()),
            )?;
            put(
                v,
                &["provider", PROVIDER, "models", model, "limit"],
                "output",
                json!(input.max_tokens.unwrap()),
            )?;
            put(v, &[], "model", json!(format!("{PROVIDER}/{model}")))?;
        }
        "qwen" => {
            let kind = if input.api == "anthropic-messages" {
                "anthropic"
            } else {
                "openai"
            };
            // Every model/auth pair has its own binding: rotating one gateway's key
            // must not send that new key to a previously configured endpoint.
            let binding = format!(
                "{KEY}_{}",
                crate::service::hash(format!("{kind}:{model}").as_bytes()).to_ascii_uppercase()
            );
            let models = obj(v, &["modelProviders"])?
                .entry(kind)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or("Qwen 模型列表格式无效")?;
            let matches: Vec<_> = models
                .iter()
                .enumerate()
                .filter(|(_, m)| m["id"].as_str() == Some(model))
                .map(|(i, _)| i)
                .collect();
            if matches.len() > 1
                || matches
                    .first()
                    .is_some_and(|i| !managed_qwen_model(&models[*i]))
            {
                return Err("Qwen 已有同名模型，请使用其他模型 ID 或在原应用中整理".into());
            }
            let index = matches.first().copied().unwrap_or_else(|| {
                models.push(json!({}));
                models.len() - 1
            });
            let entry = models[index].as_object_mut().ok_or("Qwen 模型格式无效")?;
            for (field, value) in [
                ("id", model),
                ("name", model),
                ("baseUrl", &base),
                ("envKey", &binding),
            ] {
                entry.insert(field.into(), json!(value));
            }
            if kind == "openai" {
                entry.insert(
                    "wireApi".into(),
                    json!(if input.api == "openai-responses" {
                        "responses"
                    } else {
                        "chat-completions"
                    }),
                );
            }
            put(v, &["env"], &binding, json!(key))?;
            put(v, &["security", "auth"], "selectedType", json!(kind))?;
            put(v, &["model"], "name", json!(model))?;
        }
        "kimi" => {
            let kind = match input.api.as_str() {
                "anthropic-messages" => "anthropic",
                "openai-responses" => "openai_responses",
                _ => "openai_legacy",
            };
            for (field, value) in [("type", kind), ("base_url", &base), ("api_key", &key)] {
                put(v, &["providers", PROVIDER], field, json!(value))?;
            }
            put(v, &["models", PROVIDER], "provider", json!(PROVIDER))?;
            put(v, &["models", PROVIDER], "model", json!(model))?;
            put(
                v,
                &["models", PROVIDER],
                "max_context_size",
                json!(input.context_window.unwrap()),
            )?;
            put(v, &[], "default_model", json!(PROVIDER))?;
        }
        "grok" => {
            let backend = match input.api.as_str() {
                "anthropic-messages" => "messages",
                "openai-responses" => "responses",
                _ => "chat_completions",
            };
            for (field, value) in [
                ("model", model),
                ("name", NAME),
                ("base_url", &base),
                ("api_key", &key),
                ("api_backend", backend),
            ] {
                put(v, &["model", PROVIDER], field, json!(value))?;
            }
            put(
                v,
                &["model", PROVIDER],
                "context_window",
                json!(input.context_window.unwrap()),
            )?;
            put(
                v,
                &["model", PROVIDER],
                "max_completion_tokens",
                json!(input.max_tokens.unwrap()),
            )?;
            if backend == "messages" {
                put(
                    v,
                    &["model", PROVIDER, "extra_headers"],
                    "x-api-key",
                    json!(key),
                )?;
                put(
                    v,
                    &["model", PROVIDER, "extra_headers"],
                    "anthropic-version",
                    json!("2023-06-01"),
                )?;
            } else if previous.api == "anthropic-messages" {
                let headers = obj(v, &["model", PROVIDER, "extra_headers"])?;
                headers.remove("x-api-key");
                headers.remove("anthropic-version");
            }
            put(v, &["models"], "default", json!(PROVIDER))?;
        }
        "continue" => {
            let map = obj(v, &[])?;
            map.entry("name").or_insert(json!("Local Config"));
            map.entry("version").or_insert(json!("1.0.0"));
            if map.get("schema").is_some_and(|s| s.as_str() != Some("v1")) {
                return Err("Continue 配置 schema 尚未适配".into());
            }
            map.entry("schema").or_insert(json!("v1"));
            let models = map
                .entry("models")
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or("Continue 模型列表格式无效")?;
            let matches: Vec<_> = models
                .iter()
                .enumerate()
                .filter(|(_, m)| m["name"].as_str() == Some(NAME))
                .map(|(i, _)| i)
                .collect();
            if matches.len() > 1 {
                return Err("Continue 存在重复 CYAPI 模型，请先整理".into());
            }
            let index = matches.first().copied().unwrap_or_else(|| {
                models.push(json!({"roles":["chat","edit","apply"]}));
                models.len() - 1
            });
            let entry = models[index]
                .as_object_mut()
                .ok_or("Continue 模型格式无效")?;
            let provider = if input.api == "anthropic-messages" {
                "anthropic"
            } else {
                "openai"
            };
            for (field, value) in [
                ("name", NAME),
                ("provider", provider),
                ("model", model),
                ("apiBase", &base),
                ("apiKey", &key),
            ] {
                entry.insert(field.into(), json!(value));
            }
            if provider == "openai" {
                entry.insert(
                    "useResponsesApi".into(),
                    json!(input.api == "openai-responses"),
                );
            } else {
                entry.remove("useResponsesApi");
            }
        }
        "roo" => {
            let path = ["providerProfiles", "apiConfigs", NAME];
            for (field, value) in [
                ("id", PROVIDER),
                ("apiProvider", "openai"),
                ("openAiBaseUrl", &base),
                ("openAiApiKey", &key),
                ("openAiModelId", model),
            ] {
                put(v, &path, field, json!(value))?;
            }
            put(v, &path, "openAiStreamingEnabled", json!(true))?;
            put(
                v,
                &["providerProfiles"],
                "currentApiConfigName",
                json!(NAME),
            )?;
        }
        "aider" => {
            put(
                v,
                &[],
                "model",
                json!(format!(
                    "openai/{}",
                    model.strip_prefix("openai/").unwrap_or(model)
                )),
            )?;
            put(v, &[], "openai-api-base", json!(base))?;
            put(v, &[], "openai-api-key", json!(key))?;
        }
        "gemini" => {
            put(v, &["model"], "name", json!(model))?;
            put(
                v,
                &["security", "auth"],
                "selectedType",
                json!("gemini-api-key"),
            )?;
            put(&mut docs[1], &[], "GEMINI_API_KEY", json!(key))?;
            put(&mut docs[1], &[], "GOOGLE_GEMINI_BASE_URL", json!(base))?;
        }
        _ => return Err("不支持的 Harness 工具".into()),
    }
    current
        .iter()
        .zip(&docs)
        .map(|(file, value)| file.edited(value))
        .collect()
}

#[derive(Serialize, Deserialize)]
struct Backup {
    schema: u32,
    before: Vec<File>,
    after: String,
}
fn backup_path(data: &Path, tool: &str) -> PathBuf {
    data.join(format!("harness-config/{tool}/previous.json"))
}
fn backup_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    no_links(path)?;
    match fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(m) if m.is_file() && m.len() <= 4_000_000 => {}
        _ => return Err("无法读取配置备份".into()),
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "无法读取配置备份")?
        .take(4_000_001)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取配置备份")?;
    if bytes.len() > 4_000_000 {
        return Err("配置备份过大".into());
    }
    Ok(Some(bytes))
}
fn read_backup(data: &Path, tool: &str) -> Result<Option<Backup>> {
    let Some(bytes) = backup_bytes(&backup_path(data, tool))? else {
        return Ok(None);
    };
    let backup: Backup = serde_json::from_slice(&bytes).map_err(|_| "配置备份无效")?;
    if backup.schema != 1 || backup.before.len() > 2 {
        return Err("配置备份无效".into());
    }
    for f in &backup.before {
        f.text()?;
    }
    Ok(Some(backup))
}
fn matches(backup: &Backup, current: &[File]) -> bool {
    backup.before.len() == current.len()
        && backup
            .before
            .iter()
            .zip(current)
            .all(|(a, b)| a.path == b.path && a.format == b.format)
        && backup.after == revision(current)
}
fn current_matches(files: &[File]) -> Result<bool> {
    for file in files {
        no_links(&file.path)?;
        let bytes = if file.format == "backup" {
            backup_bytes(&file.path)?
        } else {
            read_bytes(&file.path)?
        };
        if bytes.map(|b| STANDARD.encode(b)) != file.bytes {
            return Ok(false);
        }
    }
    Ok(true)
}
fn replace(file: &File) -> Result<()> {
    no_links(&file.path)?;
    match &file.bytes {
        Some(bytes) => {
            let temp = stage(
                &file.path,
                &STANDARD.decode(bytes).map_err(|_| "配置快照无效")?,
            )?;
            fs::rename(&temp, &file.path).map_err(|_| {
                let _ = fs::remove_file(temp);
                "无法替换配置文件".into()
            })
        }
        None => match fs::remove_file(&file.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法恢复配置文件".into()),
        },
    }
}
fn commit(current: &[File], next: &[File]) -> Result<()> {
    let mut staged = Vec::new();
    let prepared: Result<()> = (|| {
        for f in next {
            staged.push(match &f.bytes {
                Some(b) => Some(stage(
                    &f.path,
                    &STANDARD.decode(b).map_err(|_| "配置快照无效")?,
                )?),
                None => None,
            });
        }
        Ok(())
    })();
    if let Err(e) = prepared {
        for p in staged.into_iter().flatten() {
            let _ = fs::remove_file(p);
        }
        return Err(e);
    }
    let mut count = 0;
    let result = (|| {
        if !current_matches(current)? {
            return Err("配置已被其他程序修改，请重新读取".into());
        }
        for ((old, new), temp) in current.iter().zip(next).zip(&staged) {
            if !current_matches(std::slice::from_ref(old))? {
                return Err("配置已变化，请重新读取".into());
            }
            if let Some(temp) = temp {
                fs::rename(temp, &new.path).map_err(|_| "无法替换配置文件，请检查占用")?;
            } else {
                replace(new)?;
            }
            count += 1;
        }
        Ok(())
    })();
    let mut failed = false;
    if result.is_err() {
        for (old, new) in current.iter().zip(next).take(count).rev() {
            // Retain the newly written recovery snapshot if any configuration failed to roll back.
            if failed && old.format == "backup" {
                continue;
            }
            if !current_matches(std::slice::from_ref(new)).unwrap_or(false) || replace(old).is_err()
            {
                failed = true;
            }
        }
    }
    for p in staged.into_iter().flatten() {
        let _ = fs::remove_file(p);
    }
    if failed {
        return Err("保存中断，部分文件未能恢复，请检查本地配置备份".into());
    }
    result
}

pub fn view(home: &Path, data: &Path, tool: &str) -> Result<Value> {
    let files = snapshot(home, data, tool)?;
    let docs = files.iter().map(File::value).collect::<Result<Vec<_>>>()?;
    let s = selection(tool, &docs)?;
    let can_restore = read_backup(data, tool)
        .ok()
        .flatten()
        .is_some_and(|b| matches(&b, &files));
    Ok(
        json!({"revision":revision(&files),"baseUrl":s.base,"model":s.model,"api":s.api,"apiKeyConfigured":!s.key.is_empty(),"contextWindow":s.context,"maxTokens":s.output,"canRestore":can_restore,"files":files.iter().map(|f|json!({"path":f.path,"exists":f.bytes.is_some()})).collect::<Vec<_>>()}),
    )
}
pub fn save(home: &Path, data: &Path, tool: &str, input: &Input) -> Result<Value> {
    let current = snapshot(home, data, tool)?;
    if revision(&current) != input.revision {
        return Err("配置已变化，请重新读取后保存".into());
    }
    let next = prepare(tool, &current, input)?;
    if next != current {
        let backup = Backup {
            schema: 1,
            before: current.clone(),
            after: revision(&next),
        };
        let path = backup_path(data, tool);
        no_links(&path)?;
        let old_backup = File {
            path: path.clone(),
            format: "backup".into(),
            bytes: backup_bytes(&path)?.map(|b| STANDARD.encode(b)),
        };
        let bytes = serde_json::to_vec(&backup).map_err(|_| "无法生成备份")?;
        if bytes.len() > 4_000_000 {
            return Err("配置备份过大".into());
        }
        let new_backup = File {
            path,
            format: "backup".into(),
            bytes: Some(STANDARD.encode(bytes)),
        };
        let mut originals = vec![old_backup];
        originals.extend(current);
        let mut outputs = vec![new_backup];
        outputs.extend(next);
        commit(&originals, &outputs)?;
    }
    view(home, data, tool)
}
pub fn restore(home: &Path, data: &Path, tool: &str, expected: &str) -> Result<Value> {
    let current = snapshot(home, data, tool)?;
    if revision(&current) != expected {
        return Err("配置已变化，请重新读取后恢复".into());
    }
    let backup = read_backup(data, tool)?.ok_or("没有可恢复的配置")?;
    if !matches(&backup, &current) {
        return Err("保存后配置已被其他程序修改，无法直接恢复".into());
    }
    commit(&current, &backup.before)?;
    view(home, data, tool)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("cyapi-harness-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        let data = root.join("data");
        fs::create_dir_all(&home).unwrap();
        (home, data)
    }
    fn input(home: &Path, data: &Path, tool: &str) -> Input {
        Input {
            base_url: "https://example.invalid/v1".into(),
            api_key: "test-key".into(),
            model: "test-model".into(),
            api: "openai-completions".into(),
            revision: revision(&snapshot(home, data, tool).unwrap()),
            context_window: Some(32000),
            max_tokens: Some(4000),
        }
    }
    #[test]
    fn all_adapters_roundtrip_and_restore_exact_files() {
        for tool in [
            "cline", "kilo", "qwen", "kimi", "continue", "roo", "aider", "gemini", "grok",
        ] {
            let (home, data) = fixture();
            let locations = locations(&home, &data, tool).unwrap();
            for (path, format) in &locations {
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                let seed = match *format {
                    "toml" => "# keep\n[unrelated]\nvalue = 1 # comment\n",
                    "yaml" => "# keep\nunrelated: 1 # comment\n",
                    "env" => "# keep\nOTHER='untouched'\n",
                    _ => "{\n // keep\n \"unrelated\": 1\n}\n",
                };
                fs::write(path, seed).unwrap();
            }
            let before = snapshot(&home, &data, tool).unwrap();
            let mut req = input(&home, &data, tool);
            if tool == "gemini" {
                req.api = "gemini".into();
                req.base_url = "https://example.invalid".into();
            }
            let saved = save(&home, &data, tool, &req).unwrap_or_else(|e| panic!("{tool}: {e}"));
            assert_eq!(saved["model"], "test-model", "{tool}");
            assert_eq!(saved["apiKeyConfigured"], true, "{tool}");
            assert_eq!(saved["canRestore"], true, "{tool}");
            assert!(!saved.to_string().contains("test-key"));
            for (path, _) in locations {
                assert!(
                    fs::read_to_string(path).unwrap().contains("# keep")
                        || before[0].format == "json"
                );
            }
            restore(&home, &data, tool, saved["revision"].as_str().unwrap()).unwrap();
            assert_eq!(
                revision(&snapshot(&home, &data, tool).unwrap()),
                revision(&before)
            );
            fs::remove_dir_all(home.parent().unwrap()).unwrap();
        }
    }
    #[test]
    fn stale_revisions_origin_changes_and_invalid_configs_do_not_write() {
        let (home, data) = fixture();
        let mut req = input(&home, &data, "qwen");
        let saved = save(&home, &data, "qwen", &req).unwrap();
        assert!(save(&home, &data, "qwen", &req).is_err());
        req.revision = saved["revision"].as_str().unwrap().into();
        req.api_key.clear();
        req.base_url = "https://other.invalid/v1".into();
        let before = snapshot(&home, &data, "qwen").unwrap();
        assert!(save(&home, &data, "qwen", &req).is_err());
        assert_eq!(
            revision(&before),
            revision(&snapshot(&home, &data, "qwen").unwrap())
        );
        fs::write(&before[0].path, "{\"model\":{},\"model\":{}}").unwrap();
        req.revision = revision(&snapshot(&home, &data, "qwen").unwrap());
        req.api_key = "test-key".into();
        assert!(save(&home, &data, "qwen", &req).is_err());
        assert!(restore(&home, &data, "qwen", &req.revision).is_err());
        fs::remove_dir_all(home.parent().unwrap()).unwrap();
    }
    #[test]
    fn protocols_merge_other_providers_and_grok_headers_are_updated() {
        for tool in ["cline", "kilo", "qwen", "kimi", "continue", "grok"] {
            let (home, data) = fixture();
            let mut req = input(&home, &data, tool);
            for api in [
                "anthropic-messages",
                "openai-responses",
                "openai-completions",
            ] {
                req.api = api.into();
                req.revision = revision(&snapshot(&home, &data, tool).unwrap());
                let saved =
                    save(&home, &data, tool, &req).unwrap_or_else(|e| panic!("{tool}/{api}: {e}"));
                assert_eq!(saved["api"], api, "{tool}");
                if tool == "grok" {
                    let doc = snapshot(&home, &data, tool).unwrap()[0].value().unwrap();
                    assert_eq!(
                        doc["model"][PROVIDER]["extra_headers"]["x-api-key"].is_string(),
                        api == "anthropic-messages"
                    );
                }
            }
            fs::remove_dir_all(home.parent().unwrap()).unwrap();
        }
    }
    #[test]
    fn complete_openai_endpoints_are_normalized_for_all_responses_adapters() {
        for tool in ["cline", "kilo", "qwen", "kimi", "continue", "grok"] {
            let (home, data) = fixture();
            let mut req = input(&home, &data, tool);
            req.api = "openai-responses".into();
            req.base_url = "https://example.invalid/v1/responses/".into();
            let saved =
                save(&home, &data, tool, &req).unwrap_or_else(|error| panic!("{tool}: {error}"));
            assert_eq!(saved["api"], "openai-responses", "{tool}");
            assert_eq!(saved["baseUrl"], "https://example.invalid/v1", "{tool}");
            fs::remove_dir_all(home.parent().unwrap()).unwrap();
        }
    }
    #[test]
    fn fresh_files_restore_to_absent_and_blank_keys_are_preserved() {
        for tool in [
            "cline", "kilo", "qwen", "kimi", "continue", "roo", "aider", "gemini", "grok",
        ] {
            let (home, data) = fixture();
            let mut req = input(&home, &data, tool);
            if tool == "gemini" {
                req.api = "gemini".into();
                req.base_url = "https://example.invalid".into();
            }
            let first = save(&home, &data, tool, &req).unwrap();
            let first_files = snapshot(&home, &data, tool).unwrap();
            req.revision = first["revision"].as_str().unwrap().into();
            req.api_key.clear();
            req.model = "second-model".into();
            let next = prepare(tool, &first_files, &req).unwrap();
            let docs = next
                .iter()
                .map(File::value)
                .collect::<Result<Vec<_>>>()
                .unwrap();
            assert_eq!(selection(tool, &docs).unwrap().key, "test-key", "{tool}");
            req.api = "anthropic-messages".into();
            assert!(prepare(tool, &first_files, &req).is_err(), "{tool}");
            restore(&home, &data, tool, first["revision"].as_str().unwrap()).unwrap();
            assert!(snapshot(&home, &data, tool)
                .unwrap()
                .iter()
                .all(|f| f.bytes.is_none()));
            fs::remove_dir_all(home.parent().unwrap()).unwrap();
        }
    }
    #[test]
    fn large_backups_support_repeated_saves_and_latest_restore() {
        let (home, data) = fixture();
        let path = home.join(".qwen/settings.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, json!({"unrelated":"x".repeat(800_000)}).to_string()).unwrap();
        let mut req = input(&home, &data, "qwen");
        let first = save(&home, &data, "qwen", &req).unwrap();
        assert!(fs::metadata(backup_path(&data, "qwen")).unwrap().len() > 1_000_000);
        req.revision = first["revision"].as_str().unwrap().into();
        req.model = "second-model".into();
        req.api_key.clear();
        let second = save(&home, &data, "qwen", &req).unwrap();
        let restored = restore(&home, &data, "qwen", second["revision"].as_str().unwrap()).unwrap();
        assert_eq!(restored["revision"], first["revision"]);
        fs::remove_dir_all(home.parent().unwrap()).unwrap();
    }
    #[test]
    fn qwen_keys_stay_scoped_to_models_and_protocols() {
        let (home, data) = fixture();
        let mut req = input(&home, &data, "qwen");
        let first = prepare("qwen", &snapshot(&home, &data, "qwen").unwrap(), &req).unwrap();
        req.api = "anthropic-messages".into();
        req.api_key = "second-key".into();
        req.base_url = "https://second.invalid/v1".into();
        let next = prepare("qwen", &first, &req).unwrap();
        let v = next[0].value().unwrap();
        let original = &v["modelProviders"]["openai"][0];
        let second = &v["modelProviders"]["anthropic"][0];
        assert_eq!(v["env"][original["envKey"].as_str().unwrap()], "test-key");
        assert_eq!(v["env"][second["envKey"].as_str().unwrap()], "second-key");
        assert_eq!(selection("qwen", &[v]).unwrap().api, "anthropic-messages");
        fs::remove_dir_all(home.parent().unwrap()).unwrap();
    }
    #[test]
    fn dotenv_preserves_unrelated_multiline_and_literal_credentials() {
        let source = "# keep\r\nOTHER=\"line one\nGEMINI_API_KEY=not-a-binding\nline three\"\r\nexport GEMINI_API_KEY='old-key' # old\r\n";
        let file = File {
            path: PathBuf::from("fixture.env"),
            format: "env".into(),
            bytes: Some(STANDARD.encode(source)),
        };
        let next = json!({"GEMINI_API_KEY": r##"key\value"#part"##, "GOOGLE_GEMINI_BASE_URL":"https://example.invalid"});
        let edited = file.edited(&next).unwrap();
        assert_eq!(edited.value().unwrap(), next);
        assert!(edited
            .text()
            .unwrap()
            .contains("OTHER=\"line one\nGEMINI_API_KEY=not-a-binding\nline three\"\r\n"));
        assert!(env_parse("GEMINI_API_KEY=a\nexport GEMINI_API_KEY=b").is_err());
    }
    #[test]
    fn commit_detects_stale_second_file_and_preserves_originals() {
        let (home, data) = fixture();
        let req = input(&home, &data, "cline");
        let current = snapshot(&home, &data, "cline").unwrap();
        let next = prepare("cline", &current, &req).unwrap();
        fs::create_dir_all(current[1].path.parent().unwrap()).unwrap();
        fs::write(&current[1].path, "{\"other\":true}").unwrap();
        assert!(commit(&current, &next).is_err());
        assert!(!current[0].path.exists());
        assert_eq!(
            fs::read_to_string(&current[1].path).unwrap(),
            "{\"other\":true}"
        );
        assert!(!fs::read_dir(current[1].path.parent().unwrap())
            .unwrap()
            .any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        fs::remove_dir_all(home.parent().unwrap()).unwrap();
    }
}
