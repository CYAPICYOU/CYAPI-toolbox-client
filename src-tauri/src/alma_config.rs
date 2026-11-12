//! Alma model configuration through Alma's local provider API.
//!
//! Alma keeps provider data in its application database and exposes the
//! supported configuration surface while the app is running.  Do not edit
//! that database directly: the local API also keeps Alma's provider state
//! and model metadata consistent.

use reqwest::blocking::Client;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Map, Value};
use std::time::Duration;

type Result<T> = std::result::Result<T, String>;

const API: &str = "http://127.0.0.1:23001";
const PROVIDER_NAME: &str = "CYAPI Toolbox";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Provider {
    id: String,
    name: String,
    #[serde(rename = "type")]
    provider_type: String,
    #[serde(default, deserialize_with = "null_default")]
    api_key: String,
    #[serde(
        default,
        rename = "baseURL",
        alias = "baseUrl",
        deserialize_with = "null_default"
    )]
    base_url: String,
    #[serde(default, deserialize_with = "null_default")]
    enabled: bool,
    #[serde(default, deserialize_with = "null_default")]
    api_format: String,
    #[serde(default, deserialize_with = "null_default")]
    models: Vec<Value>,
    #[serde(default, deserialize_with = "null_default")]
    available_models: Vec<Value>,
}

fn null_default<'de, D, T>(deserializer: D) -> std::result::Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Clone, Serialize)]
struct Snapshot {
    provider: Option<Provider>,
    settings: Value,
}

fn client() -> Result<Client> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "无法创建 Alma 本机连接".into())
}

fn request(method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value> {
    let url = format!("{API}{path}");
    let client = client()?;
    let mut request = client.request(method, url);
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .map_err(|_| "无法连接 Alma，请先启动 Alma 后重试".to_string())?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|_| "无法读取 Alma 响应".to_string())?;
    if !status.is_success() {
        return Err(format!("Alma 请求失败（HTTP {}）", status.as_u16()));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|_| "Alma 返回了无效响应".into())
}

fn providers() -> Result<Vec<Provider>> {
    let value = request(reqwest::Method::GET, "/api/providers", None)?;
    let value = value.get("providers").cloned().unwrap_or(value);
    let list = value.as_array().ok_or("Alma 服务商列表格式不受支持")?;
    list.iter()
        .filter(|provider| provider.get("name").and_then(Value::as_str) == Some(PROVIDER_NAME))
        .map(|provider| {
            serde_json::from_value(provider.clone()).map_err(|_| "Alma 服务商格式不受支持".into())
        })
        .collect()
}

fn managed_provider(list: &[Provider]) -> Result<Option<Provider>> {
    let matches: Vec<_> = list
        .iter()
        .filter(|provider| provider.name == PROVIDER_NAME)
        .collect();
    if matches.len() > 1 {
        return Err("Alma 中存在多个同名 CYAPI Toolbox 服务商，请先处理重名后重试".into());
    }
    if matches
        .first()
        .is_some_and(|provider| provider.provider_type != "custom")
    {
        return Err("Alma 中的 CYAPI Toolbox 不是自定义服务商，请先处理重名后重试".into());
    }
    Ok(matches.first().map(|provider| (*provider).clone()))
}

fn settings() -> Result<Value> {
    let value = request(reqwest::Method::GET, "/api/settings", None)?;
    if !value.is_object() || value.get("chat").is_some_and(|chat| !chat.is_object()) {
        return Err("Alma 设置格式不受支持，未修改配置".into());
    }
    Ok(value)
}

fn default_model(value: &Value) -> &str {
    value
        .pointer("/chat/defaultModel")
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn selected_model(provider: Option<&Provider>, settings: &Value) -> String {
    let default = default_model(settings);
    if let Some(provider) = provider {
        let prefix = format!("{}:", provider.id);
        if let Some(model) = default.strip_prefix(&prefix) {
            return model.into();
        }
        if let Some(model) = model_ids(provider).first() {
            return model.clone();
        }
    }
    String::new()
}

fn model_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.get("id").and_then(Value::as_str).map(str::to_string))
}

