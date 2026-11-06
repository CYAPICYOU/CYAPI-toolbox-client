import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Database,
  FileText,
  FolderOpen,
  LoaderCircle,
  Search,
} from 'lucide-react';
import { LogCoverage, LogDetailModal, LogEvents, LogFilters, LogHeader, LogTabs } from './LogAnalysisShared';
import type { LogTab } from './LogAnalysisShared';
import { nativeAvailable } from '../lib/api/native';
import {
  analyzeCodex,
  analysisEvents,
  analysisDetail,
  analyzeSession,
  exportAnalysis,
} from '../lib/api/codexAnalysis';
import type {
  Analysis,
  AnalysisDetail,
  AnalysisEvent,
  AnalysisFilter,
  AnalysisIssue,
  AnalysisPage,
  AnalysisSession,
  SessionAnalysis,
} from '../lib/api/codexAnalysis';
import './diagnostics.css';
import './codex-analysis.css';

const roles: Record<string, string> = {
  runtime: '运行数据库',
  index: '会话索引',
  cli: 'CLI 日志',
  desktop: '桌面日志',
  rollout: '会话记录',
};
const kinds: Record<string, string> = {
  request: '模型请求',
  http: '其他 HTTP',
  retry: '重试',
  turn_error: '回合错误',
  sse: '响应流',
  mcp: 'MCP',
  tool: '工具调用',
  tool_result: '工具返回',
  session: '会话初始化',
  error: '运行告警',
  desktop: '桌面事件',
  other: '其他',
  turn_started: '回合开始',
  turn_completed: '回合完成',
  turn_aborted: '回合中止',
  context: '回合配置',
  compaction: '上下文压缩',
};
const categories: Record<string, string> = {
  auth: '认证',
  rate_limit: '限流',
  upstream: '上游服务',
  network: '网络',
  stream: '响应流',
  mcp: 'MCP',
  tool: '工具与权限',
  retry: '重试',
  turn: '回合',
  desktop: '桌面',
  background: '后台功能',
  runtime: '运行时',
};
const date = (ms: number) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');
const clock = (ms: number) =>
  ms ? new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
const number = (n: number) => n.toLocaleString('zh-CN');
const bytes = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
const title = (s: AnalysisSession) => s.title.trim() || s.id.slice(0, 8);
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface CodexAnalysisClient {
  available: boolean;
  analyze: typeof analyzeCodex;
  events: typeof analysisEvents;
  detail: typeof analysisDetail;
  session: typeof analyzeSession;
  export: typeof exportAnalysis;
}
const localClient: CodexAnalysisClient = {
  available: nativeAvailable,
  analyze: analyzeCodex,
  events: analysisEvents,
  detail: analysisDetail,
  session: analyzeSession,
  export: exportAnalysis,
};

function EventList({
  events,
  requests = false,
  onOpen,
  onSession,
}: {
  events: AnalysisEvent[];
  requests?: boolean;
  onOpen: (event: AnalysisEvent) => void;
  onSession: (id: string) => void;
}) {
  return <LogEvents rows={events.map(e => ({
    id: e.id, time: e.time, sessionId: e.threadId, model: e.model,
    severity: (e.http && !e.http.ok) || e.level === 'ERROR' ? 'error' : e.level === 'WARN' ? 'warn' : '',
    label: String(e.http ? e.http.status ?? (e.http.timeout ? '超时' : '连接失败') : kinds[e.kind] ?? e.kind),
    summary: requests && e.http ? `${e.http.method} ${e.http.host}${e.http.path}` : e.summary,
  }))} onOpen={id => { const event = events.find(e => e.id === id); if (event) onOpen(event); }} onSession={onSession} />;
}

