//! Local installation discovery for the App picker. Never starts an installed app.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

const TOOLS: &[(&str, &[&str])] = &[
    ("codex", &["codex"]),
    ("claude", &["claude"]),
    ("opencode", &["opencode"]),
    ("dsh", &["dsh"]),
    ("workbuddy", &["workbuddy"]),
    ("pi", &["pi"]),
    ("minimax", &["minimax", "minimax-code"]),
    ("alma", &["alma"]),
    ("cline", &["cline"]),
    ("kilo", &["kilo"]),
    ("qwen", &["qwen"]),
    ("kimi", &["kimi"]),
    ("continue", &["cn"]),
    ("aider", &["aider"]),
    ("cursor", &["cursor"]),
    ("gemini", &["gemini"]),
    ("grok", &["grok"]),
];
const EXTENSIONS: &[(&str, &str)] = &[
    ("cline", "saoudrizwan.claude-dev"),
    ("kilo", "kilocode.kilo-code"),
    ("continue", "continue.continue"),
    ("codex", "openai.chatgpt"),
    ("claude", "anthropic.claude-code"),
];

fn read_json(path: &Path) -> Option<Value> {
    if !fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() <= 1_000_000) {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn discover_files(bins: &[PathBuf], extension_dirs: &[PathBuf]) -> HashMap<String, &'static str> {
    let mut found = HashMap::new();
    for (id, commands) in TOOLS {
        let installed = bins.iter().filter(|p| p.is_absolute()).any(|dir| {
            commands.iter().any(|command| {
                #[cfg(windows)]
                let names = [
                    format!("{command}.exe"),
                    format!("{command}.cmd"),
                    format!("{command}.bat"),
                    format!("{command}.ps1"),
                ];
                #[cfg(not(windows))]
                let names = [command.to_string()];
                names.iter().any(|name| executable(&dir.join(name)))
            })
        });
        if installed {
            found.insert(id.to_string(), "命令行工具");
        }
    }
    for dir in extension_dirs {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        let obsolete = read_json(&dir.join(".obsolete")).unwrap_or(Value::Null);
        for entry in entries.take(2000).flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if obsolete.get(&name).and_then(Value::as_bool) == Some(true) {
                continue;
            }
            for (id, extension) in EXTENSIONS {
                if !name.starts_with(&format!("{extension}-")) {
                    continue;
                }
                let Some(package) = read_json(&entry.path().join("package.json")) else {
                    continue;
                };
                let identity = format!(
                    "{}.{}",
                    package["publisher"].as_str().unwrap_or(""),
                    package["name"].as_str().unwrap_or("")
                );
                if identity.eq_ignore_ascii_case(extension) {
                    found.insert(id.to_string(), "IDE 扩展");
                }
            }
        }
    }
    found
}

fn desktop_declarations() -> Vec<Value> {
    [
        ("codex", "Codex", "Codex.app", "localAppData", "Programs/Codex/Codex.exe"),
        ("opencode", "OpenCode", "OpenCode.app", "localAppData", "OpenCode/OpenCode.exe"),
        ("dsh", "DeepSeek Harness", "DeepSeek Harness.app", "localAppData", "Programs/DeepSeek Harness/DeepSeek Harness.exe"),
        ("workbuddy", "WorkBuddy", "WorkBuddy.app", "localAppData", "Programs/WorkBuddy/WorkBuddy.exe"),
        ("minimax", "MiniMax Code", "MiniMax Code.app", "localAppData", "Programs/MiniMax Code/MiniMax Code.exe"),
        ("alma", "Alma", "Alma.app", "localAppData", "Programs/Alma/Alma.exe"),
        ("cline", "Cline", "Cline.app", "localAppData", "Programs/Cline/Cline.exe"),
        // The Kimi Code desktop installer targets Program Files, not the
        // per-user Programs directory.
        ("kimi", "Kimi Code", "Kimi Code.app", "programFiles", "Kimi Code/Kimi Code.exe"),
        ("cursor", "Cursor", "Cursor.app", "localAppData", "Programs/cursor/Cursor.exe"),
    ].into_iter().map(|(id, name, bundle, root, executable)| json!({
        "id":id,"detection":{"windowsNames":[name],"windowsExecutables":[{"root":root,"path":executable}],"macosBundles":[bundle]}
    })).collect()
}

