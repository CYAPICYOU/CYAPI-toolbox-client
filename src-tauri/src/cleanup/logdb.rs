use super::*;
use rusqlite::{Connection, OpenFlags};
use std::time::Duration;

#[derive(Clone)]
pub(super) struct LogDatabase {
    pub path: PathBuf,
    pub bytes: u64,
    pub records: usize,
    pub first: u64,
    pub last: u64,
    max_id: i64,
    nanos: bool,
    stamps: Vec<files::Stamp>,
}

pub(super) struct DeletedLogs {
    pub records: usize,
    pub bytes: u64,
    pub warning: Option<String>,
}

fn open(path: &Path, writable: bool) -> Result<Connection> {
    checked(path)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        checked(&PathBuf::from(format!("{}{suffix}", path.display())))?;
    }
    let db = Connection::open_with_flags(
        path,
        if writable {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        },
    )
    .map_err(|_| "无法打开日志数据库")?;
    db.busy_timeout(Duration::from_secs(2))
        .map_err(|_| "无法设置日志数据库等待时间")?;
    Ok(db)
}

fn paths(path: &Path) -> Vec<PathBuf> {
    vec![
        path.into(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ]
}

pub(super) fn inspect(path: &Path) -> Result<LogDatabase> {
    let parent = path.parent().ok_or("日志数据库路径无效")?;
    for p in paths(path) {
        checked(&p)?;
    }
    let db = open(path, false)?;
    let triggers: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "无法确认日志数据库触发器")?;
    if triggers > 0 {
        return Err("日志数据库包含未知触发器，保持只读".into());
    }
    let mut stmt = db
        .prepare("PRAGMA table_info(logs)")
        .map_err(|_| "无法读取日志表结构")?;
    let columns = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|_| "无法读取日志表字段")?
        .collect::<std::result::Result<HashSet<_>, _>>()
        .map_err(|_| "日志表字段无效")?;
    if !["id", "ts"].iter().all(|c| columns.contains(*c)) {
        return Err("日志数据库结构不受支持，保持只读".into());
    }
    let nanos = columns.contains("ts_nanos");
    let time = if nanos {
        "ts*1000 + MAX(ts_nanos,0)/1000000"
    } else {
        "ts*1000"
    };
    let (records, max_id, first, last): (i64, i64, i64, i64) = db.query_row(
        &format!("SELECT COUNT(*),COALESCE(MAX(id),0),COALESCE(MIN({time}),0),COALESCE(MAX({time}),0) FROM logs"),
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(|_| "无法统计日志记录")?;
    drop(stmt);
    drop(db);
    let stamps = files::stamps(parent, &paths(path))?;
    Ok(LogDatabase {
        path: path.into(),
        bytes: stamps.iter().map(|s| s.bytes).sum(),
        records: records.max(0) as usize,
        first: first.max(0) as u64,
        last: last.max(0) as u64,
        max_id,
        nanos,
        stamps,
    })
}

pub(super) fn verify(expected: &LogDatabase) -> Result<()> {
    let current = inspect(&expected.path)?;
    if current.max_id != expected.max_id
        || current.records != expected.records
        || current.stamps != expected.stamps
    {
        return Err("日志数据库在扫描后已变化，请重新扫描".into());
    }
    Ok(())
}

pub(super) fn delete(expected: &LogDatabase, range: &TimeRange) -> Result<DeletedLogs> {
    delete_using(expected, range, |p| native::compact_path(p).map(|_| ()))
}

