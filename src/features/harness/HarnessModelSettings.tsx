import { useEffect, useState } from 'react';
import { Copy, ExternalLink, RefreshCw, RotateCcw, Save } from 'lucide-react';
import { nativeAvailable, nativeCall } from '../../lib/api/native';
import { openExternal } from '../../lib/api/update';
import { CYAPI_DEFAULT_URL, sameRoute } from '../../lib/api/cyapi';
import { useCyapiRoutes } from '../../app/useCyapiRoutes';
import { CyapiRoutes } from '../../app/CyapiRoutes';
import {
  harnesses,
  modelProtocols,
  protocolLabels,
  type HarnessTool,
  type ModelProtocol,
} from './catalog';
import { apiEndpoint } from '../../lib/openai-endpoints';

interface View {
  revision: string;
  baseUrl: string;
  model: string;
  api: ModelProtocol;
  apiKeyConfigured: boolean;
  files: { path: string; exists: boolean }[];
  canRestore: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export function HarnessModelSettings({ tool }: { tool: HarnessTool }) {
  const spec = harnesses.find((item) => item.id === tool)!;
  const manual = tool === 'cursor';
  const [view, setView] = useState<View>();
  const [baseUrl, setBaseUrl] = useState(
    tool === 'gemini' ? 'https://generativelanguage.googleapis.com' : CYAPI_DEFAULT_URL,
  );
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [api, setApi] = useState<ModelProtocol>(spec.protocols[0] ?? 'openai-completions');
  const [contextWindow, setContextWindow] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [mode, setMode] = useState<'cyapi' | 'custom'>(tool === 'gemini' ? 'custom' : 'cyapi');
  const { view: routes, loading, refresh } = useCyapiRoutes();
  const limits = ['kilo', 'kimi', 'grok'].includes(tool);
  // Harness adapters still show every wire protocol; unsupported ones are
  // disabled and labelled so the restriction is visible instead of hidden.
  const shownProtocols: readonly ModelProtocol[] =
    tool === 'gemini' ? ['gemini'] : modelProtocols.filter((p) => p !== 'gemini');
  const protocolNote =
    tool === 'aider'
      ? 'Aider 通过 OpenAI 兼容接口使用 Chat Completions，协议固定为该项，仅作展示、不可切换。'
      : undefined;

  function apply(next: View) {
    setView(next);
    setBaseUrl(
      next.baseUrl ||
        (tool === 'gemini' ? 'https://generativelanguage.googleapis.com' : CYAPI_DEFAULT_URL),
    );
    setMode(
      tool !== 'gemini' &&
        (!next.baseUrl || routes.manifest.routes.some((r) => sameRoute(r.baseUrl, next.baseUrl)))
        ? 'cyapi'
        : 'custom',
    );
    setApi(next.api);
    setModel(next.model);
    setContextWindow(next.contextWindow?.toString() ?? '');
    setMaxTokens(next.maxTokens?.toString() ?? '');
    setApiKey('');
    setModels([]);
  }

  async function act(job: () => Promise<void>) {
    setBusy(true);
    setNotice(undefined);
    try {
      await job();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    setView(undefined);
    await act(async () => apply(await nativeCall<View>('harness-model-read', { workspace: tool })));
  }

  useEffect(() => {
    if (nativeAvailable && !manual) void reload();
  }, [tool]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!view) return;
    await act(async () => {
      // The read/save view only reports whether a key exists; keep the value the
      // user just typed so saving does not look like it dropped the credential.
      const typedKey = apiKey;
      apply(
        await nativeCall<View>('harness-model-save', {
          workspace: tool,
          harnessModel: {
            baseUrl,
            apiKey,
            model,
            api,
            revision: view.revision,
            contextWindow: limits && contextWindow ? Number(contextWindow) : undefined,
            maxTokens: limits && tool !== 'kimi' && maxTokens ? Number(maxTokens) : undefined,
          },
        }),
      );
      setApiKey(typedKey);
      setNotice({ text: '配置已保存并备份。请在目标工具中新建会话确认模型生效。' });
    });
  }

  return (
    <section className="n-panel n-codex-panel">
      <div className="n-panel-heading">
        <h2>{manual ? 'Cursor 接入指引' : `${spec.name} · 模型接入`}</h2>
        <div className="n-config-savebar">
          <button className="n-button" onClick={() => void act(() => openExternal(spec.docs))}>
            <ExternalLink size={14} />
            官方说明
          </button>
          {!manual && (
            <button
              className="n-button"
              disabled={busy || !nativeAvailable}
              onClick={() => void reload()}
            >
              <RefreshCw size={14} />
              重新读取
            </button>
          )}
        </div>
      </div>
      <p className="n-config-note">{spec.note}</p>
      {notice && (
        <div
          className={`n-alert ${notice.error ? 'n-error' : 'n-success'}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.text}
        </div>
      )}
      {!nativeAvailable && !manual && <p className="n-alert">请在桌面版读写本机配置。</p>}
      {manual ? (
        <div className="n-api-section">
          <ol>
            <li>打开 Cursor Settings → Models，找到对应服务商。</li>
            <li>填写 API Key；如当前版本提供 Override OpenAI Base URL，可填写下方线路地址。</li>
            <li>保存并验证，在新会话中选择可用模型。</li>
          </ol>
          <CyapiRoutes
            embedded
            view={routes}
            loading={loading}
            disabled={busy}
            value={baseUrl}
            onChange={setBaseUrl}
            onReload={() => void refresh()}
          />
          <button
            className="n-button"
            onClick={() =>
              void act(async () => {
                await navigator.clipboard.writeText(baseUrl);
                setNotice({ text: '线路地址已复制。' });
              })
            }
          >
            <Copy size={14} />
            复制线路地址
          </button>
          <p className="n-config-note">此入口提供配置指引，API Key 请直接填写到 Cursor。</p>
        </div>
      ) : (
        <form onSubmit={save} autoComplete="off">
          <fieldset disabled={busy || !view} className="n-codex-fields">
            <section className="n-api-section">
              <div className="n-api-section-heading">
                <h3>API 地址</h3>
                {tool !== 'gemini' && (
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
                )}
              </div>
              {mode === 'cyapi' && tool !== 'gemini' ? (
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
                  <label htmlFor="harness-url">
                    {tool === 'gemini' ? 'Gemini API 根地址' : 'Base URL'}
                  </label>
                  <input
                    id="harness-url"
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
              <label htmlFor="harness-api">API 协议</label>
              <select
                id="harness-api"
                value={api}
                onChange={(e) => setApi(e.target.value as ModelProtocol)}
              >
                {shownProtocols.map((p) => {
                  const unsupported = !(spec.protocols as readonly string[]).includes(p);
                  return (
                    <option key={p} value={p} disabled={unsupported}>
                      {protocolLabels[p]}
                      {unsupported ? '（该工具不支持）' : ''}
                    </option>
                  );
                })}
              </select>
              {api !== 'gemini' && (
                <p className="n-config-note">
                  实际请求端点：<code>{apiEndpoint(baseUrl, api)}</code>
                </p>
              )}
              {protocolNote && <p className="n-config-note">{protocolNote}</p>}
            </div>
            <div className="n-config-field n-api-section">
              <label htmlFor="harness-key">API Key</label>
              <input
                id="harness-key"
                type="password"
                autoComplete="new-password"
                required={!view?.apiKeyConfigured}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  view?.apiKeyConfigured
                    ? '留空保留已保存的 Key；更换地址或协议时需重新填写'
                    : '填写 API Key'
                }
              />
            </div>
            <div className="n-config-field n-api-section">
              <label htmlFor="harness-model">模型 ID</label>
              <input
                id="harness-model"
                required
                list="harness-models"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="填写服务商提供的模型 ID"
              />
              <datalist id="harness-models">
                {models.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              {tool !== 'gemini' && (
                <button
                  className="n-button"
                  type="button"
                  disabled={!apiKey.trim() || !baseUrl.trim()}
                  onClick={() =>
                    void act(async () => {
                      const result = await nativeCall<{ models: string[] }>('models-list', {
                        baseUrl: baseUrl
                          .trim()
                          .replace(/\/(chat\/completions|responses|messages)\/?$/, ''),
                        apiKey,
                        modelApi: api === 'anthropic-messages' ? 'anthropic' : 'openai',
                      });
                      setModels(result.models);
                      setNotice({
                        text: result.models.length
                          ? `已获取 ${result.models.length} 个模型。模型列表成功不代表工具调用已验证。`
                          : '服务未返回模型，请手动填写。',
                      });
                    })
                  }
                >
                  获取可用模型
                </button>
              )}
            </div>
            {limits && (
              <section className="n-api-section">
                <div className="n-config-field">
                  <label htmlFor="harness-context">上下文窗口（tokens）</label>
                  <input
                    id="harness-context"
                    type="number"
                    min="1"
                    max="9007199254740991"
                    step="1"
                    required
                    value={contextWindow}
                    onChange={(e) => setContextWindow(e.target.value)}
                    placeholder="填写模型实际支持的上限"
                  />
                </div>
                {tool !== 'kimi' && (
                  <div className="n-config-field">
                    <label htmlFor="harness-output">最大输出（tokens）</label>
                    <input
                      id="harness-output"
                      type="number"
                      min="1"
                      max="9007199254740991"
                      step="1"
                      required
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(e.target.value)}
                      placeholder="填写模型实际支持的上限"
                    />
                  </div>
                )}
              </section>
            )}
          </fieldset>
          <div className="n-config-savebar">
            <p className="n-config-note">配置与备份仅保存在本机。保存会合并已有配置。</p>
            <button
              type="button"
              className="n-button"
              disabled={busy || !view?.canRestore || !nativeAvailable}
              onClick={() =>
                void act(async () => {
                  apply(
                    await nativeCall<View>('harness-model-restore', {
                      workspace: tool,
                      configurationRevision: view?.revision,
                    }),
                  );
                  setNotice({ text: '已恢复上次保存前的文件。' });
                })
              }
            >
              <RotateCcw size={14} />
              恢复上次配置
            </button>
            <button
              type="submit"
              className="n-button n-primary"
              disabled={busy || !view || !nativeAvailable}
            >
              <Save size={14} />
              保存配置
            </button>
          </div>
        </form>
      )}
      {view && (
        <details className="n-source-details">
          <summary>配置文件位置</summary>
          {view.files.map((file) => (
            <p key={file.path}>
              <code>{file.path}</code> {file.exists ? '已存在' : '保存时创建'}{' '}
              <button
                className="n-button"
                onClick={() =>
                  void act(async () => {
                    await navigator.clipboard.writeText(file.path);
                    setNotice({ text: '文件路径已复制。' });
                  })
                }
              >
                <Copy size={12} />
                复制
              </button>
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
