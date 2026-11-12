import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, Save } from 'lucide-react';
import { nativeAvailable, nativeCall } from '../../lib/api/native';
import type { AlmaConfiguration } from '../../lib/api/native';
import { openExternal } from '../../lib/api/update';
import { CYAPI_DEFAULT_URL, sameRoute } from '../../lib/api/cyapi';
import { useCyapiRoutes } from '../../app/useCyapiRoutes';
import { CyapiRoutes } from '../../app/CyapiRoutes';
import { apiEndpoint } from '../../lib/openai-endpoints';

const ALMA_DOCS = 'https://alma.now/docs/zh/settings/providers';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function AlmaModelSettings() {
  const [view, setView] = useState<AlmaConfiguration>();
  const [baseUrl, setBaseUrl] = useState(CYAPI_DEFAULT_URL);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [mode, setMode] = useState<'cyapi' | 'custom'>('cyapi');
  const [busy, setBusy] = useState(nativeAvailable);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const { view: routes, loading, refresh } = useCyapiRoutes();

  function apply(next: AlmaConfiguration) {
    setView(next);
    setBaseUrl(next.baseUrl || CYAPI_DEFAULT_URL);
    setMode(
      !next.baseUrl || routes.manifest.routes.some((route) => sameRoute(route.baseUrl, next.baseUrl))
        ? 'cyapi'
        : 'custom',
    );
    setModel(next.model);
    setModels(next.models ?? []);
    setApiKey('');
  }

  async function reload() {
    setBusy(true);
    setNotice(undefined);
    try {
      apply(await nativeCall<AlmaConfiguration>('harness-model-read', { workspace: 'alma' }));
    } catch (error) {
      setView(undefined);
      setNotice({ text: errorText(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (nativeAvailable) void reload();
    else setBusy(false);
  }, []);

  async function discover() {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await nativeCall<{ models: string[] }>('models-list', {
        baseUrl: baseUrl
          .trim()
          .replace(/\/(chat\/completions|responses|messages)\/?$/, ''),
        apiKey,
        modelApi: 'openai',
      });
      setModels([...new Set([...(view?.models ?? []), ...result.models])]);
      setNotice({
        text: result.models.length
          ? `已获取 ${result.models.length} 个模型。模型列表成功不代表 Alma 调用已验证。`
          : '服务未返回模型，请手动填写模型 ID。',
      });
    } catch (error) {
      setNotice({ text: errorText(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!view) return;
    setBusy(true);
    setNotice(undefined);
    try {
      apply(
        await nativeCall<AlmaConfiguration>('harness-model-save', {
          workspace: 'alma',
          harnessModel: {
            baseUrl,
            apiKey,
            model,
            api: 'openai-completions',
            revision: view.revision,
          },
        }),
      );
      setNotice({ text: '已写入 Alma 的 CYAPI Toolbox 服务商，并设置默认模型。' });
    } catch (error) {
      setNotice({ text: errorText(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="n-panel n-codex-panel">
      <div className="n-panel-heading">
        <h2>Alma · 模型接入</h2>
        <div className="n-config-savebar">
          <button className="n-button" disabled={busy} onClick={() => void openExternal(ALMA_DOCS)}>
            <ExternalLink size={14} />
            官方说明
          </button>
          <button
            className="n-button"
            disabled={busy || !nativeAvailable}
            onClick={() => void reload()}
          >
            <RefreshCw size={14} />
            重新读取
          </button>
        </div>
      </div>
      <p className="n-config-note">
        Alma 需要保持运行。客户端通过 Alma 的本机接口管理服务商，不直接改写 Alma 数据库；API Key
        仅发送给本机 Alma，不会回显到界面。
      </p>
      {notice && (
        <div className={`n-alert ${notice.error ? 'n-error' : 'n-success'}`} role="status">
          {notice.text}
        </div>
      )}
      {!nativeAvailable && <p className="n-alert">请在桌面版中配置 Alma。</p>}
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
                    if (!routes.manifest.routes.some((route) => sameRoute(route.baseUrl, baseUrl)))
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
                <label htmlFor="alma-api-url">API 地址</label>
                <input
                  id="alma-api-url"
                  type="url"
                  required
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                />
              </div>
            )}
          </section>
          <div className="n-config-field n-api-section">
            <label>API 协议</label>
            <p className="n-config-note">
              OpenAI Chat Completions · 实际请求端点：
              <code>{apiEndpoint(baseUrl, 'openai-completions')}</code>
            </p>
          </div>
          <div className="n-config-field n-api-section">
            <label htmlFor="alma-api-key">API Key</label>
            <input
              id="alma-api-key"
              type="password"
              autoComplete="new-password"
              required={!view?.apiKeyConfigured}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={view?.apiKeyConfigured ? '留空保留 Alma 中已保存的 Key' : '填写 API Key'}
              spellCheck={false}
            />
          </div>
          <section className="n-api-section n-api-models">
            <div className="n-config-field">
              <label htmlFor="alma-model">模型 ID</label>
              <input
                id="alma-model"
                list="alma-model-options"
                required
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="填写服务商提供的模型 ID"
              />
              <datalist id="alma-model-options">
                {models.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <button
                type="button"
                className="n-button"
                disabled={!apiKey.trim() || !baseUrl.trim()}
                onClick={() => void discover()}
              >
                获取可用模型
              </button>
              <p className="n-config-note">
                Alma 的自定义服务商支持手动添加模型；获取列表需要重新输入 API Key。
              </p>
            </div>
          </section>
        </fieldset>
        <div className="n-config-savebar">
          <p className="n-config-note">保存后请在 Alma 新建聊天并确认默认模型。</p>
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
    </section>
  );
}
