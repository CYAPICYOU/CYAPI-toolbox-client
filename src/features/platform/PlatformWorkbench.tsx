import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ExternalLink,
  FileJson,
  KeyRound,
  LoaderCircle,
  Plus,
  Trash2,
  Upload,
  Workflow,
} from 'lucide-react';
import {
  cancelWorkflowTask,
  createWorkflowDraft,
  downloadWorkflowArtifact,
  editorToken,
  getActivation,
  getWorkflowCatalog,
  openEditorWindow,
  quoteBridgeDraft,
  quoteWorkflowDraft,
  runBridgeDraft,
  runWorkflowDraft,
  saveWorkflowDraft,
  uploadWorkflowAsset,
  uploadPreparedWorkflowImage,
  PlatformError,
  removeUnsubmittedWorkflowDraft,
  removeWorkflowUpload,
  type WorkflowTask,
} from './api';
import { addKey, loadKeys, maskKey, saveKeys, type StoredKeyState } from './keyStore';
import { Modal } from '../../components/Primitives';
import {
  loadDraftState,
  saveDraftState,
  validateDraft,
  storeBlobDraft,
  loadBlobDraft,
  deleteBlobDraft,
  type LocalWorkflowDraft,
  type WorkflowDraftState,
} from './draftStore';
import {
  importWorkflow,
  loadPersonalWorkflows,
  savePersonalWorkflows,
  workflowDocument,
  type WorkflowCatalog,
  type WorkflowTemplate,
} from './library';
import { WorkflowLibrary } from './WorkflowLibrary';
import { WorkflowPage } from './WorkflowPage';
import { createEditorLauncher, editorLaunchPending, type EditorLaunchState } from './editorLaunch';
import type { EditorLaunchNoticeState } from './EditorLaunchNotice';
import { logWorkflowLaunch } from '../../lib/api/diagnostics';
import { useWorkflowTasks } from './useWorkflowTasks';
import { WorkflowTaskQueue } from './WorkflowTaskQueue';
import { WorkflowResults } from './WorkflowResults';
import { errorText } from './taskState';
import { formatImagePriceDetails, formatVideoPriceDetails, formatWorkflowUsd } from './workflowPrice';
import { OVERLAY_LIMIT, REFERENCE_LIMIT, prepareLocalImage } from './imagePreparation';
import './platform.css';

const viewContent = {
  library: {
    title: '工作流库',
    description: '',
  },
  drafts: { title: '草稿', description: '保存并继续编辑尚未提交的任务' },
  queue: { title: '任务队列', description: '查看任务的排队和运行进度' },
  results: { title: '结果', description: '查看和下载任务产物' },
} as const;

