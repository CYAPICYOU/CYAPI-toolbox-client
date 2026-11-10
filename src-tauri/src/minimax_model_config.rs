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

// 3.1.6 and later keep the same `custom_provider` config layout; accept later
// releases by default rather than whitelisting every patch version.
const MIN_VERSION: (u64, u64, u64) = (3, 1, 6);

fn version() -> Result<String> {
    let v = crate::desktop_model_config::version("minimax")?;
    supported(&v)?;
    Ok(v)
}
fn supported(v: &str) -> Result<()> {
    let Some(parsed) = version_parts(v) else {
        return Err(format!(
            "检测到 MiniMax Code {v}，无法识别版本号，暂不支持写入"
        ));
    };
    if parsed < MIN_VERSION {
        return Err(format!(
            "检测到 MiniMax Code {v}，客户端版本过低；请更新到 3.1.6 或更高版本"
        ));
    }
    Ok(())
}
fn version_parts(value: &str) -> Option<(u64, u64, u64)> {
    let core = value.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let parsed = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    // Extra numeric components such as `3.1.13.1` are still fine.
    parts
        .all(|part| part.parse::<u64>().is_ok())
        .then_some(parsed)
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

fn resolve_path(home: &Path, dir: &str) -> Result<PathBuf> {
    if !dir.trim().is_empty() {
        return path(dir);
    }
    let isolated = std::env::var_os("CYAPI_TOOLBOX_HOME_DIR").is_some()
        || !crate::platform::is_default_home(home);
    if !isolated {
        for name in ["MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"] {
            if let Some(value) = std::env::var_os(name).filter(|v| !v.is_empty()) {
                return path(value.to_str().ok_or("MiniMax 数据目录编码无效")?);
            }
        }
        #[cfg(windows)]
        let app_data = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"));
        #[cfg(target_os = "macos")]
        let app_data = home.join("Library/Application Support");
        #[cfg(not(any(windows, target_os = "macos")))]
        let app_data = home.join(".config");
        let mut configured = Vec::new();
        for app in ["MiniMax Code", "MiniMax", "MiniMax Agent"] {
            for file in ["minimax-agent-cn-config.json", "minimax-agent-config.json"] {
                let store = app_data.join(app).join(file);
                no_links(&store)?;
                let Some(bytes) = read_bytes(&store)? else {
                    continue;
                };
                let doc = serde_json::from_slice::<crate::pi_model_config::Strict>(&bytes)
                    .map_err(|_| "MiniMax 桌面目录设置无效，请手动指定数据目录")?
                    .0;
                if let Some(parent) = doc
                    .pointer("/config/localRuntimeDataParentDir")
                    .and_then(Value::as_str)
                    .filter(|v| !v.trim().is_empty())
                {
                    configured.push(PathBuf::from(parent.trim()).join(".minimax"));
                }
            }
        }
        configured.sort();
        configured.dedup();
        if configured.len() > 1 {
            return Err("检测到多个 MiniMax 数据目录，请手动指定".into());
        }
        if let Some(dir) = configured.first() {
            return path(dir.to_str().ok_or("MiniMax 数据目录编码无效")?);
        }
    }
    path(
        home.join(".minimax")
            .to_str()
            .ok_or("MiniMax 数据目录编码无效")?,
    )
}
fn parse(bytes: &[u8]) -> Result<Value> {
    let s = std::str::from_utf8(bytes).map_err(|_| "MiniMax 配置不是 UTF-8")?;
    let value = crate::harness_yaml::parse(s)?;
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
            {
                return Err("MiniMax 已有同名供应商，未覆盖原配置".into());
            }
            return Ok(Some(p));
        }
    }
    Ok(None)
}
pub fn view(home: &Path, dir: &str) -> Result<Value> {
    let ver = version()?;
    view_at(&resolve_path(home, dir)?, &ver)
}
fn view_at(path: &Path, ver: &str) -> Result<Value> {
    no_links(path)?;
    let bytes = read_bytes(path)?.ok_or("MiniMax 配置不存在")?;
    let doc = parse(&bytes)?;
    let p = provider(&doc)?;
    let models: Vec<_> = p
        .and_then(|v| v.get("models"))
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|m| m.iter())
        .filter(|(_, m)| m.get("enabled").and_then(Value::as_bool) != Some(false))
        .map(|(id, _)| id.as_str())
        .collect();
    let model = doc
        .get("defaultModel")
        .and_then(Value::as_str)
        .and_then(|m| m.strip_prefix("custom_provider:cyapi-toolbox/"))
        .filter(|m| models.contains(m))
        .or_else(|| models.first().copied())
        .unwrap_or("");
    Ok(
        json!({"version":ver,"revision":revision(path,&bytes),"baseUrl":p.and_then(|v|v.pointer("/options/baseURL")).and_then(Value::as_str).unwrap_or(""),"model":model,"models":models,"api":p.and_then(|v|v.get("api")).and_then(Value::as_str).unwrap_or("openai-responses"),"apiKeyConfigured":p.and_then(|v|v.pointer("/options/apiKey")).and_then(Value::as_str).is_some_and(|v|!v.is_empty()),"configPath":path,"dataDir":path.parent()}),
    )
}
pub fn save(home: &Path, dir: &str, input: &Input) -> Result<()> {
    version()?;
    save_at(&resolve_path(home, dir)?, input)
}
fn save_at(path: &Path, input: &Input) -> Result<()> {
    let base_url = crate::desktop_model_config::validate(input)?;
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
    p.insert("api".into(), json!(input.api));
    let options = p
        .entry("options")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("MiniMax 供应商选项格式无效")?;
    options.insert("baseURL".into(), json!(base_url));
    options.insert("authMode".into(), json!("api-key"));
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
    let encoded = crate::harness_yaml::update(
        std::str::from_utf8(&original).map_err(|_| "MiniMax 配置不是 UTF-8")?,
        &doc,
    )?
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
    fn accepts_3_1_6_and_later_but_not_older_or_unparsable() {
        for v in [
            "3.1.6",
            "3.1.13",
            "3.2.0",
            "4.0.0",
            "3.1.13.1",
            "3.1.13-beta.1",
        ] {
            assert!(supported(v).is_ok(), "{v}");
        }
        for v in ["3.1.5", "3.0.9", "2.9.0", "3.1", "3.x", "beta", ""] {
            assert!(supported(v).is_err(), "{v}");
        }
    }
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
            api: crate::desktop_model_config::default_api(),
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
    // Round-trip a config captured from a real 3.1.13 install; it uses anchors,
    // aliases and a managed `provider` tree that must survive untouched.
    #[test]
    fn appends_custom_provider_to_realistic_3_1_13_config() {
        let dir =
            std::env::temp_dir().join(format!("cyapi-minimax-313-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.yaml");
        let original = "logLevel: info\nprovider:\n  minimax:\n    name: MiniMax\n    api: anthropic-messages\n    options:\n      authMode: managed-login\n    models:\n      MiniMax-M3.1-Flash:\n        name: M3.1-Flash\n        capabilities: &ref_0\n          support_files_api: true\n          max_attachments_count: 4\n      MiniMax-M3:\n        name: MiniMax-M3\n        capabilities: *ref_0\ndefaultModel: minimax/MiniMax-M3.1-Flash\n";
        fs::write(&path, original).unwrap();
        let request = Input {
            base_url: "https://example.invalid/v1/responses/".into(),
            api_key: "fictional-key".into(),
            model: "fictional-model".into(),
            api: "openai-responses".into(),
            revision: revision(&path, original.as_bytes()),
        };
        save_at(&path, &request).unwrap();
        let result = fs::read_to_string(&path).unwrap();
        assert!(result.starts_with(original));
        let doc = parse(result.as_bytes()).unwrap();
        assert_eq!(
            doc["provider"]["minimax"]["options"]["authMode"],
            "managed-login"
        );
        assert_eq!(
            doc["custom_provider"][PROVIDER]["options"]["baseURL"],
            "https://example.invalid/v1"
        );
        assert_eq!(doc["custom_provider"][PROVIDER]["api"], "openai-responses");
        assert_eq!(
            doc["custom_provider"][PROVIDER]["models"]["fictional-model"]["enabled"],
            true
        );
        assert_eq!(doc["defaultModel"], "minimax/MiniMax-M3.1-Flash");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn accepts_comments_and_order_but_rejects_duplicates_and_foreign_provider() {
        assert!(parse(b"x: 1 # note\n").is_ok());
        assert!(parse(b"x: 1\nx: 2\n").is_err());
        assert!(parse(b"z: 1\na: 2\n").is_ok());
        assert!(provider(&json!({"custom_provider":{"cyapi-toolbox":{"name":"other"}}})).is_err());
    }

    #[test]
    fn edits_realistic_commented_config_preserving_order_and_model_metadata() {
        let dir = std::env::temp_dir().join(format!(
            "cyapi-minimax-comment-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.yaml");
        let original = "# user settings\nzoom: 1\ncustom_provider:\n  cyapi-toolbox:\n    name: CYAPI Toolbox\n    kind: custom\n    api: openai-completions\n    options:\n      baseURL: https://example.invalid/v1\n      apiKey: 'old#key' # key note\n    models:\n      z-model: {name: Z, enabled: true, contextWindow: 200000}\n      a-model: {name: A, enabled: true}\n# default\ndefaultModel: custom_provider:cyapi-toolbox/z-model\n";
        fs::write(&path, original).unwrap();
        let request = Input {
            base_url: "https://example.invalid/v1/responses/".into(),
            api_key: "!a&#*b".into(),
            model: "z-model".into(),
            api: "openai-responses".into(),
            revision: revision(&path, original.as_bytes()),
        };
        save_at(&path, &request).unwrap();
        let result = fs::read_to_string(&path).unwrap();
        assert!(result
            .contains("z-model: {name: Z, enabled: true, contextWindow: 200000}\n      a-model:"));
        assert!(result.starts_with("# user settings\nzoom: 1\n"));
        assert!(result.contains("# key note"));
        assert!(result.contains("# default\ndefaultModel: custom_provider:cyapi-toolbox/z-model"));
        let view = view_at(&path, "3.1.6").unwrap();
        assert_eq!(view["model"], "z-model");
        assert_eq!(view["api"], "openai-responses");
        assert!(!serde_json::to_string(&view).unwrap().contains("!a&#*b"));
        assert_eq!(
            parse(result.as_bytes()).unwrap()["custom_provider"][PROVIDER]["options"]["apiKey"],
            "!a&#*b"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn resolves_isolated_default_and_explicit_data_directories() {
        let home =
            std::env::temp_dir().join(format!("cyapi-minimax-path-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(home.join(".minimax")).unwrap();
        fs::write(home.join(".minimax/config.yaml"), "{}").unwrap();
        assert_eq!(
            resolve_path(&home, "").unwrap(),
            home.join(".minimax/config.yaml")
        );
        assert_eq!(
            resolve_path(&home, home.join(".minimax").to_str().unwrap()).unwrap(),
            home.join(".minimax/config.yaml")
        );
        assert!(resolve_path(&home, "relative").is_err());
        fs::remove_dir_all(home).unwrap();
    }
}
