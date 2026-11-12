mod agent_logs;
mod alma_config;
mod blender_runtime;
mod blender_service;
mod cancel;
mod catalog_cache;
mod claude_config;
mod cleanup;
mod codex_config;
mod codex_i18n;
mod codex_logs;
mod codex_models;
mod configuration;
mod cyapi_balance;
mod cyapi_routes;
mod diagnostics;
mod desktop_model_config;
mod pi_model_config;
mod minimax_model_config;
mod harness_yaml;
mod harness_config;
mod tool_apps;
mod pi_mcp_config;
mod external_tools;
mod installed;
mod integrations;
mod logging;
mod request_network;
mod mcp;
mod mcp_bridge;
mod model_list;
mod model_selection;
mod models;
mod network;
mod opencode_config;
mod platform;
mod python_dependencies;
mod python_runtime;
mod runtime;
mod service;
mod software;
mod update;
mod usage;

pub mod tunnel;

use models::Request;
use service::Service;
use std::sync::{Arc, Mutex, OnceLock};

struct AppService(Arc<Mutex<Result<Service, String>>>);

static EDITOR_ROUTE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn editor_route_state() -> &'static Mutex<Option<String>> {
    EDITOR_ROUTE.get_or_init(|| Mutex::new(None))
}

/// Only the packaged (or dev-server) main WebView can call native commands.
fn trusted_caller(view: &tauri::Webview) -> bool {
    view.label() == "main" && view.url().is_ok_and(|url| local_app_url(&url))
}

fn local_app_url(url: &tauri::Url) -> bool {
    let packaged = (url.scheme() == "http"
        && url.host_str() == Some("tauri.localhost")
        && url.port().is_none())
        || (url.scheme() == "tauri" && url.host_str() == Some("localhost"));
    let development = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);
    packaged || development
}

/// Network payload fetched before the service lock is taken, keyed by action.
enum Prefetched {
    Catalog(&'static str, Result<service::Fetched, String>),
    Update(Result<Vec<u8>, String>),
}

#[tauri::command]
async fn cyapi_routes(
    action: String,
    route_id: Option<String>,
    state: tauri::State<'_, AppService>,
) -> Result<serde_json::Value, String> {
    // Release the toolbox lock before network I/O, so probing never blocks local configuration.
    let data = state
        .0
        .lock()
        .map_err(|_| "线路服务暂不可用")?
        .as_ref()
        .map_err(|e| e.clone())?
        .data
        .clone();
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "cache" => serde_json::to_value(cyapi_routes::read_cache(&data))
            .map_err(|_| "无法读取线路缓存".into()),
        "read" => {
            serde_json::to_value(cyapi_routes::read(&data)).map_err(|_| "无法读取线路清单".into())
        }
        "probe" => serde_json::to_value(cyapi_routes::probe(
            &data,
            route_id.as_deref().ok_or("缺少线路标识")?,
        )?)
        .map_err(|_| "无法读取测速结果".into()),
        _ => Err("未知线路操作".into()),
    })
    .await
    .map_err(|_| "线路操作未完成".to_string())?
}

/// Route an authenticated hosted-platform request in native code.  The key
/// never enters a URL and the remote editor WebView is not given this command.
#[tauri::command]
async fn cyapi_request(
    request: network::HttpRequest,
    state: tauri::State<'_, AppService>,
) -> Result<network::HttpResponse, String> {
    if let Some(key) = request.key.as_deref() {
        logging::register_secret(key);
    }
    let server_url = state
        .0
        .lock()
        .map_err(|_| "安装服务暂不可用".to_string())?
        .as_ref()
        .map_err(|error| error.clone())?
        .server_url()
        .to_string();
    tauri::async_runtime::spawn_blocking(move || network::request(&server_url, request))
        .await
        .map_err(|error| error.to_string())?
}

