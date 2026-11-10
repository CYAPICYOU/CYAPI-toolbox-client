mod files;
mod native;
#[cfg(test)]
mod tests;

use crate::{configuration::no_links, diagnostics, logging};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

type Result<T> = std::result::Result<T, String>;
const DAY: u64 = 86_400_000;
const LIMIT: usize = 20_000;
static PLANS: Mutex<Vec<Plan>> = Mutex::new(Vec::new());
static OPERATION: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    id: String,
    title: String,
    updated_at: u64,
    bytes: u64,
    sessions: usize,
    #[serde(skip)]
    parent: String,
    #[serde(skip)]
    fork: String,
    #[serde(skip)]
    files: Vec<files::Stamp>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    token: String,
    workspace: String,
    root: String,
    items: Vec<Item>,
    protected_sessions: usize,
    notes: Vec<String>,
}

struct Plan {
    scan: Scan,
    root: PathBuf,
    days: u64,
    created: u64,
    all: Vec<Item>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    deleted_sessions: usize,
    reclaimed_bytes: u64,
    errors: Vec<String>,
    notes: Vec<String>,
}

fn checked(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("清理目录必须是无跳转的绝对路径".into());
    }
    no_links(path)
}

fn root(workspace: &str) -> Result<PathBuf> {
    let isolated = std::env::var_os("CYAPI_TOOLBOX_HOME_DIR").is_some();
    let env = |key| {
        std::env::var_os(key)
            .filter(|_| !isolated)
            .map(PathBuf::from)
    };
    let path = match workspace {
        "codex" => diagnostics::codex_home(),
        "claude" => {
            env("CLAUDE_CONFIG_DIR").unwrap_or_else(|| diagnostics::home_path().join(".claude"))
        }
        "opencode" => env("XDG_DATA_HOME")
            .unwrap_or_else(|| diagnostics::home_path().join(".local/share"))
            .join("opencode"),
        _ => return Err("不支持的清理工具".into()),
    };
    checked(&path)?;
    // Never let a misconfigured environment turn a home/root directory into a cleanup target.
    if path.parent().is_none() || path == diagnostics::home_path() {
        return Err("清理目录不能是用户主目录或磁盘根目录".into());
    }
    Ok(path)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

fn inventory(workspace: &str, root: &Path) -> Result<Vec<Item>> {
    match workspace {
        "claude" => files::claude(root),
        "codex" => native::codex_list(root),
        "opencode" => native::opencode_list(root),
        _ => Err("不支持的清理工具".into()),
    }
}

// Only expose whole trees. A recent/unknown descendant protects every ancestor.
// Incoming fork references protect the referenced tree even when the fork is old.
fn candidates(all: &[Item], cutoff: u64) -> Result<Vec<Item>> {
    if all.len() > LIMIT {
        return Err("会话超过 20,000 条，无法完整确认关联关系；未生成删除计划".into());
    }
    let mut ids = HashSet::new();
    if all
        .iter()
        .any(|i| !valid_id(&i.id) || !ids.insert(i.id.as_str()))
    {
        return Err("发现重复或无效的会话标识，已停止清理".into());
    }
    let map: HashMap<_, _> = all.iter().map(|i| (i.id.as_str(), i)).collect();
    let mut groups: HashMap<&str, Vec<&Item>> = HashMap::new();
    for item in all {
        let mut node = item;
        let mut seen = HashSet::new();
        while !node.parent.is_empty() {
            if !seen.insert(node.id.as_str()) {
                return Err("会话父子关系存在循环，已停止清理".into());
            }
            let Some(parent) = map.get(node.parent.as_str()) else {
                break;
            };
            node = parent;
        }
        groups.entry(&node.id).or_default().push(item);
    }
    let referenced: HashSet<_> = all
        .iter()
        .map(|i| i.fork.as_str())
        .filter(|s| !s.is_empty())
        .collect();
    let mut result = Vec::new();
    for (id, members) in groups {
        let root = map[id];
        if !root.parent.is_empty()
            || members.iter().any(|i| {
                i.updated_at == 0 || i.updated_at >= cutoff || referenced.contains(i.id.as_str())
            })
        {
            continue;
        }
        let mut item = root.clone();
        item.bytes = members.iter().map(|i| i.bytes).sum();
        item.sessions = members.len();
        item.updated_at = members.iter().map(|i| i.updated_at).max().unwrap_or(0);
        result.push(item);
    }
    result.sort_by(|a, b| a.updated_at.cmp(&b.updated_at).then(a.id.cmp(&b.id)));
    Ok(result)
}

fn scan(workspace: &str, days: u64) -> Result<Scan> {
    if ![7, 30, 90, 180].contains(&days) {
        return Err("保留期仅支持 7、30、90 或 180 天".into());
    }
    let root = root(workspace)?;
    let all = inventory(workspace, &root)?;
    let now = logging::now();
    let items = candidates(&all, now.saturating_sub(days * DAY))?;
    let count: usize = items.iter().map(|i| i.sessions).sum();
    let scan = Scan {
        token: uuid::Uuid::new_v4().to_string(),
        workspace: workspace.into(),
        root: root.to_string_lossy().into_owned(),
        items,
        protected_sessions: all.len().saturating_sub(count),
        notes: vec![
            "仅列出整个会话树均早于保留期的会话；有关联 fork 的源会话会保留。".into(),
            "永久删除，不进入回收站。清理前请自行导出需要保留的会话，并关闭对应工具及其后台服务。"
                .into(),
            if workspace == "claude" {
                "包含会话正文、同名附件目录、文件历史与图片缓存；不清理 memory、配置、凭据、插件。"
                    .into()
            } else {
                "需要支持原生会话删除的 CLI：Codex thread/delete；OpenCode 独立模式（V2 --standalone，兼容旧版 --pure）。不直接删除数据库、WAL 或 SHM；大小为会话数据估算，不等于磁盘释放量。".into()
            },
        ],
    };
    let mut plans = PLANS.lock().map_err(|_| "清理计划暂不可用")?;
    plans.retain(|p| now.saturating_sub(p.created) < 10 * 60_000 && p.scan.workspace != workspace);
    plans.push(Plan {
        scan: scan.clone(),
        root,
        days,
        created: now,
        all,
    });
    Ok(scan)
}

fn run(workspace: &str, token: &str, selected: &[String], confirmed: bool) -> Result<Outcome> {
    if !confirmed || selected.is_empty() || selected.len() > LIMIT {
        return Err("请先选择会话并确认永久删除".into());
    }
    let plan = {
        let mut plans = PLANS.lock().map_err(|_| "清理计划暂不可用")?;
        let index = plans
            .iter()
            .position(|p| p.scan.token == token && p.scan.workspace == workspace)
            .ok_or("扫描计划不存在，请重新扫描")?;
        plans.remove(index)
    };
    if logging::now().saturating_sub(plan.created) >= 10 * 60_000 || root(workspace)? != plan.root {
        return Err("扫描计划已过期或数据目录已改变，请重新扫描".into());
    }
    let ids: HashSet<_> = selected.iter().map(String::as_str).collect();
    if ids.len() != selected.len()
        || ids
            .iter()
            .any(|id| !plan.scan.items.iter().any(|i| i.id == *id))
    {
        return Err("选择包含扫描计划以外的会话".into());
    }
    native::ensure_stopped(workspace)?;
    let current = inventory(workspace, &plan.root)?;
    let eligible = candidates(&current, plan.created.saturating_sub(plan.days * DAY))?;
    // Whole inventory comparison also catches a newly spawned child or fork.
    if !same_inventory(&current, &plan.all)
        || ids.iter().any(|id| !eligible.iter().any(|i| i.id == *id))
    {
        return Err("会话或关联数据在扫描后已变化，请重新扫描；未执行删除".into());
    }
    let mut outcome = Outcome::default();
    for item in plan
        .scan
        .items
        .iter()
        .filter(|i| ids.contains(i.id.as_str()))
    {
        if let Err(e) = native::ensure_stopped(workspace) {
            outcome.errors.push(e);
            break;
        }
        let result = match workspace {
            "claude" => files::delete_claude(&plan.root, item),
            "codex" => native::codex_delete(&plan.root, &item.id).map(|_| item.bytes),
            "opencode" => native::opencode_delete(&plan.root, &item.id).map(|_| 0),
            _ => unreachable!(),
        };
        match result {
            Ok(bytes) => {
                outcome.deleted_sessions += item.sessions;
                outcome.reclaimed_bytes += bytes;
            }
            Err(e) => {
                outcome.errors.push(format!("会话 {}：{e}", item.id));
                break;
            }
        }
    }
    if workspace == "opencode" && outcome.deleted_sessions > 0 {
        match native::compact(&plan.root) {
            Ok(bytes) => outcome.reclaimed_bytes += bytes,
            Err(e) => outcome
                .notes
                .push(format!("会话已删除，但数据库空间回收未完成：{e}")),
        }
    }
    crate::agent_logs::invalidate(workspace);
    crate::usage::invalidate();
    outcome.notes.push(
        "释放量按文件逻辑大小计算；压缩、稀疏文件或文件系统快照可能影响实际磁盘可用空间。".into(),
    );
    Ok(outcome)
}

fn same_inventory(a: &[Item], b: &[Item]) -> bool {
    let map: HashMap<_, _> = b.iter().map(|i| (&i.id, i)).collect();
    a.len() == b.len()
        && a.iter()
            .all(|i| map.get(&i.id).is_some_and(|old| *old == i))
}

#[tauri::command]
pub async fn cleanup_scan(workspace: String, days: u64) -> Result<Scan> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATION.try_lock().map_err(|_| "已有清理任务在执行")?;
        scan(&workspace, days)
    })
    .await
    .map_err(|_| "清理扫描任务中断".to_string())?
}

#[tauri::command]
pub async fn cleanup_run(
    workspace: String,
    token: String,
    selected: Vec<String>,
    confirmed: bool,
) -> Result<Outcome> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATION.try_lock().map_err(|_| "已有清理任务在执行")?;
        run(&workspace, &token, &selected, confirmed)
    })
    .await
    .map_err(|_| "清理任务中断；请重新扫描检查结果".to_string())?
}

#[tauri::command]
pub async fn cleanup_toolbox_cache() -> Result<Outcome> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = OPERATION.try_lock().map_err(|_| "已有清理任务在执行")?;
        files::toolbox_cache(&logging::data_path())
    })
    .await
    .map_err(|_| "缓存清理任务中断".to_string())?
}
