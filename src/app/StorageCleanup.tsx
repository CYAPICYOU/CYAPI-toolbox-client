import { useMemo, useState } from 'react';
import {
  Database,
  FileClock,
  FlaskConical,
  HardDrive,
  LoaderCircle,
  Search,
  Trash2,
} from 'lucide-react';
import { Modal } from '../components/Primitives';
import { scanCleanup, runCleanup } from '../lib/api/cleanup';
import type {
  CleanupItem,
  CleanupScan,
  CleanupOutcome,
  CleanupWorkspace,
} from '../lib/api/cleanup';
import {
  cleanupBytes,
  cleanupTotals,
  cleanupRange,
  inCleanupRange,
  selectableCleanupItems,
} from '../lib/cleanup';
import type { CleanupPeriod } from '../lib/cleanup';
import { nativeAvailable } from '../lib/api/native';
import './storage-cleanup.css';

const names = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' };
const categoryNames = {
  logs: '日志',
  sessions: '会话与附件',
  cache: '缓存',
  temporary: '临时文件',
  other: '配置、资源及其他',
};
const periods: [CleanupPeriod, string][] = [
  ['all', '全部时间'],
  ['older7', '7 天以前'],
  ['older30', '30 天以前'],
  ['older90', '90 天以前'],
  ['older180', '180 天以前'],
  ['custom', '自定义日期范围'],
];