fn model_ids(provider: &Provider) -> Vec<String> {
    let mut ids = Vec::new();
    for value in &provider.models {
        if let Some(id) = model_id(value).filter(|id| !id.trim().is_empty()) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    for value in &provider.available_models {
        if let Some(id) = model_id(value).filter(|id| !id.trim().is_empty()) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

fn revision(provider: Option<&Provider>, settings: &Value) -> Result<String> {
    serde_json::to_vec(&Snapshot {
        provider: provider.cloned(),
        settings: settings.clone(),
    })
    .map(|bytes| crate::service::hash(&bytes))
    .map_err(|_| "无法生成 Alma 配置版本".into())
}

fn read() -> Result<(Option<Provider>, Value)> {
    let list = providers()?;
    let provider = managed_provider(&list)?;
    Ok((provider, settings()?))
}

fn snapshot_matches(expected: &str, provider: Option<&Provider>, settings: &Value) -> Result<()> {
    if revision(provider, settings)? != expected {
        return Err("Alma 配置已变化，请重新读取后保存".into());
    }
    Ok(())
}

fn path_segment(value: &str) -> Result<&str> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Alma 服务商 ID 无效".into());
    }
    Ok(value)
}

fn validate(input: &crate::harness_config::Input) -> Result<String> {
    if input.api != "openai-completions" {
        return Err("Alma 目前支持 OpenAI Chat Completions 接口".into());
    }
    let desktop = crate::desktop_model_config::Input {
        base_url: input.base_url.clone(),
        api_key: input.api_key.clone(),
        model: input.model.clone(),
        revision: input.revision.clone(),
        api: input.api.clone(),
    };
    crate::desktop_model_config::validate(&desktop)
}

fn models_payload(provider: &Provider, selected: &str) -> Value {
    let mut ids: Vec<String> = provider.models.iter().filter_map(model_id).collect();
    if !ids.iter().any(|id| id == selected) {
        ids.push(selected.into());
    }
    let mut known = provider.available_models.clone();
    if !known
        .iter()
        .any(|value| model_id(value).as_deref() == Some(selected))
    {
        known.push(json!({"id": selected, "name": selected}));
    }
    json!({ "models": ids, "availableModels": known })
}

fn set_default(mut value: Value, selected: &str) -> Result<Value> {
    let object = value.as_object_mut().ok_or("Alma 设置格式不受支持")?;
    let chat = object
        .entry("chat")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("Alma 聊天设置格式不受支持")?;
    chat.insert("defaultModel".into(), Value::String(selected.into()));
    Ok(value)
}

pub fn view() -> Result<Value> {
    let (provider, settings) = read()?;
    let model = selected_model(provider.as_ref(), &settings);
    let models = provider.as_ref().map(model_ids).unwrap_or_default();
    Ok(json!({
        "revision": revision(provider.as_ref(), &settings)?,
        "baseUrl": provider.as_ref().map(|p| p.base_url.clone()).unwrap_or_default(),
        "model": model,
        "api": "openai-completions",
        "apiKeyConfigured": provider.as_ref().is_some_and(|p| !p.api_key.is_empty()),
        "models": models,
        "canRestore": false,
        "files": []
    }))
}

pub fn save(input: &crate::harness_config::Input) -> Result<Value> {
    let base = validate(input)?;
    let selected = input.model.trim();
    let (current, current_settings) = read()?;
    snapshot_matches(&input.revision, current.as_ref(), &current_settings)?;

    let provider = if let Some(provider) = current {
        let id = path_segment(&provider.id)?;
        let mut update = Map::new();
        update.insert("name".into(), json!(PROVIDER_NAME));
        update.insert("type".into(), json!("custom"));
        update.insert("apiFormat".into(), json!("openai-chat"));
        update.insert("baseURL".into(), json!(base));
        update.insert("enabled".into(), json!(true));
        if !input.api_key.is_empty() {
            update.insert("apiKey".into(), json!(input.api_key));
        } else if provider.api_key.is_empty() {
            return Err("请填写 API Key".into());
        }
        request(
            reqwest::Method::PUT,
            &format!("/api/providers/{id}"),
            Some(&Value::Object(update)),
        )?;
        Provider {
            base_url: base.clone(),
            api_format: "openai-chat".into(),
            enabled: true,
            ..provider
        }
    } else {
        if input.api_key.is_empty() {
            return Err("请填写 API Key".into());
        }
        let created = request(
            reqwest::Method::POST,
            "/api/providers",
            Some(&json!({
                "name": PROVIDER_NAME,
                "type": "custom",
                "apiFormat": "openai-chat",
                "apiKey": input.api_key,
                "baseURL": base,
                "enabled": true
            })),
        )?;
        let id = created
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                providers()
                    .ok()
                    .and_then(|list| managed_provider(&list).ok().flatten())
                    .map(|provider| provider.id)
            })
            .ok_or("Alma 未返回新服务商 ID")?;
        Provider {
            id,
            name: PROVIDER_NAME.into(),
            provider_type: "custom".into(),
            api_key: input.api_key.clone(),
            base_url: base.clone(),
            enabled: true,
            api_format: "openai-chat".into(),
            models: Vec::new(),
            available_models: Vec::new(),
        }
    };

    let id = path_segment(&provider.id)?;
    request(
        reqwest::Method::PUT,
        &format!("/api/providers/{id}/models"),
        Some(&models_payload(&provider, selected)),
    )
    .map_err(|error| format!("服务商可能已保存，但模型更新失败：{error}。请重新读取后重试"))?;
    let latest_settings = settings().map_err(|error| {
        format!("服务商和模型已保存，但无法读取默认模型设置：{error}。请重新读取后重试")
    })?;
    if latest_settings != current_settings {
        return Err(
            "服务商和模型已保存，但 Alma 设置在保存期间发生变化，未修改默认模型；请重新读取后重试"
                .into(),
        );
    }
    let next_settings = set_default(latest_settings, &format!("{id}:{selected}"))?;
    request(reqwest::Method::PUT, "/api/settings", Some(&next_settings)).map_err(|error| {
        format!("服务商和模型已保存，但默认模型更新失败：{error}。请重新读取后重试")
    })?;
    view().map_err(|error| format!("配置已提交，但重新读取失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(models: Vec<Value>, available_models: Vec<Value>) -> Provider {
        Provider {
            id: "provider-1".into(),
            name: PROVIDER_NAME.into(),
            provider_type: "custom".into(),
            api_key: String::new(),
            base_url: "https://example.invalid/v1".into(),
            enabled: true,
            api_format: "openai-chat".into(),
            models,
            available_models,
        }
    }

    #[test]
    fn model_ids_accept_alma_string_and_object_shapes_without_duplicates() {
        let p = provider(
            vec![json!("first"), json!({"id":"second"}), json!("first")],
            vec![json!({"id":"second"}), json!({"id":"third"})],
        );
        assert_eq!(model_ids(&p), ["first", "second", "third"]);
    }

    #[test]
    fn model_payload_preserves_existing_models_and_adds_the_selected_model() {
        let p = provider(
            vec![json!("first")],
            vec![json!({"id":"first","name":"First"})],
        );
        assert_eq!(
            models_payload(&p, "second"),
            json!({
                "models": ["first", "second"],
                "availableModels": [
                    {"id":"first","name":"First"},
                    {"id":"second","name":"second"}
                ]
            })
        );
    }

    #[test]
    fn default_model_is_written_without_dropping_other_settings() {
        let next = set_default(json!({"theme":"dark"}), "provider-1:model").unwrap();
        assert_eq!(next["theme"], "dark");
        assert_eq!(next["chat"]["defaultModel"], "provider-1:model");
        assert!(set_default(json!({"chat": null}), "p:m").is_err());
    }

    #[test]
    fn reads_alma_base_url_and_rejects_ambiguous_provider_names() {
        let p: Provider = serde_json::from_value(json!({
            "id": "provider-1", "name": PROVIDER_NAME, "type": "custom",
            "baseURL": "https://example.invalid/v1", "apiKey": "fictional-key"
        }))
        .unwrap();
        assert_eq!(p.base_url, "https://example.invalid/v1");
        let nullable: Provider = serde_json::from_value(json!({
            "id": "provider-2", "name": PROVIDER_NAME, "type": "custom",
            "baseURL": null, "apiKey": null, "models": null, "availableModels": null
        }))
        .unwrap();
        assert!(nullable.base_url.is_empty() && nullable.models.is_empty());
        assert!(managed_provider(&[p.clone(), p.clone()]).is_err());
        let mut foreign = p;
        foreign.provider_type = "openai".into();
        assert!(managed_provider(&[foreign]).is_err());
    }

    #[test]
    fn model_payload_does_not_enable_other_available_models() {
        let p = provider(
            vec![json!("enabled")],
            vec![json!({"id":"disabled", "capabilityOverrides":{"tools":false}})],
        );
        let payload = models_payload(&p, "selected");
        assert_eq!(payload["models"], json!(["enabled", "selected"]));
        assert_eq!(
            payload["availableModels"][0]["capabilityOverrides"]["tools"],
            false
        );
    }
}
