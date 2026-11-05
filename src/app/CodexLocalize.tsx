import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  CircleHelp,
  Info,
  Languages,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Undo2,
} from 'lucide-react';
import { nativeAvailable, nativeCall } from '../lib/api/native';
import type { CodexLocalizationStatus } from '../lib/api/native';
import './codex-localize.css';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const preview: CodexLocalizationStatus = {
  supported: false,
  running: false,
  port: null,
  caTrusted: false,
  proxyServer: '',
  proxyEnabled: false,
  captures: false,
  codexFound: false,
  codexRunning: false,
  localeOverride: '',
  message: '网页预览无法操作本机代理，请使用桌面客户端。',
};

type Notice = { text: string; error?: boolean; info?: boolean };

function stateLabel(status?: CodexLocalizationStatus) {
  if (!status) return { text: '读取中', tone: '' };
  if (status.captures) return { text: '已启用', tone: 'on' };
  if (status.running) return { text: '代理已启动 · 未接管系统代理', tone: 'warn' };
  return { text: '未启用', tone: '' };
}

export function CodexLocalize() {
  const [status, setStatus] = useState<CodexLocalizationStatus>();
  const [busy, setBusy] = useState<'enable' | 'restore'>();
  const [notice, setNotice] = useState<Notice>();
  const [restart, setRestart] = useState(true);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await nativeCall<CodexLocalizationStatus>('codex-i18n-status'));
    } catch (error) {
      setNotice({ text: errorText(error), error: true });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!nativeAvailable) {
      setStatus(preview);
      setLoading(false);
      return;
    }
    void load();
  }, [load]);

  async function enable() {
    setBusy('enable');
    setNotice(undefined);
    try {
      let next = await nativeCall<CodexLocalizationStatus>('codex-i18n-start');
      const wasRunning = next.codexRunning;
      if (restart && wasRunning) {
        next = await nativeCall<CodexLocalizationStatus>('codex-i18n-restart');
      }
      setStatus(next);
      setNotice({
        info: true,
        text: !wasRunning
          ? '已启用，Codex 语言已设为 zh-CN。下次启动 Codex 时即为中文界面。'
          : restart
            ? '已启用并重启 Codex，语言已设为 zh-CN，界面现在即为中文。'
            : '已启用，语言已设为 zh-CN。请关闭并重新打开 Codex 以加载中文界面。',
      });
    } catch (error) {
      setNotice({ text: errorText(error), error: true });
    } finally {
      setBusy(undefined);
    }
  }

  async function restore() {
    setBusy('restore');
    setNotice(undefined);
    try {
      const next = await nativeCall<CodexLocalizationStatus>('codex-i18n-stop');
      setStatus(next);
      setNotice({
        info: true,
        text: '已恢复系统代理并还原 Codex 语言设置。Codex 当前会话仍保持中文，下次启动会回到英文。',
      });
    } catch (error) {
      setNotice({ text: errorText(error), error: true });
    } finally {
      setBusy(undefined);
    }
  }

  const state = stateLabel(status);
  const on = Boolean(status?.captures);
  const canRestore = Boolean(status?.running || status?.proxyEnabled);

  return (
    <div className="n-localize">
      <section className="n-api-section n-localize-hero" aria-label="Codex 中文界面">
        <div className="n-api-section-heading">
          <h3>
            <Languages size={17} />
            中文界面
          </h3>
          <span className={`n-localize-state ${state.tone}`} role="status">
            {loading ? <LoaderCircle size={13} className="n-spin" /> : null}
            {state.text}
          </span>
        </div>
        <p className="n-config-note">
          Codex 桌面版自带完整的中文语言包，但只有在远程开关
          <code>enable_i18n</code>
          可用时才会加载。OpenAI 不可达时该开关始终为关闭。启用后，本机代理只接管
          <code>ab.chatgpt.com</code>
          的这一次评估请求并返回“已启用”，同时把
          <code>config.toml</code> 的 <code>[desktop] localeOverride</code> 设为 <code>zh-CN</code>
          ，无需在 Codex 设置里手动切换语言；不改动 Codex 安装目录，因此升级后依然有效。
        </p>

        <dl className="n-localize-checks">
          <div>
            <dt>本地代理</dt>
            <dd className={status?.running ? 'ok' : ''}>
              {status?.running ? `运行中 · 127.0.0.1:${status.port}` : '未启动'}
            </dd>
          </div>
          <div>
            <dt>系统代理</dt>
            <dd className={on ? 'ok' : ''}>
              {on
                ? '已接管，仅启用期间生效'
                : status?.proxyEnabled
                  ? `${status.proxyServer || '已启用'}（未指向本地代理）`
                  : '未启用'}
            </dd>
          </div>
          <div>
            <dt>本地证书</dt>
            <dd className={status?.caTrusted ? 'ok' : ''}>
              {status?.caTrusted ? '已信任（当前用户）' : '首次启用时自动安装'}
            </dd>
          </div>
          <div>
            <dt>Codex 桌面版</dt>
            <dd className={status?.codexRunning ? 'ok' : ''}>
              {status?.codexFound
                ? status.codexRunning
                  ? '运行中'
                  : '已安装 · 未运行'
                : '未检测到'}
            </dd>
          </div>
          <div>
            <dt>Codex 语言</dt>
            <dd className={status?.localeOverride === 'zh-CN' ? 'ok' : ''}>
              {status?.localeOverride || '未设置 · 启用时自动写入'}
            </dd>
          </div>
        </dl>

        <div className="n-localize-actions">
          <button
            type="button"
            className="n-button n-primary"
            disabled={!nativeAvailable || Boolean(busy) || on}
            onClick={enable}
          >
            {busy === 'enable' ? (
              <LoaderCircle size={15} className="n-spin" />
            ) : (
              <ShieldCheck size={15} />
            )}
            启用中文界面
          </button>
          <button
            type="button"
            className="n-button"
            disabled={!nativeAvailable || Boolean(busy) || !canRestore}
            onClick={restore}
          >
            {busy === 'restore' ? (
              <LoaderCircle size={15} className="n-spin" />
            ) : (
              <Undo2 size={15} />
            )}
            恢复默认
          </button>
          <label className="n-localize-restart">
            <input
              type="checkbox"
              checked={restart}
              onChange={(event) => setRestart(event.target.checked)}
              disabled={!nativeAvailable || Boolean(busy)}
            />
            启用后自动重启 Codex
          </label>
          <button
            type="button"
            className="n-icon-button"
            onClick={() => void load()}
            disabled={!nativeAvailable || Boolean(busy) || loading}
            title="重新检测"
            aria-label="重新检测"
          >
            <RefreshCw size={15} className={loading ? 'n-spin' : ''} />
          </button>
        </div>

        <p className={`n-localize-keep ${on ? 'on' : ''}`} role="note">
          <Info size={15} />
          <span>
            {on ? (
              <strong>已启用，请保持本工具运行</strong>
            ) : (
              <strong>启用后请保持本工具运行</strong>
            )}
            （可以最小化）。本地代理由本工具托管：退出本工具会停止代理并还原系统代理，已经打开的
            Codex 本次会话仍是中文，但下次启动会回到英文，需要重新启用。
          </span>
        </p>

        {notice && (
          <div
            className={`n-alert ${notice.error ? 'n-error' : notice.info ? '' : 'n-success'}`}
            role={notice.error ? 'alert' : 'status'}
          >
            {notice.error || notice.info ? <CircleHelp size={16} /> : <CheckCircle2 size={16} />}
            <span>{notice.text}</span>
          </div>
        )}
        {status && !notice && (
          <p className="n-config-note" role="status">
            {status.message}
          </p>
        )}
      </section>

      <details className="n-localize-help">
        <summary>原理与注意事项</summary>
        <div>
          <p>
            启用时会在本机 <code>127.0.0.1:9409</code> 启动一个只拦截{' '}
            <code>ab.chatgpt.com/v1/initialize</code> 的小型代理（端口被占用时依次使用
            9410–9412），并把系统代理临时指向它；其他流量原样转发（若原本已有代理，会继续经由它转发）。恢复默认会还原原来的系统代理设置并停止代理。
          </p>
          <ul>
            <li>
              本地代理由本工具进程提供，必须保持本工具运行；退出本工具（包括删除或升级工具箱）会自动停止代理，并还原系统代理和
              Codex 语言设置，效果与「恢复默认」相同。
            </li>
            <li>Codex 只在启动时读取该开关：恢复默认后当前窗口仍是中文，重新打开才回到英文。</li>
            <li>
              首次启用会把本地证书加入“当前用户”的受信任根存储，仅用于本机
              <code>ab.chatgpt.com</code>
              的本地拦截；恢复默认不会删除证书，重复启用无需再次确认。
            </li>
            <li>不修改 Codex 安装目录与签名，因此应用商店更新后仍然有效。</li>
            <li>
              启用时会把 <code>config.toml</code> 的 <code>[desktop] localeOverride</code> 设为
              <code>zh-CN</code>，不需要在 Codex
              设置里手动选语言；恢复默认会还原原值，原本没有该键则删除。
              配置文件格式有误时会拒绝启用并提示先修复。
            </li>
          </ul>
        </div>
      </details>
    </div>
  );
}