/// Download a private workflow artifact (image/video) for the results page.
#[tauri::command]
async fn cyapi_download(
    request: network::DownloadRequest,
    state: tauri::State<'_, AppService>,
) -> Result<network::DownloadResponse, String> {
    if let Some(key) = request.key.as_deref() {
        logging::register_secret(key);
    }
    let server_url = state
        .0
        .lock()
        .map_err(|_| "安装服务暂不可用".to_string())?
        .as_ref()
        .map_err(|error| error.clone())?
        .server_url()
        .to_string();
    tauri::async_runtime::spawn_blocking(move || network::download(&server_url, request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_workflow_artifact(window: tauri::WebviewWindow, filename: String, base64: String) -> Result<bool, String> {
    use base64::Engine;
    #[cfg(target_os = "windows")]
    let owner = window.hwnd().map_err(|_| "无法获取主窗口")?.0 as isize;
    #[cfg(not(target_os = "windows"))]
    let owner = { let _ = window; 0isize };
    if base64.len() > 45 * 1024 * 1024 { return Err("产物超过保存大小限制".into()); }
    let filename = std::path::Path::new(&filename).file_name().and_then(|s| s.to_str())
        .filter(|s| !s.is_empty()).unwrap_or("workflow-result").to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD.decode(base64).map_err(|_| "产物数据无效")?;
        let Some(path) = artifact_save_dialog(&filename, owner)? else { return Ok(false); };
        std::fs::write(path, bytes).map_err(|e| format!("保存失败：{e}"))?;
        Ok(true)
    }).await.map_err(|e| format!("保存操作失败：{e}"))?
}

#[cfg(target_os = "windows")]
fn artifact_save_dialog(filename: &str, owner: isize) -> Result<Option<std::path::PathBuf>, String> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::UI::Controls::Dialogs::{CommDlgExtendedError, GetSaveFileNameW, OPENFILENAMEW, OFN_EXPLORER, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST};
    let mut buffer = vec![0u16; 32768];
    let name: Vec<u16> = std::ffi::OsStr::new(filename).encode_wide().take(buffer.len() - 1).collect();
    buffer[..name.len()].copy_from_slice(&name);
    let mut dialog = OPENFILENAMEW::default();
    dialog.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    dialog.hwndOwner = owner as _;
    dialog.lpstrFile = buffer.as_mut_ptr();
    dialog.nMaxFile = buffer.len() as u32;
    dialog.Flags = OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST;
    if unsafe { GetSaveFileNameW(&mut dialog) } == 0 {
        let code = unsafe { CommDlgExtendedError() };
        return if code == 0 { Ok(None) } else { Err(format!("无法打开保存对话框（{code}）")) };
    }
    let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    Ok(Some(std::path::PathBuf::from(std::ffi::OsString::from_wide(&buffer[..end]))))
}

#[cfg(not(target_os = "windows"))]
fn artifact_save_dialog(_filename: &str, _owner: isize) -> Result<Option<std::path::PathBuf>, String> {
    Err("当前系统暂不支持保存产物".into())
}

/// Open the hosted ComfyUI editor in its own WebView. The URL carries a
/// one-shot token; the remote child window never receives native capabilities
/// because `capabilities/default.json` only grants `main`.
#[tauri::command]
async fn open_workflow_editor(
    app: tauri::AppHandle,
    url: String,
    route: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let parsed = tauri::Url::parse(&url).map_err(|_| "编辑器地址无效".to_string())?;
    let route = route.unwrap_or_else(|| "cloudflare".into());
    let route_ip = match route.as_str() {
        "beijing" => Some("101.201.221.190"),
        "hongkong" => Some("149.104.31.54"),
        "cloudflare" => None,
        _ => return Err("编辑器线路无效".into()),
    };
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("编辑器地址必须使用 http 或 https".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("编辑器地址不能包含凭据".into());
    }
    let host = parsed.host_str().unwrap_or_default();
    let loopback = matches!(host, "127.0.0.1" | "localhost" | "::1");
    if host != "api.cyapi.cyou" && !loopback {
        return Err("编辑器地址不在允许的范围内".into());
    }
    if route_ip.is_some() && loopback {
        return Err("本地编辑器不能使用公网线路覆盖".into());
    }
    #[cfg(not(target_os = "windows"))]
    if route_ip.is_some() {
        return Err("当前平台不支持为编辑器设置安全的域名线路覆盖".into());
    }

    const LABEL: &str = "workflow-editor";
    if let Some(window) = app.get_webview_window(LABEL) {
        let same_route = editor_route_state()
            .lock()
            .ok()
            .and_then(|value| value.clone())
            .is_some_and(|value| value == route);
        if same_route {
            window
                .navigate(parsed)
                .map_err(|error| format!("无法打开编辑器：{error}"))?;
            let _ = window.show();
            let _ = window.set_focus();
            return Ok(());
        }
        // WebView2's resolver rules are fixed when the environment is built;
        // recreate the child if a failed API route selects another origin.
        let _ = window.close();
        if let Ok(mut value) = editor_route_state().lock() {
            *value = None;
        }
    }

    let mut builder =
        tauri::WebviewWindowBuilder::new(&app, LABEL, tauri::WebviewUrl::External(parsed));
    #[cfg(target_os = "windows")]
    if route_ip.is_some() {
        // WebView2 refuses to start when two environments share a user data
        // folder but use different environment options (ERROR_INVALID_STATE,
        // 0x8007139F). The main window keeps the default folder, so the editor
        // gets its own folder, one per route: switching routes rebuilds the
        // window and must not collide with the previous resolver rule.
        let base = app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("无法定位编辑器数据目录：{error}"))?;
        let data_directory = base.join("editor-webview").join(&route);
        std::fs::create_dir_all(&data_directory)
            .map_err(|error| format!("无法创建编辑器数据目录：{error}"))?;
        // Beijing is carried by the local tunnel proxy: the CONNECT request
        // keeps `api.cyapi.cyou` as the hostname and the proxy nests it inside
        // a TLS layer the mainland filter accepts, so no resolver override is
        // needed. Hong Kong keeps the URL/SNI and only changes the DNS answer.
        let tunnel = if route == "beijing" {
            crate::tunnel::proxy_url()
        } else {
            None
        };
        let args = match tunnel {
            Some(proxy) => format!("--proxy-server={proxy}"),
            None => match route_ip {
                Some(ip) => format!("--host-resolver-rules=\"MAP api.cyapi.cyou {ip}\""),
                None => String::new(),
            },
        };
        if !args.is_empty() {
            builder = builder.additional_browser_args(&args);
        }
        builder = builder.data_directory(data_directory);
    }
    builder
        .title("CYAPI 工作流")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1024.0, 700.0)
        .build()
        .map_err(|error| format!("无法打开编辑器：{error}"))?;
    if let Ok(mut value) = editor_route_state().lock() {
        *value = Some(route);
    }
    Ok(())
}

