use super::*;
use serde_json::json;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("cyapi-cleanup-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn put(&self, path: &str, value: &[u8]) -> PathBuf {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, value).unwrap();
        path
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn item(id: &str, parent: &str, time: u64) -> Item {
    Item {
        id: id.into(),
        title: id.into(),
        updated_at: time,
        bytes: 10,
        sessions: 1,
        parent: parent.into(),
        fork: String::new(),
        files: Vec::new(),
    }
}

#[test]
fn old_session_tree_is_one_selectable_unit() {
    let items = vec![
        item("root", "", 10),
        item("child", "root", 20),
        item("grandchild", "child", 30),
    ];
    let result = candidates(&items, 100).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(
        (
            result[0].id.as_str(),
            result[0].sessions,
            result[0].bytes,
            result[0].updated_at
        ),
        ("root", 3, 30, 30)
    );
}

#[test]
fn recent_and_unknown_descendants_protect_the_whole_tree() {
    for time in [0, 100, 200] {
        let items = vec![
            item("root", "", 10),
            item("child", "root", time),
            item("safe", "", 20),
        ];
        assert_eq!(
            candidates(&items, 100)
                .unwrap()
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            ["safe"]
        );
    }
}

#[test]
fn incoming_fork_reference_protects_source_tree() {
    let mut fork = item("fork", "", 10);
    fork.fork = "child".into();
    let items = vec![item("root", "", 10), item("child", "root", 10), fork];
    assert_eq!(candidates(&items, 100).unwrap()[0].id, "fork");
    assert_eq!(candidates(&items, 100).unwrap().len(), 1);
}

#[test]
fn cycles_duplicates_and_unsafe_ids_are_rejected() {
    assert!(candidates(&[item("a", "b", 1), item("b", "a", 1)], 100).is_err());
    assert!(candidates(&[item("a", "", 1), item("a", "", 1)], 100).is_err());
    for id in [
        "..",
        "../settings",
        "a/b",
        "a\\b",
        "a&b",
        "a%PATH%",
        "",
        "a\nb",
    ] {
        assert!(candidates(&[item(id, "", 1)], 100).is_err());
    }
}

#[test]
fn missing_parents_are_protected_not_treated_as_roots() {
    assert!(candidates(&[item("orphan", "missing", 1)], 100)
        .unwrap()
        .is_empty());
}

#[test]
fn plan_inventory_detects_new_children_forks_and_modified_metadata() {
    let original = vec![item("root", "", 10)];
    assert!(same_inventory(&original, &original));
    assert!(!same_inventory(&[item("root", "", 11)], &original));
    assert!(!same_inventory(
        &[original[0].clone(), item("child", "root", 10)],
        &original
    ));
    let mut fork = item("fork", "", 10);
    fork.fork = "root".into();
    assert!(!same_inventory(&[original[0].clone(), fork], &original));
}

#[test]
fn relative_and_traversal_cleanup_roots_are_rejected() {
    assert!(checked(Path::new("relative/path")).is_err());
    let temp = Temp::new();
    assert!(checked(&temp.0.join("..").join("outside")).is_err());
}

#[test]
fn claude_deletes_only_complete_selected_session_and_prunes_index() {
    let root = Temp::new();
    let id = "00000000-0000-4000-8000-000000000001";
    let other = "00000000-0000-4000-8000-000000000002";
    root.put(
        &format!("projects/demo/{id}.jsonl"),
        b"{\"type\":\"user\"}\n",
    );
    root.put(
        &format!("projects/demo/{id}/subagents/agent-test.jsonl"),
        b"subagent",
    );
    root.put(
        &format!("projects/demo/{id}/tool-results/test.txt"),
        b"result",
    );
    root.put(
        &format!("projects/demo/{id}/tool-results/sessions-index.json"),
        b"fixture attachment",
    );
    root.put(&format!("projects/demo/{id}/mcp-tasks/task.json"), b"{}");
    for folder in ["file-history", "image-cache", "uploads"] {
        root.put(&format!("{folder}/{id}/fixture.bin"), b"fixture");
    }
    let protected = [
        format!("projects/demo/{other}.jsonl"),
        "projects/demo/memory/MEMORY.md".into(),
        "agent-memory/demo/MEMORY.md".into(),
        "settings.json".into(),
        ".credentials.json".into(),
        "plugins/example/plugin.json".into(),
        "jobs/job.json".into(),
        "daemon/config.json".into(),
    ];
    for p in &protected {
        root.put(p, b"protected");
    }
    root.put(
        "projects/demo/sessions-index.json",
        &serde_json::to_vec(
            &json!({"version":1,"originalPath":"/fictional/project", "entries":[
                {"sessionId":id,"summary":"Fixture session"},{"sessionId":other,"summary":"Keep"}
            ]}),
        )
        .unwrap(),
    );
    let all = files::claude(&root.0).unwrap();
    let selected = all.iter().find(|i| i.id == id).unwrap();
    assert!(files::delete_claude(&root.0, selected).unwrap() > 0);
    assert!(!root.0.join(format!("projects/demo/{id}.jsonl")).exists());
    assert!(!root.0.join(format!("projects/demo/{id}")).exists());
    for p in protected {
        assert_eq!(fs::read(root.0.join(p)).unwrap(), b"protected");
    }
    let index: serde_json::Value = serde_json::from_slice(
        &fs::read(root.0.join("projects/demo/sessions-index.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        index["entries"],
        json!([{"sessionId":other,"summary":"Keep"}])
    );
    assert_eq!(index["originalPath"], "/fictional/project");
}

#[test]
fn claude_without_index_still_supports_session_deletion() {
    let root = Temp::new();
    let path = root.put(
        "projects/demo/00000000-0000-4000-8000-000000000003.jsonl",
        b"fixture",
    );
    let all = files::claude(&root.0).unwrap();
    assert_eq!(all.len(), 1);
    files::delete_claude(&root.0, &all[0]).unwrap();
    assert!(!path.exists());
}

#[test]
fn claude_rechecks_attachment_changes_before_removing_anything() {
    let root = Temp::new();
    let id = "00000000-0000-4000-8000-000000000004";
    let transcript = root.put(&format!("projects/demo/{id}.jsonl"), b"fixture");
    let all = files::claude(&root.0).unwrap();
    root.put(
        &format!("projects/demo/{id}/tool-results/new.txt"),
        b"recent",
    );
    assert!(files::delete_claude(&root.0, &all[0]).is_err());
    assert!(transcript.exists());
}

#[test]
fn claude_bad_index_fails_without_deletion() {
    let root = Temp::new();
    let path = root.put(
        "projects/demo/00000000-0000-4000-8000-000000000005.jsonl",
        b"fixture",
    );
    root.put("projects/demo/sessions-index.json", b"{broken}");
    assert!(files::claude(&root.0).is_err());
    assert!(path.exists());
}

#[test]
fn claude_index_recency_also_protects_an_old_transcript() {
    let root = Temp::new();
    let id = "00000000-0000-4000-8000-000000000009";
    let path = root.put(&format!("projects/demo/{id}.jsonl"), b"fixture");
    let time = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 86_400);
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(time))
        .unwrap();
    root.put(
        "projects/demo/sessions-index.json",
        &serde_json::to_vec(&json!({"version":1,"entries":[
            {"sessionId":id,"modified":"2035-01-01T00:00:00Z"}
        ]}))
        .unwrap(),
    );
    let all = files::claude(&root.0).unwrap();
    assert!(candidates(&all, logging::now().saturating_sub(DAY))
        .unwrap()
        .is_empty());
    assert!(path.exists());
}

#[test]
fn claude_index_updates_are_preserved_across_multiple_selected_sessions() {
    let root = Temp::new();
    let ids = [
        "00000000-0000-4000-8000-000000000006",
        "00000000-0000-4000-8000-000000000007",
    ];
    for id in ids {
        root.put(&format!("projects/demo/{id}.jsonl"), b"fixture");
    }
    root.put(
        "projects/demo/sessions-index.json",
        &serde_json::to_vec(&json!({"version":1,"entries":ids.map(|id| json!({"sessionId":id}))}))
            .unwrap(),
    );
    for i in files::claude(&root.0).unwrap() {
        files::delete_claude(&root.0, &i).unwrap();
    }
    let v: serde_json::Value = serde_json::from_slice(
        &fs::read(root.0.join("projects/demo/sessions-index.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(v["entries"], json!([]));
}

#[test]
fn toolbox_cache_only_removes_old_content_addressed_installers() {
    let root = Temp::new();
    let name = format!("{}.skillpack.json", "a".repeat(64));
    let old = root.put(&format!("cache/{name}"), b"old cache");
    let recent = root.put(&format!("cache/{}.zip", "b".repeat(64)), b"recent");
    let installer = root.put(&format!("cache/{}.exe", "c".repeat(64)), b"installer");
    let artifact = root.put(&format!("cache/{}", "d".repeat(64)), b"artifact");
    let time = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 86_400);
    fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(time))
        .unwrap();
    for path in [&installer, &artifact] {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(time))
            .unwrap();
    }
    for p in [
        "cache/user.json",
        "cache/download.part",
        "backups/previous.json",
        "installed.json",
        "runtime/python.exe",
        "claude/projects/session.jsonl",
    ] {
        root.put(p, b"protected");
    }
    let outcome = files::toolbox_cache(&root.0).unwrap();
    assert_eq!(outcome.reclaimed_bytes, 26);
    assert!(outcome.errors.is_empty());
    assert!(!old.exists());
    assert!(!installer.exists());
    assert!(!artifact.exists());
    assert!(recent.exists());
    for p in [
        "cache/user.json",
        "cache/download.part",
        "backups/previous.json",
        "installed.json",
        "runtime/python.exe",
        "claude/projects/session.jsonl",
    ] {
        assert_eq!(fs::read(root.0.join(p)).unwrap(), b"protected");
    }
}

#[test]
fn unknown_and_unconfirmed_plans_never_reach_native_deletion() {
    assert!(run("codex", "missing", &["fixture".into()], true).is_err());
    assert!(run("claude", "missing", &["fixture".into()], false).is_err());
    assert!(run("opencode", "missing", &[], true).is_err());
    assert!(scan("unsupported", 30).is_err());
    assert!(scan("claude", 0).is_err());
}

#[cfg(unix)]
#[test]
fn symbolic_links_are_never_followed_or_deleted() {
    let root = Temp::new();
    let external = Temp::new();
    let victim = external.put("victim.txt", b"keep");
    let path = root.put(
        "projects/demo/00000000-0000-4000-8000-000000000008.jsonl",
        b"fixture",
    );
    let link = root
        .0
        .join("projects/demo/00000000-0000-4000-8000-000000000008");
    std::os::unix::fs::symlink(&external.0, link).unwrap();
    assert!(files::claude(&root.0).is_err());
    assert!(path.exists());
    assert_eq!(fs::read(victim).unwrap(), b"keep");
}

#[cfg(windows)]
#[test]
fn directory_junctions_are_never_followed_or_deleted() {
    let root = Temp::new();
    let external = Temp::new();
    let victim = external.put("victim.txt", b"keep");
    root.put(
        "projects/demo/00000000-0000-4000-8000-000000000008.jsonl",
        b"fixture",
    );
    let link = root
        .0
        .join("projects/demo/00000000-0000-4000-8000-000000000008");
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:CYAPI_TEST_LINK -Target $env:CYAPI_TEST_TARGET | Out-Null"])
        .env("CYAPI_TEST_LINK", &link).env("CYAPI_TEST_TARGET", &external.0)
        .stdout(std::process::Stdio::null()).status().unwrap();
    assert!(status.success());
    assert!(files::claude(&root.0).is_err());
    assert_eq!(fs::read(&victim).unwrap(), b"keep");
    fs::remove_dir(link).unwrap();
}

fn database_fixture(root: &Temp, v2: bool) -> PathBuf {
    let path = root.0.join("opencode.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    let (session, message) = if v2 {
        ("session_v2", "session_message")
    } else {
        ("session", "message")
    };
    db.execute_batch(&format!("CREATE TABLE {session}(id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT, title TEXT, time_updated INTEGER);
        CREATE TABLE {message}(id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_updated INTEGER);
        CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_updated INTEGER);
        INSERT INTO {session} VALUES('root',NULL,NULL,'Fixture root',10), ('child','root',NULL,'Fixture child',10);
        INSERT INTO {message} VALUES('msg','child','{{}}',200);
        INSERT INTO part VALUES('tool','root','{{}}',300);")).unwrap();
    path
}

#[test]
fn opencode_v1_scan_reads_message_and_part_recency_without_modifying_database() {
    let root = Temp::new();
    let path = database_fixture(&root, false);
    let before = fs::read(&path).unwrap();
    let items = native::opencode_list(&root.0).unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(
        items.iter().find(|i| i.id == "root").unwrap().updated_at,
        300
    );
    assert!(candidates(&items, 100).unwrap().is_empty());
    assert_eq!(before, fs::read(path).unwrap());
}

#[test]
fn opencode_v2_scan_preserves_child_relationships_and_protects_recent_tree() {
    let root = Temp::new();
    database_fixture(&root, true);
    let items = native::opencode_list(&root.0).unwrap();
    assert_eq!(
        items.iter().find(|i| i.id == "child").unwrap().parent,
        "root"
    );
    assert!(candidates(&items, 100).unwrap().is_empty());
    assert_eq!(candidates(&items, 400).unwrap()[0].sessions, 2);
}

#[test]
fn unknown_database_schema_fails_closed() {
    let root = Temp::new();
    let path = root.0.join("opencode.db");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE secret(value TEXT); INSERT INTO secret VALUES('fixture');")
        .unwrap();
    let before = fs::read(&path).unwrap();
    assert!(native::opencode_list(&root.0).is_err());
    assert_eq!(before, fs::read(path).unwrap());
}

#[test]
fn plan_tokens_are_scoped_and_foreign_selection_is_rejected_before_io() {
    let token = uuid::Uuid::new_v4().to_string();
    let path = root("claude").unwrap();
    let scan = Scan {
        token: token.clone(),
        workspace: "claude".into(),
        root: path.to_string_lossy().into(),
        items: vec![item("allowed", "", 1)],
        protected_sessions: 0,
        notes: Vec::new(),
    };
    PLANS.lock().unwrap().push(Plan {
        scan,
        root: path,
        days: 30,
        created: logging::now(),
        all: Vec::new(),
    });
    assert!(run("codex", &token, &["allowed".into()], true)
        .unwrap_err()
        .contains("扫描计划不存在"));
    assert!(run("claude", &token, &["foreign".into()], true)
        .unwrap_err()
        .contains("扫描计划以外"));
    assert!(run("claude", &token, &["allowed".into()], true)
        .unwrap_err()
        .contains("扫描计划不存在"));
}
