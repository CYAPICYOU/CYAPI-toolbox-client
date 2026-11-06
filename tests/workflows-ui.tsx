import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlatformWorkbench } from '../src/features/platform/PlatformWorkbench';
import type { WorkflowTask, WorkflowTaskLog } from '../src/features/platform/api';
import '../src/app/styles.css';
import '../src/app/native.css';
import '../src/app/theme.css';

// Isolated, synthetic responses for checking the actual workbench without a service or Key.
const storage = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
localStorage.setItem(
  'cyapi.workflows.keys.v1',
  JSON.stringify({
    keys: [
      { id: 'a', key: 'fixture-a', name: '测试 A', createdAt: 1 },
      { id: 'b', key: 'fixture-b', name: '测试 B', createdAt: 2 },
    ],
    activeId: 'a',
  }),
);
let failed = false;
let complete = false;
let sequence = 1;
const at = Date.now();
const logs: WorkflowTaskLog[] = [
  { id: 1, at, level: 'info', event: 'queued', message: '任务已进入队列' },
];
const task = (): WorkflowTask => ({
  id: 'fixture-task',
  draftId: 'fixture-draft',
  name: '日志交互测试',
  description: '测试任务运行日志',
  status: complete ? 'succeeded' : 'running',
  outputs: [],
  createdAt: at,
  mode: 'worker',
});
window.fetch = async (input, options) => {
  const url = new URL(String(input), location.href);
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const key = new Headers(options?.headers).get('Authorization');
  if (url.pathname.endsWith('/public/catalog'))
    return json({ version: 1, categories: [], items: [] });
  if (url.pathname.endsWith('/workspace')) return json({ workspace: { status: 'running' } });
  if (url.pathname.endsWith('/tasks'))
    return json({ tasks: key === 'Bearer fixture-b' ? [] : [task()], total: 1 });
  if (url.pathname.endsWith('/logs')) {
    if (failed) return json({ error: '测试网络中断' }, 503);
    const after = Number(url.searchParams.get('after') || 0);
    return json({
      taskId: task().id,
      status: task().status,
      entries: logs.filter((entry) => entry.id > after),
      cursor: sequence,
      truncated: false,
    });
  }
  return json({ error: 'Fixture route not found' }, 404);
};
function Fixture() {
  const [view, setView] = useState<'library' | 'drafts' | 'queue' | 'results'>('queue');
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <nav style={{ padding: 12, display: 'flex', gap: 12 }}>
        <button
          onClick={() =>
            logs.push({
              id: ++sequence,
              at: Date.now(),
              event: `node:${sequence}`,
              nodeId: '3',
              level: 'info',
              message: 'AI 节点正在生成结果',
            })
          }
        >
          追加测试日志
        </button>
        <button
          onClick={() => {
            failed = !failed;
          }}
        >
          切换网络故障
        </button>
        <button
          onClick={() => {
            complete = true;
            logs.push({
              id: ++sequence,
              at: Date.now(),
              event: 'succeeded',
              level: 'info',
              message: '任务已完成',
            });
          }}
        >
          完成测试任务
        </button>
        <button onClick={() => setView('queue')}>任务队列</button>
        <button onClick={() => setView('results')}>结果</button>
      </nav>
      <PlatformWorkbench
        visible
        view={view}
        onViewChange={setView}
        onEditorLaunchChange={() => {}}
      />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
