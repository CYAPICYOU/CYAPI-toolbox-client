import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  AlertCircle,
  Copy,
  Download,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Modal } from '../components/Primitives';
import type { RequestIp } from '../lib/api/requestNetwork';

export type LogTab = 'overview' | 'sessions' | 'activity' | 'issues' | 'events' | 'sources';
export const logDate = (ms: number) =>
  ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '未记录';
const windows = [
  ['1 小时', 3600],
  ['6 小时', 21600],
  ['24 小时', 86400],
  ['3 天', 259200],
  ['7 天', 604800],
  ['全部', 0],
] as const;

export function LogHeader({
  name,
  windowSeconds,
  onWindow,
  live,
  onLive,
  busy,
  available,
  exporting,
  canExport,
  sessionReport,
  onRefresh,
  onExport,
}: {
  name: string;
  windowSeconds: number;
  onWindow: (value: number) => void;
  live: boolean;
  onLive: () => void;
  busy: boolean;
  available: boolean;
  exporting: boolean;
  canExport: boolean;
  sessionReport: boolean;
  onRefresh: () => void;
  onExport: () => void;
}) {
  return (
    <header className="ca-header">
      <div>
        <span className="ca-eyebrow">
          <Activity size={14} /> 本机日志
        </span>
        <h2>{name} 日志</h2>
        <p>先看概览，按会话或问题定位，再查看日志详情。</p>
      </div>
      <div className="ca-actions">
        <select
          aria-label="分析时间范围"
          value={windowSeconds}
          disabled={busy || exporting}
          onChange={(e) => onWindow(Number(e.target.value))}
        >
          {windows.map(([label, value]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button className="n-button" disabled={busy || exporting || !available} onClick={onRefresh}>
          <RefreshCw size={14} className={busy ? 'n-spin' : ''} />
          {busy ? '刷新中…' : '刷新'}
        </button>
        <button
          className={`n-button ${live ? 'ca-live' : ''}`}
          disabled={!available}
          aria-pressed={live}
          onClick={onLive}
          title="每 15 秒刷新；查看详情或导出时暂缓"
        >
          {live ? <Pause size={14} /> : <Play size={14} />}
          {live ? '暂停自动刷新' : '自动刷新'}
        </button>
        <button className="n-button" disabled={!canExport || busy || exporting} onClick={onExport}>
          <Download size={14} />
          {exporting ? '导出中…' : sessionReport ? '导出会话报告' : '导出报告'}
        </button>
      </div>
    </header>
  );
}

export function LogTabs({
  tab,
  onChange,
  issues,
}: {
  tab: LogTab;
  onChange: (tab: LogTab) => void;
  issues: number;
}) {
  return (
    <nav className="d-tabs ca-tabs" aria-label="日志分析视图">
      {(
        [
          ['overview', '概览'],
          ['sessions', '会话'],
          ['activity', '模型活动'],
          ['issues', '问题'],
          ['events', '全部事件'],
          ['sources', '数据来源'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          className={tab === id ? 'active' : ''}
          aria-current={tab === id ? 'page' : undefined}
          onClick={() => onChange(id)}
        >
          {label}
          {id === 'issues' && issues > 0 && <span className="ca-count">{issues}</span>}
        </button>
      ))}
    </nav>
  );
}

export function LogCoverage({
  count,
  generatedAt,
  partial,
  onSources,
}: {
  count: number;
  generatedAt: number;
  partial: boolean;
  onSources: () => void;
}) {
  return (
    <div className={`ca-coverage ${partial ? 'ca-coverage-partial' : ''}`}>
      {partial && <AlertCircle size={16} />}
      <span>
        {partial ? '统计基于部分记录 · ' : ''}
        {count.toLocaleString('zh-CN')} 条事件 · 更新于 {logDate(generatedAt)}
      </span>
      <button className="x-link" onClick={onSources}>
        查看读取范围
      </button>
    </div>
  );
}

export interface LogRow {
  id: string;
  time: number;
  label: string;
  summary: string;
  model?: string;
  severity: 'error' | 'warn' | '';
  sessionId?: string;
  requestIps?: RequestIp[];
  request?: boolean;
}
export function RequestIps({ ips = [] }: { ips?: RequestIp[] }) {
  if (!ips.length) return <span className="ca-muted">请求 IP：未记录</span>;
  return (
    <span className="ca-request-ips">
      {ips.map((ip, index) => (
        <span
          key={`${ip.kind}:${ip.ip}:${ip.port}:${index}`}
          title={`来源：${ip.source}${ip.port ? ` · 端口 ${ip.port}` : ''}`}
        >
          {ip.kind === 'target'
            ? '目标 IP（连接未确认）'
            : ip.kind === 'upstream'
              ? '上游 IP'
              : '远端 IP'}
          ：<code>{ip.ip}</code>
        </span>
      ))}
    </span>
  );
}
export function LogEvents({
  rows,
  onOpen,
  onSession,
}: {
  rows: LogRow[];
  onOpen: (id: string) => void;
  onSession: (id: string) => void;
}) {
  if (!rows.length) return <div className="ca-empty">没有匹配的记录，可调整筛选或时间范围。</div>;
  return (
    <div className="ca-table-scroll">
      <table className="x-table ca-events">
        <thead>
          <tr>
            <th>时间</th>
            <th>事件 / 结果</th>
            <th>会话</th>
            <th>
              <span className="ca-muted">详情</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <time>{logDate(row.time)}</time>
              </td>
              <td>
                <div className="ca-event-title">
                  <span className={`ca-tag ${row.severity ? `ca-tag-${row.severity}` : ''}`}>
                    {row.label}
                  </span>
                  <span title={row.summary}>{row.summary}</span>
                </div>
                {row.model && <small>{row.model}</small>}
                {(row.request || !!row.requestIps?.length) && (
                  <div className="ca-request-ip">
                    <RequestIps ips={row.requestIps} />
                  </div>
                )}
              </td>
              <td>
                {row.sessionId ? (
                  <button
                    className="x-link ca-mono"
                    title={row.sessionId}
                    onClick={() => onSession(row.sessionId!)}
                  >
                    {row.sessionId.slice(0, 8)}
                  </button>
                ) : (
                  <span className="ca-muted">未关联</span>
                )}
              </td>
              <td>
                <button className="x-link" onClick={() => onOpen(row.id)}>
                  查看
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LogFilters({
  search,
  onSearch,
  session,
  onSession,
  sessions,
  advancedCount,
  active,
  onReset,
  children,
  failed,
  onFailed,
}: {
  search: string;
  onSearch: (value: string) => void;
  session: string;
  onSession: (value: string) => void;
  sessions: { id: string; title: string }[];
  advancedCount: number;
  active: boolean;
  onReset: () => void;
  children: ReactNode;
  failed?: boolean;
  onFailed?: (value: boolean) => void;
}) {
  return (
    <div className="ca-filter-group">
      <div className="ca-filters">
        <label className="ca-search">
          <Search size={15} />
          <input
            aria-label="搜索事件"
            placeholder="搜索关键词、模型、IP 或请求 ID"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </label>
        <select aria-label="筛选会话" value={session} onChange={(e) => onSession(e.target.value)}>
          <option value="">全部会话</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title.trim() || s.id.slice(0, 8)}
            </option>
          ))}
        </select>
        {onFailed && (
          <label className="ca-check">
            <input type="checkbox" checked={failed} onChange={(e) => onFailed(e.target.checked)} />
            只看失败
          </label>
        )}
        <button className="x-link" disabled={!active} onClick={onReset}>
          清除筛选
        </button>
      </div>
      <details className="ca-advanced">
        <summary>更多筛选{advancedCount > 0 && ` · 已选 ${advancedCount} 项`}</summary>
        <div className="ca-filters">{children}</div>
      </details>
    </div>
  );
}

export function LogDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="ca-disclosure">
      <summary>{title}</summary>
      <div>{children}</div>
    </details>
  );
}