export function PlatformWorkbench({
  visible,
  view,
  onViewChange,
  onEditorLaunchChange,
}: {
  visible: boolean;
  view: keyof typeof viewContent;
  onViewChange: (view: keyof typeof viewContent) => void;
  onEditorLaunchChange: (notice: EditorLaunchNoticeState | null) => void;
}) {
  const [keys, setKeys] = useState<StoredKeyState>(() => loadKeys());
  const [draft, setDraft] = useState('');
  const [keyDialog, setKeyDialog] = useState(false);
  const [keyNotice, setKeyNotice] = useState('');
  const [keyError, setKeyError] = useState('');
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [retry, setRetry] = useState(0);
  const [draftState, setDraftState] = useState<WorkflowDraftState>(loadDraftState);
  const [editor, setEditor] = useState<LocalWorkflowDraft | null>(null);
  const [draftError, setDraftError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [personal, setPersonal] = useState(loadPersonalWorkflows);
  const [editorTab, setEditorTab] = useState<'inputs' | 'flow'>('inputs');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [baseId, setBaseId] = useState('');
  const [editorLaunch, setEditorLaunch] = useState<EditorLaunchState | null>(null);
  const [editorLauncher] = useState(() =>
    createEditorLauncher({
      token: editorToken,
      open: openEditorWindow,
      onChange: setEditorLaunch,
      onEvent: logWorkflowLaunch,
    }),
  );
  const editorStarting = editorLaunchPending(editorLaunch);
  const importFile = useRef<HTMLInputElement>(null);
  const activeKey = keys.keys.find((entry) => entry.id === keys.activeId)?.key ?? '';
  const {
    tasks,
    error: taskError,
    loading: tasksLoading,
    refresh: loadTasks,
  } = useWorkflowTasks(activeKey, visible && (view === 'queue' || view === 'results'));
  const taskIdentity = useRef('');

  useEffect(() => {
    taskIdentity.current = activeKey;
    return () => {
      taskIdentity.current = '';
    };
  }, [activeKey]);

  useEffect(() => {
    onEditorLaunchChange(
      editorLaunch
        ? {
            state: editorLaunch,
            onRetry: () => void editorLauncher.retry(),
            onDismiss: () => editorLauncher.reset(),
          }
        : null,
    );
  }, [editorLaunch, editorLauncher, onEditorLaunchChange]);
  useEffect(() => () => onEditorLaunchChange(null), [onEditorLaunchChange]);

  // Switching identity invalidates an outstanding launch; a late response must
  // not open the previous user's editor. Navigation alone does not cancel it.
  useEffect(() => {
    editorLauncher.reset();
    return () => editorLauncher.reset();
  }, [activeKey, editorLauncher]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setCatalogLoading(true);
    setCatalogError('');
    getWorkflowCatalog()
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch((cause) => {
        if (!cancelled) setCatalogError(errorText(cause));
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, catalogRetry]);

  useEffect(() => {
    setEditor(null);
    setCreating(false);
    setDraftError('');
    // A Key error from another page must not follow the user back to the
    // public catalog.
    setError('');
  }, [view]);

  function persistDrafts(next: WorkflowDraftState) {
    try {
      saveDraftState(next);
      setDraftState(next);
      setDraftError('');
      return true;
    } catch (cause) {
      setDraftError(errorText(cause));
      return false;
    }
  }
  function openWorkflow(template: WorkflowTemplate, tab: 'inputs' | 'flow' = 'inputs') {
    setDraftError('');
    setCreating(false);
    setEditorTab(tab);
    setEditor({
      id: crypto.randomUUID(),
      kind: template.kind,
      title: template.title,
      template,
      prompt: '',
      fileName: '',
      fileData: '',
      files: [],
      maskName: '',
      maskData: '',
      params: {},
      updatedAt: Date.now(),
    });
  }
  async function openDraft(item: LocalWorkflowDraft) {
    const saved = item.template ?? catalog?.items.find((entry) => entry.kind === item.kind);
    const current = saved?.source === 'server' ? catalog?.items.find((entry) => entry.id === saved.id) : undefined;
    // Keep the saved execution configuration, but show the latest public examples.
    const template = saved && current ? { ...saved, examples: current.examples } : saved;
    if (!template) {
      setDraftError('暂时无法找到这份草稿的工作流，请重新加载目录后再试。');
      return;
    }
    setDraftError('');
    setEditorTab('inputs');
    try { setEditor({ ...await loadBlobDraft(item), template }); }
    catch (cause) { setDraftError(errorText(cause)); }
  }
  function backToLibrary() {
    if (
      editor &&
      (editor.prompt || editor.fileData || editor.maskData || editor.markupData || editor.files?.length) &&
      !window.confirm('返回后将离开当前编辑。请确认已保存需要保留的草稿。')
    )
      return;
    setEditor(null);
    setCreating(false);
    setDraftError('');
    onViewChange('library');
  }
  async function launchEditor(template: WorkflowTemplate, prompt = '') {
    if (!requireKey()) return;
    if (editorStarting) return;
    try {
      const document = workflowDocument(template, prompt);
      if (!document) throw new Error('此工作流的节点流程尚未发布。');
      await editorLauncher.launch(activeKey, template.title, document);
    } catch (cause) {
      setError(errorText(cause));
    }
  }
  async function runImport(file: File) {
    if (file.size > 2 * 1024 * 1024) {
      setError('工作流文件不能超过 2 MB。');
      return;
    }
    await run(async () => {
      const item = importWorkflow(await file.text(), file.name);
      const next = [item, ...personal];
      savePersonalWorkflows(next);
      setPersonal(next);
      setCategory('personal');
      setQuery('');
      setCreating(false);
      openWorkflow(item, 'flow');
    });
  }
  async function createWorkflow() {
    if (editorStarting) return;
    const title = newName.trim();
    if (!title) {
      setError('请填写工作流名称。');
      return;
    }
    if (!requireKey()) return;
    await run(async () => {
      const base = catalog?.items.find((item) => item.id === baseId);
      if (baseId && !base) throw new Error('所选模板已更新，请重新选择。');
      const item: WorkflowTemplate = base
        ? { ...structuredClone(base), id: crypto.randomUUID(), title, source: 'personal' }
        : {
            id: crypto.randomUUID(),
            title,
            description: '使用 ComfyUI 节点构建自己的创作流程。',
            category: 'personal',
            version: '1.0.0',
            source: 'personal',
            kind: 'text',
            input: '在 ComfyUI 中配置节点输入',
            output: '由工作流节点决定',
            steps: ['添加与连接节点', '配置输入参数', '运行并查看结果'],
            form: {},
            execution: 'preview',
            workflow: {
              last_node_id: 0,
              last_link_id: 0,
              nodes: [],
              links: [],
              groups: [],
              config: {},
              extra: {},
              version: 0.4,
            },
          };
      const next = [item, ...personal];
      savePersonalWorkflows(next);
      setPersonal(next);
      setCategory('personal');
      setQuery('');
      openWorkflow(item, base ? 'inputs' : 'flow');
      // Saving is local and immediate; the long launch has its own state and
      // never keeps the entire workbench busy.
      void launchEditor(item);
    });
  }
  async function saveDraft() {
    if (!editor) return;
    const blobDraft = Boolean(editor.files?.some(file => file.blob) || editor.maskBlob || editor.markupBlob);
    const blobDraftId = blobDraft ? crypto.randomUUID() : undefined;
    try {
      if (blobDraftId) await storeBlobDraft(editor, blobDraftId);
    } catch {
      setDraftError('本地图片存储空间不足或不可用，草稿未保存。');
      return;
    }
    if (
      persistDrafts({
        drafts: [
          { ...editor, blobDraft, blobDraftId, updatedAt: Date.now() },
          ...draftState.drafts.filter((item) => item.id !== editor.id),
        ],
      })
    ) {
      if (editor.blobDraft) void deleteBlobDraft(editor.blobDraftId ?? editor.id).catch(() => {});
      setEditor(null);
      onViewChange('drafts');
    } else if (blobDraftId) void deleteBlobDraft(blobDraftId).catch(() => {});
  }
  async function submitRun() {
    const item = editor;
    if (!item?.template || submitting) return;
    const template = item.template;
    const validation = validateDraft(item);
    if (validation) {
      setDraftError(validation);
      return;
    }
    if (!requireKey()) return;
    if (template.source === 'personal') {
      setDraftError('个人工作流暂不支持从此处直接运行，请打开 ComfyUI 编辑器运行。');
      return;
    }
    setSubmitting(true);
    setDraftError('');
    let createdDraftId: string | undefined;
    let submitted = false;
    const uploadedIds: string[] = [];
    try {
      // The server owns the template graph: create a draft from the published
      // template, fill the prompt, quote, then submit the full graph to ComfyUI.
      const draft = await createWorkflowDraft(activeKey, template.id);
      createdDraftId = draft.id;
      const localFiles = item.files?.length
        ? item.files
        : item.fileData
          ? [{ name: item.fileName, data: item.fileData }]
          : [];
      const references: string[] = [];
      let mask: string | null = null, markup: string | null = null;
      if (template.id === 'gpt-image-25-edit') {
        const overlayKind = item.maskData ? 'mask' : item.markupData ? 'markup' : null;
        const layer = overlayKind ? (overlayKind === 'mask' ? item.maskBlob : item.markupBlob)
          ?? await fetch((overlayKind === 'mask' ? item.maskData : item.markupData)!).then(response => response.blob()) : undefined;
        for (let index = 0; index < localFiles.length && index < 16; index++) {
          if (taskIdentity.current !== activeKey) throw new Error('Key 已更换，请重新操作');
          const file = localFiles[index];
          const original = 'blob' in file && file.blob instanceof Blob ? file.blob : await fetch(file.data).then(response => response.blob());
          const paired = index === 0 ? layer : undefined;
          if ((original.size > REFERENCE_LIMIT || (paired && paired.size > OVERLAY_LIMIT)) &&
              !window.confirm(`${file.name} 需要在本机压缩后上传。透明图层保持 PNG；是否继续？`)) return;
          const prepared = await prepareLocalImage(original, paired, overlayKind ?? 'mask', () =>
            window.confirm(paired ? '需要同步缩放基准图和标注层才能满足限制，是否继续？' : '需要缩小图片才能满足限制，是否继续？'));
          if ((prepared.image.changed || prepared.overlay?.changed) && !window.confirm(
            `本机处理：${file.name} ${(original.size / 1048576).toFixed(2)} → ${(prepared.image.blob.size / 1048576).toFixed(2)} MiB，${prepared.image.width} × ${prepared.image.height}，${prepared.image.blob.type}。${prepared.overlay ? `\n标注层 ${(paired!.size / 1048576).toFixed(2)} → ${(prepared.overlay.blob.size / 1048576).toFixed(2)} MiB。` : ''}\n是否上传？`)) return;
          let uploaded;
          let allowCompression = false, allowResize = false;
          for (;;) {
            try {
              uploaded = await uploadPreparedWorkflowImage(activeKey, prepared.image.blob, {
                kind: prepared.overlay ? overlayKind! : 'image', overlay: prepared.overlay?.blob, allowCompression, allowResize,
              });
              break;
            } catch (cause) {
              if (!(cause instanceof PlatformError)) throw cause;
              if (!allowResize && /缩放/.test(cause.message) && [400, 409].includes(cause.status)) {
                if (!window.confirm(`${cause.message}\n服务端需要${prepared.overlay ? '同步' : ''}缩放，是否允许？`)) throw cause;
                allowResize = true;
                allowCompression = true;
              } else if (!allowCompression && cause.status === 409 && /压缩/.test(cause.message)) {
                if (!window.confirm(`${cause.message}\n服务端需要再次压缩，是否允许？`)) throw cause;
                allowCompression = true;
              } else throw cause;
            }
          }
          references.push(uploaded.image.id);
          uploadedIds.push(uploaded.image.id);
          if (uploaded.overlay) uploadedIds.push(uploaded.overlay.id);
          if (uploaded.overlay && overlayKind === 'mask') mask = uploaded.overlay.id;
          if (uploaded.overlay && overlayKind === 'markup') markup = uploaded.overlay.id;
          if ((uploaded.image.changed || uploaded.overlay?.changed) && !window.confirm(`服务端兜底处理结果：${uploaded.image.width} × ${uploaded.image.height}，基准图 ${uploaded.image.bytes} 字节${uploaded.overlay ? `，标注层 ${uploaded.overlay.bytes} 字节` : ''}。是否使用处理后的素材？`)) return;
        }
      } else {
        for (const file of localFiles.slice(0, 16)) {
          const id = (await uploadWorkflowAsset(activeKey, file.data)).id;
          references.push(id);
          uploadedIds.push(id);
        }
        mask = item.maskData ? (await uploadWorkflowAsset(activeKey, item.maskData, 'mask')).id : null;
        if (mask) uploadedIds.push(mask);
        markup = item.markupData ? (await uploadWorkflowAsset(activeKey, item.markupData, 'markup')).id : null;
        if (markup) uploadedIds.push(markup);
      }
      const saved = await saveWorkflowDraft(activeKey, draft.id, {
        revision: draft.revision,
        description: item.prompt.trim(),
        references,
        mask,
        markup,
        params: item.params ?? {},
      });
      const direct = template.transport === 'bridge';
      const quote = direct
        ? await quoteBridgeDraft(activeKey, draft.id)
        : await quoteWorkflowDraft(activeKey, draft.id);
      const priceDetails = direct
        ? formatImagePriceDetails(quote.bridgeQuote?.priceDetails) || formatVideoPriceDetails(quote.bridgeQuote?.priceDetails)
        : quote.items.map((item) => {
            const detail = formatImagePriceDetails(item.priceDetails) || formatVideoPriceDetails(item.priceDetails);
            return detail ? `${item.title ?? item.classType}：${detail}` : '';
          }).filter(Boolean).join('\n');
      if (taskIdentity.current !== activeKey) throw new Error('Key 已更换，请重新操作');
      if (
        !window.confirm(
          direct
            ? `将由 CYAPI Bridge 直接调用真实 AI。\nAI 节点预估费用：${formatWorkflowUsd(quote.amount)}${priceDetails ? `\n${priceDetails}` : ''}\n节点实际费用受确认报价上限约束。是否继续？`
            : `将由 Worker ComfyUI 执行完整工作流。\nAI 节点预估费用：${formatWorkflowUsd(quote.amount)}\n工作流执行费：${formatWorkflowUsd(quote.runFee ?? 0)}${priceDetails ? `\n${priceDetails}` : ''}\n节点实际费用受确认报价上限约束。是否继续？`,
        )
      )
        return;
      try {
        // Once submission is attempted its outcome may be unknown; never
        // delete the draft or inputs until the original task is reconciled.
        submitted = true;
        if (direct) await runBridgeDraft(activeKey, draft.id, saved.revision, quote);
        else await runWorkflowDraft(activeKey, draft.id, saved.revision, quote);
      } catch (cause) {
        throw new Error(
          `${errorText(cause)}。提交状态可能未知，请先检查任务列表和工作区队列，勿重复运行以免重复扣费。`,
        );
      }
      if (taskIdentity.current !== activeKey) return;
      if (draftState.drafts.some((entry) => entry.id === item.id) &&
          persistDrafts({ drafts: draftState.drafts.filter((entry) => entry.id !== item.id) })) {
        if (item.blobDraft) void deleteBlobDraft(item.blobDraftId ?? item.id).catch(() => {});
      }
      setEditor(null);
      onViewChange('queue');
      await loadTasks();
    } catch (cause) {
      if (taskIdentity.current === activeKey) setDraftError(errorText(cause));
    } finally {
      if (!submitted && createdDraftId) {
        try {
          await removeUnsubmittedWorkflowDraft(activeKey, createdDraftId);
          await Promise.allSettled(uploadedIds.map(id => removeWorkflowUpload(activeKey, id)));
        } catch { /* Preserve referenced assets if draft removal is uncertain. */ }
      }
      setSubmitting(false);
    }
  }
  async function cancelTask(task: WorkflowTask) {
    if (!requireKey()) return;
    await run(async () => {
      await cancelWorkflowTask(activeKey, task.id);
      await loadTasks();
    });
  }
  async function continueImage(output: WorkflowTask['outputs'][number]) {
    const key = activeKey;
    const template = catalog?.items.find((item) => item.id === 'gpt-image-25-edit');
    if (!template) {
      setError('GPT Image 2.5 改图模板当前不可用，请先启用 OpenAI Images Provider。');
      return;
    }
    if (!requireKey()) return;
    await run(async () => {
      const objectUrl = await downloadWorkflowArtifact(key, output.download);
      try {
        const blob = await fetch(objectUrl).then((response) => response.blob());
        const data = URL.createObjectURL(blob);
        const name = output.title || '上一轮生成结果.png';
        if (taskIdentity.current !== key) { URL.revokeObjectURL(data); return; }
        setEditor({
          id: crypto.randomUUID(),
          kind: template.kind,
          title: template.title,
          template,
          prompt: '',
          fileName: name,
          fileData: data,
          files: [{ name, data, blob }],
          params: {},
          maskName: '',
          maskData: '',
          updatedAt: Date.now(),
        });
        setEditorTab('inputs');
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    });
  }

  useEffect(() => {
    if (!visible) {
      setKeyDialog(false);
      setDraft('');
      setKeyError('');
      setKeyNotice('');
    }
  }, [visible]);

  // Browsing recommended workflows is public, so a saved Key is only verified
  // when a page actually needs the hosted service.
  useEffect(() => {
    if (!visible || !activeKey || view === 'library') return;
    let cancelled = false;
    setConnected(false);
    setError('');
    (async () => {
      try {
        await getActivation(activeKey);
        if (!cancelled) setConnected(true);
      } catch (cause) {
        if (!cancelled) setError(errorText(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeKey, visible, retry, view]);

  function activateKey() {
    try {
      const key = addKey(keys.keys, `Key ${keys.keys.length + 1}`, draft.trim());
      const next = keys.keys.some((item) => item.id === key.id) ? keys.keys : [...keys.keys, key];
      saveKeys(next, key.id);
      setKeys({ keys: next, activeId: key.id });
      setDraft('');
      setKeyError('');
      setKeyNotice('已保存并切换当前 Key。');
      setError('');
    } catch (cause) {
      setKeyError(errorText(cause));
    }
  }
  function requireKey() {
    if (activeKey) return true;
    setKeyError('');
    setKeyNotice('此操作需要配置并激活 Key，请先添加 Key。');
    setKeyDialog(true);
    return false;
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pfx">
      <header className="pfx-top">
        <div className="pfx-heading">
          <h1>{viewContent[view].title}</h1>
          {viewContent[view].description && <p>{viewContent[view].description}</p>}
        </div>
        <div className="pfx-top-actions">
          {view === 'library' && !editor && !creating && (
            <>
              <button className="pfx-secondary" onClick={() => importFile.current?.click()}>
                <Upload size={14} />
                导入
              </button>
              <button
                className="pfx-primary"
                onClick={() => {
                  setCreating(true);
                  setNewName('');
                  setBaseId('');
                  setError('');
                }}
              >
                <Plus size={15} />
                新建工作流
              </button>
            </>
          )}
          <button
            type="button"
            className="pfx-ghost pfx-key-manager"
            onClick={() => {
              setKeyNotice('');
              setKeyError('');
              setKeyDialog(true);
            }}
          >
            <KeyRound size={15} />
            Key 管理 <span>{activeKey ? '已配置' : '未配置'}</span>
          </button>
        </div>
      </header>
      <div className="pfx-body">
        {error && (
          <div className="pfx-alert" role="alert">
            <AlertCircle size={16} />
            {error}
            <button className="pfx-ghost" onClick={() => setRetry((n) => n + 1)}>
              重试
            </button>
          </div>
        )}
        {editor?.template ? (
          <WorkflowPage
            key={editor.id}
            draft={editor}
            template={editor.template}
            tab={editorTab}
            onTab={setEditorTab}
            onChange={setEditor}
            onBack={backToLibrary}
            onSave={saveDraft}
            onSubmit={submitRun}
            onEditor={() => void launchEditor(editor.template!, editor.prompt)}
            error={draftError}
            busy={busy || submitting}
            editorStarting={editorStarting}
          />
        ) : creating ? (
          <div className="pfx-create-page">
            <button className="pfx-back" onClick={backToLibrary}>
              <ArrowLeft size={16} />
              返回工作流库
            </button>
            <div className="pfx-panel-heading">
              <h1>新建工作流</h1>
              <p>从空白节点画布开始，也可以基于已有模板继续创作。</p>
            </div>
            <section className="pfx-input-panel">
              <div className="pfx-field">
                <label htmlFor="new-workflow-name">工作流名称</label>
                <input
                  id="new-workflow-name"
                  maxLength={80}
                  autoFocus
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="为你的工作流起个名字"
                />
              </div>
              <div className="pfx-field">
                <label>选择起点</label>
                <div className="pfx-create-options">
                  <button className={baseId === '' ? 'selected' : ''} onClick={() => setBaseId('')}>
                    <Workflow size={23} />
                    <strong>空白工作流</strong>
                    <small>在 ComfyUI 中自由添加与连接节点</small>
                  </button>
                  {catalog?.items
                    .filter((item) => item.apiGraph || item.workflow)
                    .map((item) => (
                      <button
                        key={item.id}
                        className={baseId === item.id ? 'selected' : ''}
                        onClick={() => setBaseId(item.id)}
                      >
                        <FileJson size={23} />
                        <strong>{item.title}</strong>
                        <small>{item.description}</small>
                      </button>
                    ))}
                </div>
              </div>
              <p className="pfx-hint">
                创建后将打开 ComfyUI 编辑器。编辑完成后，请在编辑器中保存或导出工作流。
              </p>
              <div className="pfx-input-footer">
                <button className="pfx-secondary" onClick={() => importFile.current?.click()}>
                  <Upload size={14} />
                  已有 JSON？直接导入
                </button>
                <button
                  className="pfx-primary"
                  disabled={busy || editorStarting || !newName.trim()}
                  onClick={() => void createWorkflow()}
                >
                  {editorStarting ? (
                    <LoaderCircle size={14} className="pfx-spin" />
                  ) : (
                    <ExternalLink size={14} />
                  )}
                  {editorStarting ? 'ComfyUI 正在后台启动…' : '创建并打开 ComfyUI 编辑器'}
                </button>
              </div>
            </section>
          </div>
        ) : view === 'library' ? (
          <WorkflowLibrary
            catalog={catalog}
            personal={personal}
            category={category}
            query={query}
            onCategory={setCategory}
            onQuery={setQuery}
            onOpen={openWorkflow}
            loading={catalogLoading}
            error={catalogError}
            onRetry={() => setCatalogRetry((n) => n + 1)}
          />
        ) : (
          <>
            {draftError && (
              <div className="pfx-alert" role="alert">
                {draftError}
              </div>
            )}
            {(view === 'queue' || view === 'results') && taskError && (
              <div className="pfx-alert" role="alert">
                <AlertCircle size={16} />
                {taskError}
                <button className="pfx-ghost" onClick={() => void loadTasks()}>
                  重试
                </button>
              </div>
            )}
            {view === 'drafts' ? (
              draftState.drafts.length ? (
                draftState.drafts.map((item) => (
                  <article key={item.id} className="pfx-card pfx-task-row">
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.prompt || item.fileName || '未填写内容'}</p>
                      <small>更新于 {new Date(item.updatedAt).toLocaleString()}</small>
                    </div>
                    <div className="pfx-task-actions">
                      <button className="pfx-secondary" onClick={() => openDraft(item)}>
                        继续编辑
                      </button>
                      <button
                        className="pfx-ghost"
                        onClick={() => {
                          if (window.confirm('删除这份草稿？') && persistDrafts({
                              drafts: draftState.drafts.filter((entry) => entry.id !== item.id),
                            }) && item.blobDraft) void deleteBlobDraft(item.blobDraftId ?? item.id).catch(() => {});
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <div className="pfx-card pfx-empty">还没有草稿，前往工作流库选择一个工作流。</div>
              )
            ) : null}
            {(view === 'queue' || view === 'results') && tasksLoading && !tasks.length ? (
              <div className="pfx-loading" role="status">
                <LoaderCircle size={14} className="pfx-spin" />
                正在加载任务…
              </div>
            ) : view === 'queue' ? (
              <WorkflowTaskQueue
                key={activeKey}
                tasks={tasks}
                activeKey={activeKey}
                visible={visible}
                busy={busy}
                onCancel={(task) => void cancelTask(task)}
                onResults={() => onViewChange('results')}
              />
            ) : view === 'results' ? (
              <WorkflowResults
                key={activeKey}
                tasks={tasks}
                activeKey={activeKey}
                visible={visible}
                onContinue={(output) => void continueImage(output)}
              />
            ) : null}
          </>
        )}
        {activeKey && view !== 'library' && !connected && !error && (
          <span className="pfx-connecting">
            <LoaderCircle size={14} className="pfx-spin" />
            正在准备服务…
          </span>
        )}
      </div>
      <input
        ref={importFile}
        type="file"
        accept="application/json,.json"
        hidden
        aria-label="导入工作流文件"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void runImport(file);
        }}
      />
      {keyDialog && (
        <Modal
          title="Key 管理"
          onClose={() => {
            setKeyDialog(false);
            setDraft('');
            setKeyError('');
            setKeyNotice('');
          }}
          className="pfx-key-dialog"
        >
          <div className="pfx-key-dialog-body">
            <p className="pfx-key-description">
              可保存多个工作流 Key，同一时间只能使用一个。Key 保存在本机。
            </p>
            {keyNotice && (
              <p className="pfx-key-notice" role="status">
                {keyNotice}
              </p>
            )}
            {keyError && (
              <p className="pfx-key-error" role="alert">
                {keyError}
              </p>
            )}
            {keys.keys.length > 0 ? (
              <ul className="pfx-key-list">
                {keys.keys.map((entry) => (
                  <li key={entry.id}>
                    <div className="pfx-key-details">
                      <strong>{entry.name}</strong>
                      <code>{maskKey(entry.key)}</code>
                    </div>
                    {entry.id === keys.activeId ? (
                      <span className="pfx-key-active">当前使用</span>
                    ) : (
                      <button
                        type="button"
                        className="pfx-secondary"
                        onClick={() => {
                          saveKeys(keys.keys, entry.id);
                          setKeys({ ...keys, activeId: entry.id });
                          setError('');
                          setKeyNotice('已切换当前 Key。');
                        }}
                      >
                        设为当前
                      </button>
                    )}
                    <button
                      type="button"
                      className="pfx-icon-button"
                      aria-label={`移除 ${entry.name} ${maskKey(entry.key)}`}
                      onClick={() => {
                        if (!window.confirm(`确定移除 ${entry.name}（${maskKey(entry.key)}）？`))
                          return;
                        const remaining = keys.keys.filter((key) => key.id !== entry.id);
                        const activeId =
                          keys.activeId === entry.id ? (remaining[0]?.id ?? null) : keys.activeId;
                        saveKeys(remaining, activeId);
                        setKeys({ keys: remaining, activeId });
                        setError('');
                        setKeyNotice(
                          activeId
                            ? 'Key 已移除。'
                            : 'Key 已移除，请添加 Key 后使用需要授权的功能。',
                        );
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pfx-key-empty">还没有添加 Key，浏览工作流无需配置。</p>
            )}
            <form
              className="pfx-form pfx-key-form"
              onSubmit={(event) => {
                event.preventDefault();
                activateKey();
              }}
            >
              <label htmlFor="workflow-key-input">添加 Key</label>
              <div className="pfx-key-input-row">
                <input
                  id="workflow-key-input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft}
                  placeholder="输入 CYAPI API Key"
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit" className="pfx-primary">
                  <Plus size={15} />
                  添加并使用
                </button>
              </div>
            </form>
          </div>
        </Modal>
      )}
    </section>
  );
}
