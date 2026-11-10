mod analysis;
mod codex;
mod files;
mod logdb;
mod native;
mod settings;
#[cfg(test)]
mod tests;

use crate::{configuration::no_links, diagnostics, logging};
use serde::{Deserialize, Serialize};
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
    references: Vec<String>,
    #[serde(skip)]
    files: Vec<files::Stamp>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    token: String,
    workspace: String,
    root: String,
    roots: Vec<RootView>,
    items: Vec<Entry>,
    categories: Vec<Category>,
    total_bytes: u64,
    partial: bool,
    notes: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootView {
    path: String,
    label: String,
    exists: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    id: String,
    title: String,
    bytes: u64,
    files: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: String,
    title: String,
    category: String,
    kind: String,
    path: String,
    bytes: u64,
    files: usize,
    sessions: usize,
    records: usize,
    min_updated_at: u64,
    updated_at: u64,
    deletable: bool,
    reason: String,
    estimated: bool,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeRange {
    since: Option<u64>,
    until: Option<u64>,
}

impl TimeRange {
    fn validate(&self) -> Result<()> {
        if self.since.unwrap_or(0) >= self.until.unwrap_or(i64::MAX as u64)
            || self.since.is_some_and(|t| t > i64::MAX as u64)
            || self.until.is_some_and(|t| t > i64::MAX as u64)
        {
            return Err("时间范围无效：开始时间必须早于结束时间".into());
        }
        Ok(())
    }
    fn allows(&self, entry: &Entry) -> bool {
        if entry.kind == "logDatabase" {
            return entry.records > 0
                && entry.updated_at >= self.since.unwrap_or(0)
                && entry.min_updated_at < self.until.unwrap_or(u64::MAX);
        }
        entry.min_updated_at > 0
            && entry.min_updated_at >= self.since.unwrap_or(0)
            && entry.updated_at < self.until.unwrap_or(u64::MAX)
    }
}

struct Plan {
    scan: Scan,
    root: PathBuf,
    created: u64,
    all: Vec<Item>,
    actions: HashMap<String, analysis::Action>,
    scopes: Vec<analysis::Scope>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    deleted_sessions: usize,
    deleted_files: usize,
    deleted_records: usize,
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
        "codex" => codex::list(root),
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
        .flat_map(|i| {
            std::iter::once(i.fork.as_str()).chain(i.references.iter().map(String::as_str))
        })
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

fn scan(workspace: &str) -> Result<Scan> {
    let root = root(workspace)?;
    let analysis = analysis::build(workspace, &root)?;
    let now = logging::now();
    let scan = analysis.scan;
    let mut plans = PLANS.lock().map_err(|_| "清理计划暂不可用")?;
    plans.retain(|p| now.saturating_sub(p.created) < 10 * 60_000 && p.scan.workspace != workspace);
    plans.push(Plan {
        scan: scan.clone(),
        root,
        created: now,
        all: analysis.all,
        actions: analysis.actions,
        scopes: analysis.scopes,
    });
    Ok(scan)
}

fn run(
    workspace: &str,
    token: &str,
    selected: &[String],
    range: &TimeRange,
    confirmed: bool,
) -> Result<Outcome> {
    range.validate()?;
    if !confirmed || selected.is_empty() || selected.len() > 100_000 {
        return Err("请先选择清理项目并确认永久删除".into());
    }
    let plan = {
        let mut plans = PLANS.lock().map_err(|_| "清理计划暂不可用")?;
        let index = plans
            .iter()
            .position(|p| p.scan.token == token && p.scan.workspace == workspace)
            .ok_or("扫描计划不存在，请重新扫描")?;
        plans.remove(index)
    };
    if logging::now().saturating_sub(plan.created) >= 10 * 60_000
        || root(workspace)? != plan.root
        || analysis::scopes(workspace, &plan.root)? != plan.scopes
    {
        return Err("扫描计划已过期或数据目录已改变，请重新扫描".into());
    }
    let ids: HashSet<_> = selected.iter().map(String::as_str).collect();
    if ids.len() != selected.len() || ids.iter().any(|id| !plan.actions.contains_key(*id)) {
        return Err("选择包含扫描计划以外或不可清理的项目".into());
    }
    let mut entries: Vec<_> = plan
        .scan
        .items
        .iter()
        .filter(|i| ids.contains(i.id.as_str()))
        .collect();
    if entries.len() != ids.len() || entries.iter().any(|e| !e.deletable || !range.allows(e)) {
        return Err("所选项目不在时间范围内或受到保护，未执行删除".into());
    }
    native::ensure_stopped(workspace)?;
    let has_sessions = entries.iter().any(|e| e.kind == "session");
    if has_sessions {
        let current = inventory(workspace, &plan.root)?;
        if !same_inventory(&current, &plan.all) {
            return Err("会话或关联数据在扫描后已变化，请重新扫描；未执行删除".into());
        }
    }
    // Validate every selected file before the first deletion, without requiring unrelated
    // active logs or unrelated database records to remain unchanged.
    for entry in &entries {
        match &plan.actions[&entry.id] {
            analysis::Action::File { root, stamp } => {
                if files::stamps(root, std::slice::from_ref(&stamp.path))? != [stamp.clone()] {
                    return Err("所选文件在扫描后已变化，请重新扫描；未执行删除".into());
                }
            }
            analysis::Action::Logs(db) => logdb::verify(db)?,
            analysis::Action::Session(_) => {}
        }
    }
    // Native app-servers may write fresh runtime logs. Clear the old selected logs first.
    entries.sort_by_key(|e| (e.kind == "session", e.id.clone()));
    let mut outcome = Outcome::default();
    for (index, entry) in entries.iter().enumerate() {
        if index % 100 == 0 || entry.kind != "file" {
            if let Err(e) = native::ensure_stopped(workspace) {
                outcome.errors.push(e);
                break;
            }
        }
        let result: Result<u64> = (|| match &plan.actions[&entry.id] {
            analysis::Action::File { root, stamp } => {
                if files::stamps(root, std::slice::from_ref(&stamp.path))? != [stamp.clone()] {
                    return Err("所选文件发生变化，已停止".into());
                }
                files::remove(stamp)?;
                outcome.deleted_files += 1;
                Ok(stamp.bytes)
            }
            analysis::Action::Logs(db) => {
                let deleted = logdb::delete(db, range)?;
                outcome.deleted_records += deleted.records;
                if let Some(warning) = deleted.warning {
                    outcome.notes.push(warning);
                }
                Ok(deleted.bytes)
            }
            analysis::Action::Session(item) => {
                let bytes = match workspace {
                    "claude" => files::delete_claude(&plan.root, item)?,
                    "codex" => {
                        native::codex_delete(&plan.root, &item.id, &plan.all, range)?;
                        item.bytes
                    }
                    "opencode" => {
                        native::opencode_delete(&plan.root, &item.id, &plan.all, range)?;
                        0
                    }
                    _ => unreachable!(),
                };
                outcome.deleted_sessions += item.sessions;
                Ok(bytes)
            }
        })();
        match result {
            Ok(bytes) => outcome.reclaimed_bytes += bytes,
            Err(e) => {
                outcome.errors.push(format!("项目 {}：{e}", entry.title));
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

// Native recursive deletion must match the selected, locally scanned tree, not
// merely contain its root. This also catches DB-only/new descendants and forks.
fn verify_session_tree(
    current: &[Item],
    expected: &[Item],
    id: &str,
    range: &TimeRange,
) -> Result<HashSet<String>> {
    let entries = analysis::session_entries(current, &Ok(()))?;
    let entry = entries
        .iter()
        .find(|(e, _)| e.id == format!("session:{id}"))
        .map(|(e, _)| e)
        .filter(|e| e.deletable && range.allows(e))
        .ok_or("原生会话树受到保护或不在所选时间范围内，未执行删除")?;
    fn subtree(all: &[Item], id: &str) -> HashSet<String> {
        let mut ids = HashSet::from([id.to_string()]);
        loop {
            let count = ids.len();
            for item in all {
                if ids.contains(&item.parent) {
                    ids.insert(item.id.clone());
                }
            }
            if count == ids.len() {
                return ids;
            }
        }
    }
    let actual = subtree(current, id);
    let planned = subtree(expected, id);
    if actual != planned
        || actual.len() != entry.sessions
        || !expected.iter().any(|i| i.id == id)
        || current.iter().filter(|i| actual.contains(&i.id)).any(|i| {
            !expected
                .iter()
                .any(|old| old.id == i.id && old.parent == i.parent)
        })
    {
        return Err("原生会话树与扫描计划不一致（可能有未扫描到的子会话），未执行删除".into());
    }
    Ok(actual)
}

#[tauri::command]
pub async fn cleanup_scan(workspace: String) -> Result<Scan> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATION.try_lock().map_err(|_| "已有清理任务在执行")?;
        settings::require_enabled()?;
        scan(&workspace)
    })
    .await
    .map_err(|_| "清理扫描任务中断".to_string())?
}

#[tauri::command]
pub async fn cleanup_run(
    workspace: String,
    token: String,
    selected: Vec<String>,
    range: TimeRange,
    confirmed: bool,
) -> Result<Outcome> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATION.try_lock().map_err(|_| "已有清理任务在执行")?;
        settings::require_enabled()?;
        run(&workspace, &token, &selected, &range, confirmed)
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

#[tauri::command]
pub fn experimental_settings() -> Result<settings::ExperimentalSettings> {
    settings::read(&logging::data_path())
}

#[tauri::command]
pub fn set_experimental_settings(
    enabled: bool,
    confirmed: bool,
) -> Result<settings::ExperimentalSettings> {
    let _guard = OPERATION
        .try_lock()
        .map_err(|_| "请等待当前扫描或清理结束后再切换实验性功能")?;
    let result = settings::write(&logging::data_path(), enabled, confirmed)?;
    if !enabled {
        PLANS.lock().map_err(|_| "无法清除清理计划")?.clear();
    }
    Ok(result)
}
