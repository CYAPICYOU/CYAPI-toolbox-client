import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronRight,
  Database,
  FileText,
  GitBranch,
  LoaderCircle,
  Search,
} from 'lucide-react';
import { LogCoverage, LogDetailModal, LogEvents, LogFilters, LogHeader, LogTabs } from './LogAnalysisShared';
import type { LogTab } from './LogAnalysisShared';
import { localAgentLogClient } from '../lib/api/agentLogs';
import type {
  AgentLogClient,
  AgentLogDetail,
  AgentLogEvent,
  AgentLogPage,
  AgentLogQuery,
  AgentLogSnapshot,
  LogIssue,
  LogSession,
  LogSessionDetail,
  LogStats,
  LogWorkspace,
} from '../lib/api/agentLogs';
import './diagnostics.css';
import './codex-analysis.css';
import './agent-log-analysis.css';

const kinds: Record<string, string> = {
  response: '模型响应',
  api_error: 'API 错误',
  retry: '重试',
  tool: '工具调用',
  tool_result: '工具返回',
  compaction: '上下文压缩',
  user_turn: '用户回合',
  turn_duration: '回合耗时',
  idle: '会话空闲',
  step: '模型步骤',
  http: '运行日志 HTTP',
  mcp: 'MCP',
  runtime: '运行事件',
};
const roles: Record<string, string> = {
  conversation: '会话记录',
  index: '会话索引',
  subagent: '子代理',
  runtime: '运行日志',
  legacy: '旧版存储',
};
const date = (n: number) => (n ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '未记录');
const num = (n: number) => n.toLocaleString('zh-CN');
const bytes = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
const title = (s: LogSession) => s.title.trim() || s.id;
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Usage({ stats, workspace }: { stats: LogStats; workspace: LogWorkspace }) {
  if (!stats.usageRecords) return <p className="ca-empty">当前读取范围内没有用量记录。</p>;
  return (
    <>
      <div className="ca-usage">
        {[
          ['输入', stats.tokens.input],
          ['输出', stats.tokens.output],
          ['缓存读取 · 已含在输入', stats.tokens.cacheRead],
          ['缓存创建 · 已含在输入', stats.tokens.cacheWrite],
          workspace === 'claude'
            ? ['其中 1 小时缓存创建', stats.tokens.cacheWrite1h]
            : ['推理 · 已含在输出', stats.tokens.reasoning],
        ].map(([label, n]) => (
          <div key={label}>
            <small>{label}</small>
            <strong>{num(Number(n))}</strong>
          </div>
        ))}
      </div>
      <p className="ca-read-scope">
        {num(stats.usageRecords)}{' '}
        条用量记录的合计，只覆盖当前时间窗及已读取部分。缓存和推理子项已含在输入、输出中。
      </p>
    </>
  );
}
function Events({
  events,
  onOpen,
  onSession,
}: {
  events: AgentLogEvent[];
  onOpen: (id: string) => void;
  onSession: (id: string) => void;
}) {
  return <LogEvents rows={events.map(e => ({
    id: e.id, time: e.time, sessionId: e.sessionId, model: e.model,
    severity: e.failed || e.level === 'ERROR' ? 'error' : e.level === 'WARN' ? 'warn' : '',
    label: String(e.status ?? kinds[e.kind] ?? e.kind), summary: e.summary,
  }))} onOpen={onOpen} onSession={onSession} />;
}
function Issue({
  issue,
  onOpen,
  onSession,
}: {
  issue: LogIssue;
  onOpen: (id: string) => void;
  onSession: (id: string) => void;
}) {
  return (
    <details className="ca-issue">
      <summary>
        <AlertCircle size={17} />
        <span>
          <strong>{issue.title}</strong>
          <small>
            {num(issue.count)} 条记录 · 最近 {date(issue.lastAt)}
          </small>
        </span>
        <ChevronRight size={16} className="d-chevron" />
      </summary>
      <div className="ca-issue-body">
        <p>{issue.advice}</p>
        <small>证据条数可能来自同一次故障；归类是排查线索。</small>
        <div className="ca-actions">
          {issue.eventIds.map((id, i) => (
            <button key={id} className="x-link" onClick={() => onOpen(id)}>
              查看记录 {i + 1}
            </button>
          ))}
          {issue.sessionIds.slice(0, 3).map((id) => (
            <button key={id} className="x-link ca-mono" onClick={() => onSession(id)}>
              会话 {id.slice(0, 10)}
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}

export function AgentLogAnalysis({
  workspace,
  client = localAgentLogClient,
}: {
  workspace: LogWorkspace;
  client?: AgentLogClient;
}) {
  const name = workspace === 'claude' ? 'Claude Code' : 'OpenCode';
  const [snapshot, setSnapshot] = useState<AgentLogSnapshot>();
  const [windowSeconds, setWindowSeconds] = useState(86400);
  const [tab, setTab] = useState<LogTab>('overview');
  const [busy, setBusy] = useState(false),
    [live, setLive] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [search, setSearch] = useState(''),
    [needle, setNeedle] = useState('');
  const [kind, setKind] = useState(''),
    [level, setLevel] = useState('');
  const [sessionFilter, setSessionFilter] = useState(''),
    [sourceFilter, setSourceFilter] = useState('');
  const [failed, setFailed] = useState(false),
    [page, setPage] = useState<AgentLogPage>();
  const [eventsBusy, setEventsBusy] = useState(false);
  const [sessionSearch, setSessionSearch] = useState(''),
    [selectedSession, setSelectedSession] = useState('');
  const [session, setSession] = useState<LogSessionDetail>(),
    [sessionBusy, setSessionBusy] = useState(false),
    [sessionError, setSessionError] = useState('');
  const [detail, setDetail] = useState<AgentLogDetail>(),
    [detailBusy, setDetailBusy] = useState(false),
    [detailError, setDetailError] = useState('');
  const [evidenceOpen, setEvidenceOpen] = useState(false),
    [exporting, setExporting] = useState(false);
  const refreshTicket = useRef(0),
    eventsTicket = useRef(0),
    detailTicket = useRef(0);
  const refreshPending = useRef(false);
  const evidenceTarget = useRef('');

  const refresh = useCallback(async () => {
    if (!client.available || refreshPending.current) return;
    const ticket = ++refreshTicket.current;
    refreshPending.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await client.analyze(workspace, windowSeconds);
      if (ticket === refreshTicket.current) {
        setSnapshot(next);
      }
    } catch (e) {
      if (ticket === refreshTicket.current) setError(reason(e));
    } finally {
      if (ticket === refreshTicket.current) {
        setBusy(false);
        refreshPending.current = false;
      }
    }
  }, [workspace, windowSeconds, client]);
  useEffect(() => {
    refreshPending.current = false;
    setSnapshot(undefined);
    setPage(undefined);
    setSession(undefined);
    setNotice('');
    void refresh();
    return () => {
      refreshTicket.current++;
      detailTicket.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (!live || !client.available) return;
    const timer = window.setInterval(() => {
      if (!refreshPending.current && !evidenceOpen && !exporting) void refresh();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [live, refresh, client.available, evidenceOpen, exporting]);
  useEffect(() => {
    const timer = window.setTimeout(() => setNeedle(search.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [search]);
  const query = useMemo<AgentLogQuery>(
    () => ({
      search: needle || undefined,
      kind: tab === 'activity' ? 'response' : kind || undefined,
      level: level || undefined,
      sessionId: sessionFilter || undefined,
      sourceId: sourceFilter || undefined,
      failed: failed || undefined,
    }),
    [needle, tab, kind, level, sessionFilter, sourceFilter, failed],
  );
  useEffect(() => {
    const ticket = ++eventsTicket.current;
    setPage(undefined);
    if (!snapshot || (tab !== 'events' && tab !== 'activity')) {
      setEventsBusy(false);
      return;
    }
    setEventsBusy(true);
    void client
      .events(workspace, snapshot.id, query)
      .then((next) => {
        if (ticket === eventsTicket.current) setPage(next);
      })
      .catch((e) => {
        if (ticket === eventsTicket.current) setError(reason(e));
      })
      .finally(() => {
        if (ticket === eventsTicket.current) setEventsBusy(false);
      });
    return () => {
      eventsTicket.current++;
    };
  }, [snapshot, tab, query, client, workspace]);
  async function more() {
    if (!snapshot || eventsBusy || page?.nextOffset == null) return;
    const ticket = ++eventsTicket.current;
    setEventsBusy(true);
    try {
      const next = await client.events(workspace, snapshot.id, query, page.nextOffset);
      if (ticket === eventsTicket.current)
        setPage((prev) => ({ ...next, events: [...(prev?.events ?? []), ...next.events] }));
    } catch (e) {
      if (ticket === eventsTicket.current) setError(reason(e));
    } finally {
      if (ticket === eventsTicket.current) setEventsBusy(false);
    }
  }
  const sessions = useMemo(
    () =>
      snapshot?.sessions.filter((s) =>
        `${s.title} ${s.id} ${s.project} ${s.model} ${s.provider} ${s.agent}`
          .toLowerCase()
          .includes(sessionSearch.trim().toLowerCase()),
      ) ?? [],
    [snapshot, sessionSearch],
  );
  const active = sessions.find((s) => s.id === selectedSession) ?? sessions[0];
  useEffect(() => {
    setSession(undefined);
    setSessionError('');
    if (!snapshot || tab !== 'sessions' || !active) {
      setSessionBusy(false);
      return;
    }
    let current = true;
    setSessionBusy(true);
    void client
      .session(workspace, snapshot.id, active.id)
      .then((next) => {
        if (current) setSession(next);
      })
      .catch((e) => {
        if (current) setSessionError(reason(e));
      })
      .finally(() => {
        if (current) setSessionBusy(false);
      });
    return () => {
      current = false;
    };
  }, [snapshot, tab, active?.id, client, workspace]);
  function openSession(id: string) {
    if (!snapshot?.sessions.some((s) => s.id === id)) {
      setNotice(`会话 ${id} 未包含在当前读取范围，可扩大时间范围后刷新。`);
      return;
    }
    setSessionSearch('');
    setSelectedSession(id);
    setTab('sessions');
  }
  async function evidence(id: string) {
    if (!snapshot) return;
    evidenceTarget.current = id;
    const ticket = ++detailTicket.current;
    setEvidenceOpen(true);
    setDetailBusy(true);
    setDetail(undefined);
    setDetailError('');
    try {
      const next = await client.detail(workspace, snapshot.id, id);
      if (ticket === detailTicket.current) setDetail(next);
    } catch (e) {
      if (ticket === detailTicket.current) setDetailError(reason(e));
    } finally {
      if (ticket === detailTicket.current) setDetailBusy(false);
    }
  }
  function closeEvidence() {
    detailTicket.current++;
    setEvidenceOpen(false);
    setDetailBusy(false);
    setDetail(undefined);
  }
  function resetFilters() {
    setSearch(''); setNeedle(''); setSessionFilter(''); setSourceFilter('');
    setKind(''); setLevel(''); setFailed(false);
  }
  function changeTab(next: LogTab) { resetFilters(); setTab(next); }
  async function saveReport() {
    if (!snapshot || exporting) return;
    setExporting(true);
    setNotice('');
    try {
      const result = await client.export(
        workspace,
        snapshot.id,
        tab === 'sessions' ? active?.id : undefined,
      );
      setNotice(`报告已保存：${result.path}`);
    } catch (e) {
      setError(reason(e));
    } finally {
      setExporting(false);
    }
  }
  function showSource(id: string) {
    resetFilters();
    setSourceFilter(id);
    setTab('events');
  }
  const fileSources =
    snapshot?.sources.filter(
      (s) => /\.(jsonl|json|db|log|txt)$/i.test(s.path) && s.role !== 'index',
    ) ?? [];
  const totals = snapshot?.totals;
  const eventProps = { onOpen: (id: string) => void evidence(id), onSession: openSession };

  return (
    <div className={`ca-page al-page al-${workspace}`}>
      <LogHeader name={name} windowSeconds={windowSeconds} onWindow={setWindowSeconds}
        live={live} onLive={() => setLive(!live)} busy={busy} available={client.available}
        exporting={exporting} canExport={!!snapshot && (tab !== 'sessions' || !!active)} sessionReport={tab === 'sessions'}
        onRefresh={() => void refresh()} onExport={() => void saveReport()} />
      {!client.available && (
        <div className="d-notice">请在桌面版打开 {name} 日志分析。日志在本机只读解析。</div>
      )}
      {error && (
        <div className="d-notice d-notice-error" role="alert">
          {error}
          <button className="x-link" onClick={() => setError('')}>
            关闭
          </button>
        </div>
      )}
      {notice && (
        <div className="d-notice ca-notice" role="status">
          {notice}
          <button className="x-link" onClick={() => setNotice('')}>
            关闭
          </button>
        </div>
      )}
      {busy && !snapshot && (
        <div className="ca-empty" role="status">
          <LoaderCircle size={22} className="n-spin" />
          <p>正在读取 {name} 的会话与运行日志…</p>
        </div>
      )}
      {snapshot && totals && (
        <>
          <LogCoverage count={snapshot.eventCount} generatedAt={snapshot.generatedAt} partial={snapshot.partial} onSources={() => changeTab('sources')} />
          <LogTabs tab={tab} onChange={changeTab} issues={snapshot.issues.length} />
          {tab === 'overview' && (
            <>
              <div className="ca-metrics">
                {(
                  [
                    ['关联会话', snapshot.sessions.length, '查看会话时间线', 'sessions'],
                    ['模型响应', totals.responses, `${totals.responseErrors + totals.apiErrors} 条响应 / API 错误`, 'activity'],
                    ['问题分组', snapshot.issues.length, '查看排查建议与相关记录', 'issues'],
                  ] as [string, number, string, LogTab][]
                ).map(([label, n, help, next]) => (
                  <button
                    key={label}
                    className={`ca-metric ${label === '问题分组' && n ? 'ca-metric-error' : ''}`}
                    onClick={() => {
                      changeTab(next);
                    }}
                  >
                    <span>{label}</span>
                    <strong>{num(n)}</strong>
                    <small>{help}</small>
                  </button>
                ))}
              </div>
              <div className="ca-overview-grid">
                <details className="n-panel ca-overview-details ca-overview-usage">
                  <summary>用量与统计口径</summary>
                  <div className="d-section-title">
                    <h3>已记录的用量</h3>
                    <span className="ca-tag">所选时间窗</span>
                  </div>
                  <Usage stats={totals} workspace={workspace} />
                  <p className="ca-read-scope">
                    {workspace === 'claude'
                      ? 'Claude 输入含未缓存输入、缓存读取及缓存创建；模型响应记录与 API 尝试分别统计。'
                      : 'OpenCode 消息级用量与压缩用量相加，工具步骤中的重复用量已排除。运行日志 HTTP 单独列出。'}
                  </p>
                </details>
                <section className="n-panel">
                  <div className="d-section-title">
                    <h3>优先排查</h3>
                    <button className="x-link" onClick={() => setTab('issues')}>
                      查看全部
                    </button>
                  </div>
                  {snapshot.issues.slice(0, 4).map((issue) => (
                    <Issue key={issue.id} issue={issue} {...eventProps} />
                  ))}
                  {!snapshot.issues.length && (
                    <div className="ca-empty">已读取的记录中没有错误或告警线索。</div>
                  )}
                </section>
              </div>
              <details className="n-panel ca-overview-details">
                <summary>模型与服务商</summary>
                <div className="d-section-title">
                  <h3>模型与服务商</h3>
                </div>
                {snapshot.models.length ? (
                  <div className="ca-table-scroll">
                    <table className="x-table">
                      <thead>
                        <tr>
                          <th>模型 / 服务商</th>
                          <th>模型响应</th>
                          <th>输入</th>
                          <th>输出</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.models.map((m) => (
                          <tr key={`${m.model}:${m.provider}`}>
                            <td>
                              {m.model || '未记录模型'}
                              <small className="al-block">{m.provider || '未记录服务商'}</small>
                            </td>
                            <td>{num(m.stats.responses)}</td>
                            <td>{m.stats.usageRecords ? num(m.stats.tokens.input) : '未记录'}</td>
                            <td>{m.stats.usageRecords ? num(m.stats.tokens.output) : '未记录'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="ca-empty">当前范围内没有模型响应或压缩用量。</div>
                )}
              </details>
              <section className="n-panel">
                <div className="d-section-title">
                  <h3>最近需要关注的事件</h3>
                  <button className="x-link" onClick={() => changeTab('events')}>全部事件</button>
                </div>
                <Events events={snapshot.recent.slice(0, 5)} {...eventProps} />
              </section>
            </>
          )}
          {tab === 'sessions' && (
            <div className="ca-session-layout">
              <aside className="n-panel ca-session-list">
                <label className="ca-search">
                  <Search size={14} />
                  <input
                    aria-label="搜索会话"
                    placeholder="标题、项目、模型或会话 ID"
                    value={sessionSearch}
                    onChange={(e) => setSessionSearch(e.target.value)}
                  />
                </label>
                <small className="ca-list-count">
                  {num(sessions.length)} 个会话 · 子代理独立列出
                </small>
                <div className="ca-session-items">
                  {sessions.map((s) => (
                    <button
                      key={s.id}
                      className={`ca-session-item ${s.id === active?.id ? 'active' : ''}`}
                      onClick={() => setSelectedSession(s.id)}
                    >
                      <strong>{title(s)}</strong>
                      <small>
                        {s.parentId ? '子会话 · ' : ''}
                        {s.agent ? `${s.agent} · ` : ''}
                        {s.model || '未记录模型'}
                      </small>
                      <small title={s.project}>{s.project || '未记录项目'}</small>
                      <span>
                        <time>{date(s.updatedAt)}</time>
                        <em>
                          {s.stats.responseErrors + s.stats.apiErrors + s.stats.toolErrors
                            ? `${s.stats.responseErrors + s.stats.apiErrors + s.stats.toolErrors} 条失败`
                            : `${s.stats.responses} 次响应`}
                        </em>
                      </span>
                    </button>
                  ))}
                  {!sessions.length && <div className="ca-empty">没有匹配的会话。</div>}
                </div>
              </aside>
              <div className="ca-session-content">
                {sessionBusy && (
                  <div className="n-panel ca-empty" role="status">
                    正在读取会话分析…
                  </div>
                )}
                {sessionError && (
                  <div className="d-notice d-notice-error" role="alert">
                    {sessionError}
                  </div>
                )}
                {session && (
                  <>
                    <section className="n-panel">
                      <div className="ca-session-heading">
                        <h3>{title(session.session)}</h3>
                        <span className="ca-tag">
                          {session.session.parentId ? '子会话' : '主会话'}
                        </span>
                      </div>
                      <div className="ca-session-meta">
                        <span>{session.session.project || '未记录项目目录'}</span>
                        <span>
                          {session.session.model || '未记录模型'} ·{' '}
                          {session.session.provider || '未记录服务商'}
                        </span>
                        <details className="ca-read-scope"><summary>会话信息与关联关系</summary>
                        <code>会话 ID：{session.session.id}</code>
                        {(
                          [
                            ['父会话', session.session.parentId],
                            ['分叉来源', session.session.forkedFrom],
                          ] as const
                        )
                          .filter(([, id]) => id)
                          .map(([label, id]) => (
                            <span key={label}>
                              <GitBranch size={12} /> {label}：
                              <button className="x-link ca-mono" onClick={() => openSession(id!)}>
                                {id}
                              </button>
                            </span>
                          ))}
                        {session.children.length > 0 && (
                          <span>
                            子会话：
                            {session.children.map((s) => (
                              <button
                                className="x-link al-child"
                                key={s.id}
                                onClick={() => openSession(s.id)}
                              >
                                {title(s)}
                              </button>
                            ))}
                          </span>
                        )}
                        </details>
                      </div>
                      <div className="ca-session-stats">
                        <span>
                          <strong>{session.session.stats.responses}</strong> 模型响应
                        </span>
                        <span>
                          <strong>
                            {session.session.stats.apiErrors + session.session.stats.responseErrors}
                          </strong>{' '}
                          响应 / API 错误
                        </span>
                        <span>
                          <strong>{session.session.stats.toolCalls}</strong> 工具调用
                        </span>
                        <span>
                          <strong>{session.session.stats.toolErrors}</strong> 工具失败
                        </span>
                        <span>
                          <strong>{session.session.stats.retries}</strong> 重试
                        </span>
                      </div>
                      <Usage stats={session.session.stats} workspace={workspace} />
                      <p className="ca-read-scope">{session.note}</p>
                    </section>
                    <section className="n-panel">
                      <div className="d-section-title">
                        <h3>会话时间线</h3>
                        <span className="ca-muted">最近优先</span>
                      </div>
                      <Events events={session.events} {...eventProps} />
                      {session.hasMore && (
                        <p className="ca-read-scope">
                          此处展示最近 1,000 条事件，可在全部事件中按会话筛选。
                        </p>
                      )}
                      <button
                        className="x-link"
                        onClick={() => {
                          resetFilters();
                          setSessionFilter(session.session.id);
                          setTab('events');
                        }}
                      >
                        筛选此会话的全部事件
                      </button>
                    </section>
                  </>
                )}
                {!sessionBusy && !session && !sessionError && (
                  <section className="n-panel ca-empty">
                    选择会话查看用量、工具状态与时间线。
                  </section>
                )}
              </div>
            </div>
          )}
          {(tab === 'activity' || tab === 'events') && (
            <section className="n-panel">
              <div className="d-section-title">
                <h3>{tab === 'activity' ? '模型活动' : '全部事件'}</h3>
                <small className="ca-muted">{page ? `${num(page.total)} 条匹配` : '读取中'}</small>
              </div>
              <LogFilters search={search} onSearch={setSearch} session={sessionFilter} onSession={setSessionFilter} sessions={snapshot.sessions}
                advancedCount={[sourceFilter, kind, level].filter(Boolean).length}
                active={!!(search || sessionFilter || sourceFilter || kind || level || failed)} onReset={resetFilters}
                failed={failed} onFailed={setFailed}>
                <select
                  aria-label="筛选日志来源"
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                >
                  <option value="">全部来源</option>
                  {fileSources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {roles[s.role]} · {s.path.split(/[\\/]/).pop()}
                    </option>
                  ))}
                </select>
                {tab === 'events' && (
                  <select
                    aria-label="筛选事件类型"
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                  >
                    <option value="">全部类型</option>
                    {Object.entries(kinds).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                )}
                <select
                  aria-label="筛选日志级别"
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                >
                  <option value="">全部级别</option>
                  {['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'].map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              </LogFilters>
              <details className="ca-read-scope"><summary>记录范围与统计口径</summary><p>
                {tab === 'activity'
                  ? '每条为会话中观测到的一次模型响应，流式片段已合并。API 错误、工具失败和运行日志 HTTP 可在全部事件中分别筛选。'
                  : '在当前快照内筛选。只有明确记录会话 ID 的运行事件才会关联到会话。'}
              </p></details>
              {eventsBusy && !page ? (
                <div className="ca-empty" role="status">
                  正在筛选记录…
                </div>
              ) : (
                <Events events={page?.events ?? []} {...eventProps} />
              )}
              {page && (
                <div className="ca-load-more">
                  <small>
                    已显示 {num(page.events.length)} / {num(page.total)}
                  </small>
                  {page.nextOffset != null && (
                    <button className="n-button" disabled={eventsBusy} onClick={() => void more()}>
                      {eventsBusy ? '加载中…' : '加载更多'}
                    </button>
                  )}
                </div>
              )}
            </section>
          )}
          {tab === 'issues' && (
            <section className="n-panel">
              <div className="d-section-title">
                <h3>故障归类</h3>
                <span className="ca-muted">按错误类型及状态归组</span>
              </div>
              <p className="ca-read-scope">
                模型响应、API
                错误、工具失败和运行日志告警分别保留来源，建议结合证据确认原因。重试与工具失败也不代表整个会话失败。
              </p>
              {snapshot.issues.map((issue) => (
                <Issue key={issue.id} issue={issue} {...eventProps} />
              ))}
              {!snapshot.issues.length && (
                <div className="ca-empty">当前读取范围内没有故障线索。</div>
              )}
            </section>
          )}
          {tab === 'sources' && (
            <section className="n-panel">
              <div className="d-section-title">
                <h3>数据来源与读取范围</h3>
              </div>
              <p className="ca-read-scope">
                数据目录：<code>{snapshot.home}</code>
              </p>
              <p className="ca-read-scope">
                {workspace === 'claude'
                  ? '读取 projects 下的会话 JSONL、会话索引和 subagents，以及 debug 文本。相同消息 ID 合并，工具按调用 ID 关联。'
                  : '优先读取 opencode.db：新版 session_v2 / session_message 或旧版 session / message / part；数据库不可用时回退到 storage JSON。log 目录提供独立运行证据。'}
              </p>
              {snapshot.sources.map((s) => (
                <details
                  className={`ca-source ${s.status === 'error' ? 'ca-source-error' : ''}`}
                  key={s.id}
                >
                  <summary>
                    {s.format === 'SQLite' ? <Database size={17} /> : <FileText size={17} />}
                    <span>
                      <strong>{s.path.split(/[\\/]/).pop() || s.path}</strong>
                      <small>
                        {roles[s.role]} · {s.format} · {num(s.records)} 条结构记录
                        {s.partial && ' · 部分读取'}
                      </small>
                    </span>
                    <span
                      className={`ca-tag ${s.status === 'error' ? 'ca-tag-error' : s.status === 'missing' ? 'ca-tag-warn' : ''}`}
                    >
                      {s.status === 'available'
                        ? '可读取'
                        : s.status === 'missing'
                          ? '未发现'
                          : '读取失败'}
                    </span>
                  </summary>
                  <div>
                    <code>{s.path}</code>
                    <p>
                      文件 {bytes(s.size)}
                      {s.walSize > 0 && ` · WAL ${bytes(s.walSize)}`}
                    </p>
                    <p>{s.note || '按结构提取元数据。'}</p>
                    {fileSources.some((file) => file.id === s.id) && (
                      <button className="x-link" onClick={() => showSource(s.id)}>
                        查看此来源事件
                      </button>
                    )}
                  </div>
                </details>
              ))}
              <ul className="ca-notes">
                {snapshot.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {evidenceOpen && <LogDetailModal busy={detailBusy} error={detailError} onClose={closeEvidence}
        onRetry={() => void evidence(evidenceTarget.current)} detail={detail ? {
          summary: detail.event.summary, time: detail.event.time, kind: kinds[detail.event.kind] ?? detail.event.kind,
          level: detail.event.level, note: detail.note,
          content: JSON.stringify({ evidence: detail.evidence, ...(detail.event.usage ? { tokens: detail.event.usage } : {}) }, null, 2),
          copy: JSON.stringify(detail, null, 2),
          facts: <>
            {detail.event.model && <><dt>模型 / 服务商</dt><dd>{detail.event.model} · {detail.event.provider || '未记录'}</dd></>}
            {detail.event.status != null && <><dt>状态</dt><dd>{detail.event.status}</dd></>}
            {detail.event.durationMs != null && <><dt>耗时</dt><dd>{num(detail.event.durationMs)} ms</dd></>}
            {detail.event.usage && <><dt>用量</dt><dd>输入 {num(detail.event.usage.input)} · 输出 {num(detail.event.usage.output)}</dd></>}
            {detail.event.sessionId && <><dt>会话</dt><dd><button className="x-link ca-mono" onClick={() => { closeEvidence(); openSession(detail.event.sessionId!); }}>{detail.event.sessionId}</button></dd></>}
          </>,
          metadata: <>
            <dt>来源</dt><dd><code>{detail.event.location.path}</code><code>{detail.event.location.position}</code></dd>
            {detail.event.mirrors.length > 0 && <><dt>合并的记录位置</dt><dd>{detail.event.mirrors.map((m, i) => <code key={i}>{m.path} · {m.position}</code>)}</dd></>}
            <dt>模块</dt><dd>{detail.event.target || '未记录'}</dd>
            {detail.event.requestId && <><dt>request-id</dt><dd>{detail.event.requestId}</dd></>}
            {detail.event.messageId && <><dt>消息 ID</dt><dd>{detail.event.messageId}</dd></>}
          </>,
        } : undefined} />}
    </div>
  );
}