export function LogPagination({
  shown,
  total,
  hasMore,
  busy,
  onMore,
}: {
  shown: number;
  total: number;
  hasMore: boolean;
  busy: boolean;
  onMore: () => void;
}) {
  return (
    <div className="ca-load-more">
      <small>
        已显示 {shown.toLocaleString('zh-CN')} / {total.toLocaleString('zh-CN')} 条
      </small>
      {hasMore && (
        <button className="n-button" disabled={busy} onClick={onMore}>
          {busy ? '加载中…' : '加载更多'}
        </button>
      )}
    </div>
  );
}

export function LogDetailModal({
  busy,
  error,
  onClose,
  onRetry,
  detail,
}: {
  busy: boolean;
  error: string;
  onClose: () => void;
  onRetry: () => void;
  detail?: {
    summary: string;
    time: number;
    kind: string;
    level: string;
    facts: ReactNode;
    metadata: ReactNode;
    content: string;
    context?: string;
    note: string;
    copy: string;
  };
}) {
  const [copyStatus, setCopyStatus] = useState('');
  const [copyError, setCopyError] = useState('');
  const [copying, setCopying] = useState(false);
  async function copy() {
    if (!detail || copying) return;
    setCopying(true);
    setCopyStatus('');
    setCopyError('');
    try {
      await navigator.clipboard.writeText(detail.copy);
      setCopyStatus('已复制日志详情。');
    } catch (e) {
      setCopyError(`复制失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCopying(false);
    }
  }
  return (
    <Modal title="日志详情" wide className="ca-detail-modal" onClose={onClose}>
      <div className="ca-evidence">
        {busy && (
          <p className="n-progress" role="status">
            <LoaderCircle size={15} className="n-spin" />
            正在读取日志详情…
          </p>
        )}
        {error && (
          <div className="n-alert n-error" role="alert">
            <span>{error}</span>
            <button className="x-link" onClick={onRetry}>
              重试
            </button>
          </div>
        )}
        {detail && (
          <>
            <div className="ca-actions">
              <span
                className={`ca-tag ${detail.level === 'ERROR' ? 'ca-tag-error' : detail.level === 'WARN' ? 'ca-tag-warn' : ''}`}
              >
                {detail.kind}
              </span>
              <time>{logDate(detail.time)}</time>
              <span className="ca-muted">{detail.level}</span>
            </div>
            <h3>{detail.summary}</h3>
            <dl>{detail.facts}</dl>
            <LogDisclosure title="来源与技术信息">
              <dl>{detail.metadata}</dl>
            </LogDisclosure>
            <LogDisclosure title="原始记录">
              <pre tabIndex={0}>{detail.content}</pre>
              {detail.context && (
                <>
                  <h4>跨度上下文</h4>
                  <pre tabIndex={0}>{detail.context}</pre>
                </>
              )}
              <p className="ca-muted">{detail.note}</p>
            </LogDisclosure>
          </>
        )}
      </div>
      <div className="n-dialog-footer ca-detail-footer">
        {(copyStatus || copyError) && (
          <span role={copyError ? 'alert' : 'status'}>{copyError || copyStatus}</span>
        )}
        <button className="n-button" disabled={!detail || copying} onClick={() => void copy()}>
          <Copy size={14} />
          {copying ? '复制中…' : '复制详情'}
        </button>
        <button className="n-button" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
