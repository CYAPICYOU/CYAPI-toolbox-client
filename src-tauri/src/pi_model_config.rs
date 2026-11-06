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
    version_on_path(&std::env::split_paths(&path).collect::<Vec<_>>())
}

fn supported(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    parts.len() == 3 && parts[0] == "1" && matches!(parts[1], "4" | "5")
        && !parts[2].is_empty() && parts[2].bytes().all(|b| b.is_ascii_digit())
}

fn version_on_path(bins: &[PathBuf]) -> Result<String> {
    for bin in bins {
        if !bin.is_absolute() { continue; }
        #[cfg(windows)]
        let launchers = [bin.join("pi.exe"), bin.join("pi.cmd"), bin.join("pi.ps1")];
        #[cfg(not(windows))]
        let launchers = [bin.join("pi")];
        let Some(launcher) = launchers.iter().find(|p| p.is_file()) else { continue; };
        let mut candidates = Vec::new();
        // npm, local node_modules/.bin, standalone releases, and package-manager
        // symlinks (pnpm, Bun, Homebrew). Read metadata without starting Pi.
        if let Ok(real) = fs::canonicalize(launcher) {
            if real != *launcher {
                candidates.extend(real.ancestors().skip(1).take(5).map(|p| p.join("package.json")));
            }
        }
        candidates.extend([
            bin.join("node_modules/@earendil-works/pi-coding-agent/package.json"),
            bin.join("../lib/node_modules/@earendil-works/pi-coding-agent/package.json"),
            bin.join("../@earendil-works/pi-coding-agent/package.json"),
            bin.join("package.json"),
        ]);
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
                    return if supported(v) { Ok(v.to_owned()) } else {
                        Err(format!("检测到 Pi {v}，目前支持官方 Pi 1.4.x / 1.5.x"))
                    };
                }
            }
        }
        // The first executable wins on PATH. Never identify a later install as
        // the active one when an unrelated or unidentifiable launcher shadows it.
        return Err("发现 Pi 启动器，但无法确认其官方安装信息；请检查 PATH 和安装目录".into());
    }
    Err("未检测到官方 Pi 安装，请安装 Pi 1.4.x / 1.5.x 并将其加入 PATH".into())
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
        json!({"version":version,"revision":revision(&files),"baseUrl":p.and_then(|p| p.get("baseUrl")).and_then(Value::as_str).unwrap_or(""),"model":model,"api":p.and_then(|p|p.get("api")).and_then(Value::as_str).unwrap_or("openai-completions"),"models":p.and_then(|p|p.get("models")).and_then(Value::as_array).map(|m|m.iter().filter_map(|m|m.get("id").and_then(Value::as_str)).collect::<Vec<_>>()).unwrap_or_default(),"apiKeyConfigured":p.and_then(|p| p.get("apiKey")).and_then(Value::as_str).is_some_and(|v| !v.is_empty()),"configPath":paths[0]}),
    )
}
pub fn save(home: &Path, input: &Input) -> Result<()> {
    version()?;
    save_at(&paths(home)?, input)
}
fn save_at(paths: &[PathBuf], input: &Input) -> Result<()> {
    let base_url = crate::desktop_model_config::validate(input)?;
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
        // Pi interpolates '$' and executes leading '!'. Its documented escapes
        // preserve literal keys without evaluating either form.
        let escaped = input.api_key.replace('$', "$$");
        let escaped = if escaped.starts_with('!') { format!("${escaped}") } else { escaped };
        provider.insert("apiKey".into(), json!(escaped));
    }
    if !provider
        .get("apiKey")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty())
    {
        return Err("请填写 API Key".into());
    }
    provider.insert("name".into(), json!(NAME));
    provider.insert("api".into(), json!(input.api));
    provider.insert("baseUrl".into(), json!(base_url));
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
    if let Some(model) = entries.iter_mut().find(|m| m["id"].as_str() == Some(input.model.trim())).and_then(Value::as_object_mut) {
        if model.contains_key("api") { model.insert("api".into(), json!(input.api)); }
        if model.contains_key("baseUrl") { model.insert("baseUrl".into(), json!(base_url)); }
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
            api: crate::desktop_model_config::default_api(),
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
    fn rejects_stale_revision_and_escapes_literal_keys() {
        let (root, paths) = fixture();
        let mut request = input(&paths);
        fs::write(&paths[1], "{}").unwrap();
        assert!(save_at(&paths, &request).is_err());
        request.revision = revision(&snapshot(&paths).unwrap());
        for (key, encoded) in [("$SECRET", "$$SECRET"), ("!command", "$!command"), ("a$b", "a$$b")] {
            request.api_key = key.into();
            request.revision = revision(&snapshot(&paths).unwrap());
            save_at(&paths, &request).unwrap();
            assert_eq!(parse(read_bytes(&paths[0]).unwrap().as_deref()).unwrap()["providers"][PROVIDER]["apiKey"], encoded);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_current_package_and_obeys_path_precedence() {
        let (root, _) = fixture();
        let first = root.join("first");
        let second = root.join("second");
        #[cfg(windows)]
        let launcher = "pi.cmd";
        #[cfg(not(windows))]
        let launcher = "pi";
        for (dir, version) in [(&first, "1.5.0"), (&second, "1.4.0")] {
            let package = dir.join("node_modules/@earendil-works/pi-coding-agent");
            fs::create_dir_all(&package).unwrap();
            fs::write(dir.join(launcher), "").unwrap();
            fs::write(package.join("package.json"), serde_json::to_vec(&json!({"name":"@earendil-works/pi-coding-agent","version":version})).unwrap()).unwrap();
        }
        assert_eq!(version_on_path(&[first.clone(), second.clone()]).unwrap(), "1.5.0");
        fs::remove_dir_all(first.join("node_modules")).unwrap();
        assert!(version_on_path(&[first, second]).is_err());
        assert!(supported("1.5.1"));
        assert!(!supported("1.5.0-dev"));
        assert!(!supported("2.0.0"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn switching_protocol_updates_selected_model_overrides() {
        let (root, paths) = fixture();
        save_at(&paths, &input(&paths)).unwrap();
        let mut doc = parse(read_bytes(&paths[0]).unwrap().as_deref()).unwrap();
        doc["providers"][PROVIDER]["models"][0]["api"] = json!("openai-completions");
        doc["providers"][PROVIDER]["models"][0]["baseUrl"] = json!("https://old.invalid/v1");
        doc["providers"][PROVIDER]["models"][0]["contextWindow"] = json!(200000);
        fs::write(&paths[0], serde_json::to_vec(&doc).unwrap()).unwrap();
        let mut request = input(&paths);
        request.api = "openai-responses".into();
        request.base_url = "https://example.invalid/v1/responses".into();
        save_at(&paths, &request).unwrap();
        let model = &parse(read_bytes(&paths[0]).unwrap().as_deref()).unwrap()["providers"][PROVIDER]["models"][0];
        assert_eq!(model["api"], "openai-responses");
        assert_eq!(model["baseUrl"], "https://example.invalid/v1");
        assert_eq!(model["contextWindow"], 200000);
        assert_eq!(view_at(&paths, "1.5.0").unwrap()["api"], "openai-responses");
        fs::remove_dir_all(root).unwrap();
    }
}
