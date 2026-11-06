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
  editorToken,
  getActivation,
  getWorkflowCatalog,
  openEditorWindow,
  quoteWorkflowDraft,
  runWorkflowDraft,
  saveWorkflowDraft,
  type WorkflowTask,
} from './api';
import { addKey, loadKeys, maskKey, saveKeys, type StoredKeyState } from './keyStore';
import { Modal } from '../../components/Primitives';
import {
  loadDraftState,
  saveDraftState,
  validateDraft,
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
import { formatWorkflowUsd } from './workflowPrice';
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
      updatedAt: Date.now(),
    });
  }
  function openDraft(item: LocalWorkflowDraft) {
    const template = item.template ?? catalog?.items.find((entry) => entry.kind === item.kind);
    if (!template) {
      setDraftError('暂时无法找到这份草稿的工作流，请重新加载目录后再试。');
      return;
    }
    setDraftError('');
    setEditorTab('inputs');
    setEditor({ ...item, template });
  }
  function backToLibrary() {
    if (
      editor &&
      (editor.prompt || editor.fileData) &&
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
  function saveDraft() {
    if (!editor) return;
    if (
      persistDrafts({
        drafts: [
          { ...editor, updatedAt: Date.now() },
          ...draftState.drafts.filter((item) => item.id !== editor.id),
        ],
      })
    ) {
      setEditor(null);
      onViewChange('drafts');
    }
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
    if (item.fileData) {
      setDraftError('完整工作流暂不支持从此处上传素材，请在 ComfyUI 编辑器中添加素材并运行。');
      return;
    }
    if (template.source === 'personal') {
      setDraftError('个人工作流暂不支持从此处直接运行，请打开 ComfyUI 编辑器运行。');
      return;
    }
    setSubmitting(true);
    setDraftError('');
    try {
      // The server owns the template graph: create a draft from the published
      // template, fill the prompt, quote, then submit the full graph to ComfyUI.
      const draft = await createWorkflowDraft(activeKey, template.id);
      const saved = await saveWorkflowDraft(activeKey, draft.id, {
        revision: draft.revision,
        description: item.prompt.trim(),
      });
      const quote = await quoteWorkflowDraft(activeKey, draft.id);
      if (taskIdentity.current !== activeKey) throw new Error('Key 已更换，请重新操作');
      if (
        !window.confirm(
          `将由 Worker ComfyUI 执行完整工作流。\nAI 节点预估费用：${formatWorkflowUsd(quote.amount)}\n工作流执行费：${formatWorkflowUsd(quote.runFee)}\n节点实际费用受确认报价上限约束。是否继续？`,
        )
      )
        return;
      try {
        await runWorkflowDraft(activeKey, draft.id, saved.revision, quote);
      } catch (cause) {
        throw new Error(
          `${errorText(cause)}。提交状态可能未知，请先检查任务列表和工作区队列，勿重复运行以免重复扣费。`,
        );
      }
      if (taskIdentity.current !== activeKey) return;
      if (draftState.drafts.some((entry) => entry.id === item.id))
        persistDrafts({ drafts: draftState.drafts.filter((entry) => entry.id !== item.id) });
      setEditor(null);
      onViewChange('queue');
      await loadTasks();
    } catch (cause) {
      if (taskIdentity.current === activeKey) setDraftError(errorText(cause));
    } finally {
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
                          if (window.confirm('删除这份草稿？'))
                            persistDrafts({
                              drafts: draftState.drafts.filter((entry) => entry.id !== item.id),
                            });
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