function IssueCard({
  issue,
  onOpen,
  onSession,
}: {
  issue: AnalysisIssue;
  onOpen: (id: string) => void;
  onSession: (id: string) => void;
}) {
  return (
    <details className={`ca-issue ca-issue-${issue.severity}`}>
      <summary>
        <AlertCircle size={17} />
        <span>
          <strong>{issue.title}</strong>
          <small>
            {categories[issue.category]} · {issue.count} 条记录 · 最近 {date(issue.lastAt)}
          </small>
        </span>
        <ChevronRight size={16} className="d-chevron" />
      </summary>
      <div className="ca-issue-body">
        <p>{issue.advice}</p>
        <pre>{issue.sample}</pre>
        <small>
          首次 {date(issue.firstAt)} · 最近 {date(issue.lastAt)}
        </small>
        <div className="ca-actions">
          {issue.eventIds.map((id, i) => (
            <button key={id} className="x-link" onClick={() => onOpen(id)}>
              查看记录 {i + 1}
            </button>
          ))}
          {issue.threads.slice(0, 3).map((id) => (
            <button key={id} className="x-link" onClick={() => onSession(id)}>
              会话 {id.slice(0, 8)}
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}

export function CodexAnalysis({ client = localClient }: { client?: CodexAnalysisClient } = {}) {
  const {
    available: nativeAvailable,
    analyze: analyzeCodex,
    events: analysisEvents,
    detail: analysisDetail,
    session: analyzeSession,
    export: exportAnalysis,
  } = client;
  const [analysis, setAnalysis] = useState<Analysis>();
  const [windowSeconds, setWindowSeconds] = useState(86400);
  const [tab, setTab] = useState<LogTab>('overview');
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState<AnalysisPage>();
  const [eventsBusy, setEventsBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sourceRole, setSourceRole] = useState('');
  const [eventKind, setEventKind] = useState('');
  const [level, setLevel] = useState('');
  const [thread, setThread] = useState('');
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');
  const [selectedSession, setSelectedSession] = useState('');
  const [session, setSession] = useState<SessionAnalysis>();
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [issueCategory, setIssueCategory] = useState('');
  const [detail, setDetail] = useState<AnalysisDetail>();
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const evidenceTarget = useRef<AnalysisEvent | string>('');
  const refreshTicket = useRef(0);
  const refreshPending = useRef(false);
  const eventsTicket = useRef(0);
  const detailTicket = useRef(0);

  const refresh = useCallback(async () => {
    if (!nativeAvailable || refreshPending.current) return;
    const ticket = ++refreshTicket.current;
    refreshPending.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await analyzeCodex(windowSeconds);
      if (ticket === refreshTicket.current) setAnalysis(next);
    } catch (e) {
      if (ticket === refreshTicket.current) setError(reason(e));
    } finally {
      if (ticket === refreshTicket.current) {
        setBusy(false);
        refreshPending.current = false;
      }
    }
  }, [windowSeconds, nativeAvailable, analyzeCodex]);
  useEffect(() => {
    refreshPending.current = false;
    setAnalysis(undefined);
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
    if (!live || !nativeAvailable) return;
    const timer = window.setInterval(() => {
      if (!refreshPending.current && !evidenceOpen && !exporting) void refresh();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [live, refresh, nativeAvailable, evidenceOpen, exporting]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [search]);
  const filter = useMemo<AnalysisFilter>(
    () => ({
      kinds: tab === 'activity' ? ['request'] : eventKind ? [eventKind] : undefined,
      levels: tab === 'events' && level ? [level] : undefined,
      threadId: thread || undefined,
      search: debouncedSearch || undefined,
      outcome: tab === 'activity' && onlyFailed ? 'failed' : undefined,
    }),
    [tab, eventKind, level, thread, debouncedSearch, onlyFailed],
  );
  useEffect(() => {
    const ticket = ++eventsTicket.current;
    if (!analysis || (tab !== 'events' && tab !== 'activity')) return;
    setEventsBusy(true);
    setPage(undefined);
    void analysisEvents(analysis.id, filter, sourceRole || undefined)
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
  }, [analysis, tab, filter, sourceRole, analysisEvents]);
  async function loadMore() {
    if (!analysis || eventsBusy || page?.nextOffset == null) return;
    const ticket = ++eventsTicket.current;
    setEventsBusy(true);
    try {
      const next = await analysisEvents(
        analysis.id,
        filter,
        sourceRole || undefined,
        page.nextOffset,
      );
      if (ticket === eventsTicket.current)
        setPage((prev) => ({ ...next, events: [...(prev?.events ?? []), ...next.events] }));
    } catch (e) {
      if (ticket === eventsTicket.current) setError(reason(e));
    } finally {
      if (ticket === eventsTicket.current) setEventsBusy(false);
    }
  }
  const sessions = useMemo(() => {
    const needle = sessionSearch.trim().toLowerCase();
    return (
      analysis?.sessions.filter(
        (s) =>
          !needle ||
          `${s.title} ${s.id} ${s.cwd} ${s.provider} ${s.model}`.toLowerCase().includes(needle),
      ) ?? []
    );
  }, [analysis, sessionSearch]);
  const effectiveSession = sessions.find((s) => s.id === selectedSession) ?? sessions[0];
  useEffect(() => {
    if (!analysis || tab !== 'sessions' || !effectiveSession) {
      setSession(undefined);
      setSessionBusy(false);
      setSessionError('');
      return;
    }
    let current = true;
    setSessionBusy(true);
    setSession(undefined);
    setSessionError('');
    void analyzeSession(analysis.id, effectiveSession.id)
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
  }, [analysis, tab, effectiveSession?.id, analyzeSession]);
  function openSession(id: string) {
    if (!analysis?.sessions.some(s => s.id === id)) {
      setNotice(`会话 ${id} 未包含在当前读取范围，可扩大时间范围后刷新。`);
      return;
    }
    setSessionSearch('');
    setSelectedSession(id);
    setTab('sessions');
  }
  async function openEvidence(eventOrId: AnalysisEvent | string) {
    if (!analysis) return;
    evidenceTarget.current = eventOrId;
    const ticket = ++detailTicket.current;
    setEvidenceOpen(true);
    setDetailError('');
    setDetailBusy(true);
    setDetail(undefined);
    try {
      const event = typeof eventOrId === 'string' ? undefined : eventOrId;
      const next =
        event?.location.sourceRole === 'rollout'
          ? {
              event,
              message: session?.eventDetails[event.id] ?? event.summary,
              span: '',
              note: '会话 JSONL 的结构信息；不含聊天正文、工具参数和输出。',
            }
          : await analysisDetail(
              analysis.id,
              typeof eventOrId === 'string' ? eventOrId : eventOrId.id,
            );
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
    setSearch(''); setDebouncedSearch(''); setSourceRole(''); setThread('');
    setEventKind(''); setLevel(''); setOnlyFailed(false);
  }
  function changeTab(next: LogTab) { resetFilters(); setTab(next); }
  async function saveReport() {
    if (!analysis || exporting) return;
    setExporting(true);
    setNotice('');
    try {
      const result = await exportAnalysis(
        analysis.id,
        tab === 'sessions' ? effectiveSession?.id : undefined,
      );
      setNotice(`报告已保存：${result.path}`);
    } catch (e) {
      setError(reason(e));
    } finally {
      setExporting(false);
    }
  }
  const issues =
    analysis?.issues.filter((i) => !issueCategory || i.category === issueCategory) ?? [];
  const modelSourceAvailable = analysis?.sources.some(
    (s) => ['runtime', 'cli'].includes(s.role) && s.status === 'available',
  );

  return (
    <div className="ca-page">
      <LogHeader name="Codex" windowSeconds={windowSeconds} onWindow={setWindowSeconds}
        live={live} onLive={() => setLive(!live)} busy={busy} available={nativeAvailable}
        exporting={exporting} canExport={!!analysis && (tab !== 'sessions' || !!effectiveSession)} sessionReport={tab === 'sessions'}
        onRefresh={() => void refresh()} onExport={() => void saveReport()} />
      {!nativeAvailable && (
        <div className="n-alert">
          <FileText size={16} />
          <span>请在桌面版使用日志分析，直接读取本机 Codex 数据。</span>
        </div>
      )}
      {error && (
        <div className="n-alert n-error" role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="n-alert ca-notice" role="status">
          <CheckCircle2 size={16} />
          <span>{notice}</span>
        </div>
      )}
      {busy && (
        <div className="n-progress" role="status">
          <LoaderCircle size={15} className="n-spin" />
          正在关联 Codex 日志与会话…
        </div>
      )}
      {analysis && (
        <>
           <LogCoverage count={analysis.eventCount} generatedAt={analysis.generatedAt} partial={analysis.partial} onSources={() => changeTab('sources')} />
           <LogTabs tab={tab} onChange={changeTab} issues={analysis.issues.length} />
          {tab === 'overview' && (
            <>
              <div className="ca-metrics">
                {(
                  [
                    ['关联会话', analysis.totals.sessions, '查看会话时间线', 'sessions'],
                    ['模型请求', analysis.totals.requests, `${analysis.totals.failed} 次 HTTP 失败`, 'activity'],
                    ['问题分组', analysis.issues.length, '查看排查建议与相关记录', 'issues'],
                  ] as const
                ).map(([label, value, help, target]) => (
                  <button
                    key={label}
                    className={`ca-metric ${label === '问题分组' && value ? 'ca-metric-error' : ''}`}
                    onClick={() => {
                      changeTab(target);
                    }}
                  >
                    <span>{label}</span>
                    <strong>{number(value)}</strong>
                    <small>{help}</small>
                  </button>
                ))}
              </div>
              {!modelSourceAvailable && (
                <div className="n-alert">
                  <AlertCircle size={16} />
                  <span>未读到模型运行日志。请求数为当前可见记录，不代表 Codex 没有发起请求。</span>
                </div>
              )}
              <div className="ca-overview-grid">
                <section className="n-panel">
                  <div className="d-section-title">
                    <h3>优先排查</h3>
                    <button className="x-link" onClick={() => setTab('issues')}>
                      查看全部 <ArrowRight size={12} />
                    </button>
                  </div>
                  {analysis.issues.slice(0, 4).map((issue) => (
                    <IssueCard
                      key={issue.id}
                      issue={issue}
                      onOpen={(id) => void openEvidence(id)}
                      onSession={openSession}
                    />
                  ))}
                  {!analysis.issues.length && (
                    <div className="ca-empty">
                      <CheckCircle2 size={22} />
                      <p>已读取记录中未发现匹配的告警。</p>
                      <small>可打开会话查看回合结束情况。</small>
                    </div>
                  )}
                </section>
                <details className="n-panel ca-overview-details">
                  <summary>模型与请求地址</summary>
                  <div className="d-section-title">
                    <h3>实际模型请求地址</h3>
                    <button className="x-link" onClick={() => changeTab('activity')}>
                      请求明细 <ArrowRight size={12} />
                    </button>
                  </div>
                  <div className="ca-config">
                    <small>当前全局配置</small>
                    <strong>
                      {analysis.config.provider || '未读取'} ·{' '}
                      {analysis.config.model || '未指定模型'}
                    </strong>
                    <code>{analysis.config.baseUrl || '未读取到 base_url'}</code>
                  </div>
                  {analysis.routes.map((r) => (
                    <div className="ca-route" key={r.address}>
                      <code>{r.address}</code>
                      <div>
                        <span>{r.requests} 次尝试</span>
                        <span className="x-ok">{r.ok} 成功</span>
                        <span className={r.failed ? 'd-error' : ''}>{r.failed} 失败</span>
                      </div>
                      <small>
                        {Object.entries(r.statuses)
                          .map(([status, count]) => `${status} × ${count}`)
                          .join(' · ')}
                      </small>
                    </div>
                  ))}
                  {!analysis.routes.length && (
                    <div className="ca-empty">所选范围没有可识别的模型 HTTP 记录。</div>
                  )}
                  <p className="d-help">
                    HTTP 成功表示收到正常响应；回合是否完成，请查看会话时间线。地址不同需结合会话
                    provider 和配置覆盖判断。
                  </p>
                </details>
              </div>
              <section className="n-panel">
                <div className="d-section-title">
                  <h3>最近需要关注的事件</h3>
                  <button className="x-link" onClick={() => changeTab('events')}>全部事件</button>
                </div>
                <EventList
                  events={analysis.recent.slice(0, 5)}
                  onOpen={(e) => void openEvidence(e)}
                  onSession={openSession}
                />
              </section>
            </>
          )}
          {tab === 'sessions' && (
            <section className="ca-session-layout">
              <aside className="n-panel ca-session-list">
                <label className="ca-search">
                  <Search size={15} />
                  <input
                    aria-label="搜索会话"
                    placeholder="会话、项目、模型"
                    value={sessionSearch}
                    onChange={(e) => setSessionSearch(e.target.value)}
                  />
                </label>
                <small className="ca-list-count">{sessions.length} 个会话 · 最近活动排序</small>
                <div className="ca-session-items">
                  {sessions.map((s) => (
                    <button
                      key={s.id}
                      className={`ca-session-item ${effectiveSession?.id === s.id ? 'active' : ''}`}
                      onClick={() => setSelectedSession(s.id)}
                    >
                      <strong>{title(s)}</strong>
                      <small title={s.cwd}>{s.cwd || '项目路径未记录'}</small>
                      <span>
                        <small>{s.model || s.provider || s.id.slice(0, 8)}</small>
                        <time>{clock(s.updatedAt)}</time>
                      </span>
                      {(s.failures > 0 || s.turnErrors > 0 || s.archived) && (
                        <span>
                          {s.failures > 0 && <em>{s.failures} 次请求失败</em>}
                          {s.turnErrors > 0 && <em>{s.turnErrors} 条回合错误</em>}
                          {s.archived && <small>已归档</small>}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                {!sessions.length && (
                  <div className="ca-empty">没有匹配会话。可扩大时间范围，或查看数据来源。</div>
                )}
              </aside>
              <div className="ca-session-content">
                {sessionBusy && (
                  <div className="n-progress" role="status">
                    <LoaderCircle size={15} className="n-spin" />
                    正在解析会话回合与用量…
                  </div>
                )}
                {sessionError && (
                  <div className="n-alert n-error" role="alert">
                    {sessionError}
                  </div>
                )}
                {session && (
                  <>
                    <section className="n-panel">
                      <div className="ca-session-heading">
                        <h3>{title(session.session)}</h3>
                        <span className="ca-tag">
                          {session.session.archived
                            ? '已归档'
                            : session.session.origin || '本地会话'}
                        </span>
                      </div>
                      <div className="ca-session-meta">
                        <span>
                          <FolderOpen size={14} />
                          {session.session.cwd || '未记录项目路径'}
                        </span>
                        <span>provider：{session.session.provider || '未记录'}</span>
                        <span>模型：{session.session.model || '未记录'}</span>
                      </div>
                      <div className="ca-session-stats">
                        <span>
                          <strong>{session.turns.started}</strong> 回合开始
                        </span>
                        <span>
                          <strong>{session.turns.completed}</strong> 完成
                        </span>
                        <span>
                          <strong>{session.turns.aborted}</strong> 中止
                        </span>
                        <span>
                          <strong>{session.toolCalls}</strong> 工具调用
                        </span>
                        <span>
                          <strong>{session.session.requests}</strong> HTTP 尝试
                        </span>
                      </div>
                      {session.session.hosts.length > 0 && (
                        <p className="d-help">
                          请求地址：{session.session.hosts.join('、')}
                          {session.session.routeStatus === 'different' &&
                            ' · 与当前全局配置不同，需核对项目 / profile 或旧会话配置'}
                        </p>
                      )}
                      {session.source.status !== 'available' && (
                        <div className="n-alert">
                          <AlertCircle size={15} />
                          <span>会话文件不可读，仍显示已关联运行日志。{session.source.note}</span>
                        </div>
                      )}
                      {session.source.partial && (
                        <div className="n-alert">
                          <AlertCircle size={15} />
                          <span>{session.source.note}</span>
                        </div>
                      )}
                       <details className="ca-read-scope">
                         <summary>会话信息与统计范围</summary>
                         <code>会话 ID：{session.session.id}</code>
                        <code>{session.source.path}</code>
                        <p>{session.note}</p>
                      </details>
                    </section>
                    <section className="n-panel">
                      <div className="d-section-title">
                        <h3>会话累计用量</h3>
                        {session.usage && (
                          <small className="ca-muted">
                            记录于 {date(session.usage.observedAt)}
                          </small>
                        )}
                      </div>
                      {session.usage ? (
                        <>
                          <div className="ca-usage">
                            <div>
                              <small>总 token</small>
                              <strong>{number(session.usage.total)}</strong>
                            </div>
                            <div>
                              <small>输入</small>
                              <strong>{number(session.usage.input)}</strong>
                            </div>
                            <div>
                              <small>其中缓存输入</small>
                              <strong>{number(session.usage.cachedInput)}</strong>
                            </div>
                            <div>
                              <small>输出</small>
                              <strong>{number(session.usage.output)}</strong>
                            </div>
                            <div>
                              <small>其中推理输出</small>
                              <strong>{number(session.usage.reasoningOutput)}</strong>
                            </div>
                          </div>
                          <p className="d-help">
                            取日志中最后一条累计快照；缓存输入和推理输出已包含在输入、输出中。该值不是所选时间窗的新增消耗。
                          </p>
                        </>
                      ) : (
                        <p className="d-help">未读取到用量快照，不根据请求次数估算 token。</p>
                      )}
                    </section>
                    <section className="n-panel">
                      <div className="d-section-title">
                        <h3>会话时间线</h3>
                        <span className="ca-tag">最近事件在前</span>
                      </div>
                      <p className="d-help">
                        合并此会话的请求、重试、回合和工具记录。回合缺少结束记录时，不能据此判断仍在运行。
                      </p>
                      <EventList
                        events={session.events}
                        onOpen={(e) => void openEvidence(e)}
                        onSession={openSession}
                      />
                      {session.hasMore && (
                        <p className="d-help">仅展示最近 1,000 条会话事件，可缩小分析时间范围。</p>
                      )}
                    </section>
                  </>
                )}
              </div>
            </section>
          )}
          {(tab === 'activity' || tab === 'events') && (
            <section className="n-panel">
              <div className="d-section-title">
                <h3>
                  {tab === 'activity' ? '模型活动' : '全部事件'}
                  {page && <small className="ca-muted"> · {number(page.total)} 条匹配记录</small>}
                </h3>
              </div>
              <LogFilters search={search} onSearch={setSearch} session={thread} onSession={setThread} sessions={analysis.sessions}
                advancedCount={[sourceRole, eventKind, level].filter(Boolean).length}
                active={!!(search || sourceRole || thread || eventKind || level || onlyFailed)} onReset={resetFilters}
                failed={onlyFailed} onFailed={tab === 'activity' ? setOnlyFailed : undefined}>
                <select
                  aria-label="筛选日志来源"
                  value={sourceRole}
                  onChange={(e) => setSourceRole(e.target.value)}
                >
                  <option value="">全部来源</option>
                  {['runtime', 'cli', 'desktop'].map((r) => (
                    <option key={r} value={r}>
                      {roles[r]}
                    </option>
                  ))}
                </select>
                {tab === 'events' && (
                  <>
                    <select
                      aria-label="筛选事件类型"
                      value={eventKind}
                      onChange={(e) => setEventKind(e.target.value)}
                    >
                      <option value="">全部类型</option>
                      {Object.entries(kinds)
                        .filter(
                          ([k]) =>
                            ![
                              'turn_started',
                              'turn_completed',
                              'turn_aborted',
                              'context',
                              'compaction',
                              'tool_result',
                            ].includes(k),
                        )
                        .map(([k, label]) => (
                          <option value={k} key={k}>
                            {label}
                          </option>
                        ))}
                    </select>
                    <select
                      aria-label="筛选日志级别"
                      value={level}
                      onChange={(e) => setLevel(e.target.value)}
                    >
                      <option value="">全部级别</option>
                      {['ERROR', 'WARN', 'INFO', 'DEBUG'].map((l) => (
                        <option value={l} key={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </LogFilters>
              <details className="ca-read-scope"><summary>记录范围与统计口径</summary><p>
                {tab === 'activity'
                  ? '只统计模型接口的 HTTP 尝试；401 / 429 / 5xx 均记为失败。'
                  : '运行数据库与文本日志合并后分页；会话 JSONL 的回合和工具记录在「会话」中按需读取。'}{' '}
                所有筛选基于同一次分析快照。
              </p></details>
              {eventsBusy && !page && (
                <div className="n-progress" role="status">
                  <LoaderCircle size={15} className="n-spin" />
                  正在筛选记录…
                </div>
              )}
              {page && (
                <EventList
                  events={page.events}
                  requests={tab === 'activity'}
                  onOpen={(e) => void openEvidence(e)}
                  onSession={openSession}
                />
              )}
              {page?.nextOffset != null && (
                <div className="ca-load-more">
                  <button
                    className="n-button"
                    disabled={eventsBusy}
                    onClick={() => void loadMore()}
                  >
                    {eventsBusy ? '正在读取…' : '加载更多'}
                  </button>
                  <small>
                    已显示 {page.events.length} / {page.total} 条
                  </small>
                </div>
              )}
            </section>
          )}
          {tab === 'issues' && (
            <section className="n-panel">
              <div className="d-section-title">
                <h3>按故障特征归类</h3>
                <select
                  aria-label="筛选故障类型"
                  value={issueCategory}
                  onChange={(e) => setIssueCategory(e.target.value)}
                >
                  <option value="">全部类型</option>
                  {Object.entries(categories).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="d-help">
                相同模块与错误特征合并为一组，计数表示日志条数。同一次故障可能产生请求失败、重试和回合错误多条记录；建议用于定位，实际原因请结合证据确认。
              </p>
              {issues.map((issue) => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  onOpen={(id) => void openEvidence(id)}
                  onSession={openSession}
                />
              ))}
              {!issues.length && <div className="ca-empty">已读取范围没有匹配的故障记录。</div>}
            </section>
          )}
          {tab === 'sources' && (
            <>
              <section className="n-panel">
                <div className="d-section-title">
                  <h3>Codex 数据来源</h3>
                  <span className="ca-tag">本机只读</span>
                </div>
                <p className="d-help">
                  主目录：<code>{analysis.codexHome}</code>
                </p>
                <p className="d-help">
                  时间范围：{analysis.since ? date(analysis.since) : '不限起始时间'} —{' '}
                  {date(analysis.generatedAt)}。SQLite 包含尚未合并的 WAL；文本按记录时间筛选。
                </p>
                <div className="ca-source-legend">
                  <span>
                    <Database size={16} />
                    <strong>运行 SQLite</strong>
                    <small>请求、重试与运行事件</small>
                  </span>
                  <span>
                    <Database size={16} />
                    <strong>state SQLite</strong>
                    <small>会话、项目与 provider</small>
                  </span>
                  <span>
                    <FileText size={16} />
                    <strong>CLI / 桌面文本</strong>
                    <small>运行与桌面连接告警</small>
                  </span>
                  <span>
                    <FileText size={16} />
                    <strong>会话 JSONL / zst</strong>
                    <small>回合、工具与累计用量</small>
                  </span>
                </div>
                {analysis.sources.map((s) => (
                  <details
                    key={s.id}
                    className={`ca-source ca-source-${s.status}`}
                    open={s.status === 'error'}
                  >
                    <summary>
                      <span>
                        {s.format === 'SQLite' ? <Database size={16} /> : <FileText size={16} />}
                      </span>
                      <span>
                        <strong>{s.name}</strong>
                        <small>
                          {roles[s.role]} · {s.format}
                          {s.role !== 'rollout' && ` · ${s.records} 条已读记录`}
                        </small>
                      </span>
                      <span
                        className={`ca-tag ${s.status === 'error' || s.partial ? 'ca-tag-warn' : ''}`}
                      >
                        {s.status === 'available'
                          ? s.partial
                            ? '部分读取'
                            : s.role === 'rollout'
                              ? '按需解析'
                              : '已读取'
                          : s.status === 'missing'
                            ? '未发现'
                            : s.status === 'skipped'
                              ? '未选用'
                              : '不可读'}
                      </span>
                      <ChevronRight size={15} className="d-chevron" />
                    </summary>
                    <div>
                      <code>{s.path}</code>
                      <p>{s.note || '在所选时间窗内读取。'}</p>
                      <small>
                        文件 {bytes(s.size)}
                        {s.walSize > 0 && ` · WAL ${bytes(s.walSize)}`} · 修改于{' '}
                        {date(s.modifiedAt)}
                      </small>
                    </div>
                  </details>
                ))}
              </section>
              <section className="n-panel">
                <h3>统计口径</h3>
                <ul className="ca-notes">
                  {analysis.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
                <p className="d-help">显示和导出前隐藏常见凭据；日志始终在本机解析。</p>
              </section>
            </>
          )}
        </>
      )}
      {!analysis && !busy && nativeAvailable && (
        <div className="ca-empty">
          <Activity size={28} />
          <p>尚未读取到分析结果。</p>
          <button className="n-button" onClick={() => void refresh()}>
            重新分析
          </button>
        </div>
      )}
      {evidenceOpen && <LogDetailModal busy={detailBusy} error={detailError} onClose={closeEvidence}
        onRetry={() => void openEvidence(evidenceTarget.current)} detail={detail ? {
          summary: detail.event.summary, time: detail.event.time, kind: kinds[detail.event.kind] ?? detail.event.kind,
          level: detail.event.level, content: detail.message, context: detail.span, note: detail.note,
          copy: `${date(detail.event.time)} ${detail.event.location.path} ${detail.event.location.position}\n${JSON.stringify(detail.event, null, 2)}\n${detail.message}${detail.span ? `\n${detail.span}` : ''}`,
          facts: <>
            {detail.event.model && <><dt>模型</dt><dd>{detail.event.model}</dd></>}
            {detail.event.http && <><dt>请求结果</dt><dd>{detail.event.http.status ?? (detail.event.http.timeout ? '超时' : '连接失败')} · {detail.event.http.method} {detail.event.http.host}{detail.event.http.path}</dd></>}
            {detail.event.threadId && <><dt>会话</dt><dd><button className="x-link ca-mono" onClick={() => { closeEvidence(); openSession(detail.event.threadId!); }}>{detail.event.threadId}</button></dd></>}
          </>,
          metadata: <>
            <dt>来源</dt><dd>{roles[detail.event.location.sourceRole]}<code>{detail.event.location.path}</code><code>{detail.event.location.position}</code></dd>
            {detail.event.mirrors.length > 0 && <><dt>合并的记录位置</dt><dd>{detail.event.mirrors.map((m, i) => <code key={i}>{m.path} · {m.position}</code>)}</dd></>}
            <dt>模块</dt><dd>{detail.event.target || '未记录'}</dd>
            {detail.event.turnId && <><dt>回合 ID</dt><dd>{detail.event.turnId}</dd></>}
            {detail.event.http && <><dt>完整地址 / request-id</dt><dd><code>{detail.event.http.url}</code><code>{detail.event.http.requestId ?? '未记录'}</code></dd></>}
          </>,
        } : undefined} />}
    </div>
  );
}
