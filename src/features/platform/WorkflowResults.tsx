import { LoaderCircle } from 'lucide-react';
import type { WorkflowTask } from './api';
import { artifactSourceLabel, groupIdenticalImages } from './artifactDisplay';
import { useWorkflowArtifacts } from './useWorkflowArtifacts';
import { WorkflowTaskLogs } from './WorkflowTaskLogs';

// Mounted with the active Key as React key: previews and pending downloads belong to one identity.
export function WorkflowResults({
  tasks,
  activeKey,
  visible,
}: {
  tasks: WorkflowTask[];
  activeKey: string;
  visible: boolean;
}) {
  const {
    artifacts,
    artifactErrors,
    imageHashes,
    saveNotice,
    zipTaskId,
    saveOutput,
    saveTaskZip,
    retryArtifact,
  } = useWorkflowArtifacts(activeKey, tasks, visible);
  const completed = tasks.filter(
    (task) => task.status === 'succeeded' && task.outputs.length > 0,
  );
  return (
    <>
      {saveNotice && (
        <div className="pfx-alert" role="status">
          {saveNotice}
        </div>
      )}
      {!completed.length && (
        <div className="pfx-card pfx-empty">
          暂无产物。任务成功并生成可下载文件后，会显示在这里。
        </div>
      )}
      {completed.map((task) => {
        const worker = task.source === 'editor' || task.mode === 'worker';
        const groups = worker
          ? groupIdenticalImages(task.outputs, imageHashes)
          : task.outputs.map((output) => [output]);
        return (
          <article key={task.id} className="pfx-card pfx-task-result">
            <div className="pfx-task-row">
              <strong>{task.name}</strong>
              <div className="pfx-result-meta">
                <small>{new Date(task.createdAt).toLocaleString()}</small>
                <small>建议 30 天内下载，超过后文件可能过期</small>
              </div>
            </div>
            {task.outputs.length > 0 && (
              <button
                type="button"
                className="pfx-secondary pfx-download-zip"
                disabled={Boolean(zipTaskId)}
                onClick={() => void saveTaskZip(task)}
              >
                {zipTaskId === task.id ? '正在打包…' : '下载全部（ZIP）'}
              </button>
            )}
            {worker && task.message && <small>{task.message}</small>}
            <div className="pfx-results">
              {groups.map((group) => {
                const output = group[0];
                const url = artifacts[output.download];
                return (
                  <figure key={output.id} className="pfx-result">
                    {worker && (
                      <small>
                        {output.role === 'preview'
                          ? '预览图（临时文件，可能不是原始质量）'
                          : output.role === 'file'
                            ? '输出文件'
                            : output.role === 'temporary'
                              ? '临时文件（来源节点未确认为预览）'
                              : '历史文件（来源类型未知）'}
                      </small>
                    )}
                    {worker &&
                      group.map((item) => <small key={item.id}>{artifactSourceLabel(item)}</small>)}
                    {url ? (
                      output.kind === 'video' ? (
                        <video src={url} controls playsInline />
                      ) : output.kind === 'image' ? (
                        <img src={url} alt={output.title || '生成结果'} />
                      ) : output.kind === 'audio' ? (
                        <audio src={url} controls />
                      ) : (
                        <div>{output.title || '文件'}</div>
                      )
                    ) : artifactErrors[output.download] ? (
                      <div className="pfx-result-loading" role="alert">
                        <span>产物无法加载：{artifactErrors[output.download]}</span>
                        <button
                          className="pfx-secondary"
                          onClick={() => retryArtifact(output.download)}
                        >
                          重试
                        </button>
                      </div>
                    ) : (
                      <div className="pfx-result-loading">
                        <LoaderCircle size={14} className="pfx-spin" />
                        正在加载产物…
                      </div>
                    )}
                    {url && (
                      <button
                        type="button"
                        className="pfx-secondary"
                        onClick={() => void saveOutput(output)}
                      >
                        下载
                        {output.role === 'preview' ? '预览' : output.role === 'file' ? '文件' : ''}
                      </button>
                    )}
                    {group.length > 1 && (
                      <small>预览与输出图像的像素相同；两个原文件均已保留。</small>
                    )}
                    {group.slice(1).map(
                      (alternative, index) =>
                        artifacts[alternative.download] && (
                          <button
                            type="button"
                            className="pfx-secondary"
                            key={alternative.id}
                            onClick={() => void saveOutput(alternative)}
                          >
                            下载预览 {index + 1}
                          </button>
                        ),
                    )}
                  </figure>
                );
              })}
            </div>
            {task.billing && (
              <small>
                {task.billing.amount > 0
                  ? `${task.billing.status === 'quoted' || task.mode === 'worker' ? '预估费用' : '本次费用'} ${task.billing.amount} ${task.billing.unit}`
                  : task.mode === 'worker'
                    ? '预估费用 0 USD，实际费用请查看账单'
                    : '未产生费用'}
              </small>
            )}
            <WorkflowTaskLogs task={task} activeKey={activeKey} visible={visible} />
          </article>
        );
      })}
    </>
  );
}
