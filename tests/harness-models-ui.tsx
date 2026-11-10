import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { defaultCyapiRoutes } from '../src/lib/cyapi-routes';
import { harnesses, type HarnessTool } from '../src/features/harness/catalog';
import '../src/app/styles.css';
import '../src/app/native.css';
import '../src/app/theme.css';

// In-memory IPC only; these forms never read or write a real tool configuration.
const requests: Record<string, any>[] = [];
const views = Object.fromEntries(
  harnesses.map(({ id, protocols }) => [
    id,
    {
      revision: 'initial',
      baseUrl: id === 'gemini' ? 'https://example.invalid' : 'https://example.invalid/v1',
      model: 'existing-model',
      api: protocols[0],
      apiKeyConfigured: true,
      canRestore: false,
      contextWindow: 32000,
      maxTokens: 4000,
      files: [{ path: `/fixture/${id}/config`, exists: true }],
    },
  ]),
);
const originals = structuredClone(views);
Object.assign(globalThis, { isTauri: true, harnessRequests: requests });
mockIPC((command, args) => {
  if (command === 'cyapi_routes') return defaultCyapiRoutes;
  if (command !== 'toolbox') throw new Error(`Unexpected command ${command}`);
  const request = (args as { request: Record<string, any> }).request;
  requests.push(request);
  if (request.action === 'tool-apps-detect')
    return { apps: [{ id: 'gemini', installed: true, source: '命令行工具' }] };
  if (request.action === 'harness-model-read') return structuredClone(views[request.workspace]);
  if (request.action === 'harness-model-save') {
    const { apiKey: _key, ...draft } = request.harnessModel;
    if (draft.model === 'conflict') throw new Error('配置已变化，请重新读取后保存');
    Object.assign(views[request.workspace], draft, {
      revision: crypto.randomUUID(),
      canRestore: true,
    });
    return structuredClone(views[request.workspace]);
  }
  if (request.action === 'harness-model-restore') {
    views[request.workspace] = structuredClone(originals[request.workspace]);
    return structuredClone(views[request.workspace]);
  }
  if (request.action === 'models-list') return { models: ['discovered-model'] };
  if (request.action === 'open-url') return null;
  throw new Error(`Unexpected action ${request.action}`);
});
const { HarnessModelSettings } = await import('../src/features/harness/HarnessModelSettings');
const { ManageApps } = await import('../src/features/harness/ManageApps');
const { useToolApps } = await import('../src/features/harness/useToolApps');
const apps = [
  {
    id: 'codex',
    name: 'Codex',
    hint: 'OpenAI',
    site: 'https://github.com/openai/codex',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    hint: 'Anthropic',
    site: 'https://claude.com/product/claude-code',
  },
  { id: 'opencode', name: 'OpenCode', hint: '开源', site: 'https://opencode.ai/' },
  ...harnesses,
];
function Fixture() {
  const [tool, setTool] = useState<HarnessTool>('grok');
  const [managing, setManaging] = useState(false);
  const state = useToolApps(apps);
  return (
    <main style={{ maxWidth: 900, padding: 24, margin: 'auto' }}>
      <p data-visible-apps>{state.visible.map(({ name }) => name).join(' · ')}</p>
      <button className="n-button" onClick={() => setManaging(true)}>
        管理 App
      </button>
      <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        {harnesses.map(({ id, name }) => (
          <button key={id} onClick={() => setTool(id)}>
            {name}
          </button>
        ))}
      </nav>
      <HarnessModelSettings key={tool} tool={tool} />
      {managing && (
        <ManageApps
          apps={apps}
          state={state}
          onClose={() => setManaging(false)}
          onConfigure={(id) => {
            if (harnesses.some((app) => app.id === id)) {
              state.show(id, true);
              setTool(id as HarnessTool);
              setManaging(false);
            }
          }}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
