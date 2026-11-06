use crate::configuration::{no_links, read_bytes, stage};
use crate::desktop_model_config::Input;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, String>;
const PROVIDER: &str = "cyapi-toolbox";
const NAME: &str = "CYAPI Toolbox";

fn version() -> Result<String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let script = r#"$k=@('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'); @(Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'MiniMax Code' } | ForEach-Object { $_.DisplayVersion })"#;
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(0x08000000)
            .output()
            .map_err(|_| "无法检测 MiniMax Code 版本")?;
        let v = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !output.status.success() || v != "3.1.10" {
            return Err("未检测到受支持的 MiniMax Code 官方桌面版；目前仅适配 3.1.10，旧版本及其他版本暂不支持".into());
        }
        Ok(v)
    }
    #[cfg(not(windows))]
    {
        Err("当前系统尚不能可靠识别 MiniMax Code 桌面版版本，暂不支持写入".into())
    }
}
fn path(dir: &str) -> Result<PathBuf> {
    let root = Path::new(dir.trim());
    if !root.is_absolute()
        || !root.is_dir()
        || root
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("请填写已确认的 MiniMax Code 数据目录绝对路径".into());
    }
    let path = root.join("config.yaml");
    no_links(&path)?;
    if read_bytes(&path)?.is_none() {
        return Err("数据目录中未找到 config.yaml，请在 MiniMax Code 中确认目录".into());
    }
    Ok(path)
}
fn parse(bytes: &[u8]) -> Result<Value> {
    let s = std::str::from_utf8(bytes).map_err(|_| "MiniMax 配置不是 UTF-8")?;
    // serde_yaml does not preserve comments, anchors, aliases or tags.
    if s.contains(['#', '&', '*', '!']) {
        return Err("MiniMax 配置含注释或复杂 YAML，请在应用中配置，未写入文件".into());
    }
    let value = serde_yaml_ng::from_str::<crate::pi_model_config::Strict>(s)
        .map_err(|_| "MiniMax 配置无效或含重复字段，未写入文件")?
        .0;
    // The JSON value encoder sorts mappings. Refuse files whose existing
    // mapping order would change, including the model chooser order.
    let ordered: serde_yaml_ng::Value =
        serde_yaml_ng::from_str(s).map_err(|_| "MiniMax 配置无效，未写入文件")?;
    fn ordered_keys(value: &serde_yaml_ng::Value) -> bool {
        match value {
            serde_yaml_ng::Value::Mapping(map) => {
                let mut previous: Option<&str> = None;
                for (key, item) in map {
                    let Some(key) = key.as_str() else {
                        return false;
                    };
                    if previous.is_some_and(|p| p >= key) || !ordered_keys(item) {
                        return false;
                    }
                    previous = Some(key);
                }
                true
            }
            serde_yaml_ng::Value::Sequence(items) => items.iter().all(ordered_keys),
            serde_yaml_ng::Value::Tagged(_) => false,
            _ => true,
        }
    }
    if !ordered_keys(&ordered) {
        return Err("MiniMax 配置的字段或模型顺序无法安全保留，请在应用中配置，未写入文件".into());
    }
    if !value.is_object() {
        return Err("MiniMax 配置必须是 YAML 对象".into());
    }
    Ok(value)
}
fn revision(path: &Path, bytes: &[u8]) -> String {
    crate::service::hash(&serde_json::to_vec(&(path, bytes)).unwrap_or_default())
}
fn provider(doc: &Value) -> Result<Option<&Value>> {
    if let Some(all) = doc.get("custom_provider") {
        let all = all.as_object().ok_or("MiniMax 自定义供应商格式无效")?;
        if let Some(p) = all.get(PROVIDER) {
            if p.get("name").and_then(Value::as_str) != Some(NAME)
                || p.get("kind").and_then(Value::as_str) != Some("custom")
                || p.get("api").and_then(Value::as_str) != Some("openai-completions")
            {
                return Err("MiniMax 已有同名供应商，未覆盖原配置".into());
            }
            return Ok(Some(p));
        }
    }
    Ok(None)
}
pub fn view(dir: &str) -> Result<Value> {
    let ver = version()?;
    view_at(&path(dir)?, &ver)
}
fn view_at(path: &Path, ver: &str) -> Result<Value> {
    no_links(path)?;
    let bytes = read_bytes(path)?.ok_or("MiniMax 配置不存在")?;
    let doc = parse(&bytes)?;
    let p = provider(&doc)?;
    let model = p
        .and_then(|v| v.get("models"))
        .and_then(Value::as_object)
        .and_then(|v| v.keys().next())
        .map(String::as_str)
        .unwrap_or("");
    Ok(
        json!({"version":ver,"revision":revision(path,&bytes),"baseUrl":p.and_then(|v|v.pointer("/options/baseURL")).and_then(Value::as_str).unwrap_or(""),"model":model,"apiKeyConfigured":p.and_then(|v|v.pointer("/options/apiKey")).and_then(Value::as_str).is_some_and(|v|!v.is_empty()),"configPath":path}),
    )
}
pub fn save(dir: &str, input: &Input) -> Result<()> {
    version()?;
    save_at(&path(dir)?, input)
}
fn save_at(path: &Path, input: &Input) -> Result<()> {
    let url = reqwest::Url::parse(input.base_url.trim()).map_err(|_| "API 地址无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || input.base_url.len() > 2048
        || input.base_url.chars().any(char::is_control)
    {
        return Err("API 地址无效".into());
    }
    if input.model.trim().is_empty()
        || input.model.len() > 200
        || input.model.chars().any(char::is_control)
        || input.api_key.len() > 8192
        || input.api_key.chars().any(char::is_control)
    {
        return Err("模型或 API Key 格式无效".into());
    }
    if input.model.contains(['#', '&', '*', '!'])
        || input.api_key.contains(['#', '&', '*', '!'])
        || input.base_url.contains(['#', '&', '*', '!'])
    {
        return Err("此配置包含特殊 YAML 字符，请在 MiniMax Code 中配置".into());
    }
    no_links(path)?;
    let original = read_bytes(path)?.ok_or("MiniMax 配置不存在")?;
    if revision(path, &original) != input.revision {
        return Err("配置已变化，请重新读取后保存".into());
    }
    let mut doc = parse(&original)?;
    provider(&doc)?;
    let providers = doc
        .as_object_mut()
        .unwrap()
        .entry("custom_provider")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("MiniMax 供应商格式无效")?;
    let p = providers
        .entry(PROVIDER)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("MiniMax 供应商格式无效")?;
    p.insert("name".into(), json!(NAME));
    p.insert("kind".into(), json!("custom"));
    p.insert("enabled".into(), json!(true));
    p.insert("api".into(), json!("openai-completions"));
    let options = p
        .entry("options")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("MiniMax 供应商选项格式无效")?;
    options.insert("baseURL".into(), json!(input.base_url.trim()));
    if !input.api_key.is_empty() {
        options.insert("apiKey".into(), json!(input.api_key));
    }
    if !options
        .get("apiKey")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty())
    {
        return Err("请填写 API Key".into());
    }
    let models = p
        .entry("models")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("MiniMax 模型列表格式无效")?;
    if models
        .get(input.model.trim())
        .is_some_and(|model| model.get("enabled").and_then(Value::as_bool) == Some(false))
    {
        return Err("该模型已在 MiniMax 中停用，请先在应用中处理".into());
    }
    models
        .entry(input.model.trim())
        .or_insert_with(|| json!({"name":input.model.trim(),"enabled":true}));
    let encoded = serde_yaml_ng::to_string(&doc)
        .map_err(|_| "无法生成 MiniMax 配置")?
        .into_bytes();
    if encoded.len() > 1_000_000 {
        return Err("生成的配置过大".into());
    }
    let tmp = stage(path, &encoded)?;
    let backup = path.with_file_name(format!("config.yaml.cyapi-backup-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        if read_bytes(path)?.as_ref() != Some(&original) {
            return Err("配置已被其他程序修改，请重新读取".into());
        }
        let backup_tmp = stage(&backup, &original)?;
        if let Err(_e) = fs::rename(&backup_tmp, &backup) {
            let _ = fs::remove_file(backup_tmp);
            return Err("无法备份 MiniMax 配置，未写入".into());
        }
        no_links(path)?;
        if read_bytes(path)?.as_ref() != Some(&original) {
            return Err("配置已被其他程序修改，请重新读取".into());
        }
        fs::rename(&tmp, path).map_err(|_| "无法替换 MiniMax 配置，请检查是否被占用")?;
        Ok(())
    })();
    let _ = fs::remove_file(tmp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merge_preserves_other_fields_and_backups_original() {
        let dir = std::env::temp_dir().join(format!("cyapi-minimax-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.yaml");
        let original = "custom_provider:\n  other:\n    name: other\nsetting: value\n";
        fs::write(&path, original).unwrap();
        let mut input = Input {
            base_url: "https://example.invalid/v1".into(),
            api_key: "fictional-key".into(),
            model: "fictional-model".into(),
            revision: revision(&path, original.as_bytes()),
        };
        save_at(&path, &input).unwrap();
        let contents = fs::read(&path).unwrap();
        let doc = parse(&contents).unwrap();
        assert_eq!(doc["setting"], "value");
        assert_eq!(doc["custom_provider"]["other"]["name"], "other");
        assert_eq!(
            doc["custom_provider"][PROVIDER]["models"]["fictional-model"]["enabled"],
            true
        );
        assert!(fs::read_dir(&dir)
            .unwrap()
            .any(|e| fs::read(e.unwrap().path()).unwrap() == original.as_bytes()));
        assert!(save_at(&path, &input).is_err());
        input.revision = revision(&path, &contents);
        input.api_key.clear();
        input.model = "another-model".into();
        save_at(&path, &input).unwrap();
        let doc = parse(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            doc["custom_provider"][PROVIDER]["options"]["apiKey"],
            "fictional-key"
        );
        assert!(doc["custom_provider"][PROVIDER]["models"]
            .get("fictional-model")
            .is_some());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn refuses_comments_duplicate_keys_and_foreign_provider() {
        assert!(parse(b"x: 1 # note\n").is_err());
        assert!(parse(b"x: 1\nx: 2\n").is_err());
        assert!(parse(b"z: 1\na: 2\n").is_err());
        assert!(provider(&json!({"custom_provider":{"cyapi-toolbox":{"name":"other"}}})).is_err());
    }
}
