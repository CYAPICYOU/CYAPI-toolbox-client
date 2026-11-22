use block2::RcBlock;
use objc2::{rc::Retained, MainThreadMarker};
use objc2_app_kit::{
    NSModalResponse, NSModalResponseCancel, NSModalResponseOK, NSSavePanel, NSWindow,
};
use objc2_foundation::{NSString, NSURL};
use std::{cell::Cell, path::PathBuf};
use tokio::sync::oneshot;

pub(crate) async fn artifact_save_dialog(
    window: &tauri::WebviewWindow,
    filename: String,
) -> Result<Option<PathBuf>, String> {
    // AppKit must present the panel on the main thread. Await its completion
    // without blocking that thread (including while the user chooses a path).
    let (send, receive) = oneshot::channel();
    let owner = window.clone();
    window
        .run_on_main_thread(move || {
            let parent = MainThreadMarker::new().and_then(|mtm| {
                let ptr = owner.ns_window().ok()?;
                // SAFETY: Tauri returns the NSWindow pointer for `owner` on this thread.
                let parent = unsafe { Retained::retain(ptr.cast::<NSWindow>()) }?;
                Some((mtm, parent))
            });
            let Some((mtm, parent)) = parent else {
                let _ = send.send(Err("无法获取主窗口".into()));
                return;
            };
            if parent.attachedSheet().is_some() {
                let _ = send.send(Err("请先关闭当前窗口中的对话框".into()));
                return;
            }

            let panel = NSSavePanel::savePanel(mtm);
            panel.setNameFieldStringValue(&NSString::from_str(&filename));
            panel.setCanCreateDirectories(true);

            // Keep the panel alive through completion, then release the extra retain.
            let pending = Cell::new(Some((panel.clone(), send)));
            let completion = RcBlock::new(move |response| {
                if let Some((panel, send)) = pending.take() {
                    let _ = send.send(selected_path(response, || panel.URL()));
                }
            });
            panel.beginSheetModalForWindow_completionHandler(&parent, &completion);
        })
        .map_err(|e| format!("无法打开保存对话框：{e}"))?;
    receive.await.map_err(|_| "保存对话框未完成".to_string())?
}

fn selected_path(
    response: NSModalResponse,
    url: impl FnOnce() -> Option<Retained<NSURL>>,
) -> Result<Option<PathBuf>, String> {
    if response == NSModalResponseOK {
        url()
            .and_then(|url| url.to_file_path())
            .map(Some)
            .ok_or_else(|| "无法读取选择的保存位置".into())
    } else if response == NSModalResponseCancel {
        Ok(None)
    } else {
        Err("无法打开保存对话框".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_app_kit::NSModalResponseAbort;
    use std::path::Path;

    #[test]
    fn save_panel_distinguishes_file_selection_cancellation_and_failure() {
        for path in ["/tmp/工作流 #1.png", "/tmp/workflow %2.zip"] {
            let path = Path::new(path);
            let selected = selected_path(NSModalResponseOK, || NSURL::from_file_path(path));
            assert_eq!(selected, Ok(Some(path.to_owned())));
        }
        assert_eq!(
            selected_path(NSModalResponseCancel, || unreachable!()),
            Ok(None)
        );
        assert!(selected_path(NSModalResponseAbort, || unreachable!()).is_err());
        assert!(selected_path(NSModalResponseOK, || None).is_err());
    }
}
