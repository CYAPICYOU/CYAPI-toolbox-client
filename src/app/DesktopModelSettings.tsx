import { useEffect, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { nativeAvailable, nativeCall } from '../lib/api/native';
import { CYAPI_DEFAULT_URL, sameRoute } from '../lib/api/cyapi';
import { useCyapiRoutes } from './useCyapiRoutes';
import { CyapiRoutes } from './CyapiRoutes';
import { apiEndpoint } from '../lib/openai-endpoints';

type Tool = 'dsh' | 'workbuddy' | 'pi' | 'minimax';
interface View {
  version: string;
  revision: string;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  configPath: string;
  api: string;
  models?: string[];
  dataDir?: string;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
type DesktopProtocol = 'openai-responses' | 'openai-completions' | 'anthropic-messages';
const desktopProtocols: DesktopProtocol[] = [
  'openai-responses',
  'openai-completions',
  'anthropic-messages',
];
const desktopProtocolLabels: Record<DesktopProtocol, string> = {
  'openai-responses': 'OpenAI Responses',
  'openai-completions': 'OpenAI Chat Completions',
  'anthropic-messages': 'Anthropic Messages',
};
// WorkBuddy only implements Chat Completions; the other tools accept all three.
const desktopToolProtocols: Record<Tool, DesktopProtocol[]> = {
  dsh: desktopProtocols,
  pi: desktopProtocols,
  minimax: desktopProtocols,
  workbuddy: ['openai-completions'],
};
const workbuddyProtocolNote =
  'WorkBuddy 目前只支持 OpenAI Chat Completions 接口，协议固定为该项，仅作展示、不可切换。';

export function DesktopModelSettings({ tool }: { tool: Tool }) {
  const [view, setView] = useState<View>();
  const [baseUrl, setBaseUrl] = useState(CYAPI_DEFAULT_URL);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [api, setApi] = useState<DesktopProtocol>(desktopToolProtocols[tool][0]);
  const [models, setModels] = useState<string[]>([]);
  const [mode, setMode] = useState<'cyapi' | 'custom'>('cyapi');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [dataDir, setDataDir] = useState('');
  const { view: routes, loading, refresh } = useCyapiRoutes();

  function apply(next: View) {
    setView(next);
    setBaseUrl(next.baseUrl || CYAPI_DEFAULT_URL);
    setMode(
      !next.baseUrl || routes.manifest.routes.some((r) => sameRoute(r.baseUrl, next.baseUrl))
        ? 'cyapi'
        : 'custom',
    );
    setModel(next.model);
    setApi(
      desktopToolProtocols[tool].includes(next.api as DesktopProtocol)
        ? (next.api as DesktopProtocol)
        : desktopToolProtocols[tool][0],
    );
    setModels(next.models ?? []);
    setKey('');
    if (tool === 'minimax' && next.dataDir) setDataDir(next.dataDir);
  }
  async function reload() {
    setBusy(true);
    setNotice(undefined);
    try {
      apply(
        await nativeCall<View>('desktop-model-read', {
          workspace: tool,
          projectPath: tool === 'minimax' ? dataDir : undefined,
        }),
      );
    } catch (error) {
      setView(undefined);
      setNotice({ text: message(error), error: true });
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (nativeAvailable) void reload();
  }, [tool]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!view) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const typedKey = key;
      apply(
        await nativeCall<View>('desktop-model-save', {
          workspace: tool,
          projectPath: tool === 'minimax' ? dataDir : undefined,
          desktopModel: { baseUrl, apiKey: key, model, api, revision: view.revision },
        }),
      );
      // The read view never returns the credential, so keep what was just typed.
      setKey(typedKey);
      if (tool === 'minimax') setModel(model.trim());
      setNotice({
        text:
          tool === 'dsh'
            ? '已保存。新会话可选择该模型；已有会话可能保留原模型。'
            : tool === 'pi'
              ? '已保存 Pi 的新会话默认模型。请在 Pi 中确认模型已加载；已有会话可能保留原模型。'
              : tool === 'minimax'
                ? '已保存。请在 MiniMax Code 中确认模型已加载并手动选择；保存不代表连接测试通过。'
                : '已保存。请在 WorkBuddy 模型选择器中选择该模型。',
        error: false,
      });
    } catch (error) {
      setNotice({ text: message(error), error: true });
    } finally {
      setBusy(false);
    }
  }
  async function discover() {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await nativeCall<{ models: string[] }>('models-list', {
        baseUrl: baseUrl.trim().replace(/\/(chat\/completions|responses|messages)\/?$/, ''),
        apiKey: key,
        modelApi: api === 'anthropic-messages' ? 'anthropic' : 'openai',
      });
      setModels([...new Set([...(view?.models ?? []), ...result.models])]);
      if (!result.models.length)
        setNotice({ text: '服务没有返回模型，请手动填写模型 ID。', error: false });
    } catch (error) {
      setNotice({ text: message(error), error: true });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="n-panel n-codex-panel">
      <div className="n-panel-heading">
        <h2>API 配置</h2>
        <button
          className="n-button"
          disabled={busy || !nativeAvailable}
          onClick={() => void reload()}
        >
          <RefreshCw size={14} />
          重新检测
        </button>
      </div>
      {tool === 'minimax' && (
        <div className="n-config-field n-api-section">
          <label htmlFor="minimax-data-dir">MiniMax Code 实际数据目录</label>
          <input
            id="minimax-data-dir"
            disabled={busy}
            value={dataDir}
            onChange={(e) => {
              setDataDir(e.target.value);
              setView(undefined);
            }}
            placeholder="留空自动检测，或填写数据目录绝对路径"
          />
          <p className="n-config-note">
            自动读取环境变量、桌面目录设置或
            ~/.minimax；也可以指定目录后重新检测。保存前会备份原配置。
          </p>
        </div>
      )}
      {notice && (
        <div
          className={`n-alert ${notice.error ? 'n-error' : 'n-success'}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.text}
        </div>
      )}
      {view && (
        <p className="n-codex-current">
          <span>已检测版本 {view.version}</span>
          <span>API Key 仅保存在本机</span>
        </p>
      )}
      <form onSubmit={save} autoComplete="off">
        <fieldset disabled={busy || !view} className="n-codex-fields">
          <section className="n-api-section n-api-route">
            <div className="n-api-section-heading">
              <h3>线路</h3>
              <div className="n-cyapi-mode" role="group" aria-label="API 服务类型">
                <button
                  type="button"
                  aria-pressed={mode === 'cyapi'}
                  onClick={() => {
                    setMode('cyapi');
                    if (!routes.manifest.routes.some((r) => sameRoute(r.baseUrl, baseUrl)))
                      setBaseUrl(CYAPI_DEFAULT_URL);
                  }}
                >
                  CYAPI 专属
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'custom'}
                  onClick={() => setMode('custom')}
                >
                  自定义服务
                </button>
              </div>
            </div>
            {mode === 'cyapi' ? (
              <CyapiRoutes
                embedded
                view={routes}
                loading={loading}
                disabled={busy || !view}
                value={baseUrl}
                onChange={setBaseUrl}
                onReload={() => void refresh()}
              />
            ) : (
              <div className="n-config-field">
                <label htmlFor="desktop-api-url">API 地址</label>
                <input
                  id="desktop-api-url"
                  type="url"
                  required
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.example.com/v1"
                />
              </div>
            )}
          </section>
          <div className="n-config-field n-api-section">
            <label htmlFor="desktop-api-protocol">API 协议</label>
            <select
              id="desktop-api-protocol"
              value={api}
              onChange={(e) => setApi(e.target.value as DesktopProtocol)}
            >
              {desktopProtocols.map((protocol) => {
                const unsupported = !desktopToolProtocols[tool].includes(protocol);
                return (
                  <option key={protocol} value={protocol} disabled={unsupported}>
                    {desktopProtocolLabels[protocol]}
                    {unsupported ? '（该工具不支持）' : ''}
                  </option>
                );
              })}
            </select>
            <p className="n-config-note">
              实际请求端点：
              <code>
                {apiEndpoint(
                  baseUrl,
                  api as 'openai-completions' | 'openai-responses' | 'anthropic-messages',
                )}
              </code>
            </p>
            {tool === 'workbuddy' && <p className="n-config-note">{workbuddyProtocolNote}</p>}
          </div>
          <div className="n-config-field n-api-section">
            <label htmlFor="desktop-api-key">API Key</label>
            <input
              id="desktop-api-key"
              type="password"
              autoComplete="new-password"
              required={!view?.apiKeyConfigured}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={view?.apiKeyConfigured ? '留空保留已保存的 Key' : '填写 API Key'}
            />
          </div>
          <section className="n-api-section n-api-models">
            <div className="n-config-field">
              <label htmlFor="desktop-model">模型 ID</label>
              <input
                id="desktop-model"
                list="desktop-model-options"
                required
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="填写模型 ID"
              />
              <datalist id="desktop-model-options">
                {models.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <button
                type="button"
                className="n-button"
                disabled={!key.trim() || !baseUrl.trim()}
                onClick={() => void discover()}
              >
                获取可用模型
              </button>
              <p className="n-config-note">获取列表需要重新输入 API Key；也可以直接填写模型 ID。</p>
            </div>
          </section>
        </fieldset>
        <p className="n-config-note">
          保存当前模型配置；请按服务商提供的接口选择协议和 API 地址。
          {tool === 'workbuddy' && 'WorkBuddy 中需手动选择模型。'}
          {tool === 'pi' && 'Pi 将其设为新会话默认模型；项目设置或启动参数可能覆盖默认值。'}
          {tool === 'minimax' && '不会更改默认模型或当前会话，需在 MiniMax Code 中选择。'}
        </p>
        <div className="n-config-savebar">
          <p className="n-config-note">
            {tool === 'dsh'
              ? '仅支持 DeepSeek 官方桌面版'
              : tool === 'pi'
                ? '仅支持官方 Pi Coding Agent'
                : tool === 'minimax'
                  ? '仅支持 MiniMax Code 官方桌面版'
                  : '仅支持腾讯 WorkBuddy 桌面版'}
          </p>
          <button
            className="n-button n-primary"
            disabled={busy || !view || !nativeAvailable}
            type="submit"
          >
            <Save size={15} />
            保存配置
          </button>
        </div>
      </form>
      {view && (
        <details className="n-source-details">
          <summary>配置文件位置</summary>
          <code>{view.configPath}</code>
        </details>
      )}
    </section>
  );
}
