import { useEffect, useRef, useState } from 'react';
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
import type { LocalWorkflowDraft } from './draftStore';
import type { WorkflowTemplate } from './library';
import { WorkflowIcon } from './WorkflowLibrary';
import { getWorkflowPriceCatalog } from './api';
import { formatWorkflowUsd, workflowHasImagePricing, workflowReferencePrice } from './workflowPrice';
import { ImageAnnotationEditor } from '../../components/ImageAnnotationEditor';
import { overlayDimensions } from './overlayDimensions';
import { WorkflowExamples } from './WorkflowExamples';
import { IMAGE_INPUT_LIMIT, OVERLAY_LIMIT, REFERENCE_LIMIT, prepareLocalImage } from './imagePreparation';

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
  draft: LocalWorkflowDraft;
  template: WorkflowTemplate;
  tab: 'inputs' | 'flow';
  onTab: (tab: 'inputs' | 'flow') => void;
  onChange: (draft: LocalWorkflowDraft) => void;
  onBack: () => void;
  onSave: () => void;
  onSubmit: () => void;
  onEditor: () => void;
  error: string;
  busy: boolean;
  editorStarting: boolean;
}) {
  const [fileError, setFileError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [paint, setPaint] = useState<'mask' | 'markup' | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [imagePricing, setImagePricing] = useState(false);
  const [priceLoading, setPriceLoading] = useState(template.source === 'server');
  useEffect(() => {
    let cancelled = false;
    setPrice(null);
    setImagePricing(false);
    if (template.source !== 'server') {
      setPriceLoading(false);
      return;
    }
    setPriceLoading(true);
    void getWorkflowPriceCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setPrice(workflowReferencePrice(catalog, template.id));
          setImagePricing(workflowHasImagePricing(catalog, template.id));
        }
      })
      .catch(() => {
        if (!cancelled) setPrice(null);
      })
      .finally(() => {
        if (!cancelled) setPriceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [template.id, template.source]);
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef(draft);
  const fileRequest = useRef(0);
  latest.current = draft;
  const file = template.form.file;
  const prompt = template.form.prompt;
  const options = template.form.options ?? [];
  const mask = template.form.mask;
  const markup = template.form.markup;
  const maskInput = useRef<HTMLInputElement>(null);
  const maskRequest = useRef(0);
  const markupInput = useRef<HTMLInputElement>(null);
  const markupRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; fileRequest.current++; maskRequest.current++; markupRequest.current++; };
  }, []);
  const previewUrls = useRef(new Set<string>());
  useEffect(() => {
    const current = new Set([draft.fileData, draft.maskData, draft.markupData, ...(draft.files ?? []).map(item => item.data)]
      .filter((value): value is string => Boolean(value?.startsWith('blob:'))));
    for (const url of previewUrls.current) if (!current.has(url)) URL.revokeObjectURL(url);
    previewUrls.current = current;
  }, [draft.fileData, draft.files, draft.maskData, draft.markupData]);
  useEffect(() => () => { for (const url of previewUrls.current) URL.revokeObjectURL(url); }, []);
  const hasDocument = Boolean(template.apiGraph || template.workflow);
  async function chooseFile(selected?: File, selectedFiles?: FileList) {
    if (!mounted.current || !selected || !file) return;
    const request = ++fileRequest.current;
    const candidates = file.multiple ? Array.from(selectedFiles ?? [selected]) : [selected];
    const existing = file.multiple ? (latest.current.files?.length ? latest.current.files : latest.current.fileData ? [{ name: latest.current.fileName, data: latest.current.fileData }] : []) : [];
    if (existing.length + candidates.length > (file.maxFiles ?? 16)) { setFileError(`最多选择 ${file.maxFiles ?? 16} 张图片。`); return; }
    if (template.id === 'gpt-image-25-edit') {
      if (candidates.some(item => item.size > IMAGE_INPUT_LIMIT)) { setFileError('单张图片不能超过 60 MiB，且不能超过 2500 万像素。'); return; }
      if (candidates.some(item => item.size > REFERENCE_LIMIT) && !window.confirm('部分图片超过上游限制，将在本机自动压缩。透明图片会保留透明通道；处理结果会在页面预览。是否继续？')) return;
      setPreparing(true);
      const prepared: { name: string; data: string; blob: Blob }[] = [];
      try {
        for (const candidate of candidates) {
          const result = await prepareLocalImage(candidate, undefined, 'mask', () => window.confirm('仅压缩不足以达到限制，需要缩小图片尺寸。是否继续？'));
          if (result.image.changed && !window.confirm(`${candidate.name} 已在本机处理：${(candidate.size / 1048576).toFixed(2)} → ${(result.image.blob.size / 1048576).toFixed(2)} MiB，${result.image.width} × ${result.image.height}，${result.image.blob.type}。是否使用？`)) throw new Error('已取消使用处理后的图片。');
          prepared.push({ name: candidate.name, data: URL.createObjectURL(result.image.blob), blob: result.image.blob });
        }
        if (latest.current.id !== draft.id || request !== fileRequest.current) { prepared.forEach(item => URL.revokeObjectURL(item.data)); return; }
        const files = [...existing, ...prepared];
        onChange({ ...latest.current, fileName: files[0]?.name ?? '', fileData: files[0]?.data ?? '', files,
          ...(!existing.length ? { maskName: '', maskData: '', maskBlob: undefined, markupName: '', markupData: '', markupBlob: undefined } : {}) });
        setFileError('');
      } catch (error) {
        prepared.forEach(item => URL.revokeObjectURL(item.data));
        setFileError(error instanceof Error ? error.message : '图片处理失败。');
      }
      finally { setPreparing(false); }
      return;
    }
    if (candidates.some((item) => item.size > 2 * 1024 * 1024)) {
      setFileError('单个素材不能超过 2 MB，请压缩后重试。');
      return;
    }
    const media = file.accept.startsWith('audio/') ? 'audio/' : 'image/';
    if (candidates.some((item) => !item.type.startsWith(media))) {
      setFileError(media === 'audio/' ? '请选择支持的音频文件。' : '请选择图片文件。');
      return;
    }
    try {
      const data = await Promise.all(candidates.map((item) => new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(item);
      })));
      if (latest.current.id !== draft.id || request !== fileRequest.current) return;
      const files = [...existing, ...data.map((value, index) => ({ name: candidates[index].name, data: value }))];
      onChange({
        ...latest.current,
        fileName: files[0]?.name ?? '',
        fileData: files[0]?.data ?? '',
        files,
        ...(!existing.length ? { maskName: '', maskData: '', markupName: '', markupData: '' } : {}),
      });
      setFileError('');
    } catch {
      setFileError('读取素材失败，请重新选择。');
    }
  }
  async function chooseOverlay(kind: 'mask' | 'markup', selected?: File) {
    if (!mounted.current || !selected || !(kind === 'mask' ? mask : markup)) return;
    if (kind === 'mask' ? latest.current.markupData : latest.current.maskData) { setFileError('蒙版与标注层不能同时使用，请先移除另一项。'); return; }
    const requestRef = kind === 'mask' ? maskRequest : markupRequest;
    const request = ++requestRef.current;
    if (template.id === 'gpt-image-25-edit') {
      if (!latest.current.fileData) { setFileError('请先选择基准图。'); return; }
      if (selected.type !== 'image/png' || selected.size > IMAGE_INPUT_LIMIT) { setFileError('标注层必须是 60 MiB 以内的透明 PNG。'); return; }
      if (selected.size > OVERLAY_LIMIT && !window.confirm('标注层超过上游限制，将在本机无损压缩；如需缩放会另行确认。是否继续？')) return;
      setPreparing(true);
      try {
        const first = latest.current.files?.[0];
        const baseUrl = latest.current.fileData;
        const base: Blob = first?.blob ? first.blob : await fetch(baseUrl).then(response => response.blob());
        const result = await prepareLocalImage(base, selected, kind, () => window.confirm('需要同步缩放基准图和标注层才能满足大小限制，是否继续？'));
        if (!result.overlay) throw new Error('标注层处理失败。');
        if ((result.image.changed || result.overlay.changed) && !window.confirm(`本机处理结果：基准图 ${(base.size / 1048576).toFixed(2)} → ${(result.image.blob.size / 1048576).toFixed(2)} MiB；标注层 ${(selected.size / 1048576).toFixed(2)} → ${(result.overlay.blob.size / 1048576).toFixed(2)} MiB；尺寸 ${result.image.width} × ${result.image.height}。是否使用？`)) throw new Error('已取消使用处理结果。');
        if (latest.current.id !== draft.id || request !== requestRef.current || latest.current.fileData !== baseUrl ||
            (kind === 'mask' ? latest.current.markupData : latest.current.maskData)) return;
        const files = [...(latest.current.files ?? [{ name: latest.current.fileName, data: latest.current.fileData }])];
        const imageUrl = result.image.changed ? URL.createObjectURL(result.image.blob) : latest.current.fileData;
        files[0] = { name: latest.current.fileName, data: imageUrl, blob: result.image.blob };
        const overlayUrl = URL.createObjectURL(result.overlay.blob);
        onChange({ ...latest.current, files, fileData: imageUrl, ...(kind === 'mask'
          ? { maskName: selected.name, maskData: overlayUrl, maskBlob: result.overlay.blob }
          : { markupName: selected.name, markupData: overlayUrl, markupBlob: result.overlay.blob }) });
        setFileError('');
      } catch (error) { setFileError(error instanceof Error ? error.message : '图片处理失败。'); }
      finally { setPreparing(false); }
      return;
    }
    if (selected.size > 2 * 1024 * 1024 || selected.type !== 'image/png') {
      setFileError('蒙版和标注层必须是 2 MB 以内的 PNG 文件。');
      return;
    }
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(selected);
      });
      if (latest.current.id !== draft.id || request !== requestRef.current) return;
      if (kind === 'mask' ? latest.current.markupData : latest.current.maskData) { setFileError('蒙版与标注层不能同时使用。'); return; }
      onChange({ ...latest.current, ...(kind === 'mask' ? { maskName: selected.name, maskData: data } : { markupName: selected.name, markupData: data }) });
      setFileError('');
    } catch {
      setFileError('读取图片失败，请重新选择。');
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
      {preparing && <div className="pfx-alert" role="status">正在本机处理图片，请稍候；此过程不会上传原图。</div>}
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
                {template.id === 'gpt-image-25-edit' && <p>继续修改：在结果页选择“继续修改”，或把上一轮结果作为第一张基准图上传。绘制蒙版和标注层二选一。</p>}
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
                    multiple={file.multiple}
                    accept={file.accept}
                    disabled={preparing || busy}
                    hidden
                    onChange={(event) => {
                      void chooseFile(event.target.files?.[0], event.target.files ?? undefined);
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
                        {draft.files?.[0]?.blob && <small>{(draft.files[0].blob.size / 1048576).toFixed(2)} MiB · {draft.files[0].blob.type}</small>}
                        <button
                           className="pfx-icon-button"
                           aria-label="移除素材"
                           disabled={preparing || busy}
                          onClick={() => {
                            fileRequest.current++;
                            onChange({ ...draft, fileName: '', fileData: '', files: [], maskName: '', maskData: '', maskBlob: undefined, markupName: '', markupData: '', markupBlob: undefined });
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
                      disabled={preparing || busy}
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
                        if (!preparing && !busy) void chooseFile(event.dataTransfer.files[0], event.dataTransfer.files);
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
                         {template.id === 'gpt-image-25-edit' ? ' · 单张最大 60 MiB，2500 万像素；超限将本机压缩' : ' · 最大 2 MB'}
                      </small>
                    </button>
                  )}
                  {file.multiple && draft.fileData && <>
                    <p className="pfx-hint">第一张是基准图 / 上一轮结果，后续图片作为参考图；最多 {file.maxFiles ?? 16} 张。</p>
                    {(draft.files ?? []).slice(1).map((item, index) => <div className="pfx-file-preview" key={`${index}-${item.name}`}>
                      <img src={item.data} alt={`参考图 ${index + 2}`} /><div><span>参考图 {index + 2}：{item.name}</span><button type="button" className="pfx-icon-button" disabled={preparing || busy} onClick={() => { const files = (latest.current.files ?? []).filter((_, i) => i !== index + 1); onChange({ ...latest.current, files }); }} aria-label={`移除参考图 ${index + 2}`}><X size={14} /></button></div>
                    </div>)}
                    <button type="button" className="pfx-secondary" disabled={preparing || busy} onClick={() => fileInput.current?.click()}>添加参考图</button>
                  </>}
                </div>
              )}
              {(mask || markup) && <div className="pfx-annotation-guide">
                <strong>想局部调整？选择一种方式即可</strong>
                <p><b>蒙版 Mask：</b>涂满想修改的地方，适合替换或移除物体。</p>
                <p><b>标注 Markup：</b>画圈或箭头，再在提示词里解释标记，适合指明位置或方向。</p>
                <small>两者不能同时使用，也可以都不选；它们都是引导，不能保证其他区域完全不变。</small>
              </div>}
              {(['mask', 'markup'] as const).map(kind => {
                const spec = kind === 'mask' ? mask : markup;
                if (!spec) return null;
                const label = kind === 'mask' ? '蒙版' : '标注层';
                const data = kind === 'mask' ? draft.maskData : draft.markupData;
                const name = kind === 'mask' ? draft.maskName : draft.markupName;
                const ref = kind === 'mask' ? maskInput : markupInput;
                const other = kind === 'mask' ? draft.markupData : draft.maskData;
                return <div className="pfx-field" key={kind}>
                  <label htmlFor={`workflow-${kind}`}>{spec.label}<span>{spec.required ? '必填' : '选填'}</span></label>
                  <input id={`workflow-${kind}`} ref={ref} type="file" accept={spec.accept} hidden onChange={event => { void chooseOverlay(kind, event.target.files?.[0]); event.target.value = ''; }} />
                  {data ? <div className="pfx-file-preview"><img src={data} alt={name || label} /><div><span><Check size={14} />{name || label}</span><button type="button" className="pfx-icon-button" aria-label={`移除${label}`} onClick={() => { (kind === 'mask' ? maskRequest : markupRequest).current++; onChange({ ...latest.current, ...(kind === 'mask' ? { maskName: '', maskData: '', maskBlob: undefined } : { markupName: '', markupData: '', markupBlob: undefined }) }); setFileError(''); }}><X size={14} /></button></div></div> : <div className="pfx-paint-tools"><button type="button" className="pfx-secondary" disabled={!draft.fileData || !!other || preparing} onClick={() => setPaint(kind)}>在基准图上绘制{label}</button><button type="button" className="pfx-secondary" disabled={!!other || preparing} onClick={() => ref.current?.click()}>上传 PNG {label}</button></div>}
                      <small>{kind === 'mask' ? '绘制时涂红想修改的区域；上传 PNG 时，透明区域表示修改，不透明区域表示希望保留。例如涂满杯子，再写“把杯子换成花瓶”。' : '在图上画圈、箭头或线条，并在提示词中说明标记的含义；标注不是修改范围的硬边界。'}</small>
                  <small>{other ? `已选择${kind === 'mask' ? '标注层' : '蒙版'}；移除后可切换。` : '绘制前先选择基准图。上传的透明 PNG 必须与基准图尺寸一致；需要缩放时会同步处理并征求确认。'}</small>
                </div>;
              })}
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
              {options.length > 0 && (
                <div className="pfx-options">
                  {options.map((option) => {
                    const current = draft.params?.[option.key] ?? option.default ?? (option.kind === 'toggle' ? false : '');
                    const update = (value: string | number | boolean) =>
                      onChange({
                        ...draft,
                        params: { ...(draft.params ?? {}), [option.key]: value },
                      });
                    return (
                      <div className="pfx-field" key={option.key}>
                        <label htmlFor={`workflow-option-${option.key}`}>
                          {option.label}
                        </label>
                        {option.key === 'background' && template.id.startsWith('gpt-image-25-') ? (
                          <label className="pfx-toggle" htmlFor={`workflow-option-${option.key}`}><input id={`workflow-option-${option.key}`} type="checkbox" checked={current === 'transparent'} onChange={event => update(event.target.checked ? 'transparent' : 'auto')} /><span>透明背景（PNG）：{current === 'transparent' ? '开启' : '关闭'}</span></label>
                        ) : option.kind === 'select' ? (
                          <select
                            id={`workflow-option-${option.key}`}
                            value={String(current)}
                            onChange={(event) => update(event.target.value)}
                          >
                            {(option.choices ?? []).map((choice) => (
                              <option key={choice.value} value={choice.value}>
                                {choice.label}
                              </option>
                            ))}
                          </select>
                        ) : option.kind === 'toggle' ? (
                          <label className="pfx-toggle" htmlFor={`workflow-option-${option.key}`}>
                            <input
                              id={`workflow-option-${option.key}`}
                              type="checkbox"
                              checked={Boolean(current)}
                              onChange={(event) => update(event.target.checked)}
                            />
                            <span>{current ? '开启' : '关闭'}</span>
                          </label>
                        ) : (
                          <input
                            id={`workflow-option-${option.key}`}
                            type={option.kind === 'number' ? 'number' : 'text'}
                            value={String(current)}
                            onChange={(event) =>
                              update(option.kind === 'number' ? Number(event.target.value) : event.target.value)
                            }
                          />
                        )}
                      </div>
                    );
                  })}
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
                  <button className="pfx-secondary" onClick={onSave} disabled={preparing}>
                    <Save size={14} />
                    保存草稿
                  </button>
                  <button className="pfx-primary" onClick={onSubmit} disabled={busy || preparing}>
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
                {template.id === 'gpt-image-25-edit' && <p>在 ComfyUI 中请选择基准图；可选蒙版的 MASK 输出接到 mask，或将透明标注图的合并输出接到 markup，二者不要同时连接。保存图片节点已连接。</p>}
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
          <WorkflowExamples value={template.examples} onUsePrompt={prompt ? (value) => {
            if (latest.current.prompt.trim() && !window.confirm('使用示例提示词会替换当前文字，确定继续吗？')) return;
            onChange({ ...latest.current, prompt: value });
            onTab('inputs');
          } : undefined} />
        </section>
        <aside className="pfx-workflow-aside">
          <section className="pfx-card" aria-label="工作流价格">
            <h2>价格参考</h2>
            <strong>
              {priceLoading
                ? '正在获取价格…'
                : price === null
                  ? imagePricing ? '按实际参数计费' : '价格暂不可用'
                  : `${formatWorkflowUsd(price)} / 次`}
            </strong>
            <p className="pfx-hint">
              {imagePricing
                ? '费用取决于模型、尺寸、质量、参考图和输出数量；运行前将显示确认报价。'
                : template.source === 'personal'
                ? '个人工作流的价格取决于实际节点和输入，暂无法在此预估。'
                : '按当前 sub2api 扣费单元换算的模板能力参考价，不代表完整节点图总价；请以运行前确认的完整工作流报价及实际账单为准。'}
            </p>
          </section>
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
                  {template.transport === 'bridge' ? '该表单通过 Bridge 直接运行；' : '完整工作流由 Worker ComfyUI 执行；'}提交前会确认报价，关闭客户端不会取消服务端任务。
                </p>
              </div>
            </section>
          )}
        </aside>
      </div>
      {paint && draft.fileData && <ImageAnnotationEditor key={`${draft.id}-${paint}`} image={draft.fileData} kind={paint} outputSize={template.id === 'gpt-image-25-edit' ? undefined : overlayDimensions} maxBytes={template.id === 'gpt-image-25-edit' ? undefined : 2 * 1024 * 1024} onCancel={() => setPaint(null)} onSave={data => {
        if (template.id === 'gpt-image-25-edit') {
          const kind = paint;
          setPaint(null);
          void fetch(data).then(response => response.blob()).then(blob => chooseOverlay(kind, new File([blob], kind === 'mask' ? '绘制的蒙版.png' : '绘制的标注层.png', { type: 'image/png' })));
          return;
        }
        if (latest.current.id === draft.id && !(paint === 'mask' ? latest.current.markupData : latest.current.maskData)) {
          onChange({ ...latest.current, ...(paint === 'mask' ? { maskName: '绘制的蒙版.png', maskData: data } : { markupName: '绘制的标注层.png', markupData: data }) });
          setFileError('');
        }
        setPaint(null);
      }} />}
    </div>
  );
}