/// Push the Key the workbench already holds to the loopback MCP server. The
/// Key is kept in memory; a cleared value means the page was locked or the
/// Key was removed, and the next tool call asks the user to open the workbench.
#[tauri::command]
fn cyapi_mcp_key(key: Option<String>) -> serde_json::Value {
    crate::mcp_bridge::set_key(key);
    crate::mcp_bridge::status()
}

#[tauri::command]
fn cyapi_mcp_status() -> serde_json::Value {
    crate::mcp_bridge::status()
}

/// Stop a running installation. The command does not take the service lock, so
/// it reaches the download that is in flight instead of waiting for it.
#[tauri::command]
fn toolbox_cancel() {
    crate::cancel::cancel();
}

#[tauri::command]
async fn toolbox(
    request: Request,
    state: tauri::State<'_, AppService>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let operation = request
        .operation_id
        .clone()
        .filter(|id| {
            id.len() <= 80
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let action = request.action.clone();
    let visible = !matches!(
        action.as_str(),
        "status"
            | "catalog-read"
            | "preview"
            | "codex-read"
            | "claude-read"
            | "opencode-read"
            | "desktop-model-read"
            | "harness-model-read"
            | "tool-apps-detect"
            | "pi-mcp-read"
            | "configuration-read"
            | "models-list"
            | "update-check"
            | "integration-services-read"
    );
    let started = std::time::Instant::now();
    if visible {
        logging::with_operation(operation.clone(), || {
            logging::event("info", "toolbox", format!("开始操作：{action}"));
        });
    }
    // Network-bound reads are fetched before taking the service lock, so local
    // configuration pages stay usable while the server is slow or offline.
    let prefetch_kind = match action.as_str() {
        "catalog-read" | "refresh" => Some("/api/catalog"),
        "update-check" => Some("update"),
        "mcp-catalog-read" | "mcp-refresh" => Some("/api/mcp"),
        "integrations-read" | "integrations-refresh" => Some("/api/integrations"),
        _ => None,
    };
    let prefetched = if let Some(kind) = prefetch_kind {
        let (server_url, data, needed) = {
            let guard = state.0.lock().map_err(|_| "安装服务暂不可用")?;
            let service = guard.as_ref().map_err(|error| error.clone())?;
            let needed = kind == "update"
                || service::claim_catalog_refresh(
                    &service.data,
                    kind,
                    matches!(
                        action.as_str(),
                        "refresh" | "mcp-refresh" | "integrations-refresh"
                    ),
                );
            (
                service.server_url().to_string(),
                service.data.clone(),
                needed,
            )
        };
        if needed {
            let operation = operation.clone();
            if kind == "update" {
                let fetched = tauri::async_runtime::spawn_blocking(move || {
                    logging::with_operation(operation, || {
                        crate::update::fetch_manifest(&server_url)
                    })
                })
                .await
                .map_err(|error| error.to_string())
                .and_then(|result| result);
                Some(Prefetched::Update(fetched))
            } else {
                let data = data.clone();
                let fetched = tauri::async_runtime::spawn_blocking(move || {
                    logging::with_operation(operation, || {
                        service::fetch_catalog_conditional(&server_url, &data, kind)
                    })
                })
                .await
                .map_err(|error| error.to_string())
                .and_then(|result| result);
                Some(Prefetched::Catalog(kind, fetched))
            }
        } else {
            None
        }
    } else {
        None
    };
    let service = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        logging::with_operation(operation, || {
            if let Some(input) = &request.codex {
                logging::register_secret(&input.api_key);
            }
            if let Some(input) = &request.claude {
                logging::register_secret(&input.auth_token);
            }
            if let Some(input) = &request.opencode {
                logging::register_secret(&input.api_key);
            }
            if let Some(input) = &request.desktop_model {
                logging::register_secret(&input.api_key);
            }
            if let Some(input) = &request.harness_model {
                logging::register_secret(&input.api_key);
            }
            if let Some(key) = &request.api_key {
                logging::register_secret(key);
            }
            if request.action == "configuration-save" || request.action == "integration-action" {
                if let Some(values) = &request.values {
                    for value in values.values().filter_map(|v| v.as_str()) {
                        logging::register_secret(value);
                    }
                }
            }
            let result = if action == "open-url" {
                crate::update::open(request.url.as_deref().unwrap_or_default())
            } else if action == "tool-apps-detect" {
                // Registry probing can be slow; release the service lock before scanning.
                let home = service
                    .lock()
                    .map_err(|_| "安装服务暂不可用".to_string())
                    .and_then(|state| state.as_ref().map(|service| service.home.clone()).map_err(|error| error.clone()));
                home.map(|home| crate::tool_apps::detect(&home))
            } else if action == "integration-services-read" {
                let workspace = request.workspace.as_deref().unwrap_or("codex");
                // Snapshot only local endpoint settings under the lock. DNS and
                // addon I/O must not block settings, MCP or other local pages.
                let probes = service
                    .lock()
                    .map_err(|_| "安装服务暂不可用".to_string())
                    .and_then(|state| {
                        state
                            .as_ref()
                            .map_err(|error| error.clone())?
                            .integration_service_probes(workspace)
                    });
                probes.map(|probes| {
                    tauri::async_runtime::block_on(blender_service::read(workspace, probes))
                })
            } else if action.starts_with("codex-i18n-") {
                // The proxy and the system proxy are local state; never hold
                // the installation lock while certutil or Codex starts.
                let data = service
                    .lock()
                    .map_err(|_| "安装服务暂不可用".to_string())
                    .and_then(|state| {
                        state
                            .as_ref()
                            .map(|service| service.data.clone())
                            .map_err(|error| error.clone())
                    });
                data.and_then(|data| crate::codex_i18n::run(&data, &action))
            } else if matches!(action.as_str(), "update-download" | "update-install") {
                // Copy only immutable update settings, then release the global
                // lock before any network request or large file operation.
                let context = service
                    .lock()
                    .map_err(|_| "安装服务暂不可用".to_string())
                    .and_then(|state| {
                        state
                            .as_ref()
                            .map(update::UpdateContext::snapshot)
                            .map_err(|error| error.clone())
                    });
                context.and_then(|context| {
                    if action == "update-download" {
                        use tauri::Emitter;
                        update::download(&context, |stage, downloaded, total| {
                            let _ = app.emit(
                                "toolbox-update-progress",
                                update::UpdateProgress {
                                    operation_id: request.operation_id.clone().unwrap_or_default(),
                                    stage,
                                    downloaded,
                                    total,
                                },
                            );
                        })
                    } else {
                        update::install(&context, |path| {
                            // Wait for existing Service writes to finish. Keep
                            // the mutex through launch, then replace the state
                            // with a shutdown barrier before releasing it, so
                            // no new write can start during the exit delay.
                            let mut state =
                                service.lock().map_err(|_| "安装服务暂不可用".to_string())?;
                            state.as_ref().map_err(|error| error.clone())?;
                            update::launch_and_exit(path)?;
                            *state =
                                Err("更新安装程序已启动，应用正在关闭，请稍后重新打开。".into());
                            Ok(())
                        })
                    }
                })
            } else {
                service
                    .lock()
                    .map_err(|_| "安装服务暂不可用".to_string())
                    .and_then(|mut state| {
                        let service = state.as_mut().map_err(|error| error.clone())?;
                        match prefetched {
                            Some(Prefetched::Catalog(path, fetched)) => {
                                let automatic = matches!(
                                    request.action.as_str(),
                                    "catalog-read" | "mcp-catalog-read" | "integrations-read"
                                );
                                service.apply_catalog_read(path, fetched, automatic)?;
                                if path == "/api/catalog" {
                                    Ok(service.status())
                                } else {
                                    service.dispatch(request)
                                }
                            }
                            Some(Prefetched::Update(bytes)) => service.apply_update_check(bytes),
                            None => service.dispatch(request),
                        }
                    })
            };
            if let Ok(value) = &result {
                for field in ["apiKey", "authToken"] {
                    if let Some(key) = value.get(field).and_then(|v| v.as_str()) {
                        logging::register_secret(key);
                    }
                }
            }
            match &result {
                Ok(_) if visible => logging::event(
                    "info",
                    "toolbox",
                    format!("操作完成：{action}（{} ms）", started.elapsed().as_millis()),
                ),
                // A failed background update check is expected while offline.
                Err(error) if action != "update-check" => logging::event(
                    "error",
                    "toolbox",
                    format!(
                        "操作失败：{action}；{error}（{} ms）",
                        started.elapsed().as_millis()
                    ),
                ),
                _ => {}
            }
            result
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::initialize();
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        logging::event("error", "bootstrap", format!("原生异常：{info}"));
        previous_hook(info);
    }));
    logging::event(
        "info",
        "bootstrap",
        format!("CYAPI Toolbox {} 启动", env!("CARGO_PKG_VERSION")),
    );
    let service = Service::from_environment();
    if let Err(error) = &service {
        logging::event(
            "error",
            "bootstrap",
            format!("安装服务初始化失败；仍可使用排查与日志功能：{error}"),
        );
    }
    // A previous run may have exited before restoring the system proxy.
    if let Ok(service) = &service {
        codex_i18n::recover(&service.data);
    }
    // The Beijing node is only reachable through the local nested-TLS tunnel.
    // Start it before probing so the first warm-up can already use it.
    match tunnel::start() {
        Ok(port) => {
            logging::event(
                "info",
                "network",
                format!("线路一隧道已就绪，本地代理端口 {port}"),
            );
        }
        Err(error) => {
            logging::event("warn", "network", format!("线路一隧道启动失败：{error}"));
        }
    }
    // Choose one official node now so the first user action does not pay for
    // the probe. A failed probe just leaves the choice open for the next request.
    std::thread::spawn(service::route_priority::warm);
    // The loopback MCP server lets the agent the user already runs drive the
    // workbench. It keeps the Key in memory and reuses the same node selection
    // and tunnel, so no second credential store is introduced.
    if let Ok(service) = &service {
        let app_data = service.app_data_directory();
        let server_url = service.server_url().to_string();
        match mcp_bridge::start(&app_data, &server_url) {
            Ok(port) => logging::event(
                "info",
                "mcp",
                format!("MCP 接入地址 http://127.0.0.1:{port}/mcp"),
            ),
            Err(error) => logging::event("warn", "mcp", format!("MCP 本机服务未启动：{error}")),
        }
    }
    let builder = tauri::Builder::default().manage(AppService(Arc::new(Mutex::new(service))));
    let handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
        Box::new(tauri::generate_handler![
            toolbox,
            toolbox_cancel,
            cyapi_routes,
            cyapi_request,
            cyapi_download,
            cyapi_mcp_key,
            cyapi_mcp_status,
            save_workflow_artifact,
            open_workflow_editor,
            cyapi_balance::cyapi_balance,
            usage::usage_stats,
            logging::logs_snapshot,
            logging::log_frontend_error,
            logging::log_workflow_launch,
            diagnostics::diagnostics,
            codex_logs::codex_logs,
            agent_logs::agent_logs,
            cleanup::cleanup_scan,
            cleanup::cleanup_run,
            cleanup::experimental_settings,
            cleanup::set_experimental_settings,
            cleanup::cleanup_toolbox_cache
        ]);
    builder
        .invoke_handler(move |invoke| {
            // App commands have no remote caller. Only the packaged main WebView
            // may invoke them; the hosted ComfyUI editor lives in its own
            // external window and never reaches the IPC bridge.
            if !trusted_caller(invoke.message.webview_ref()) {
                invoke.resolver.reject("远程页面没有本机操作权限");
                return true;
            }
            handler(invoke)
        })
        .build(tauri::generate_context!())
        .expect("Failed to launch CYAPI Toolbox")
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                codex_i18n::shutdown();
            }
        });
}
