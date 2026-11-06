import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import { artifactSourceLabel, groupIdenticalImages, saveArtifact, taskArtifactsZip } from '../src/features/platform/artifactDisplay.ts';
import { unzipSync, strFromU8 } from 'fflate';
import { formatWorkflowUsd, workflowReferencePrice } from '../src/features/platform/workflowPrice.ts';
import {
  createEditorLauncher,
  editorLaunchPending,
  type EditorLaunchState,
} from '../src/features/platform/editorLaunch.ts';
import {
  validateDraft,
  loadMockState,
  saveMockState,
} from '../src/features/platform/mockTasks.ts';
import {
  importWorkflow,
  loadPersonalWorkflows,
  savePersonalWorkflows,
  workflowDocument,
} from '../src/features/platform/library.ts';
import {
  isCreationSection,
  isToolPage,
  parseWorkbenchNavigation,
  WORKBENCH_KEY,
} from '../src/lib/workbenches.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const exists = (path: string) => existsSync(new URL(`../${path}`, import.meta.url));

test('workflow reference prices accept only the matching verified USD catalog value', () => {
  const catalog = { templates: [{ id: 'test', display: { price: { amount: 0, currency: 'USD', unit: '次' } } }] };
  assert.equal(workflowReferencePrice(catalog, 'test'), 0);
  assert.equal(workflowReferencePrice(catalog, 'other'), null);
  assert.equal(workflowReferencePrice({ templates: [catalog.templates[0], catalog.templates[0]] }, 'test'), null);
  assert.equal(workflowReferencePrice({ templates: [{ id: 'test', display: { price: { amount: '0.01', currency: 'USD', unit: '次' } } }] }, 'test'), null);
  assert.equal(workflowReferencePrice({ templates: [{ id: 'test', display: { price: { amount: -1, currency: 'USD', unit: '次' } } }] }, 'test'), null);
  assert.equal(formatWorkflowUsd(0.00000001), '$0.00000001 USD');
  assert.equal(formatWorkflowUsd(0), '$0 USD');
});

