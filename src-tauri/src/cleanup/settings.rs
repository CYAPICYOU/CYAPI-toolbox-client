use super::*;
use serde::{Deserialize, Serialize};
use std::io::Write;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExperimentalSettings {
    pub enabled: bool,
}

pub(super) fn read(data: &Path) -> Result<ExperimentalSettings> {
    let path = data.join("experimental-settings.json");
    checked(&path)?;
    match fs::metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ExperimentalSettings::default())
        }
        Ok(m) if m.len() <= 4096 && m.is_file() => {}
        _ => return Err("实验性设置不可读取，空间清理保持关闭".into()),
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| "无法读取实验性设置")?)
        .map_err(|_| "实验性设置无效，空间清理保持关闭".into())
}

pub(super) fn write(data: &Path, enabled: bool, confirmed: bool) -> Result<ExperimentalSettings> {
    if enabled && !confirmed {
        return Err("请先确认实验性功能仍处于开发阶段的风险提示".into());
    }
    checked(data)?;
    fs::create_dir_all(data).map_err(|_| "无法创建工具箱设置目录")?;
    let path = data.join("experimental-settings.json");
    checked(&path)?;
    let temporary = data.join(format!(".experimental-{}.tmp", uuid::Uuid::new_v4()));
    let settings = ExperimentalSettings { enabled };
    let result: Result<()> = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "无法暂存实验性设置")?;
        file.write_all(&serde_json::to_vec(&settings).map_err(|_| "无法编码实验性设置")?)
            .map_err(|_| "无法写入实验性设置")?;
        file.sync_all().map_err(|_| "无法保存实验性设置")?;
        drop(file);
        checked(&path)?;
        fs::rename(&temporary, &path).map_err(|_| "无法替换实验性设置".into())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(settings)
}

pub(super) fn require_enabled() -> Result<()> {
    require_enabled_at(&logging::data_path())
}

pub(super) fn require_enabled_at(data: &Path) -> Result<()> {
    if read(data)?.enabled {
        Ok(())
    } else {
        Err("空间清理为实验性功能，请先在软件设置中阅读风险提示并启用".into())
    }
}
