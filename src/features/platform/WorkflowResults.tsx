import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle, Maximize2, Play, Trash2 } from 'lucide-react';
import { Modal } from '../../components/Primitives';
import type { WorkflowTask } from './api';
import { artifactSourceLabel, groupIdenticalImages } from './artifactDisplay';
import type { WorkflowTemplate } from './library';
import { taskParameters } from './taskParameters';
import { useWorkflowArtifacts } from './useWorkflowArtifacts';
import { WorkflowTaskLogs } from './WorkflowTaskLogs';

function ResultCard({
  id,
  visible,
  onVisibility,
  children,
}: {
  id: string;
  visible: boolean;
  onVisibility: (id: string, visible: boolean) => void;
  children: ReactNode;
}) {
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!visible || !card.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      onVisibility(id, true);
      return () => onVisibility(id, false);
    }
    const observer = new IntersectionObserver(
      ([entry]) => onVisibility(id, entry.isIntersecting),
      { rootMargin: '200px 0px' },
    );
    observer.observe(card.current);
    return () => {
      observer.disconnect();
      onVisibility(id, false);
    };
  }, [id, visible, onVisibility]);
  return <article ref={card} className="pfx-card pfx-task-result">{children}</article>;
}

// Mounted with the active Key as React key: previews and pending downloads belong to one identity.
export function WorkflowResults({
  tasks,
  templates = [],
  activeKey,
  visible,
  busy,
  onContinue,
  onDelete,
}: {
  tasks: WorkflowTask[];
  templates?: WorkflowTemplate[];
  activeKey: string;
  visible: boolean;
  busy: boolean;
  onContinue?: (output: WorkflowTask['outputs'][number], task: WorkflowTask, url: string) => void;
  onDelete: (task: WorkflowTask) => void;
}) {
  const {
    artifacts,
    artifactErrors,
    references,
    referenceErrors,
    imageHashes,
    saveNotice,
    zipTaskId,
    setTaskVisible,
    saveOutput,
    saveTaskZip,
    retryArtifact,
  } = useWorkflowArtifacts(activeKey, tasks, visible);
  const [preview, setPreview] = useState<{
    kind: 'image' | 'video';
    url: string;
    title: string;
  } | null>(null);
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
        const prompt = task.description?.trim() ?? '';
        const parameterList = taskParameters(task, templates.find((item) => item.id === task.templateId));
        const referenceIds = task.references ?? [];
        return (
          <ResultCard key={task.id} id={task.id} visible={visible} onVisibility={setTaskVisible}>
            <div className="pfx-task-row">
              <strong>{task.name}</strong>
              <div className="pfx-result-meta">
                <small>{new Date(task.createdAt).toLocaleString()}</small>
                <small>建议 30 天内下载，超过后文件可能过期</small>
                <button
                  type="button"
                  className="pfx-ghost"
                  disabled={busy}
                  onClick={() => onDelete(task)}
                >
                  <Trash2 size={14} />
                  删除
                </button>
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
            {(prompt || referenceIds.length > 0 || parameterList.length > 0) && (
              <section className="pfx-result-inputs" aria-label="任务参数">
                {prompt && (
                  <div className="pfx-result-prompt">
                    <span>提示词</span>
                    <p>{prompt}</p>
                  </div>
                )}
                {referenceIds.length > 0 && (
                  <div className="pfx-result-references">
                    <span>参考图</span>
                    <div className="pfx-result-reference-list">
                      {referenceIds.map((id, index) => {
                        const url = references[id];
                        const error = referenceErrors[id];
                        return url ? (
                          <button
                            key={id}
                            type="button"
                            className="pfx-result-reference"
                            aria-label={`放大参考图 ${index + 1}`}
                            onClick={() =>
                              setPreview({
                                kind: 'image',
                                url,
                                title: `参考图 ${index + 1}`,
                              })
                            }
                          >
                            <img src={url} alt={`参考图 ${index + 1}`} loading="lazy" decoding="async" />
                          </button>
                        ) : (
                          <div
                            key={id}
                            className="pfx-result-reference pfx-result-reference-empty"
                            role={error ? 'alert' : 'status'}
                          >
                            {error ? (
                              <span>{error}</span>
                            ) : (
                              <LoaderCircle size={14} className="pfx-spin" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {parameterList.length > 0 && (
                  <dl className="pfx-result-params">
                    {parameterList.map((parameter) => (
                      <div key={parameter.key}>
                        <dt>{parameter.label}</dt>
                        <dd>{parameter.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>
            )}
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
                        <div className="pfx-result-video">
                          <video src={url} controls playsInline preload="metadata" />
                          <button
                            type="button"
                            className="pfx-result-play"
                            aria-label="播放视频"
                            onClick={() =>
                              setPreview({
                                kind: 'video',
                                url,
                                title: output.title || '视频预览',
                              })
                            }
                          >
                            <Play size={22} />
                          </button>
                        </div>
                      ) : output.kind === 'image' ? (
                        <button
                          type="button"
                          className="pfx-result-image"
                          aria-label="放大预览图片"
                          onClick={() =>
                            setPreview({
                              kind: 'image',
                              url,
                              title: output.title || '图片预览',
                            })
                          }
                        >
                          <img src={url} alt={output.title || '生成结果'} />
                          <span className="pfx-result-zoom" aria-hidden="true">
                            <Maximize2 size={18} />
                          </span>
                        </button>
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
                    {url && output.kind === 'image' && onContinue && (
                      <button
                        type="button"
                        className="pfx-secondary"
                        onClick={() => onContinue(output, task, url)}
                      >
                        继续修改
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
          </ResultCard>
        );
      })}
      {preview && (
        <Modal
          title={preview.title}
          onClose={() => setPreview(null)}
          wide
          className="pfx-media-modal"
        >
          {preview.kind === 'video' ? (
            <div className="pfx-media-video">
              <video src={preview.url} controls autoPlay playsInline />
            </div>
          ) : (
            <div className="pfx-media-image">
              <img src={preview.url} alt={preview.title} />
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
