import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleHelp, LoaderCircle, PlugZap, RefreshCw } from 'lucide-react';
import {
  nativeAvailable,
  nativeCall,
  readMcpServerStatus,
  type McpEntryStatus,
  type McpServerStatus,
  type McpView,
} from '../lib/api/native';
import { mcpWorkspaceNames, mcpWorkspaces } from '../lib/mcp-workspaces';

/** The catalog entry that describes the toolbox's own loopback MCP server. */
const CYAPI_SERVER = 'cyapi-toolbox';
type Workspace = McpView['workspace'];
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Settings-level entry for the toolbox MCP server.
 *
 * Management, removal and local entries stay in the per-workspace MCP page;
 * this card only writes the CYAPI entry into the agent the user picks, the
 * same `mcp-install` action that page uses, so receipts, backups and the
 * concurrent-change check all apply.
 */
export function McpConnect() {
  const [server, setServer] = useState<McpServerStatus>();
  const [workspace, setWorkspace] = useState<Workspace>('codex');
  const [view, setView] = useState<McpView>();
  const [agents, setAgents] = useState<Workspace[]>([]);
  const [busy, setBusy] = useState(nativeAvailable ? 'read' : '');
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [attempt, setAttempt] = useState(0);
  const catalogLoaded = useRef(false);
  const agentName = mcpWorkspaceNames[workspace];
  const entry: McpEntryStatus | undefined = view?.entries.find((item) => item.id === CYAPI_SERVER);
  const descriptor = view?.catalog.servers.find((item) => item.id === CYAPI_SERVER);

  // The first read also syncs the catalog, so the card works after a fresh
  // install when the per-workspace page has not been opened yet.
  async function load(target: Workspace): Promise<McpView> {
    if (catalogLoaded.current) return nativeCall<McpView>('mcp-view', { workspace: target });
    try {
      const next = await nativeCall<McpView>('mcp-catalog-read', { workspace: target });
      catalogLoaded.current = true;
      return next;
    } catch {
      // The local configuration stays readable while the catalog is offline.
      catalogLoaded.current = true;
      return nativeCall<McpView>('mcp-view', { workspace: target });
    }
  }

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    void readMcpServerStatus()
      .then((status) => {
        if (active) setServer(status);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    setBusy('read');
    setNotice(undefined);
    void load(workspace)
      .then((next) => {
        if (!active) return;
        setView(next);
        const supported = next.catalog.servers.find((item) => item.id === CYAPI_SERVER)?.workspaces;
        if (supported) {
          const list = mcpWorkspaces.filter((name) => supported.includes(name));
          setAgents([...list]);
          if (list.length && !list.includes(workspace)) setWorkspace(list[0]);
        }
      })
      .catch((error) => {
        if (active) setNotice({ text: errorText(error), error: true });
      })
      .finally(() => {
        if (active) setBusy('');
      });
    return () => {
      active = false;
    };
  }, [workspace, attempt]);

  async function connect() {
    if (!entry) return;
    setBusy('install');
    setNotice(undefined);
    try {
      const next = await nativeCall<McpView>('mcp-install', {
        workspace,
        serverId: CYAPI_SERVER,
        configurationRevision: entry.revision,
      });
      setView(next);
      setNotice({
        text:
          workspace === 'opencode'
            ? `已接入 ${agentName}，配置会自动重新加载。`
            : `已接入 ${agentName}，重启 ${agentName} 后生效。`,
      });
    } catch (error) {
      setNotice({ text: errorText(error), error: true });
    } finally {
      setBusy('');
    }
  }

  const unavailable = ['changed', 'conflict'].includes(entry?.state ?? '');
  const canConnect = !!entry?.canInstall && !unavailable && !!entry.tokenAvailable;

  return (
    <section
      className="n-settings-card n-settings-mcp"
      aria-labelledby="settings-mcp"
      aria-busy={!!busy}
    >
      <div className="n-settings-card-heading">
        <div className="n-settings-section-title">
          <span className="n-settings-icon" aria-hidden="true">
            <PlugZap size={18} />
          </span>
          <h2 id="settings-mcp">AI 连接（MCP）</h2>
        </div>
        {nativeAvailable && server && (
          <span
            className={`n-pill ${server.running ? 'n-ready' : 'n-warning'}`}
            title={server.endpoint ?? undefined}
          >
            {server.running ? '服务运行中' : '服务未启动'}
          </span>
        )}
      </div>

      {!nativeAvailable ? (
        <p className="n-settings-description">请在桌面版接入 AI 客户端。</p>
      ) : (
        <>
          <div className="n-settings-mcp-connect">
            <select
              className="n-settings-select"
              aria-label="选择要接入的 AI 客户端"
              value={workspace}
              disabled={!agents.length || !!busy}
              onChange={(event) => {
                setNotice(undefined);
                setWorkspace(event.target.value as Workspace);
              }}
            >
              {agents.map((name) => (
                <option key={name} value={name}>
                  {mcpWorkspaceNames[name]}
                </option>
              ))}
            </select>
            <button
              className="n-button n-primary"
              disabled={!canConnect || !!busy}
              onClick={() => void connect()}
            >
              {busy === 'install' ? (
                <LoaderCircle size={14} className="n-spin" />
              ) : (
                <PlugZap size={14} />
              )}
              {busy === 'install' ? '正在接入…' : `一键接入 ${agentName}`}
            </button>
          </div>

          <div className="n-settings-mcp-state" role="status">
            {entry?.installed ? (
              <>
                <CheckCircle2 size={14} aria-hidden="true" />
                <span>
                  已接入 {agentName}
                  {entry.enabled ? '' : '（已停用）'}
                </span>
                {view?.configPath && <code>{view.configPath}</code>}
              </>
            ) : busy === 'read' ? (
              <>
                <LoaderCircle size={14} className="n-spin" aria-hidden="true" />
                <span>正在读取 {agentName} 的配置…</span>
              </>
            ) : descriptor ? (
              <>
                <CircleHelp size={14} aria-hidden="true" />
                <span>尚未接入 {agentName}</span>
              </>
            ) : (
              <>
                <CircleHelp size={14} aria-hidden="true" />
                <span>暂无法读取接入状态</span>
              </>
            )}
          </div>

          {unavailable && (
            <p className="n-error-text" role="alert">
              同名配置与本机目录不一致，请在「MCP 管理」中检查后再接入。
            </p>
          )}
          {entry && !entry.tokenAvailable && (
            <p className="n-error-text" role="alert">
              未生成工具箱访问令牌，请稍后重试。
            </p>
          )}
          {!descriptor && !busy && (
            <div className="n-offline-note" role="status">
              <CircleHelp size={16} />
              <span>MCP 目录暂不可用，无法读取可用客户端。</span>
              <button
                onClick={() => {
                  catalogLoaded.current = false;
                  setAttempt((value) => value + 1);
                }}
              >
                <RefreshCw size={13} /> 重试
              </button>
            </div>
          )}
          {notice && (
            <div
              className={`n-alert ${notice.error ? 'n-error' : 'n-success'}`}
              role={notice.error ? 'alert' : 'status'}
            >
              {notice.error ? <CircleHelp size={16} /> : <CheckCircle2 size={16} />}
              <span>{notice.text}</span>
              <button onClick={() => setNotice(undefined)} aria-label="关闭提示">
                ×
              </button>
            </div>
          )}
          {server && (!server.running || !server.hasKey) && (
            <p className="n-settings-caption">
              {!server.running &&
                '本机 MCP 服务未启动；接入仍会写入地址与令牌，服务恢复后即可使用。'}
              {!server.hasKey && ' 在「工作流」页激活 API Key 后，工具调用才能执行任务。'}
            </p>
          )}
        </>
      )}
    </section>
  );
}
