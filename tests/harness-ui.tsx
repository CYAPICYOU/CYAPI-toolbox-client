import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { defaultCyapiRoutes } from '../src/lib/cyapi-routes';
import '../src/app/styles.css';
import '../src/app/native.css';
import '../src/app/theme.css';

// Exercise the real forms against in-memory IPC; all credentials and paths are synthetic.
type Tool = 'dsh' | 'workbuddy' | 'pi' | 'minimax';
const requests: Record<string, any>[] = [];
const views = Object.fromEntries(
  ['dsh', 'workbuddy', 'pi', 'minimax'].map((tool) => [
    tool,
    {
      version: tool === 'pi' ? '1.5.0' : tool === 'minimax' ? '3.1.6' : 'fixture',
      revision: 'initial',
      baseUrl: 'https://example.invalid/v1',
      model: 'existing-model',
      models: ['existing-model'],
      api: 'openai-completions',
      apiKeyConfigured: true,
      configPath: `/fixture/${tool}/config`,
      ...(tool === 'minimax' ? { dataDir: '/fixture/minimax' } : {}),
    },
  ]),
);
const mcp = {
  revision: 'initial',
  configPath: '/fixture/pi/mcp.json',
  servers: [] as { name: string; transport: string; enabled: boolean }[],
};
Object.assign(globalThis, { isTauri: true, harnessRequests: requests });
mockIPC((command, args) => {
  if (command === 'cyapi_routes') return defaultCyapiRoutes;
  if (command !== 'toolbox') throw new Error(`Unexpected command ${command}`);
  const request = (args as { request: Record<string, any> }).request;
  requests.push(request);
  if (request.action === 'desktop-model-read') return { ...views[request.workspace] };
  if (request.action === 'desktop-model-save') {
    const { apiKey: _key, ...draft } = request.desktopModel;
    Object.assign(views[request.workspace], draft, { revision: crypto.randomUUID() });
    return { ...views[request.workspace] };
  }
  if (request.action === 'models-list') return { models: ['discovered-model'] };
  if (request.action === 'pi-mcp-save') {
    mcp.servers.push({
      name: request.values.name,
      transport: request.values.transport,
      enabled: true,
    });
    mcp.revision = crypto.randomUUID();
  } else if (request.action === 'pi-mcp-toggle') {
    mcp.servers.find((s) => s.name === request.values.name)!.enabled = request.values.enabled;
    mcp.revision = crypto.randomUUID();
  } else if (request.action !== 'pi-mcp-read')
    throw new Error(`Unexpected action ${request.action}`);
  return structuredClone(mcp);
});
const { DesktopModelSettings } = await import('../src/app/DesktopModelSettings');
const { PiMcpManager } = await import('../src/app/PiMcpManager');
function Fixture() {
  const [tool, setTool] = useState<Tool | 'mcp'>('pi');
  return (
    <main style={{ maxWidth: 900, padding: 24, margin: 'auto' }}>
      <nav style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        {(['dsh', 'workbuddy', 'pi', 'minimax', 'mcp'] as const).map((id) => (
          <button key={id} onClick={() => setTool(id)}>
            {id}
          </button>
        ))}
      </nav>
      {tool === 'mcp' ? <PiMcpManager /> : <DesktopModelSettings key={tool} tool={tool} />}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
