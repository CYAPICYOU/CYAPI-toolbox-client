use crate::configuration::{no_links, read_bytes, stage};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
type Result<T> = std::result::Result<T, String>;

fn path(home: &Path) -> Result<PathBuf> {
    let models = crate::pi_model_config::paths(home)?;
    Ok(models[0].parent().ok_or("Pi 目录无效")?.join("mcp.json"))
}
fn snapshot(path: &Path) -> Result<(Value, String)> {
    no_links(path)?;
    let bytes = read_bytes(path)?;
    decode(path, bytes.as_deref())
}
fn decode(path: &Path, bytes: Option<&[u8]>) -> Result<(Value, String)> {
    let doc = match bytes {
        None => json!({}),
        Some(data) => {
            serde_json::from_slice::<crate::pi_model_config::Strict>(data)
                .map_err(|_| "Pi MCP 配置不是有效 JSON 或存在重复字段，未写入")?
                .0
        }
    };
    if !doc.is_object() || doc.get("mcpServers").is_some_and(|v| !v.is_object()) {
        return Err("Pi MCP 配置格式无效".into());
    }
    let rev = crate::service::hash(&serde_json::to_vec(&(path, bytes)).unwrap_or_default());
    Ok((doc, rev))
}
fn view_at(path: &Path) -> Result<Value> {
    let (doc, revision) = snapshot(path)?;
    let servers: Vec<_> = doc.get("mcpServers").and_then(Value::as_object).into_iter().flat_map(|m|m.iter()).map(|(name, value)|json!({
        "name":name,
        "transport": if value.get("command").is_some() { "stdio" } else if value.get("url").is_some() { "http" } else { "unknown" },
        "enabled":value.get("enabled").and_then(Value::as_bool).unwrap_or(true),
    })).collect();
    Ok(json!({"revision":revision,"servers":servers,"configPath":path}))
}
pub fn view(home: &Path) -> Result<Value> {
    crate::pi_model_config::version()?;
    view_at(&path(home)?)
}
pub fn change(home: &Path, action: &str, values: &BTreeMap<String, Value>) -> Result<()> {
    crate::pi_model_config::version()?;
    change_at(&path(home)?, action, values)
}
fn change_at(path: &Path, action: &str, values: &BTreeMap<String, Value>) -> Result<()> {
    let get = |key: &str| values.get(key).and_then(Value::as_str).unwrap_or("");
    let name = get("name");
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("MCP 名称仅支持字母、数字、下划线和连字符".into());
    }
    no_links(path)?;
    let original = read_bytes(path)?;
    let (mut doc, rev) = decode(path, original.as_deref())?;
    if get("revision") != rev {
        return Err("MCP 配置已变化，请重新读取".into());
    }
    let servers = doc
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("MCP 列表格式无效")?;
    match action {
        "pi-mcp-save" => {
            let normalized = name.replace('-', "_");
            if servers.keys().any(|n| n.replace('-', "_") == normalized) {
                return Err("同名 MCP 已存在，不会覆盖原配置".into());
            }
            let transport = get("transport");
            let mut entry = match transport {
                "stdio" => {
                    let command = get("command").trim();
                    if command.is_empty()
                        || command.len() > 512
                        || command.chars().any(char::is_control)
                    {
                        return Err("请填写有效的 MCP 程序名".into());
                    }
                    let args = values
                        .get("args")
                        .and_then(Value::as_array)
                        .ok_or("MCP 参数格式无效")?;
                    if args.len() > 64
                        || args.iter().any(|v| {
                            v.as_str()
                                .is_none_or(|s| s.len() > 2048 || s.chars().any(char::is_control))
                        })
                    {
                        return Err("MCP 参数格式无效".into());
                    }
                    json!({"command":command,"args":args})
                }
                "http" => {
                    let url = reqwest::Url::parse(get("url").trim()).map_err(|_| "MCP URL 无效")?;
                    if !matches!(url.scheme(), "http" | "https")
                        || url.host_str().is_none()
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || url.fragment().is_some()
                        || get("url").len() > 8192
                        || get("url").chars().any(char::is_control)
                    {
                        return Err("MCP URL 无效或包含用户名、密码、片段".into());
                    }
                    json!({"url":get("url").trim()})
                }
                _ => return Err("MCP 传输方式无效".into()),
            };
            let field = if transport == "stdio" {
                "env"
            } else {
                "headers"
            };
            if let Some(value) = values.get(field) {
                let map = value
                    .as_object()
                    .ok_or("MCP 环境变量或请求头必须是 JSON 对象")?;
                if map.len() > 64
                    || map.iter().any(|(k, v)| {
                        k.is_empty()
                            || k.len() > 256
                            || k.chars().any(char::is_control)
                            || v.as_str()
                                .is_none_or(|s| s.len() > 8192 || s.chars().any(char::is_control))
                            || (field == "env" && k.contains('='))
                    })
                {
                    return Err("MCP 环境变量或请求头格式无效".into());
                }
                entry[field] = value.clone();
            }
            if transport == "stdio" && !get("cwd").is_empty() {
                if get("cwd").len() > 2048 || get("cwd").chars().any(char::is_control) {
                    return Err("MCP 工作目录格式无效".into());
                }
                entry["cwd"] = json!(get("cwd"));
            }
            servers.insert(name.into(), entry);
        }
        "pi-mcp-toggle" => {
            let entry = servers
                .get_mut(name)
                .and_then(Value::as_object_mut)
                .ok_or("MCP 不存在或格式不支持")?;
            if entry.get("enabled").is_some_and(|v| !v.is_boolean()) {
                return Err("MCP 启用状态格式无法识别，未写入".into());
            }
            let enabled = values
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or("状态无效")?;
            entry.insert("enabled".into(), json!(enabled));
        }
        "pi-mcp-remove" => {
            if servers.remove(name).is_none() {
                return Err("MCP 不存在".into());
            }
        }
        _ => return Err("MCP 操作无效".into()),
    }
    let encoded = serde_json::to_vec_pretty(&doc).map_err(|_| "无法生成 MCP 配置")?;
    if encoded.len() > 1_000_000 {
        return Err("MCP 配置过大".into());
    }
    let temp = stage(path, &encoded)?;
    let result = (|| {
        no_links(path)?;
        if read_bytes(path)? != original {
            return Err("MCP 配置已被其他程序修改，请重新读取".into());
        }
        fs::rename(&temp, path).map_err(|_| "无法保存 Pi MCP 配置")?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protects_existing_entries_and_concurrent_edits() {
        let dir = std::env::temp_dir().join(format!("cyapi-pi-mcp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mcp.json");
        fs::write(&path,r#"{"other":true,"mcpServers":{"other":{"command":"fictional","env":{"TOKEN":"fictional"}}}}"#).unwrap();
        let rev = snapshot(&path).unwrap().1;
        let mut values = BTreeMap::from([
            ("revision".into(), json!(rev)),
            ("name".into(), json!("example")),
            ("transport".into(), json!("stdio")),
            ("command".into(), json!("example")),
            ("args".into(), json!([])),
        ]);
        change_at(&path, "pi-mcp-save", &values).unwrap();
        assert!(change_at(&path, "pi-mcp-save", &values).is_err());
        values.insert("revision".into(), json!(snapshot(&path).unwrap().1));
        assert!(change_at(&path, "pi-mcp-save", &values).is_err());
        values.insert("enabled".into(), json!(false));
        change_at(&path, "pi-mcp-toggle", &values).unwrap();
        let doc = snapshot(&path).unwrap().0;
        assert_eq!(doc["mcpServers"]["other"]["env"]["TOKEN"], "fictional");
        assert_eq!(doc["other"], true);
        assert_eq!(doc["mcpServers"]["example"]["enabled"], false);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn saves_stdio_environment_and_authenticated_http_without_exposing_secrets() {
        let dir =
            std::env::temp_dir().join(format!("cyapi-pi-mcp-fields-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mcp.json");
        let mut values = BTreeMap::from([
            ("revision".into(), json!(snapshot(&path).unwrap().1)),
            ("name".into(), json!("local")),
            ("transport".into(), json!("stdio")),
            ("command".into(), json!("example")),
            ("args".into(), json!([" leading space "])),
            ("env".into(), json!({"TOKEN":"${MY_TOKEN}"})),
            ("cwd".into(), json!("~/workspace")),
        ]);
        change_at(&path, "pi-mcp-save", &values).unwrap();
        values.insert("revision".into(), json!(snapshot(&path).unwrap().1));
        values.insert("name".into(), json!("remote"));
        values.insert("transport".into(), json!("http"));
        values.insert(
            "url".into(),
            json!("https://example.invalid/mcp?workspace=sample"),
        );
        values.insert(
            "headers".into(),
            json!({"Authorization":"Bearer fictional-secret"}),
        );
        change_at(&path, "pi-mcp-save", &values).unwrap();
        let doc = snapshot(&path).unwrap().0;
        assert_eq!(doc["mcpServers"]["local"]["args"][0], " leading space ");
        assert_eq!(doc["mcpServers"]["local"]["env"]["TOKEN"], "${MY_TOKEN}");
        assert_eq!(doc["mcpServers"]["local"]["cwd"], "~/workspace");
        assert_eq!(
            doc["mcpServers"]["remote"]["headers"]["Authorization"],
            "Bearer fictional-secret"
        );
        assert!(!view_at(&path)
            .unwrap()
            .to_string()
            .contains("fictional-secret"));
        values.insert("revision".into(), json!(snapshot(&path).unwrap().1));
        values.insert("name".into(), json!("invalid"));
        values.insert("headers".into(), json!({"X-Test":12}));
        assert!(change_at(&path, "pi-mcp-save", &values).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