export function StorageCleanup({ workspace }: { workspace: CleanupWorkspace }) {
  const [scan, setScan] = useState<CleanupScan>();
  const [period, setPeriod] = useState<CleanupPeriod>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rangeNow, setRangeNow] = useState(Date.now);
  const [category, setCategory] = useState<CleanupItem['category'] | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'scan' | 'delete'>();
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<CleanupOutcome>();
  const [confirm, setConfirm] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [page, setPage] = useState(0);
  const range = useMemo(
    () => cleanupRange(period, from, to, rangeNow),
    [period, from, to, rangeNow],
  );
  const filtered = useMemo(
    () =>
      (scan?.items ?? []).filter(
        (item) =>
          (category === 'all' || item.category === category) &&
          (!query ||
            `${item.title} ${item.path} ${item.reason}`
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase())) &&
          (period === 'all' || (range && inCleanupRange(item, range))),
      ),
    [scan, category, query, period, range],
  );
  const eligible = useMemo(() => selectableCleanupItems(filtered, range), [filtered, range]);
  const totals = cleanupTotals(scan?.items ?? [], selected);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50));
  const visible = filtered.slice(page * 50, (page + 1) * 50);
  const resetSelection = () => {
    setSelected(new Set());
    setPage(0);
  };

  const refresh = async () => {
    setBusy('scan');
    setScan(undefined);
    setSelected(new Set());
    setOutcome(undefined);
    setError('');
    setPage(0);
    setRangeNow(Date.now());
    try {
      setScan(await scanCleanup(workspace));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };
  const clean = async () => {
    if (!scan || !range || confirmation !== '删除' || !selected.size || busy) return;
    setBusy('delete');
    setError('');
    try {
      setOutcome(await runCleanup(workspace, scan.token, [...selected], range));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
      setConfirm(false);
      setConfirmation('');
      setScan(undefined);
      setSelected(new Set());
    }
  };

  return (
    <div className="n-cleanup" aria-busy={!!busy}>
      <section className="n-cleanup-card">
        <div className="n-cleanup-heading">
          <HardDrive size={20} />
          <h2>{names[workspace]} · 空间占用分析</h2>
          <span className="n-cleanup-badge">
            <FlaskConical size={13} />
            实验性
          </span>
          <button
            className="n-button n-primary"
            disabled={!!busy || !nativeAvailable}
            onClick={() => void refresh()}
          >
            {busy === 'scan' ? <LoaderCircle className="n-spin" size={15} /> : <Search size={15} />}
            {busy === 'scan' ? '正在分析…' : scan ? '重新分析空间' : '分析空间占用'}
          </button>
        </div>
        <p>
          查看本工具的日志、会话、缓存、临时文件和保留数据分别占了多少空间，再选择要清理的项目。
        </p>
        <p className="n-cleanup-warning">
          功能处于开发阶段，请谨慎使用。扫描只读、不依赖
          CLI；清理前请备份重要数据并完全关闭对应工具及后台服务。永久删除不进入回收站。
        </p>
      </section>
      {error && (
        <p className="n-error-text" role="alert">
          {error}
        </p>
      )}
      {outcome && (
        <section className="n-cleanup-card" role="status">
          <h3>{outcome.errors.length ? '清理部分完成 / 已停止' : '清理完成'}</h3>
          <p>
            已确认清理 {outcome.deletedFiles} 个独立文件、{outcome.deletedSessions} 个会话、
            {outcome.deletedRecords} 条数据库日志，释放 {cleanupBytes(outcome.reclaimedBytes)}。
          </p>
          {outcome.errors.map((text, index) => (
            <p className="n-error-text" key={index}>
              {text}
            </p>
          ))}
          {outcome.notes.map((text, index) => (
            <p key={index}>{text}</p>
          ))}
          <small>已完成的删除不会回滚，请重新分析查看最新占用。</small>
        </section>
      )}
      {!scan && !busy && !outcome && (
        <section className="n-cleanup-empty">
          <Database size={32} />
          <h3>先了解空间去了哪里</h3>
          <p>
            分析后显示分类占比、文件/会话明细与不可清理原因，不会因为缺少 CLI 或没有 30
            天以前的会话而隐藏占用。
          </p>
        </section>
      )}
      {scan && (
        <>
          <section className="n-cleanup-card">
            <div className="n-cleanup-total">
              <div>
                <small>{scan.partial ? '已扫描占用（扫描不完整）' : '本工具已扫描占用'}</small>
                <strong>{cleanupBytes(scan.totalBytes)}</strong>
              </div>
              <span>
                {scan.categories.reduce((sum, c) => sum + c.files, 0).toLocaleString()} 个磁盘文件 ·
                分类总量不随时间筛选改变
              </span>
            </div>
            <div className="n-cleanup-usage-bar" aria-label="磁盘空间分类占比">
              {scan.categories
                .filter((c) => c.bytes)
                .map((c) => (
                  <span
                    key={c.id}
                    className={`n-cleanup-color-${c.id}`}
                    style={{ width: `${(c.bytes / Math.max(1, scan.totalBytes)) * 100}%` }}
                    title={`${c.title}：${cleanupBytes(c.bytes)}`}
                  />
                ))}
            </div>
            <div className="n-cleanup-categories">
              {scan.categories.map((c) => (
                <button
                  key={c.id}
                  disabled={!!busy}
                  className={`n-cleanup-category${category === c.id ? ' is-selected' : ''}`}
                  aria-pressed={category === c.id}
                  onClick={() => {
                    setCategory(category === c.id ? 'all' : c.id);
                    resetSelection();
                  }}
                >
                  <span>
                    <i className={`n-cleanup-color-${c.id}`} />
                    {c.title}
                  </span>
                  <strong>{cleanupBytes(c.bytes)}</strong>
                  <small>
                    {c.files.toLocaleString()} 个文件 ·{' '}
                    {scan.totalBytes ? ((c.bytes / scan.totalBytes) * 100).toFixed(1) : 0}%
                  </small>
                </button>
              ))}
            </div>
            <details className="n-cleanup-sources">
              <summary>扫描目录与统计说明</summary>
              {scan.roots.map((root) => (
                <p key={root.path}>
                  {root.label}
                  {!root.exists && '（未发现）'}
                  <code>{root.path}</code>
                </p>
              ))}
              <ul>
                {scan.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </details>
          </section>
          <section className="n-cleanup-card">
            <div className="n-cleanup-heading">
              <FileClock size={18} />
              <h3>选择清理项目</h3>
              <span>默认不选中任何项目</span>
            </div>
            <div className="n-cleanup-toolbar">
              <label>
                分类
                <select
                  disabled={!!busy}
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value as typeof category);
                    resetSelection();
                  }}
                >
                  <option value="all">全部分类</option>
                  {scan.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                时间范围
                <select
                  value={period}
                  disabled={!!busy}
                  onChange={(e) => {
                    setPeriod(e.target.value as CleanupPeriod);
                    setRangeNow(Date.now());
                    resetSelection();
                  }}
                >
                  {periods.map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {period === 'custom' && (
                <>
                  <label>
                    开始日期
                    <input
                      type="date"
                      value={from}
                      disabled={!!busy}
                      onChange={(e) => {
                        setFrom(e.target.value);
                        resetSelection();
                      }}
                    />
                  </label>
                  <label>
                    结束日期
                    <input
                      type="date"
                      value={to}
                      disabled={!!busy}
                      onChange={(e) => {
                        setTo(e.target.value);
                        resetSelection();
                      }}
                    />
                  </label>
                </>
              )}
              <label className="n-cleanup-search">
                搜索
                <input
                  type="search"
                  value={query}
                  placeholder="名称、路径或原因"
                  disabled={!!busy}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    resetSelection();
                  }}
                />
              </label>
            </div>
            {!range && (
              <p className="n-error-text" role="alert">
                请选择有效的开始或结束日期，开始日期不能晚于结束日期。
              </p>
            )}
            <p className="n-cleanup-caption">
              独立文件按最后修改时间筛选；会话按整棵会话树的最后更新时间筛选（所有子会话都须位于范围内）；日志数据库在执行时只删除范围内的记录，不删整个数据库。
            </p>
            <div className="n-cleanup-selection">
              <label>
                <input
                  type="checkbox"
                  disabled={!!busy || !eligible.length}
                  checked={!!eligible.length && eligible.every((i) => selected.has(i.id))}
                  onChange={(e) =>
                    setSelected(new Set(e.target.checked ? eligible.map((i) => i.id) : []))
                  }
                />
                选择当前筛选下全部可清理项目（{eligible.length}）
              </label>
              <span>
                已选 {totals.items} 项 · {cleanupBytes(totals.bytes)} 所选数据量
              </span>
              <button
                className="n-button n-cleanup-delete"
                disabled={!!busy || !selected.size || !range}
                onClick={() => {
                  setConfirmation('');
                  setConfirm(true);
                }}
              >
                <Trash2 size={15} />
                清理所选
              </button>
            </div>
            <div className="n-cleanup-table-wrap">
              <table className="n-cleanup-table">
                <thead>
                  <tr>
                    <th>项目 / 路径</th>
                    <th>分类</th>
                    <th>最后更新</th>
                    <th>占用 / 数据量</th>
                    <th>清理状态</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => {
                    const allowed = item.deletable && !!range && inCleanupRange(item, range);
                    return (
                      <tr key={item.id}>
                        <td>
                          <label>
                            <input
                              type="checkbox"
                              disabled={!!busy || !allowed}
                              checked={selected.has(item.id)}
                              onChange={(e) =>
                                setSelected((before) => {
                                  const next = new Set(before);
                                  if (e.target.checked) next.add(item.id);
                                  else next.delete(item.id);
                                  return next;
                                })
                              }
                            />
                            <span>
                              {item.title}
                              <small>{item.path || `${item.sessions} 个会话（含子会话）`}</small>
                            </span>
                          </label>
                        </td>
                        <td>{categoryNames[item.category]}</td>
                        <td>
                          {item.updatedAt
                            ? new Date(item.updatedAt).toLocaleDateString('zh-CN')
                            : '未知'}
                        </td>
                        <td>
                          {cleanupBytes(item.bytes)}
                          {item.estimated && <small>逻辑估算 / 非释放保证</small>}
                        </td>
                        <td>
                          <span
                            className={
                              item.deletable ? 'n-cleanup-can-delete' : 'n-cleanup-preserved'
                            }
                          >
                            {item.deletable
                              ? item.kind === 'logDatabase'
                                ? '按记录清理'
                                : '可清理'
                              : '保留'}
                          </span>
                          <small>{item.reason}</small>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <p role="status">
                当前筛选下没有项目。可切换“全部时间”或其他分类；上方仍显示全部扫描占用。
              </p>
            )}
            {pageCount > 1 && (
              <div className="n-cleanup-toolbar">
                <button
                  className="n-button"
                  disabled={!!busy || page <= 0}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </button>
                <span>
                  {page + 1} / {pageCount} · {filtered.length} 项
                </span>
                <button
                  className="n-button"
                  disabled={!!busy || page + 1 >= pageCount}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </button>
              </div>
            )}
          </section>
        </>
      )}
      {confirm && (
        <Modal
          title={`永久清理 ${names[workspace]} 所选项目`}
          busy={!!busy}
          onClose={() => setConfirm(false)}
          wide
        >
          <div className="n-cleanup-confirm">
            <p>
              将清理 <strong>{totals.items} 个所选项目</strong>，包含 {totals.sessions}{' '}
              个会话，所选数据量 {cleanupBytes(totals.bytes)}。
            </p>
            <p>
              时间范围：{periods.find(([id]) => id === period)?.[1]}
              {period === 'custom' && `（${from || '不限'} 至 ${to || '不限'}）`}
              。未选中的项目、范围外数据、配置和长期记忆不会清理。
            </p>
            <ul>
              {(scan?.items ?? [])
                .filter((i) => selected.has(i.id))
                .slice(0, 12)
                .map((i) => (
                  <li key={i.id}>
                    {categoryNames[i.category]} · {i.title} · {cleanupBytes(i.bytes)}
                  </li>
                ))}
            </ul>
            {totals.items > 12 && <small>另有 {totals.items - 12} 项。</small>}
            <p className="n-cleanup-warning">
              功能仍处于开发阶段。永久删除不进入回收站，也不自动备份。会话大小和日志数据库占用不是可释放空间保证；数据库日志按记录时间删除。失败时可能已有部分项目被删除。
            </p>
            <label>
              输入「删除」确认
              <input
                autoFocus
                value={confirmation}
                disabled={!!busy}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </label>
          </div>
          <div className="n-dialog-footer">
            <button className="n-button" disabled={!!busy} onClick={() => setConfirm(false)}>
              取消
            </button>
            <button
              className="n-button n-cleanup-delete"
              disabled={!!busy || confirmation !== '删除'}
              onClick={() => void clean()}
            >
              {busy === 'delete' ? (
                <LoaderCircle size={15} className="n-spin" />
              ) : (
                <Trash2 size={15} />
              )}
              {busy === 'delete' ? '正在清理…' : '永久清理所选'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
