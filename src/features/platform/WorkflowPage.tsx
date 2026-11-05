import { useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  FileAudio,
  FileJson,
  ImagePlus,
  LoaderCircle,
  Save,
  Upload,
  X,
} from 'lucide-react';
import type { MockDraft } from './mockTasks';
import type { WorkflowTemplate } from './library';
import { WorkflowIcon } from './WorkflowLibrary';

export function WorkflowPage({
  draft,
  template,
  tab,
  onTab,
  onChange,
  onBack,
  onSave,
  onSubmit,
  onEditor,
  error,
  busy,
  editorStarting,
}: {
  draft: MockDraft;
  template: WorkflowTemplate;
  tab: 'inputs' | 'flow';
  onTab: (tab: 'inputs' | 'flow') => void;
  onChange: (draft: MockDraft) => void;
  onBack: () => void;
  onSave: () => void;
  onSubmit: () => void;
  onEditor: () => void;
  error: string;
  busy: boolean;
  editorStarting: boolean;
}) {
  const [fileError, setFileError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef(draft);
  const fileRequest = useRef(0);
  latest.current = draft;
  const file = template.form.file;
  const prompt = template.form.prompt;
  const hasDocument = Boolean(template.apiGraph || template.workflow);
  async function chooseFile(selected?: File) {
    if (!selected || !file) return;
    const request = ++fileRequest.current;
    if (selected.size > 2 * 1024 * 1024) {
      setFileError('素材不能超过 2 MB，请压缩后重试。');
      return;
    }
    const media = file.accept.startsWith('audio/') ? 'audio/' : 'image/';
    if (!selected.type.startsWith(media)) {
      setFileError(media === 'audio/' ? '请选择支持的音频文件。' : '请选择图片文件。');
      return;
    }
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(selected);
      });
      if (latest.current.id !== draft.id || request !== fileRequest.current) return;
      onChange({ ...latest.current, fileName: selected.name, fileData: data });
      setFileError('');
    } catch {
      setFileError('读取素材失败，请重新选择。');
    }
  }
  const graphNodes = Object.entries(template.apiGraph ?? {});
  const canvasNodes = Array.isArray(template.workflow?.nodes)
    ? (template.workflow.nodes as { id: string | number; type?: string; title?: string }[])
    : [];
  return (
    <div className="pfx-workflow-page">
      <div className="pfx-workflow-breadcrumb">
        <button className="pfx-back" onClick={onBack}>
          <ArrowLeft size={16} />
          返回工作流库
        </button>
        <span>/</span>
        <span>{template.title}</span>
      </div>
      <div className="pfx-workflow-heading">
        <div className="pfx-workflow-title">
          <span className="pfx-template-icon">
            <WorkflowIcon category={template.category} size={23} />
          </span>
          <div>
            <h1>{template.title}</h1>
            <p>{template.description}</p>
          </div>
        </div>
        <button
          className="pfx-secondary"
          disabled={busy || editorStarting || !hasDocument}
          title={hasDocument ? '将此工作流载入 ComfyUI 编辑器' : '此模板的节点流程尚未发布'}
          onClick={onEditor}
        >
          {editorStarting ? (
            <LoaderCircle size={14} className="pfx-spin" />
          ) : (
            <ExternalLink size={14} />
          )}
          {editorStarting ? 'ComfyUI 正在后台启动…' : '在 ComfyUI 中打开'}
        </button>
      </div>
      <div className="pfx-page-tabs" role="tablist" aria-label="工作流视图">
        <button role="tab" aria-selected={tab === 'inputs'} onClick={() => onTab('inputs')}>
          填写输入
        </button>
        <button role="tab" aria-selected={tab === 'flow'} onClick={() => onTab('flow')}>
          流程详情
        </button>
      </div>
      {(error || fileError) && (
        <div className="pfx-alert" role="alert">
          {error || fileError}
        </div>
      )}
      <div className="pfx-workflow-layout">
        <section
          className="pfx-input-panel"
          role="tabpanel"
          aria-label={tab === 'inputs' ? '填写输入' : '流程详情'}
        >
          {tab === 'inputs' ? (
            <>
              <div className="pfx-panel-heading">
                <h2>准备创作内容</h2>
                <p>填写文字或添加素材，无需操作节点。</p>
              </div>
              {file && (
                <div className="pfx-field">
                  <label htmlFor="workflow-material">
                    {file.label}
                    <span>{file.required ? '必填' : '选填'}</span>
                  </label>
                  <input
                    id="workflow-material"
                    ref={fileInput}
                    type="file"
                    accept={file.accept}
                    hidden
                    onChange={(event) => {
                      void chooseFile(event.target.files?.[0]);
                      event.target.value = '';
                    }}
                  />
                  {draft.fileData ? (
                    <div className="pfx-file-preview">
                      {file.accept.startsWith('image/') ? (
                        <img src={draft.fileData} alt={draft.fileName} />
                      ) : (
                        <audio src={draft.fileData} controls />
                      )}
                      <div>
                        <span>
                          <Check size={14} />
                          {draft.fileName}
                        </span>
                        <button
                          className="pfx-icon-button"
                          aria-label="移除素材"
                          onClick={() => {
                            fileRequest.current++;
                            onChange({ ...draft, fileName: '', fileData: '' });
                            setFileError('');
                          }}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={`pfx-upload-zone${dragging ? ' dragging' : ''}`}
                      onClick={() => fileInput.current?.click()}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDragging(true);
                      }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragging(false);
                        void chooseFile(event.dataTransfer.files[0]);
                      }}
                    >
                      {file.accept.startsWith('audio/') ? (
                        <FileAudio size={27} strokeWidth={1.4} />
                      ) : (
                        <ImagePlus size={27} strokeWidth={1.4} />
                      )}
                      <strong>
                        拖拽文件到这里，或<span>点击上传</span>
                      </strong>
                      <small>
                        {file.accept.startsWith('audio/')
                          ? '支持音频文件'
                          : '支持 JPG、PNG、WebP 等图片'}{' '}
                        · 最大 2 MB
                      </small>
                    </button>
                  )}
                </div>
              )}
              {prompt && (
                <div className="pfx-field">
                  <label htmlFor="workflow-prompt">
                    {prompt.label}
                    <span>{prompt.required ? '必填' : '选填'}</span>
                  </label>
                  <textarea
                    id="workflow-prompt"
                    value={draft.prompt}
                    onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
                    placeholder={prompt.placeholder}
                    rows={8}
                  />
                  <small className="pfx-character-count">{draft.prompt.length} 字</small>
                </div>
              )}
              {!prompt && !file && (
                <div className="pfx-imported-guide">
                  <FileJson size={32} strokeWidth={1.3} />
                  <h3>这个工作流使用节点输入</h3>
                  <p>已保留完整的 ComfyUI 文件。打开编辑器配置节点参数，再运行工作流。</p>
                  <button
                    className="pfx-primary"
                    disabled={busy || editorStarting || !hasDocument}
                    onClick={onEditor}
                  >
                    {editorStarting ? (
                      <LoaderCircle size={14} className="pfx-spin" />
                    ) : (
                      <ExternalLink size={14} />
                    )}
                    {editorStarting ? 'ComfyUI 正在后台启动…' : '打开 ComfyUI 编辑器'}
                  </button>
                </div>
              )}
              {(prompt || file) && (
                <div className="pfx-input-footer">
                  <button className="pfx-secondary" onClick={onSave}>
                    <Save size={14} />
                    保存草稿
                  </button>
                  <button className="pfx-primary" onClick={onSubmit} disabled={busy}>
                    {busy ? (
                      <>
                        <LoaderCircle size={14} className="pfx-spin" />
                        提交中…
                      </>
                    ) : (
                      <>
                        运行工作流
                        <ArrowRight size={14} />
                      </>
                    )}
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="pfx-panel-heading">
                <h2>工作流如何运行</h2>
                <p>查看处理步骤，需要调整节点时再进入 ComfyUI。</p>
              </div>
              <ol className="pfx-flow-steps">
                {template.steps.map((step, index) => (
                  <li key={index}>
                    <span>{index + 1}</span>
                    <div>
                      <strong>{step}</strong>
                      <small>
                        {index === 0
                          ? template.input
                          : index === template.steps.length - 1
                            ? template.output
                            : '按工作流配置处理'}
                      </small>
                    </div>
                    {index < template.steps.length - 1 && <ArrowRight size={16} />}
                  </li>
                ))}
              </ol>
              {graphNodes.length > 0 || canvasNodes.length > 0 ? (
                <div className="pfx-node-details">
                  <h3>节点概览</h3>
                  {graphNodes.length
                    ? graphNodes.map(([id, node]) => (
                        <div key={id}>
                          <code>#{id}</code>
                          <strong>{node._meta?.title || node.class_type}</strong>
                          <small>{Object.keys(node.inputs).length} 项输入</small>
                        </div>
                      ))
                    : canvasNodes.map((node) => (
                        <div key={node.id}>
                          <code>#{node.id}</code>
                          <strong>{node.title || node.type || '节点'}</strong>
                        </div>
                      ))}
                </div>
              ) : (
                <p className="pfx-hint">此模板的节点流程尚未发布，暂不支持在 ComfyUI 中查看。</p>
              )}
              {hasDocument && (
                <button
                  className="pfx-secondary"
                  disabled={busy || editorStarting}
                  onClick={onEditor}
                >
                  {editorStarting ? (
                    <LoaderCircle size={14} className="pfx-spin" />
                  ) : (
                    <ExternalLink size={14} />
                  )}
                  {editorStarting ? 'ComfyUI 正在后台启动…' : '在 ComfyUI 中查看完整流程'}
                </button>
              )}
            </>
          )}
        </section>
        <aside className="pfx-workflow-aside">
          <section className="pfx-card">
            <h2>工作流信息</h2>
            <dl>
              <dt>输入内容</dt>
              <dd>{template.input}</dd>
              <dt>生成产物</dt>
              <dd>{template.output}</dd>
              <dt>模板版本</dt>
              <dd>v{template.version}</dd>
            </dl>
            <h3>操作步骤</h3>
            <ol>
              {template.steps.map((step, index) => (
                <li key={index}>
                  <span>{index + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
          </section>
          {template.execution === 'preview' && (prompt || file) && (
            <section className="pfx-preview-note">
              <Upload size={15} />
              <div>
                <strong>运行会提交真实任务</strong>
                <p>
                  任务由服务端提交到 CYAPI Bridge，完成后在「结果」中查看图片或视频。免费能力不产生费用；关闭客户端不会取消服务端任务。
                </p>
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