test('workflow execution uses the complete Worker pipeline and asks for confirmation', () => {
  const api = read('src/features/platform/api.ts');
  const page = read('src/features/platform/PlatformWorkbench.tsx');
  assert.match(api, /\/pipeline-quote/);
  assert.match(api, /\/pipeline-run/);
  assert.match(page, /window\.confirm\(`将由 Worker ComfyUI/);
  assert.match(page, /提交状态可能未知/);
  assert.match(page, /个人工作流暂不支持/);
  assert.match(page, /暂不支持从此处上传素材/);
});

test('tool selector retains the desktop model integrations', () => {
  const app = read('src/app/App.tsx');
  for (const name of ['DeepSeek Harness', 'WorkBuddy', 'Pi Coding Agent', 'MiniMax Code']) assert.ok(app.includes(name));
  for (const hint of ["id: 'dsh', name: 'DeepSeek Harness', hint: 'Deepseek'", "id: 'workbuddy', name: 'WorkBuddy', hint: 'Tencent'", "id: 'pi', name: 'Pi Coding Agent', hint: '开源'", "id: 'minimax', name: 'MiniMax Code', hint: 'Mininax'"]) assert.ok(app.includes(hint));
  assert.match(app, /<DesktopModelSettings key=\{desktopTool\} tool=\{desktopTool\}/);
  const service = read('src-tauri/src/service.rs');
  assert.match(service, /desktop-model-read/);
  assert.match(service, /desktop-model-save/);
  for (const module of ['desktop_model_config', 'pi_model_config', 'minimax_model_config']) assert.ok(service.includes(module));
});

test('identical editor images group without losing either original', () => {
  const preview = { id: 'preview', kind: 'image', download: '/preview', storageType: 'temp', role: 'preview' as const };
  const saved = { id: 'saved', kind: 'image', download: '/saved', storageType: 'output', role: 'file' as const };
  const other = { id: 'other', kind: 'image', download: '/other', storageType: 'output', role: 'file' as const };
  assert.deepEqual(groupIdenticalImages([preview, saved, other], { '/preview': 'same', '/saved': 'same', '/other': 'different' }), [[saved, preview], [other]]);
  assert.deepEqual(groupIdenticalImages([preview], {}), [[preview]]);
  assert.deepEqual(groupIdenticalImages([saved], {}), [[saved]]);
  assert.deepEqual(groupIdenticalImages([preview, saved], {}), [[saved], [preview]]);
  assert.deepEqual(groupIdenticalImages([saved, other], { '/saved': 'same', '/other': 'same' }), [[saved], [other]]);
  const unknown = { id: 'unknown', kind: 'image', download: '/unknown' };
  assert.deepEqual(groupIdenticalImages([preview, unknown], { '/preview': 'same', '/unknown': 'same' }), [[preview], [unknown]]);
  const video = { id: 'video', kind: 'video', download: '/video' };
  assert.deepEqual(groupIdenticalImages([preview, video], { '/preview': 'same', '/video': 'same' }), [[preview], [video]]);
});

test('source labels show the recorded node name and explicitly mark missing history', () => {
  const output = { id: 'x', kind: 'image', download: '/x' };
  assert.equal(artifactSourceLabel({ ...output, sourceNode: { id: '3', type: 'SaveImage', title: '最终图片' } }), '来源节点：最终图片 · SaveImage（ID 3）');
  assert.equal(artifactSourceLabel({ ...output, sourceNode: { id: '4', type: 'PreviewImage' } }), '来源节点：PreviewImage（ID 4）');
  assert.match(artifactSourceLabel(output), /未知/);
});

test('task ZIP retains all originals, avoids unsafe names and fails on missing files', async () => {
  const outputs = [
    { id: '../same.png', kind: 'image', download: '/one', role: 'preview' as const },
    { id: '../same.png', kind: 'image', download: '/two', role: 'file' as const },
  ];
  const zip = await taskArtifactsZip(outputs, async output => new Blob([output.download]));
  const unpacked = unzipSync(new Uint8Array(await zip.arrayBuffer()));
  assert.deepEqual(Object.keys(unpacked), ['001-_same.png', '002-_same.png']);
  assert.deepEqual(Object.values(unpacked).map(value => strFromU8(value)), ['/one', '/two']);
  await assert.rejects(taskArtifactsZip(outputs, async output => {
    if (output.download === '/two') throw new Error('missing');
    return new Blob(['ok']);
  }), /missing/);
  await assert.rejects(taskArtifactsZip([], async () => new Blob()), /没有可下载/);
  await assert.rejects(taskArtifactsZip([outputs[0]], async () => new Blob([new Uint8Array(30 * 1024 * 1024 + 1)])), /超过 30 MB/);
});

test('native artifact save returns cancellation and propagates write errors', async () => {
  const url = URL.createObjectURL(new Blob(['example']));
  try {
    assert.equal(await saveArtifact(url, 'example.png', true, async (name, data) => {
      assert.equal(name, 'example.png');
      assert.equal(atob(data), 'example');
      return false;
    }), false);
    await assert.rejects(saveArtifact(url, 'example.png', true, async () => { throw new Error('disk full'); }), /disk full/);
    assert.equal(await saveArtifact(url, 'example.png', true, async () => true), true);
  } finally { URL.revokeObjectURL(url); }
});

test('missing result previews stay isolated from task queue and drafts', () => {
  const page = read('src/features/platform/PlatformWorkbench.tsx');
  assert.match(page, /view !== 'results'\) return;/);
  assert.match(page, /artifactErrors\[id\]/);
  assert.match(page, /setArtifactErrors\(\(current\)/);
  assert.match(page, /\(view === 'queue' \|\| view === 'results'\) && taskError/);
  assert.match(page, /产物无法加载/);
  assert.match(page, /typeof error === 'string'/);
  assert.doesNotMatch(page, /setTaskError\(errorText\(cause\)\);\s*\}\);\s*\}\s*\}\s*\}, \[tasks, view/);
});

test('task responses and visible results are scoped to the active Key', () => {
  const page = read('src/features/platform/PlatformWorkbench.tsx');
  assert.match(page, /taskState\.key === activeKey \? taskState\.tasks : \[\]/);
  assert.match(page, /const generation = taskGeneration\.current/);
  assert.match(page, /if \(taskGeneration\.current !== generation\) return;\s*setTaskState\(\{ key: activeKey, tasks: result\.tasks \}\)/);
  assert.match(page, /if \(taskGeneration\.current === generation\) setTaskError/);
});

test('workflows ship in standard builds with no research switch', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts['desktop:exe']);
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /research|workflow:service/);
  assert.doesNotMatch(read('src-tauri/Cargo.toml'), /research-workflows/);
  assert.doesNotMatch(read('src-tauri/src/lib.rs'), /research-workflows|configure_environment/);
  assert.equal(exists('src-tauri/tauri.research.conf.json'), false);
});

test('no offline research artifacts ship with the client', () => {
  // The historical research archive was removed; keep the repository free of
  // runnable research entry points and of the old research build config.
  assert.equal(exists('research'), false);
  assert.equal(exists('src-tauri/tauri.research.conf.json'), false);
});

test('the user workbench is native and the hosted editor opens in a separate WebView', () => {
  const page = read('src/app/Workflows.tsx');
  assert.match(
    page,
    /import \{ PlatformWorkbench \} from '\.\.\/features\/platform\/PlatformWorkbench'/,
  );
  assert.match(page, /<PlatformWorkbench\b/);
  for (const pattern of [/<iframe/, /postMessage/, /syncWorkflowView/, /invoke\(/, /WORKFLOW_URL/])
    assert.doesNotMatch(page, pattern);

  // The platform API uses the user's Key as a Bearer token and asks native code
  // to open the one-shot editor URL in a dedicated window.
  const platform = read('src/features/platform/api.ts');
  assert.match(platform, /\/workflow\/platform\/api/);
  // Rust joins the native request path onto the origin, so the platform prefix
  // has to be part of the path; a bare `/public/catalog` hits a 404.
  assert.match(platform, /cyapiRequest<T>\(base \+ path/);
  assert.match(platform, /base = PLATFORM_API_PATH/);
  assert.match(platform, /Authorization: `Bearer \$\{key\}`/);
  assert.match(platform, /invoke\('open_workflow_editor'/);
  assert.doesNotMatch(platform, /credentials:\s*['"]include|csrf|withCredentials/i);
  // Real execution lives at the server root, not under the platform prefix.
  assert.match(platform, /WORKFLOW_API_PATH = '\/api\/workflows'/);
  assert.match(platform, /base: WORKFLOW_API_PATH/);

  assert.equal(exists('src-tauri/src/workflows.rs'), false);
  assert.equal(exists('src-tauri/src/workflows-ui.js'), false);
  assert.equal(exists('src/lib/api/workflows.ts'), false);

  const backend = read('src-tauri/src/lib.rs');
  assert.doesNotMatch(backend, /mod workflows;|workflows::/);
  assert.match(backend, /fn open_workflow_editor/);
  assert.match(backend, /fn trusted_caller\(view: &tauri::Webview\)/);
  assert.match(backend, /view\.label\(\) == "main"/);
  assert.match(backend, /local_app_url\(&url\)/);
  assert.match(backend, /invoke\.resolver\.reject/);

  // The remote editor window receives no native capability, so only the main
  // WebView stays in this capability file.
  const capability = JSON.parse(read('src-tauri/capabilities/default.json'));
  assert.deepEqual(capability.webviews, ['main']);
  assert.equal(capability.windows, undefined);
  assert.equal(capability.remote, undefined);

  // No `/workflows/` page path is left anywhere in the client.
  for (const file of ['src/app/Workflows.tsx', 'src/features/platform/api.ts'])
    assert.doesNotMatch(read(file), /['"`]\/workflows\//);
});

test('workflow Keys live in the client and never in the service keyring', () => {
  const store = read('src/features/platform/keyStore.ts');
  assert.match(store, /cyapi\.workflows\.keys\.v1/);
  assert.match(store, /localStorage\.setItem/);
  assert.match(store, /localStorage\.getItem/);
  assert.doesNotMatch(store, /\/api\//);
  assert.doesNotMatch(store, /document\.cookie/);

  assert.match(read('src/features/platform/PlatformWorkbench.tsx'), /Key 保存在本机/);
});

test('local Key store de-duplicates, filters temporary Keys and caps the list', async () => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, value: string) => void data.set(name, value),
    removeItem: (name: string) => void data.delete(name),
  };
  const { addKey, loadKeys, saveKeys, maskKey } =
    await import('../src/features/platform/keyStore.ts');

  assert.deepEqual(loadKeys(), { keys: [], activeId: null });

  const first = addKey([], ' 日常 ', ' sk-abcdef123456 ');
  assert.equal(first.name, '日常');
  assert.equal(first.key, 'sk-abcdef123456');
  assert.equal(maskKey(first.key), '•••• 3456');
  assert.equal(addKey([first], '重复', first.key), first, 'the same Key is not stored twice');

  saveKeys([first, { ...first, id: 'tmp', temporary: true }], first.id);
  const stored = loadKeys();
  assert.deepEqual(
    stored.keys.map((entry) => entry.id),
    [first.id],
  );
  assert.equal(stored.activeId, first.id);
  assert.deepEqual(loadKeys().keys[0].name, '日常');

  const many = Array.from({ length: 10 }, (_, index) => ({
    id: String(index),
    name: `Key ${index}`,
    key: `sk-${index}`,
    createdAt: index,
  }));
  assert.throws(() => addKey(many, 'extra', 'sk-extra'), /最多保存 10 个 Key/);
  assert.throws(() => addKey([], 'empty', '   '), /请输入 API Key/);

  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test('desktop CSP allows the canvas origin and blob media, and nothing broader', () => {
  const csp = JSON.parse(read('src-tauri/tauri.conf.json')).app.security.csp as string;
  const directive = (name: string) =>
    csp
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `)) || '';
  const frame = directive('frame-src');
  const connect = directive('connect-src');
  const img = directive('img-src');
  const media = directive('media-src');
  for (const origin of ['https://api.cyapi.cyou', 'http://127.0.0.1:18733']) {
    assert.ok(frame.includes(origin), `frame-src must allow ${origin}`);
    assert.ok(connect.includes(origin), `connect-src must allow ${origin}`);
  }
  assert.ok(img.includes('blob:'));
  assert.ok(media.includes('blob:'));
  assert.ok(connect.includes('blob:'));
  assert.doesNotMatch(frame, /frame-src 'none'/);
  assert.doesNotMatch(frame, /\s\*\s*;|frame-src \*/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test('business workbenches remember independent pages with no research storage namespace', () => {
  const defaults = { workbench: 'create', toolPage: 'codex', creationSection: 'library' };
  for (const saved of [null, 'invalid', 'null', '[]', '123'])
    assert.deepEqual(parseWorkbenchNavigation(saved), defaults);
  assert.deepEqual(
    parseWorkbenchNavigation(
      JSON.stringify({ workbench: 'tools', toolPage: 'mcp', creationSection: 'results' }),
    ),
    { workbench: 'tools', toolPage: 'mcp', creationSection: 'results' },
  );
  assert.deepEqual(
    parseWorkbenchNavigation(
      JSON.stringify({ workbench: 'claude', toolPage: 'settings', creationSection: '<script>' }),
    ),
    defaults,
  );
  assert.equal(isCreationSection('editor'), false);
  assert.equal(isToolPage('workflows'), false);
  assert.equal(WORKBENCH_KEY, 'cyapi.workbenches.v1');
});

test('Tools and Workflows are peers and the workbench keeps the App sidebar contract', () => {
  const app = read('src/app/App.tsx');
  const tools = app.indexOf("['tools', SquareTerminal, '工具接入'");
  const workflows = app.indexOf("['create', Workflow, '工作流'");
  assert.ok(tools >= 0 && workflows > tools);
  assert.match(app, /hidden=\{page !== 'workflows'\}/);
  assert.match(app, /visible=\{page === 'workflows' && !modalOpen && !logsOpen\}/);
  assert.match(app, /workbench !== 'tools' \|\| toolsLoaded\.current/);
  assert.doesNotMatch(app, /researchBuild|预研|RESEARCH/);

  assert.equal(exists('src/features/workflows/Workbench.tsx'), false);
});

test('desktop workflow copy never claims server mode or shares tool credentials', () => {
  const app = read('src/app/App.tsx');
  assert.doesNotMatch(app, /费用以运行前报价为准/);
  assert.match(app, /工作流使用独立的 CYAPI API Key/);
  assert.match(app, /导入 ComfyUI 工作流或新建流程/);
  assert.doesNotMatch(app, /参考图拼贴模拟 · 非 AI 生成 · 不计费/);

  assert.match(read('src/features/platform/PlatformWorkbench.tsx'), /创建并打开 ComfyUI 编辑器/);
});

test('workflow library is server-fed and uses compact cards instead of hardcoded examples', () => {
  const app = read('src/app/App.tsx');
  const page = read('src/features/platform/PlatformWorkbench.tsx');
  assert.doesNotMatch(app, /节点管理|第三方扩展可在侧栏/);
  assert.doesNotMatch(page, /添加节点|第三方节点|view === 'nodes'/);
  assert.match(app, /工作流库/);
  const library = read('src/features/platform/WorkflowLibrary.tsx');
  for (const label of ['推荐工作流', '我的工作流', '搜索工作流', '查看流程', '使用模板'])
    assert.ok(library.includes(label));
  assert.match(page, /getWorkflowCatalog\(\)/);
  assert.match(
    read('src/features/platform/api.ts'),
    /request<WorkflowCatalog>\('\/public\/catalog'\)/,
  );
  assert.doesNotMatch(page + library, /const examples|体验任务流|体验工作流|本地模拟|pfx-cover/);
  assert.doesNotMatch(page, /启动工作区|停止工作区|重启工作区|getBilling/);
  const editor = read('src/features/platform/WorkflowPage.tsx');
  assert.match(editor, /运行会提交真实任务/);
  assert.match(editor, /Worker ComfyUI 执行/);
  assert.doesNotMatch(editor, /<Modal/);
  assert.doesNotMatch(page, /<Modal title=\{.*editor/);
  for (const label of ['填写输入', '流程详情', '拖拽文件', '保存草稿', '在 ComfyUI 中打开'])
    assert.ok(editor.includes(label));
});

test('hosted Key management is optional for browsing and guards authenticated actions', () => {
  const page = read('src/features/platform/PlatformWorkbench.tsx');
  assert.match(page, /title="Key 管理"/);
  assert.match(page, /浏览工作流无需配置/);
  assert.match(page, /此操作需要配置并激活 Key/);
  assert.match(page, /if \(!requireKey\(\)\) return/);
  assert.match(page, /saveKeys\(keys.keys, entry.id\)/);
  assert.doesNotMatch(page, /连接你的 CYAPI Key/);
});

test('editor launch publishes background phases, coalesces clicks and retries with a fresh token', async () => {
  const states: (EditorLaunchState | null)[] = [];
  const opened: string[] = [];
  let resolveToken!: (result: { url: string }) => void;
  let calls = 0;
  const launcher = createEditorLauncher({
    token: async () => {
      calls++;
      return new Promise((resolve) => {
        resolveToken = resolve;
      });
    },
    open: async (url) => {
      opened.push(url);
    },
    onChange: (state) => states.push(state),
  });
  const first = launcher.launch('ordinary-user-key', '测试工作流', { nodes: [] });
  assert.equal(
    states.at(-1)?.phase,
    'starting',
    'feedback is immediate, before the network responds',
  );
  assert.equal(editorLaunchPending(states.at(-1)!), true);
  assert.equal(await launcher.launch('another-key', '重复点击', {}), false);
  assert.equal(calls, 1);
  assert.equal(opened.length, 0, 'no window opens before the service is ready');
  resolveToken({ url: 'https://example.test/?t=one-shot' });
  assert.equal(await first, true);
  assert.deepEqual(
    states.map((state) => state?.phase),
    ['starting', 'opening', 'opened'],
  );
  assert.equal(editorLaunchPending(states.at(-1)!), false);
  assert.doesNotMatch(JSON.stringify(states), /ordinary-user-key|one-shot/);
  const retry = launcher.retry();
  assert.equal(calls, 2);
  resolveToken({ url: 'https://example.test/?t=fresh-token' });
  await retry;
  assert.deepEqual(opened, [
    'https://example.test/?t=one-shot',
    'https://example.test/?t=fresh-token',
  ]);
  launcher.reset();
  assert.equal(states.at(-1), null);
});

test('changing identity discards a late response without opening the previous user editor', async () => {
  const states: (EditorLaunchState | null)[] = [];
  let complete!: (result: { url: string }) => void;
  let signal: AbortSignal | undefined;
  let opened = 0;
  const launcher = createEditorLauncher({
    token: async (_key, _document, requestSignal) => {
      signal = requestSignal;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    open: async () => {
      opened++;
    },
    onChange: (state) => states.push(state),
  });
  const pending = launcher.launch('previous-key', '旧用户', { nodes: [] });
  launcher.reset();
  assert.equal(signal?.aborted, true);
  complete({ url: 'https://example.test/old-user' });
  await pending;
  assert.equal(opened, 0);
  assert.equal(states.at(-1), null);
  assert.equal(await launcher.retry(), false, 'identity reset forgets old credentials');
});

test('launch failures and timeout release the lock and do not open a window', async () => {
  let latest: EditorLaunchState | null = null;
  let fail = true;
  const launcher = createEditorLauncher({
    timeoutMs: 10,
    token: async (_key, _document, signal) => {
      if (fail) throw new Error('Worker 暂时失联');
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    },
    open: async () => {
      assert.fail('must not open after failure');
    },
    onChange: (state) => {
      latest = state;
    },
  });
  await launcher.launch('key', '失败测试', { nodes: [] });
  assert.equal((latest as EditorLaunchState | null)?.phase, 'failed');
  assert.match((latest as EditorLaunchState | null)?.error ?? '', /Worker 暂时失联/);
  fail = false;
  await launcher.retry();
  assert.equal((latest as EditorLaunchState | null)?.phase, 'failed');
  assert.match((latest as EditorLaunchState | null)?.error ?? '', /超时/);
  launcher.reset();
});

test('native window errors surface inline and the retry can recover', async () => {
  const states: (EditorLaunchState | null)[] = [];
  let opens = 0;
  const launcher = createEditorLauncher({
    token: async () => ({ url: 'https://example.test/editor' }),
    open: async () => {
      if (++opens === 1) throw new Error('无法打开编辑器窗口');
    },
    onChange: (state) => states.push(state),
  });
  assert.equal(await launcher.launch('key', '窗口失败', { nodes: [] }), false);
  assert.equal(states.at(-1)?.phase, 'failed');
  assert.match(states.at(-1)?.error ?? '', /无法打开编辑器窗口/);
  assert.equal(await launcher.retry(), true);
  assert.equal(states.at(-1)?.phase, 'opened');
  launcher.reset();
});

test('startup progress stays outside a modal and only editor launch controls are disabled', () => {
  const page = read('src/features/platform/PlatformWorkbench.tsx');
  const launch = page.slice(
    page.indexOf('async function launchEditor('),
    page.indexOf('async function runImport('),
  );
  assert.doesNotMatch(launch, /await run\(/);
  assert.match(page, /void launchEditor\(item\)/);
  assert.doesNotMatch(page, /<EditorLaunchNotice/);
  const app = read('src/app/App.tsx');
  assert.match(app, /<EditorLaunchNotice \{\.\.\.editorLaunchNotice\}/);
  assert.match(app, /onEditorLaunchChange=\{setEditorLaunchNotice\}/);
  assert.match(page, /editorStarting=\{editorStarting\}/);
  const notice = read('src/features/platform/EditorLaunchNotice.tsx');
  assert.match(notice, /role="progressbar"/);
  assert.match(notice, /role="status"/);
  assert.match(notice, /继续浏览|切换页面/);
  assert.doesNotMatch(notice, /<Modal|aria-modal|aria-valuenow/);
  // Once the editor is open the notice has served its purpose: it must not
  // stay in the page flow or offer a redundant "再次打开" action.
  assert.match(notice, /state\.phase !== 'opened'/);
  assert.match(notice, /window\.setTimeout/);
  assert.doesNotMatch(notice, /再次打开/);
});

test('the shared toolbox log entry is global and workflow lifecycle logs contain no credentials', async () => {
  const app = read('src/app/App.tsx');
  const footer = app.slice(
    app.indexOf('<div className="n-sidebar-tools"'),
    app.indexOf('<small className="n-sidebar-meta"'),
  );
  assert.match(footer, /data-logs-trigger/);
  assert.doesNotMatch(footer, /workbench === 'tools'/);
  assert.match(app, /<LogWindow operationId=\{logOperation\}/);
  assert.match(
    read('src/features/platform/EditorLaunchNotice.tsx'),
    /openLogs\(state.operationId\)/,
  );
  const events: unknown[][] = [];
  const launcher = createEditorLauncher({
    token: async () => ({ url: 'https://example.test/?t=private-editor-token' }),
    open: async () => {},
    onChange: () => {},
    onEvent: (...args) => {
      events.push(args);
    },
  });
  await launcher.launch('private-user-key', 'private-workflow-title', { prompt: 'private-input' });
  assert.deepEqual(
    events.map((event) => event[1]),
    ['starting', 'opening', 'opened'],
  );
  assert.doesNotMatch(JSON.stringify(events), /private|https/);
  assert.ok(events.every((event) => /^workflow-/.test(String(event[0]))));
  assert.match(read('src-tauri/src/lib.rs'), /logging::log_workflow_launch/);
  launcher.reset();
});

test('ComfyUI import accepts canvas, API and shared graphs and rejects unrelated JSON', () => {
  const graph = { '1': { class_type: 'CYAPI_CogView3Flash', inputs: { prompt: '', size: '1024x1024' } } };
  const fromApi = importWorkflow(JSON.stringify(graph), '灵感.json');
  assert.equal(fromApi.title, '灵感');
  assert.equal(fromApi.source, 'personal');
  assert.deepEqual(fromApi.apiGraph, graph);
  assert.deepEqual(workflowDocument(fromApi, 'new prompt'), {
    prompt: { '1': { class_type: 'CYAPI_CogView3Flash', inputs: { prompt: 'new prompt', size: '1024x1024' } } },
  });
  assert.equal(
    fromApi.apiGraph?.['1'].inputs.prompt,
    '',
    'launch must not mutate the original template',
  );
  assert.deepEqual(importWorkflow(JSON.stringify({ prompt: graph }), 'api.json').apiGraph, graph);
  const canvas = { version: 0.4, nodes: [], links: [] };
  assert.deepEqual(workflowDocument(importWorkflow(JSON.stringify(canvas), 'canvas.json')), canvas);
  assert.deepEqual(
    importWorkflow(
      JSON.stringify({ name: '分享', apiGraph: graph, workflow: canvas }),
      'share.json',
    ).workflow,
    canvas,
  );
  assert.deepEqual(
    workflowDocument(
      importWorkflow(JSON.stringify({ apiGraph: graph, workflow: canvas }), 'share.json'),
    ),
    canvas,
    'imports preserve the original canvas layout',
  );
  for (const value of ['null', '[]', '{}', '{"hello":"world"}', 'not json'])
    assert.throws(() => importWorkflow(value, 'invalid.json'));
});

test('personal workflows persist and template form metadata controls validation', () => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
    },
  });
  const item = importWorkflow('{"nodes":[]}', '我的工作流.json');
  savePersonalWorkflows([item]);
  assert.deepEqual(loadPersonalWorkflows(), [item]);
  const draft = {
    id: 'draft',
    title: item.title,
    kind: item.kind,
    prompt: '',
    fileName: '',
    fileData: '',
    updatedAt: 1,
    template: item,
  };
  assert.equal(validateDraft(draft), '', 'node-only imports do not invent text requirements');
  assert.match(
    validateDraft({
      ...draft,
      template: { ...item, form: { file: { label: '参考图', accept: 'image/*', required: true } } },
    }),
    /素材/,
  );
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test('draft validation requires the declared prompt or reference file only', () => {
  const draft = {
    id: 'test',
    kind: 'image' as const,
    title: '文字生成图片',
    prompt: '',
    fileName: '',
    fileData: '',
    updatedAt: 0,
  };
  assert.match(validateDraft(draft), /文字/);
  assert.equal(validateDraft({ ...draft, prompt: 'hello' }), '');
  assert.match(validateDraft({ ...draft, kind: 'image-reference', prompt: 'hello' }), /素材/);
  assert.equal(
    validateDraft({ ...draft, kind: 'transcription', fileData: 'data:audio/test;base64,AA==' }),
    '',
  );
});

test('local drafts persist and storage errors are surfaced', () => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
    },
  });
  const draft = {
    id: 'draft',
    kind: 'speech' as const,
    title: '文字转语音',
    prompt: '测试',
    fileName: '',
    fileData: '',
    updatedAt: 1,
  };
  saveMockState({ drafts: [draft] });
  assert.deepEqual(loadMockState().drafts, [draft]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      setItem: () => {
        throw new Error('quota');
      },
    },
  });
  assert.throws(() => saveMockState({ drafts: [draft] }), /存储空间不足/);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});
