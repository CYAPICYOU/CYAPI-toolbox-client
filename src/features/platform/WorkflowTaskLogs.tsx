import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, ScrollText } from 'lucide-react';
import { getWorkflowTaskLogs, type WorkflowTask, type WorkflowTaskLog } from './api';
import { pollResource } from './polling';
import { errorText, taskActive } from './taskState';

export function WorkflowTaskLogs({
  task,
  activeKey,
  visible,
}: {
  task: WorkflowTask;
  activeKey: string;
  visible: boolean;
}) {
  const [open, setOpen] = useState(() => taskActive(task.status));
  return (
    <section className="pfx-task-logs" aria-label={`${task.name}运行日志`}>
      <button
        type="button"
        className="pfx-log-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <ScrollText size={14} />
        运行日志
        <span>{taskActive(task.status) ? '自动更新' : '执行记录'}</span>
      </button>
      {open && (
        <TaskLogContent
          key={`${activeKey}:${task.id}`}
          task={task}
          activeKey={activeKey}
          visible={visible}
        />
      )}
    </section>
  );
}

function TaskLogContent({
  task,
  activeKey,
  visible,
}: {
  task: WorkflowTask;
  activeKey: string;
  visible: boolean;
}) {
  const [entries, setEntries] = useState<WorkflowTaskLog[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [follow, setFollow] = useState(true);
  const [retry, setRetry] = useState(0);
  const cursor = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const active = taskActive(task.status);
  useEffect(() => {
    if (!visible || !activeKey) return;
    setLoading(true);
    let unavailable = false;
    const poller = pollResource({
      request: (signal) => getWorkflowTaskLogs(activeKey, task.id, cursor.current, signal),
      onValue: (page) => {
        cursor.current = page.cursor;
        setEntries((current) => {
          if (!page.entries.length) return current;
          const merged = new Map(current.map((entry) => [entry.id, entry]));
          for (const entry of page.entries) merged.set(entry.id, entry);
          return [...merged.values()].sort((a, b) => a.id - b.id).slice(-500);
        });
        setTruncated((current) => current || page.truncated || page.cursor > 500);
        setError('');
        setLoading(false);
      },
      onError: (cause) => {
        unavailable =
          cause instanceof Error &&
          'status' in cause &&
          [401, 403, 404].includes(Number(cause.status));
        setError(
          cause instanceof Error && 'status' in cause && cause.status === 404
            ? '此任务暂无可用日志，或服务端尚未启用任务日志。'
            : errorText(cause),
        );
        setLoading(false);
      },
      delay: (page) => (unavailable || !active || (page && !taskActive(page.status)) ? null : 2500),
    });
    return () => poller.dispose();
  }, [activeKey, task.id, active, visible, retry]);
  useEffect(() => {
    if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [entries, follow]);
  return (
    <>
      <div className="pfx-log-toolbar">
        <small>
          {loading ? '正在读取日志…' : `${entries.length} 条记录`}
          {truncated ? ' · 仅保留最近 500 条' : ''}
        </small>
        <label>
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
          />
          跟随最新
        </label>
        <button
          type="button"
          className="pfx-ghost"
          disabled={loading}
          onClick={() => setRetry((n) => n + 1)}
        >
          <RefreshCw size={12} />
          刷新日志
        </button>
      </div>
      {error && (
        <div className="pfx-alert" role="alert">
          {error}
        </div>
      )}
      <div
        className="pfx-log-content"
        ref={scroll}
        role="log"
        aria-label="任务运行日志"
        aria-live={follow ? 'polite' : 'off'}
        aria-relevant="additions"
        tabIndex={0}
      >
        {entries.map((entry) => (
          <div key={entry.id} className={`pfx-log-entry pfx-log-${entry.level}`}>
            <time dateTime={new Date(entry.at).toISOString()}>
              {new Date(entry.at).toLocaleTimeString()}
            </time>
            <span className="pfx-log-level">
              {entry.level === 'error' ? '错误' : entry.level === 'warning' ? '注意' : '信息'}
            </span>
            <span>
              {entry.nodeId && <code>节点 {entry.nodeId} · </code>}
              {entry.message}
            </span>
          </div>
        ))}
        {!entries.length && !loading && !error && (
          <p className="pfx-hint">{active ? '等待任务产生日志…' : '此任务没有运行日志。'}</p>
        )}
      </div>
    </>
  );
}
