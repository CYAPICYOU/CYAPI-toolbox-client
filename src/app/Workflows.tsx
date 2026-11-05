import { PlatformWorkbench } from '../features/platform/PlatformWorkbench';
import type { EditorLaunchNoticeState } from '../features/platform/EditorLaunchNotice';

/**
 * The workbench is now a native React page that talks to the hosted workflow
 * control plane. The full ComfyUI editor itself lives in a separate Tauri
 * WebView opened with a one-shot editor token, never inside this page.
 */
export function Workflows({
  visible,
  view,
  onViewChange,
  onEditorLaunchChange,
}: {
  visible: boolean;
  view: 'library' | 'drafts' | 'queue' | 'results' | 'nodes';
  onViewChange: (view: 'library' | 'drafts' | 'queue' | 'results' | 'nodes') => void;
  onEditorLaunchChange: (notice: EditorLaunchNoticeState | null) => void;
}) {
  return (
    <PlatformWorkbench
      visible={visible}
      view={view}
      onViewChange={onViewChange}
      onEditorLaunchChange={onEditorLaunchChange}
    />
  );
}
