use crate::configuration::{no_links, read_bytes, stage};
use crate::desktop_model_config::Input;
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{json, Map, Value};
use std::{
    fmt, fs,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, String>;
const PROVIDER: &str = "cyapi-toolbox";
const NAME: &str = "CYAPI Toolbox";

// Reject duplicate keys at every level: accepting them and serializing JSON
// would silently discard user configuration.
pub(crate) struct Strict(pub(crate) Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Strict;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON value without duplicate keys")
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> std::result::Result<Strict, E> {
                Ok(Strict(json!(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Strict, E> {
                Ok(Strict(json!(v)))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Strict, E> {
                Ok(Strict(json!(v)))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Strict, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| Strict(Value::Number(n)))
                    .ok_or_else(|| E::custom("non-finite number"))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> std::result::Result<Strict, E> {
                Ok(Strict(json!(v)))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                v: String,
            ) -> std::result::Result<Strict, E> {
                Ok(Strict(json!(v)))
            }
            fn visit_none<E: serde::de::Error>(self) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Strict, A::Error> {
                let mut v = Vec::new();
                while let Some(item) = a.next_element::<Strict>()? {
                    v.push(item.0);
                }
                Ok(Strict(Value::Array(v)))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Strict, A::Error> {
                let mut v = Map::new();
                while let Some((key, item)) = a.next_entry::<String, Strict>()? {
                    if v.insert(key, item.0).is_some() {
                        return Err(serde::de::Error::custom("duplicate key"));
                    }
                }
                Ok(Strict(Value::Object(v)))
            }
        }
        d.deserialize_any(V)
    }
}
fn parse(bytes: Option<&[u8]>) -> Result<Value> {
    let value = match bytes {
        Some(bytes) => {
            serde_json::from_slice::<Strict>(bytes)
                .map_err(|_| "Pi 配置不是有效 JSON 或含重复字段，未写入")?
                .0
        }
        None => json!({}),
    };
    if !value.is_object() {
        return Err("Pi 配置必须是 JSON 对象".into());
    }
    Ok(value)
}
pub(crate) fn version() -> Result<String> {
    // Do not execute an unrelated `pi` on PATH, or start Pi just to read its
    // version: its startup can migrate or write user settings.
    let path = std::env::var_os("PATH").ok_or("无法检测 Pi 安装路径")?;
    let mut found = Vec::new();
    for bin in std::env::split_paths(&path) {
        #[cfg(windows)]
        let candidates = [bin.join("node_modules/@earendil-works/pi-coding-agent/package.json")];
        #[cfg(not(windows))]
        let candidates =
            [bin.join("../lib/node_modules/@earendil-works/pi-coding-agent/package.json")];
        #[cfg(windows)]
        let launcher = bin.join("pi.cmd");
        #[cfg(not(windows))]
        let launcher = bin.join("pi");
        if !launcher.exists() {
            continue;
        }
        for manifest in candidates {
            let Ok(Some(bytes)) = read_bytes(&manifest) else {
                continue;
            };
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            if value.get("name").and_then(Value::as_str) == Some("@earendil-works/pi-coding-agent")
            {
                if let Some(v) = value.get("version").and_then(Value::as_str) {
                    found.push(v.to_owned());
                }
            }
        }
    }
    found.sort();
    found.dedup();
    if found.as_slice() != ["1.4.0"] {
        return Err(
            "未检测到受支持的官方 Pi npm 安装；目前仅适配 1.4.0，其他安装方式或版本暂不支持".into(),
        );
    }
    Ok(found.remove(0))
}
pub(crate) fn paths(home: &Path) -> Result<Vec<PathBuf>> {
    let dir = std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|v| !v.is_empty())
        .filter(|_| {
            std::env::var_os("CYAPI_TOOLBOX_HOME_DIR").is_none()
                && crate::platform::is_default_home(home)
        })
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".pi/agent"));
    let dir = if let Ok(rest) = dir.strip_prefix("~") {
        home.join(rest)
    } else {
        dir
    };
    if !dir.is_absolute()
        || dir
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("PI_CODING_AGENT_DIR 必须是绝对路径".into());
    }
    Ok(["models.json", "settings.json", "auth.json"]
        .iter()
        .map(|f| dir.join(f))
        .collect())
}
type Files = Vec<(PathBuf, Option<Vec<u8>>)>;
fn snapshot(paths: &[PathBuf]) -> Result<Files> {
    paths
        .iter()
        .map(|p| {
            no_links(p)?;
            Ok((p.clone(), read_bytes(p)?))
        })
        .collect()
}
fn revision(files: &Files) -> String {
    crate::service::hash(&serde_json::to_vec(files).unwrap_or_default())
}
fn docs(files: &Files) -> Result<(Value, Value)> {
    let models = parse(files[0].1.as_deref())?;
    let settings = parse(files[1].1.as_deref())?;
    let auth = parse(files[2].1.as_deref())?;
    if auth.get(PROVIDER).is_some() {
        return Err(
            "Pi auth.json 存在同名凭据，优先级高于模型配置；请先在 Pi 中处理，未写入".into(),
        );
    }
    if let Some(p) = models.get("providers").and_then(|v| v.get(PROVIDER)) {
        if p.get("name").and_then(Value::as_str) != Some(NAME)
            || p.get("api").and_then(Value::as_str) != Some("openai-completions")
        {
            return Err("Pi 已存在同名提供商，未覆盖原配置".into());
        }
    }
    Ok((models, settings))
}
pub fn view(home: &Path) -> Result<Value> {
    let version = version()?;
    view_at(&paths(home)?, &version)
}
fn view_at(paths: &[PathBuf], version: &str) -> Result<Value> {
    let files = snapshot(paths)?;
    let (models, settings) = docs(&files)?;
    let p = models.pointer("/providers/cyapi-toolbox");
    let model = if settings.get("defaultProvider").and_then(Value::as_str) == Some(PROVIDER) {
        settings
            .get("defaultModel")
            .and_then(Value::as_str)
            .unwrap_or("")
    } else {
        ""
    };
    Ok(
        json!({"version":version,"revision":revision(&files),"baseUrl":p.and_then(|p| p.get("baseUrl")).and_then(Value::as_str).unwrap_or(""),"model":model,"apiKeyConfigured":p.and_then(|p| p.get("apiKey")).and_then(Value::as_str).is_some_and(|v| !v.is_empty()),"configPath":paths[0]}),
    )
}
pub fn save(home: &Path, input: &Input) -> Result<()> {
    version()?;
    save_at(&paths(home)?, input)
}
fn save_at(paths: &[PathBuf], input: &Input) -> Result<()> {
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
    // Literal dollar and command syntax must never be interpreted by Pi.
    if input.api_key.contains('$') || input.api_key.starts_with('!') {
        return Err("Pi API Key 不能包含 $ 或以 ! 开头，请在 Pi 中手动配置特殊凭据".into());
    }
    let files = snapshot(paths)?;
    if revision(&files) != input.revision {
        return Err("配置已变化，请重新读取后保存".into());
    }
    let (mut models, mut settings) = docs(&files)?;
    let providers = models
        .as_object_mut()
        .unwrap()
        .entry("providers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("Pi 提供商列表格式无效")?;
    let provider = providers
        .entry(PROVIDER)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("Pi 提供商格式无效")?;
    if !input.api_key.is_empty() {
        provider.insert("apiKey".into(), json!(input.api_key));
    }
    if !provider
        .get("apiKey")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty())
    {
        return Err("请填写 API Key".into());
    }
    provider.insert("name".into(), json!(NAME));
    provider.insert("api".into(), json!("openai-completions"));
    provider.insert("baseUrl".into(), json!(input.base_url.trim()));
    let entries = provider
        .entry("models")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or("Pi 模型列表格式无效")?;
    if !entries
        .iter()
        .any(|v| v.get("id").and_then(Value::as_str) == Some(input.model.trim()))
    {
        entries.push(json!({"id":input.model.trim()}));
    }
    settings["defaultProvider"] = json!(PROVIDER);
    settings["defaultModel"] = json!(input.model.trim());
    let output = [
        serde_json::to_vec_pretty(&models),
        serde_json::to_vec_pretty(&settings),
    ]
    .into_iter()
    .map(|v| v.map_err(|_| "无法生成 Pi 配置".to_string()))
    .collect::<Result<Vec<_>>>()?;
    if output.iter().any(|v| v.len() > 1_000_000) {
        return Err("生成的配置过大".into());
    }
    let mut staged = Vec::new();
    for (path, bytes) in paths.iter().zip(&output) {
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
        if snapshot(paths)? != files {
            return Err("配置已被其他程序修改，请重新读取".into());
        }
        for ((path, original), temp) in files.iter().zip(&staged) {
            no_links(path)?;
            if read_bytes(path)? != *original {
                return Err("配置已被其他程序修改，请重新读取".into());
            }
            no_links(&files[2].0)?;
            if read_bytes(&files[2].0)? != files[2].1 {
                return Err("Pi 凭据已变化，请重新读取".into());
            }
            fs::rename(temp, path).map_err(|_| "无法替换 Pi 配置文件，请检查是否被占用")?;
            committed += 1;
        }
        Ok(())
    })();
    let mut failed = false;
    if result.is_err() {
        for ((path, original), written) in files.iter().zip(&output).take(committed).rev() {
            if read_bytes(path).ok().flatten().as_ref() != Some(written) {
                failed = true;
                continue;
            }
            let restored = match original {
                Some(b) => {
                    stage(path, b).and_then(|p| fs::rename(p, path).map_err(|_| "恢复失败".into()))
                }
                None => fs::remove_file(path).map_err(|_| "恢复失败".into()),
            };
            failed |= restored.is_err();
        }
    }
    for p in staged {
        let _ = fs::remove_file(p);
    }
    if failed {
        return Err("保存中断，部分文件未能恢复，请检查 Pi 配置".into());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, Vec<PathBuf>) {
        let root = std::env::temp_dir().join(format!("cyapi-pi-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let paths = ["models.json", "settings.json", "auth.json"]
            .iter()
            .map(|name| root.join(name))
            .collect();
        (root, paths)
    }
    fn input(paths: &[PathBuf]) -> Input {
        Input {
            base_url: "https://example.invalid/v1".into(),
            api_key: "fictional-key".into(),
            model: "test-model".into(),
            revision: revision(&snapshot(paths).unwrap()),
        }
    }
    #[test]
    fn merges_models_and_preserves_credentials_and_settings() {
        let (root, paths) = fixture();
        fs::write(&paths[0], r#"{"providers":{"other":{"custom":true}}}"#).unwrap();
        fs::write(&paths[1], r#"{"theme":"test","defaultProvider":"other"}"#).unwrap();
        save_at(&paths, &input(&paths)).unwrap();
        let mut next = input(&paths);
        next.api_key.clear();
        next.model = "other-model".into();
        save_at(&paths, &next).unwrap();
        let m = parse(read_bytes(&paths[0]).unwrap().as_deref()).unwrap();
        let s = parse(read_bytes(&paths[1]).unwrap().as_deref()).unwrap();
        assert_eq!(m["providers"]["other"]["custom"], true);
        assert_eq!(m["providers"][PROVIDER]["apiKey"], "fictional-key");
        assert_eq!(
            m["providers"][PROVIDER]["models"].as_array().unwrap().len(),
            2
        );
        assert_eq!(s["theme"], "test");
        assert_eq!(s["defaultModel"], "other-model");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_collisions_comments_duplicates_and_auth_override() {
        let (root, paths) = fixture();
        for source in [
            r#"{"providers":{"cyapi-toolbox":{"apiKey":"foreign"}}}"#,
            "{ // comment\n }",
            r#"{"a":1,"a":2}"#,
        ] {
            fs::write(&paths[0], source).unwrap();
            assert!(save_at(&paths, &input(&paths)).is_err());
            assert_eq!(fs::read_to_string(&paths[0]).unwrap(), source);
        }
        fs::write(&paths[0], "{}").unwrap();
        fs::write(
            &paths[2],
            r#"{"cyapi-toolbox":{"type":"api_key","key":"other"}}"#,
        )
        .unwrap();
        assert!(save_at(&paths, &input(&paths)).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_stale_revision_and_special_keys() {
        let (root, paths) = fixture();
        let mut request = input(&paths);
        fs::write(&paths[1], "{}").unwrap();
        assert!(save_at(&paths, &request).is_err());
        request.revision = revision(&snapshot(&paths).unwrap());
        for key in ["$SECRET", "!command", "a$b"] {
            request.api_key = key.into();
            assert!(save_at(&paths, &request).is_err());
        }
        assert!(!paths[0].exists());
        fs::remove_dir_all(root).unwrap();
    }
}
