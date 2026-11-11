import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlatformWorkbench } from '../src/features/platform/PlatformWorkbench';
import '../src/app/styles.css';
import '../src/app/native.css';

// Isolated UI fixture: no real accounts, services, charges or model calls.
const storage = new Map<string, string>();
Object.defineProperty(window, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });
localStorage.setItem('cyapi.workflows.keys.v1', JSON.stringify({
  keys: [{ id: 'fixture', key: 'fictional-test-key', name: '测试 Key', createdAt: 1 }], activeId: 'fixture',
}));
const template = {
  id: 'gpt-image-25-edit', title: '测试图片编辑', description: '测试素材处理', category: 'image', version: '1', source: 'server',
  kind: 'image-reference', input: '图片', output: '图片', steps: ['输入', '输出'], execution: 'preview', transport: 'bridge',
  apiGraph: { 1: { class_type: 'CYAPI_GPTImage25Edit', inputs: {} } },
  form: { prompt: { label: '提示词', required: true }, file: { label: '参考图', accept: 'image/*', required: true, multiple: true, maxFiles: 16 },
    mask: { label: '蒙版', accept: 'image/png', required: false }, markup: { label: '标注层', accept: 'image/png', required: false } },
};
type Call = { path: string; size?: number; contentType?: string; body?: unknown };
const calls: Call[] = [];
Object.assign(window, { fixtureImageCalls: calls });
window.confirm = () => true;
window.fetch = async (input, options = {}) => {
  const url = new URL(String(input), location.href);
  const body = options.body;
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  calls.push({ path: url.pathname, size: body instanceof Blob ? body.size : undefined,
    contentType: new Headers(options.headers).get('content-type') ?? undefined,
    body: typeof body === 'string' ? JSON.parse(body) : undefined });
  if (url.pathname.endsWith('/public/catalog')) return json({ version: 1, categories: [{ id: 'image', label: '图片' }], items: [template] });
  if (url.pathname.endsWith('/price-catalog')) return json({});
  if (url.pathname === '/api/workflows/drafts' && options.method === 'POST') return json({ id: 'fixture-draft', revision: 1 });
  if (url.pathname === '/api/workflows/uploads/prepared') return json({ id: `${crypto.randomUUID()}.png`,
    type: 'image/png', width: 1024, height: 1024, bytes: (body as Blob).size, changed: false, resized: false }, 201);
  if (url.pathname === '/api/workflows/uploads/prepared-pair') return json({
    image: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', width: 1024, height: 1024, bytes: 100, changed: false },
    overlay: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png', bytes: 100, changed: false },
  }, 201);
  if (url.pathname === '/api/workflows/drafts/fixture-draft' && options.method === 'PUT') return json({ id: 'fixture-draft', revision: 2 });
  if (url.pathname.endsWith('/quote')) return json({ amount: 0.1 });
  if (url.pathname.endsWith('/run')) return json({ id: 'fixture-task' });
  if (url.pathname.endsWith('/tasks')) return json({ tasks: [], total: 0 });
  if (url.pathname.endsWith('/workspace')) return json({ workspace: { status: 'running' } });
  return json({ error: 'Fixture route not found' }, 404);
};

function Fixture() {
  const [view, setView] = useState<'library' | 'drafts' | 'queue' | 'results'>('library');
  return <PlatformWorkbench visible view={view} onViewChange={setView} onEditorLaunchChange={() => {}} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