pub fn detect(home: &Path) -> Value {
    let mut bins: Vec<_> = std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .filter(|p| p.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    bins.extend(
        [
            ".local/bin",
            ".cargo/bin",
            ".bun/bin",
            ".npm-global/bin",
            ".local/share/pnpm",
            ".cline/bin",
            ".kimi-code/bin",
            ".grok/bin",
            "bin",
        ]
        .into_iter()
        .map(|p| home.join(p)),
    );
    #[cfg(windows)]
    {
        if let Some(app_data) = std::env::var_os("APPDATA") {
            bins.push(PathBuf::from(app_data).join("npm"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            bins.extend([local.join("pnpm"), local.join("Microsoft/WinGet/Links")]);
            if let Ok(entries) = fs::read_dir(local.join("Programs/Python")) {
                bins.extend(
                    entries
                        .take(32)
                        .flatten()
                        .map(|entry| entry.path().join("Scripts")),
                );
            }
        }
    }
    #[cfg(not(windows))]
    bins.extend([
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ]);
    let mut extensions: Vec<_> = [
        ".vscode",
        ".vscode-insiders",
        ".vscode-oss",
        ".cursor",
        ".windsurf",
    ]
    .into_iter()
    .map(|p| home.join(p).join("extensions"))
    .collect();
    if let Some(dir) = std::env::var_os("VSCODE_EXTENSIONS")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
    {
        extensions.push(dir);
    }
    let mut found = discover_files(&bins, &extensions);
    let mut warning = None;
    match crate::software::detect_local(&desktop_declarations()) {
        Ok(apps) => {
            for (id, app) in apps {
                if app["found"].as_bool() == Some(true) {
                    found.insert(id, "桌面 App");
                }
            }
        }
        Err(_) => warning = Some("部分桌面 App 未能完成检测，可手动开启显示。"),
    }
    json!({"apps": TOOLS.iter().map(|(id, _)| json!({"id":id,"installed":found.contains_key(*id),"source":found.get(*id)})).collect::<Vec<_>>(), "warning":warning})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_launchers_and_verified_extensions_not_configuration_residue() {
        let home = std::env::temp_dir().join(format!("cyapi-app-detect-{}", uuid::Uuid::new_v4()));
        let bin = home.join("bin");
        let extensions = home.join("extensions");
        fs::create_dir_all(&bin).unwrap();
        let launcher = bin.join(if cfg!(windows) {
            "gemini.cmd"
        } else {
            "gemini"
        });
        fs::write(&launcher, "fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::create_dir_all(home.join(".grok")).unwrap();
        fs::write(home.join(".grok/config.toml"), "").unwrap();
        for (folder, publisher, name) in [
            ("continue.continue-1.0", "Continue", "continue"),
            ("saoudrizwan.claude-dev-1.0", "wrong", "claude-dev"),
            ("kilocode.kilo-code-1.0", "kilocode", "kilo-code"),
        ] {
            let dir = extensions.join(folder);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("package.json"),
                json!({"publisher":publisher,"name":name}).to_string(),
            )
            .unwrap();
        }
        fs::write(
            extensions.join(".obsolete"),
            r#"{"kilocode.kilo-code-1.0":true}"#,
        )
        .unwrap();
        let found = discover_files(&[bin], &[extensions]);
        assert!(found.contains_key("gemini"));
        assert!(found.contains_key("continue"));
        assert!(!found.contains_key("grok"));
        assert!(!found.contains_key("cline"));
        assert!(!found.contains_key("kilo"));
        fs::remove_dir_all(home).unwrap();
    }
}
