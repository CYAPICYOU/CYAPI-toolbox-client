import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, LoaderCircle, RotateCw, SquareTerminal, X } from 'lucide-react';
import { editorLaunchPending, type EditorLaunchState } from './editorLaunch';
import { openLogs } from '../../lib/api/diagnostics';

export interface EditorLaunchNoticeState {
  state: EditorLaunchState;
  onRetry: () => void;
  onDismiss: () => void;
}

export function EditorLaunchNotice({
  state,
  onRetry,
  onDismiss,
}: {
  state: EditorLaunchState;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const pending = editorLaunchPending(state);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);
  // The editor window is already in front of the user; a permanent success
  // banner only steals space from the page, so acknowledge it briefly.
  useEffect(() => {
    if (state.phase !== 'opened') return;
    const timer = window.setTimeout(() => dismiss.current(), 1500);
    return () => window.clearTimeout(timer);
  }, [state.phase]);
  const elapsed = Math.max(0, Math.floor(((state.finishedAt ?? now) - state.startedAt) / 1000));
  const label = {
    starting: '正在启动 ComfyUI',
    opening: '服务已就绪，正在打开编辑器',
    opened: '编辑器窗口已打开',
    failed: 'ComfyUI 未能打开',
  }[state.phase];
  return (
    <aside className={`pfx-launch-notice pfx-launch-${state.phase}`} aria-label="ComfyUI 启动状态">
      <div className="pfx-launch-summary">
        {pending ? (
          <LoaderCircle size={18} className="pfx-spin" aria-hidden="true" />
        ) : state.phase === 'failed' ? (
          <AlertCircle size={18} aria-hidden="true" />
        ) : (
          <CheckCircle2 size={18} aria-hidden="true" />
        )}
        <div className="pfx-launch-copy">
          <strong role="status" aria-live="polite">
            {label}
          </strong>
          <span>
            {state.title} · 已等待 {elapsed} 秒
          </span>
        </div>
        <button className="pfx-ghost" data-logs-trigger onClick={() => openLogs(state.operationId)}>
          <SquareTerminal size={14} />
          查看日志
        </button>
        {state.phase === 'failed' && (
          <button className="pfx-ghost" onClick={onRetry}>
            <RotateCw size={14} />
            重新尝试
          </button>
        )}
        {!pending && (
          <button className="pfx-icon-button" aria-label="关闭启动提示" onClick={onDismiss}>
            <X size={15} />
          </button>
        )}
      </div>
      {pending ? (
        <>
          <div
            className="pfx-launch-progress"
            role="progressbar"
            aria-label={label}
            aria-valuetext="正在等待服务响应，无精确百分比"
          >
            <span />
          </div>
          <p>
            {elapsed >= 15
              ? '首次或冷启动需要一些时间，仍在等待服务响应。你可以继续浏览工作流或切换页面，无需重复点击。'
              : '正在后台准备，完成后自动打开编辑器。你可以继续浏览或编辑，页面不会被锁定。'}
          </p>
        </>
      ) : (
        <p role={state.phase === 'failed' ? 'alert' : undefined}>
          {state.error || '编辑器将在独立窗口加载；如未切换到前台，请查看任务栏。'}
        </p>
      )}
    </aside>
  );
}
