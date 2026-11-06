import { useEffect, useState } from 'react';
import { nativeAvailable, nativeCall } from '../lib/api/native';

interface View {
  revision: string;
  configPath: string;
  servers: { name: string; transport: string; enabled: boolean }[];
}

export function PiMcpManager() {
  const [view, setView] = useState<View>();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [env, setEnv] = useState('');
  const [headers, setHeaders] = useState('');
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  async function load() {
    setBusy(true);
    try {
      setView(await nativeCall<View>('pi-mcp-read'));
      setNotice('');
    } catch (error) {
      setView(undefined);
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (nativeAvailable) void load();
  }, []);
  async function change(action: string, data: Record<string, unknown>) {
    if (!view) return;
    setBusy(true);
    setNotice('');
    try {
      setView(await nativeCall<View>(action, { values: { ...data, revision: view.revision } }));
      setNotice('配置已保存。请在 Pi 中执行 /reload；保存不代表连接成功。');
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (
      !window.confirm('添加 MCP 后，Pi 可能在启动时执行该程序或连接服务。请确认来源可信。继续吗？')
    )
      return;
    let fields: Record<string, string>;
    try {
      const value: unknown = JSON.parse((transport === 'stdio' ? env : headers).trim() || '{}');
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.values(value).some((v) => typeof v !== 'string')
      )
        throw new Error('请填写值为字符串的 JSON 对象。');
      fields = value as Record<string, string>;
    } catch (error) {
      setNotice(`环境变量或请求头格式错误：${String(error)}`);
      return;
    }
    await change('pi-mcp-save', {
      name,
      transport,
      command,
      args: args
        .split('\n')
        .map((s) => s.replace(/\r$/, ''))
        .filter((s) => s !== ''),
      url,
      ...(transport === 'stdio' ? { env: fields, cwd } : { headers: fields }),
    });
  }
  return (
    <section className="n-panel n-codex-panel">
      <div className="n-panel-heading">
        <h2>Pi MCP 管理</h2>
        <button
          className="n-button"
          disabled={busy || !nativeAvailable}
          onClick={() => void load()}
        >
          重新读取
        </button>
      </div>
      {notice && (
        <div className="n-alert" role="status">
          {notice}
        </div>
      )}
      <p className="n-config-note">
        仅管理用户级 mcp.json；项目配置和扩展可能覆盖它。不会自动连接服务或显示现有密钥。
      </p>
      {view && (
        <>
          <div className="n-record-list">
            {view.servers.map((server) => (
              <article className="n-record" key={server.name}>
                <div>
                  <h2>{server.name}</h2>
                  <p className="n-config-note">
                    {server.transport} · {server.enabled ? '已启用' : '已停用'}
                  </p>
                </div>
                <button
                  className="n-button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`${server.enabled ? '停用' : '启用'} ${server.name}？`))
                      void change('pi-mcp-toggle', { name: server.name, enabled: !server.enabled });
                  }}
                >
                  {server.enabled ? '停用' : '启用'}
                </button>
                <button
                  className="n-button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`删除 ${server.name} 的本地配置？不会卸载服务。`))
                      void change('pi-mcp-remove', { name: server.name });
                  }}
                >
                  移除
                </button>
              </article>
            ))}
          </div>
          <form onSubmit={(event) => void add(event)} autoComplete="off">
            <fieldset disabled={busy} className="n-codex-fields">
              <div className="n-config-field">
                <label htmlFor="pi-mcp-name">新增服务名称</label>
                <input
                  id="pi-mcp-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="n-config-field">
                <label htmlFor="pi-mcp-transport">传输方式</label>
                <select
                  id="pi-mcp-transport"
                  value={transport}
                  onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}
                >
                  <option value="stdio">本地程序 stdio</option>
                  <option value="http">远程 Streamable HTTP</option>
                </select>
              </div>
              {transport === 'stdio' ? (
                <>
                  <div className="n-config-field">
                    <label htmlFor="pi-mcp-command">程序</label>
                    <input
                      id="pi-mcp-command"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      required
                    />
                  </div>
                  <div className="n-config-field">
                    <label htmlFor="pi-mcp-args">参数（每行一个）</label>
                    <textarea
                      id="pi-mcp-args"
                      value={args}
                      onChange={(e) => setArgs(e.target.value)}
                    />
                  </div>
                  <div className="n-config-field">
                    <label htmlFor="pi-mcp-cwd">工作目录（可选）</label>
                    <input id="pi-mcp-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} />
                  </div>
                  <div className="n-config-field">
                    <label htmlFor="pi-mcp-env">环境变量（JSON，可选）</label>
                    <textarea
                      id="pi-mcp-env"
                      value={env}
                      onChange={(e) => setEnv(e.target.value)}
                      placeholder={'{"API_KEY":"${MY_API_KEY}"}'}
                      spellCheck={false}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="n-config-field">
                    <label htmlFor="pi-mcp-url">服务 URL</label>
                    <input
                      id="pi-mcp-url"
                      type="url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      required
                    />
                  </div>
                  <div className="n-config-field">
                    <label htmlFor="pi-mcp-headers">请求头（JSON，可选）</label>
                    <textarea
                      id="pi-mcp-headers"
                      value={headers}
                      onChange={(e) => setHeaders(e.target.value)}
                      placeholder={'{"Authorization":"Bearer ${MY_TOKEN}"}'}
                      spellCheck={false}
                    />
                  </div>
                </>
              )}
            </fieldset>
            <p className="n-config-note">
              环境变量和请求头支持 Pi 的 ${'{NAME}'} 引用语法；OAuth 登录请在 Pi 中完成。
            </p>
            <button className="n-button n-primary" type="submit" disabled={busy}>
              添加 MCP
            </button>
          </form>
          <details className="n-source-details">
            <summary>配置文件位置</summary>
            <code>{view.configPath}</code>
          </details>
        </>
      )}
    </section>
  );
}
