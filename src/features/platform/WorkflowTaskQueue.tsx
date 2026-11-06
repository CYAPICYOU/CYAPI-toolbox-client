import { type WorkflowTask } from './api';
import { taskActive, taskStatusLabel } from './taskState';
import { WorkflowTaskLogs } from './WorkflowTaskLogs';

export function WorkflowTaskQueue({
  tasks,
  activeKey,
  visible,
  busy,
  onCancel,
  onResults,
}: {
  tasks: WorkflowTask[];
  activeKey: string;
  visible: boolean;
  busy: boolean;
  onCancel: (task: WorkflowTask) => void;
  onResults: () => void;
}) {
  if (!tasks.length)
    return <div className="pfx-card pfx-empty">还没有任务，选择工作流并运行。</div>;
  return tasks.map((task) => (
    <article key={task.id} className="pfx-card">
      <div className="pfx-task-row">
        <div>
          <strong>{task.name}</strong>
          <p>{task.description || '未填写内容'}</p>
          <small>
            {taskStatusLabel[task.status] ?? task.status}
            {task.message ? ` · ${task.message}` : ''} · {new Date(task.createdAt).toLocaleString()}
          </small>
        </div>
        <div className="pfx-task-actions">
          {task.status === 'succeeded' && task.outputs.length > 0 && (
            <button className="pfx-secondary" onClick={onResults}>
              查看结果
            </button>
          )}
          {taskActive(task.status) && task.source !== 'editor' && (
            <button
              className="pfx-ghost"
              disabled={busy || task.status === 'submitting'}
              onClick={() => onCancel(task)}
            >
              取消任务
            </button>
          )}
        </div>
      </div>
      <WorkflowTaskLogs task={task} activeKey={activeKey} visible={visible} />
    </article>
  ));
}