fn delete_using(
    expected: &LogDatabase,
    range: &TimeRange,
    compact: impl FnOnce(&Path) -> Result<()>,
) -> Result<DeletedLogs> {
    range.validate()?;
    verify(expected)?;
    let mut db = open(&expected.path, true)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "日志数据库仍被占用，未删除日志")?;
    let (count, max): (i64, i64) = tx
        .query_row("SELECT COUNT(*),COALESCE(MAX(id),0) FROM logs", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(|_| "无法复查日志数据库")?;
    if count.max(0) as usize != expected.records || max != expected.max_id {
        return Err("日志数据库已变化，未执行删除".into());
    }
    let time = if expected.nanos {
        "ts*1000 + MAX(ts_nanos,0)/1000000"
    } else {
        "ts*1000"
    };
    let deleted = tx
        .execute(
            &format!("DELETE FROM logs WHERE ({time}) >= ?1 AND ({time}) < ?2 AND id <= ?3"),
            rusqlite::params![
                range.since.unwrap_or(0) as i64,
                range.until.unwrap_or(i64::MAX as u64) as i64,
                expected.max_id
            ],
        )
        .map_err(|_| "日志删除失败，事务已回滚")?;
    tx.commit().map_err(|_| "日志删除事务未完成")?;
    drop(db);
    // Once COMMIT succeeds the records are gone, even if VACUUM fails later.
    let warning = if deleted > 0 {
        compact(&expected.path)
            .err()
            .map(|e| format!("已删除 {deleted} 条日志记录，但数据库空间回收未完成：{e}"))
    } else {
        None
    };
    let after: u64 = paths(&expected.path)
        .iter()
        .filter_map(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .sum();
    Ok(DeletedLogs {
        records: deleted,
        bytes: expected.bytes.saturating_sub(after),
        warning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> PathBuf {
        fs::create_dir_all(root).unwrap();
        let path = root.join("logs_1.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER NOT NULL,ts_nanos INTEGER NOT NULL,body BLOB);
            CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('fixture');
            INSERT INTO logs VALUES(1,100,0,zeroblob(65536)),(2,200,0,zeroblob(65536)),(3,200,500000000,zeroblob(65536)),(4,300,0,zeroblob(65536));").unwrap();
        path
    }

    #[test]
    fn log_cleanup_deletes_only_in_range_records_and_preserves_other_tables() {
        let root = std::env::temp_dir().join(format!("cyapi-log-cleanup-{}", uuid::Uuid::new_v4()));
        let path = fixture(&root);
        let snapshot = inspect(&path).unwrap();
        assert_eq!(
            (snapshot.records, snapshot.first, snapshot.last),
            (4, 100000, 300000)
        );
        let deleted = delete(
            &snapshot,
            &TimeRange {
                since: Some(200000),
                until: Some(200500),
            },
        )
        .unwrap();
        assert_eq!(deleted.records, 1);
        assert!(deleted.bytes > 0);
        assert!(deleted.warning.is_none());
        let db = open(&path, false).unwrap();
        let ids: Vec<i64> = db
            .prepare("SELECT id FROM logs ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(ids, [1, 3, 4]);
        assert_eq!(
            db.query_row("SELECT value FROM retained", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "fixture"
        );
        assert_eq!(
            db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        drop(db);
        assert_eq!(
            delete(&inspect(&path).unwrap(), &TimeRange::default())
                .unwrap()
                .records,
            3
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_vacuum_reports_committed_deletions_instead_of_total_failure() {
        let root = std::env::temp_dir().join(format!("cyapi-log-partial-{}", uuid::Uuid::new_v4()));
        let path = fixture(&root);
        let deleted = delete_using(&inspect(&path).unwrap(), &TimeRange::default(), |_| {
            Err("fixture full disk".into())
        })
        .unwrap();
        assert_eq!(deleted.records, 4);
        assert!(deleted.warning.unwrap().contains("已删除 4 条日志记录"));
        assert_eq!(inspect(&path).unwrap().records, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn modified_log_snapshot_or_unknown_triggers_block_deletion() {
        let root = std::env::temp_dir().join(format!("cyapi-log-changed-{}", uuid::Uuid::new_v4()));
        let path = fixture(&root);
        let snapshot = inspect(&path).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute("UPDATE logs SET body=x'00' WHERE id=1", [])
            .unwrap();
        assert!(delete(&snapshot, &TimeRange::default()).is_err());
        assert_eq!(inspect(&path).unwrap().records, 4);
        db.execute_batch(
            "CREATE TRIGGER unknown_trigger AFTER DELETE ON logs BEGIN DELETE FROM retained; END;",
        )
        .unwrap();
        assert!(inspect(&path).is_err());
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM retained", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(db);
        fs::remove_dir_all(root).unwrap();
    }
}
