import { useCallback, useEffect, useRef, useState } from 'react';
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
  installNode,
  listNodes,
  listWorkflowTasks,
  openEditorWindow,
  quoteWorkflowDraft,
  removeNode,
  runWorkflowDraft,
  saveWorkflowDraft,
  type NodeInstall,
  type WorkflowTask,
} from './api';
import { addKey, loadKeys, maskKey, saveKeys, type StoredKeyState } from './keyStore';
import { Modal } from '../../components/Primitives';
import {
  loadMockState,
  saveMockState,
  validateDraft,
  type MockDraft,
  type MockState,
} from './mockTasks';
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
import './platform.css';

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请稍后重试';
const nodeStatus: Record<NodeInstall['status'], string> = {
  queued: '排队中',
  running: '安装中',
  completed: '已安装',
  failed: '安装失败',
};
const taskStatusLabel: Record<string, string> = {
  submitting: '提交中',
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  provider_failed_charged: '上游失败（已扣费）',
  provider_unknown: '结果待核对',
  interrupted: '已中断',
};
const taskActive = (status: string) => ['submitting', 'queued', 'running'].includes(status);
const viewContent = {
  library: {
    title: '工作流库',
    description: '选择工作流，填写内容，开始创作。也可以导入或创建自己的流程。',
  },
  drafts: { title: '草稿', description: '保存并继续编辑尚未提交的任务' },
  queue: { title: '任务队列', description: '查看任务的排队和运行进度' },
  results: { title: '结果', description: '查看和下载任务产物' },
  nodes: { title: '节点管理', description: '管理你的第三方扩展节点' },
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
  const [repo, setRepo] = useState('');
  const [nodes, setNodes] = useState<NodeInstall[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [retry, setRetry] = useState(0);
  const [mock, setMock] = useState<MockState>(loadMockState);
  const [editor, setEditor] = useState<MockDraft | null>(null);
  const [mockError, setMockError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [tasks, setTasks] = useState<WorkflowTask[]>([]);
  const [taskError, setTaskError] = useState('');
  const [artifacts, setArtifacts] = useState<Record<string, string>>({});
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
    setMockError('');
    // A Key error from another page must not follow the user back to the
    // public catalog.
    setError('');
  }, [view]);

  const loadTasks = useCallback(async () => {
    if (!activeKey) {
      setTasks([]);
      return;
    }
    try {
      const result = await listWorkflowTasks(activeKey);
      setTasks(result.tasks);
      setTaskError('');
    } catch (cause) {
      setTaskError(errorText(cause));
    }
  }, [activeKey]);

  useEffect(() => {
    if (!visible || !activeKey || (view !== 'queue' && view !== 'results')) return;
    void loadTasks();
  }, [visible, view, activeKey, loadTasks]);

  // Poll only while something is actually running; the server owns the state.
  useEffect(() => {
    if (!visible || !activeKey || (view !== 'queue' && view !== 'results')) return;
    if (!tasks.some((task) => taskActive(task.status))) return;
    const timer = window.setInterval(() => void loadTasks(), 2500);
    return () => window.clearInterval(timer);
  }, [visible, view, activeKey, tasks, loadTasks]);

  const artifactPending = useRef(new Set<string>());
  const artifactUrls = useRef<string[]>([]);
  // Result URLs are private; fetch each artifact once and keep the blob URL.
  useEffect(() => {
    if (!activeKey || (view !== 'queue' && view !== 'results')) return;
    for (const task of tasks) {
      if (task.status !== 'succeeded') continue;
      for (const output of task.outputs) {
        if (!['image', 'video'].includes(output.kind)) continue;
        if (artifacts[output.id] || artifactPending.current.has(output.id)) continue;
        artifactPending.current.add(output.id);
        void downloadWorkflowArtifact(activeKey, output.download)
          .then((url) => {
            artifactUrls.current.push(url);
            setArtifacts((current) => ({ ...current, [output.id]: url }));
          })
          .catch((cause) => {
            artifactPending.current.delete(output.id);
            setTaskError(errorText(cause));
          });
      }
    }
  }, [tasks, view, activeKey, artifacts]);

  useEffect(
    () => () => {
      for (const url of artifactUrls.current) URL.revokeObjectURL(url);
      artifactUrls.current = [];
    },
    [],
  );

  function saveMock(next: MockState) {
    try {
      saveMockState(next);
      setMock(next);
      setMockError('');
      return true;
    } catch (cause) {
      setMockError(errorText(cause));
      return false;
    }
  }
  function openWorkflow(template: WorkflowTemplate, tab: 'inputs' | 'flow' = 'inputs') {
    setMockError('');
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
  function openDraft(item: MockDraft) {
    const template = item.template ?? catalog?.items.find((entry) => entry.kind === item.kind);
    if (!template) {
      setMockError('暂时无法找到这份草稿的工作流，请重新加载目录后再试。');
      return;
    }
    setMockError('');
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
    setMockError('');
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
      saveMock({
        ...mock,
        drafts: [
          { ...editor, updatedAt: Date.now() },
          ...mock.drafts.filter((item) => item.id !== editor.id),
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
      setMockError(validation);
      return;
    }
    if (!requireKey()) return;
    setSubmitting(true);
    setMockError('');
    try {
      // The server owns the template graph: create a draft from the published
      // template, fill the prompt, quote, then submit to Bridge.
      const draft = await createWorkflowDraft(activeKey, template.id);
      const saved = await saveWorkflowDraft(activeKey, draft.id, {
        revision: draft.revision,
        description: item.prompt.trim(),
      });
      const quote = await quoteWorkflowDraft(activeKey, draft.id);
      await runWorkflowDraft(activeKey, draft.id, saved.revision, quote);
      if (mock.drafts.some((entry) => entry.id === item.id))
        saveMock({ drafts: mock.drafts.filter((entry) => entry.id !== item.id) });
      setEditor(null);
      onViewChange('queue');
      await loadTasks();
    } catch (cause) {
      setMockError(errorText(cause));
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

  const refreshNodes = useCallback(async () => {
    if (activeKey) setNodes((await listNodes(activeKey)).data);
  }, [activeKey]);
  useEffect(() => {
    setNodes([]);
    setRepo('');
  }, [activeKey]);

  useEffect(() => {
    if (!visible || view !== 'nodes' || !activeKey) return;
    let cancelled = false;
    listNodes(activeKey)
      .then((result) => {
        if (!cancelled) setNodes(result.data);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [visible, view, activeKey]);
  useEffect(() => {
    if (
      !visible ||
      view !== 'nodes' ||
      !nodes.some((node) => node.status === 'queued' || node.status === 'running')
    )
      return;
    const timer = window.setTimeout(() => {
      void refreshNodes().catch(() => {});
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [nodes, refreshNodes, visible, view]);

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
          <p>{viewContent[view].description}</p>
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
            error={mockError}
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
        ) : view === 'nodes' ? (
          <section className="pfx-card pfx-node-page">
            <h2>第三方节点</h2>
            <p>通过 GitHub 仓库添加扩展。请只安装信任的来源，第三方代码可能影响服务安全。</p>
            <form
              className="pfx-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!requireKey()) return;
                void run(async () => {
                  await installNode(activeKey, repo.trim());
                  setRepo('');
                  await refreshNodes();
                });
              }}
            >
              <input
                type="url"
                required={!!activeKey}
                value={repo}
                placeholder="https://github.com/owner/repository"
                onChange={(event) => setRepo(event.target.value)}
              />
              <button
                className="pfx-primary"
                disabled={busy}
                onClick={(event) => {
                  if (!activeKey) {
                    event.preventDefault();
                    requireKey();
                  }
                }}
              >
                <Plus size={15} />
                添加节点
              </button>
            </form>
            <p className="pfx-hint">
              节点仅下载仓库，依赖不会自动安装；变更将在下次服务重新加载后生效。
            </p>
            {!activeKey ? (
              <div className="pfx-empty">配置 Key 后可查看和管理你的节点</div>
            ) : nodes.length ? (
              <ul className="pfx-nodes">
                {nodes.map((node) => (
                  <li key={node.id}>
                    <div className="pfx-node-main">
                      <strong>{node.name}</strong>
                      <small title={node.log}>
                        {node.repo}
                        {node.status === 'failed' ? ` · ${node.log}` : ''}
                      </small>
                    </div>
                    <span>{nodeStatus[node.status]}</span>
                    <button
                      className="pfx-icon-button"
                      aria-label={`卸载 ${node.name}`}
                      disabled={busy || node.status === 'running' || node.status === 'queued'}
                      onClick={() => {
                        if (requireKey() && window.confirm(`确定卸载 ${node.name}？`))
                          void run(async () => {
                            await removeNode(activeKey, node.name);
                            await refreshNodes();
                          });
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="pfx-empty">还没有添加第三方节点</div>
            )}
          </section>
        ) : (
          <>
            {mockError && (
              <div className="pfx-alert" role="alert">
                {mockError}
              </div>
            )}
            {taskError && (
              <div className="pfx-alert" role="alert">
                <AlertCircle size={16} />
                {taskError}
                <button className="pfx-ghost" onClick={() => void loadTasks()}>
                  重试
                </button>
              </div>
            )}
            {view === 'drafts' ? (
              mock.drafts.length ? (
                mock.drafts.map((item) => (
                  <article key={item.id} className="pfx-card pfx-mock-row">
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.prompt || item.fileName || '未填写内容'}</p>
                      <small>更新于 {new Date(item.updatedAt).toLocaleString()}</small>
                    </div>
                    <div className="pfx-mock-actions">
                      <button className="pfx-secondary" onClick={() => openDraft(item)}>
                        继续编辑
                      </button>
                      <button
                        className="pfx-ghost"
                        onClick={() => {
                          if (window.confirm('删除这份草稿？'))
                            saveMock({
                              ...mock,
                              drafts: mock.drafts.filter((entry) => entry.id !== item.id),
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
            {view === 'queue' ? (
              tasks.length ? (
                tasks.map((task) => (
                  <article key={task.id} className="pfx-card pfx-mock-row">
                    <div>
                      <strong>{task.name}</strong>
                      <p>{task.description || '未填写内容'}</p>
                      <small>
                        {taskStatusLabel[task.status] ?? task.status}
                        {task.message ? ` · ${task.message}` : ''}
                        {' · '}
                        {new Date(task.createdAt).toLocaleString()}
                      </small>
                    </div>
                    <div className="pfx-mock-actions">
                      {task.status === 'succeeded' && task.outputs.length > 0 && (
                        <button className="pfx-secondary" onClick={() => onViewChange('results')}>
                          查看结果
                        </button>
                      )}
                      {taskActive(task.status) && (
                        <button className="pfx-ghost" onClick={() => void cancelTask(task)}>
                          取消任务
                        </button>
                      )}
                    </div>
                  </article>
                ))
              ) : (
                <div className="pfx-card pfx-empty">还没有任务，选择工作流并运行。</div>
              )
            ) : null}
            {view === 'results' ? (
              tasks.some((task) => task.status === 'succeeded' && task.outputs.length > 0) ? (
                tasks
                  .filter((task) => task.status === 'succeeded' && task.outputs.length > 0)
                  .map((task) => (
                    <article key={task.id} className="pfx-card pfx-mock-result">
                      <div className="pfx-mock-row">
                        <strong>{task.name}</strong>
                        <small>{new Date(task.createdAt).toLocaleString()}</small>
                      </div>
                      <div className="pfx-results">
                        {task.outputs.map((output) => (
                          <figure key={output.id} className="pfx-result">
                            {artifacts[output.id] ? (
                              output.kind === 'video' ? (
                                <video src={artifacts[output.id]} controls playsInline />
                              ) : (
                                <img src={artifacts[output.id]} alt={output.title || '生成结果'} />
                              )
                            ) : (
                              <div className="pfx-result-loading">
                                <LoaderCircle size={14} className="pfx-spin" />
                                正在加载产物…
                              </div>
                            )}
                            {artifacts[output.id] && (
                              <a
                                className="pfx-secondary"
                                href={artifacts[output.id]}
                                download={output.id}
                              >
                                下载
                              </a>
                            )}
                          </figure>
                        ))}
                      </div>
                      {task.billing && (
                        <small>
                          {task.billing.amount > 0
                            ? `本次费用 ${task.billing.amount} ${task.billing.unit}`
                            : '未产生费用'}
                        </small>
                      )}
                    </article>
                  ))
              ) : (
                <div className="pfx-card pfx-empty">暂无已完成的结果。</div>
              )
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
