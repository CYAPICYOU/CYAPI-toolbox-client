import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import '../src/app/styles.css';
import '../src/app/native.css';
import '../src/app/theme.css';
import '../src/app/app-settings.css';

// The card against in-memory IPC; every path and value here is synthetic.
const catalog = {
  schema: 2,
  generatedAt: '',
  servers: [
    {
      id: 'cyapi-toolbox',
      name: 'CYAPI 工作流',
      version: '3.0+',
      description: '把本机已登录的 CYAPI 工具箱工作台接入 Agent。',
      homepage: '',
      capabilities: ['工作区状态', '模板与报价'],
      steps: ['保持 CYAPI Toolbox 正在运行。'],
      installCommand: '',
      transport: { type: 'http', url: 'http://127.0.0.1:18733/mcp', tokenSource: 'cyapi-toolbox' },
      workspaces: ['codex', 'claude', 'opencode'],
    },
  ],
};
const paths: Record<string, string> = {
  codex: '/fixture/.codex/config.toml',
  claude: '/fixture/.claude.json',
  opencode: '/fixture/.config/opencode/opencode.jsonc',
};
const connected: Record<string, boolean> = {};
function view(workspace: string) {
  const installed = !!connected[workspace];
  return {
    catalog,
    workspace,
    configPath: paths[workspace],
    revision: 'config',
    source: 'cached',
    entries: [
      {
        id: 'cyapi-toolbox',
        revision: `entry-${workspace}`,
        state: installed ? 'managed' : 'absent',
        installed,
        managed: installed,
        modified: false,
        external: false,
        recognized: false,
        adoptable: false,
        conflict: false,
        compatible: true,
        tokenAvailable: true,
        canInstall: true,
        canAdopt: false,
        canRemove: installed,
        canEnable: false,
        canDisable: false,
        transport: 'http',
        enabled: true,
      },
    ],
    local: installed
      ? [
          {
            name: 'cyapi-toolbox',
            revision: 'local',
            transport: 'http',
            target: 'http://127.0.0.1:18733/mcp',
            enabled: true,
            managed: true,
            readOnlyReason: null,
            catalogId: 'cyapi-toolbox',
          },
        ]
      : [],
  };
}
Object.assign(globalThis, { isTauri: true });
mockIPC((command, args) => {
  if (command === 'cyapi_mcp_status')
    return {
      running: true,
      port: 18733,
      hasKey: false,
      endpoint: 'http://127.0.0.1:18733/mcp',
    };
  if (command !== 'toolbox') throw new Error(`Unexpected command ${command}`);
  const request = (args as { request: Record<string, any> }).request;
  if (request.action === 'mcp-install') connected[request.workspace] = true;
  if (['mcp-catalog-read', 'mcp-view', 'mcp-install'].includes(request.action))
    return view(request.workspace);
  throw new Error(`Unexpected action ${request.action}`);
});
const { McpConnect } = await import('../src/app/McpConnect');
function Fixture() {
  return (
    <div className="n-settings" style={{ padding: 24 }}>
      <McpConnect />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
