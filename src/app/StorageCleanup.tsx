import { useState } from 'react';
import { HardDrive, LoaderCircle, Search, Trash2 } from 'lucide-react';
import { Modal } from '../components/Primitives';
import { scanCleanup, runCleanup } from '../lib/api/cleanup';
import type { CleanupScan, CleanupOutcome, CleanupWorkspace } from '../lib/api/cleanup';
import { cleanupBytes, cleanupTotals } from '../lib/cleanup';
import { nativeAvailable } from '../lib/api/native';
import './storage-cleanup.css';

const names = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' };

export function StorageCleanup({ workspace }: { workspace: CleanupWorkspace }) {
  const [days, setDays] = useState(30);
  const [scan, setScan] = useState<CleanupScan>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'scan' | 'delete'>();
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<CleanupOutcome>();
  const [confirm, setConfirm] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [page, setPage] = useState(0);
  const totals = cleanupTotals(scan?.items ?? [], selected);
  const items = scan?.items.slice(page * 100, (page + 1) * 100) ?? [];

  const refresh = async () => {
    setBusy('scan');
    setScan(undefined);
    setSelected(new Set());
    setOutcome(undefined);
    setError('');
    setPage(0);
    try {
      setScan(await scanCleanup(workspace, days));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };
  const clean = async () => {
    if (!scan || confirmation !== '删除' || !selected.size || busy) return;
    setBusy('delete');
    setError('');
    try {
      setOutcome(await runCleanup(workspace, scan.token, [...selected]));
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
          <h2>{names[workspace]} · 空间清理</h2>
        </div>
        <p>清理不再需要的旧会话及其关联数据，只操作当前工具。</p>
        <p className="n-cleanup-warning">
          会话将被永久删除，无法从回收站恢复。请先导出重要会话，并完全关闭此工具、编辑器扩展和后台服务；清理期间不要重新打开。
        </p>
        <div className="n-cleanup-toolbar">
          <label>
            保留最近{' '}
            <select
              value={days}
              disabled={!!busy}
              onChange={(event) => {
                setDays(Number(event.target.value));
                setScan(undefined);
                setSelected(new Set());
                setError('');
              }}
            >
              {[7, 30, 90, 180].map((n) => (
                <option key={n} value={n}>
                  {n} 天
                </option>
              ))}
            </select>
          </label>
          <button
            className="n-button n-primary"
            disabled={!!busy || !nativeAvailable}
            onClick={() => void refresh()}
          >
            {busy === 'scan' ? <LoaderCircle className="n-spin" size={15} /> : <Search size={15} />}
            {busy === 'scan' ? '正在扫描…' : '扫描旧会话'}
          </button>
        </div>
        <small>
          不会删除模型配置、登录凭据、Skill、MCP、插件、项目文件或长期记忆。扫描不会删除会话。
        </small>
      </section>
      {error && (
        <p className="n-error-text" role="alert">
          {error}
        </p>
      )}
      {outcome && (
        <section className="n-cleanup-card" role="status">
          <h3>{outcome.errors.length ? '清理未全部完成' : '清理完成'}</h3>
          <p>
            已确认删除 {outcome.deletedSessions} 个会话，释放文件空间{' '}
            {cleanupBytes(outcome.reclaimedBytes)}。
          </p>
          {outcome.errors.map((text, index) => (
            <p className="n-error-text" key={index}>
              {text}
            </p>
          ))}
          {outcome.notes.map((text, index) => (
            <p key={index}>{text}</p>
          ))}
          <small>如有失败，请重新扫描；已完成的删除不会回滚。</small>
        </section>
      )}
      {scan && (
        <section className="n-cleanup-card">
          <div className="n-cleanup-heading">
            <h3>扫描结果</h3>
            <span>已保护 {scan.protectedSessions} 个近期或有关联的会话</span>
          </div>
          <code className="n-cleanup-path">{scan.root}</code>
          <ul>
            {scan.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          {!scan.items.length ? (
            <p role="status">没有可清理的旧会话。</p>
          ) : (
            <>
              <div className="n-cleanup-toolbar">
                <label>
                  <input
                    type="checkbox"
                    disabled={!!busy}
                    checked={selected.size === scan.items.length}
                    onChange={(event) =>
                      setSelected(new Set(event.target.checked ? scan.items.map((i) => i.id) : []))
                    }
                  />{' '}
                  全选可清理会话树
                </label>
                <span>
                  已选 {totals.sessions} 个会话 · 数据估算 {cleanupBytes(totals.bytes)}
                </span>
                <button
                  className="n-button n-cleanup-delete"
                  disabled={!!busy || !selected.size}
                  onClick={() => {
                    setConfirm(true);
                    setConfirmation('');
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
                      <th>会话（含子会话）</th>
                      <th>最后更新</th>
                      <th>估算大小</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <label>
                            <input
                              type="checkbox"
                              disabled={!!busy}
                              checked={selected.has(item.id)}
                              onChange={(event) =>
                                setSelected((before) => {
                                  const next = new Set(before);
                                  if (event.target.checked) next.add(item.id);
                                  else next.delete(item.id);
                                  return next;
                                })
                              }
                            />
                            <span>
                              {item.title || item.id}
                              <small>
                                {item.id} · {item.sessions} 个会话
                              </small>
                            </span>
                          </label>
                        </td>
                        <td>{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</td>
                        <td>{cleanupBytes(item.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {scan.items.length > 100 && (
                <div className="n-cleanup-toolbar">
                  <button
                    className="n-button"
                    disabled={!!busy || !page}
                    onClick={() => setPage(page - 1)}
                  >
                    上一页
                  </button>
                  <span>
                    {page + 1} / {Math.ceil(scan.items.length / 100)}
                  </span>
                  <button
                    className="n-button"
                    disabled={!!busy || (page + 1) * 100 >= scan.items.length}
                    onClick={() => setPage(page + 1)}
                  >
                    下一页
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}
      {confirm && (
        <Modal
          title={`永久删除 ${names[workspace]} 旧会话`}
          busy={!!busy}
          onClose={() => setConfirm(false)}
        >
          <div className="n-cleanup-confirm">
            <p>
              将永久删除所选会话树中的 <strong>{totals.sessions} 个会话</strong>，数据估算{' '}
              {cleanupBytes(totals.bytes)}。不创建占用同一磁盘的备份，也不移入回收站。
            </p>
            <p>执行前会复查保留期、会话关联和工具进程。失败时可能已有部分会话被删除。</p>
            <label>
              输入「删除」以确认
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
              {busy === 'delete' ? '正在清理…' : '永久删除'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
