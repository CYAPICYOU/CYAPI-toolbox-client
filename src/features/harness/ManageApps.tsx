import { useState } from 'react';
import { ExternalLink, Search, Settings2 } from 'lucide-react';
import { Modal } from '../../components/Primitives';
import { nativeAvailable } from '../../lib/api/native';
import { openExternal } from '../../lib/api/update';
import { appIsVisible, DEFAULT_APPS, type AppEntry } from './apps';
import type { useToolApps } from './useToolApps';
import { AppLogo } from './AppLogo';

export function ManageApps({
  apps,
  state,
  onConfigure,
  onClose,
}: {
  apps: readonly AppEntry[];
  state: ReturnType<typeof useToolApps>;
  onConfigure: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = apps.filter((app) =>
    `${app.name} ${app.hint} ${app.site ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Modal title="管理 App" onClose={onClose} className="n-manage-apps">
      <div className="n-manage-apps-toolbar">
        <label className="n-manage-apps-search">
          <Search size={15} />
          <input
            aria-label="搜索 App"
            placeholder="搜索 App"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {!nativeAvailable && <p className="n-config-note">本机安装检测在桌面版可用。</p>}
      {(state.error || state.detection.warning) && (
        <p className="n-alert" role="status">
          {state.error || state.detection.warning}
        </p>
      )}
      <div className="n-manage-apps-list">
        {filtered.map((app) => {
          const detected = state.detection.apps.find(({ id }) => id === app.id);
          const shown = appIsVisible(app.id, state.preferences, state.detection.apps);
          const site = app.site;
          return (
            <div key={app.id} className="n-manage-app-row">
              <AppLogo id={app.id} size="large" />
              <div className="n-manage-app-info">
                <strong>{app.name}</strong>
                <small>
                  {detected?.installed
                    ? `已安装 · ${detected.source || app.hint}`
                    : DEFAULT_APPS.has(app.id)
                      ? '默认 App'
                      : state.loading
                        ? '检测中…'
                        : nativeAvailable
                          ? '未检测到安装'
                          : app.hint}
                </small>
                {site && (
                  <a
                    className="n-manage-app-site"
                    href={site}
                    target="_blank"
                    rel="noreferrer"
                    title={site}
                    onClick={(event) => {
                      if (!nativeAvailable) return;
                      event.preventDefault();
                      void openExternal(site);
                    }}
                  >
                    <ExternalLink size={11} />
                    <span>{site.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
                  </a>
                )}
              </div>
              <button
                className="n-button"
                aria-label={`配置 ${app.name}`}
                onClick={() => onConfigure(app.id)}
              >
                <Settings2 size={14} />
                配置
              </button>
              <label className="n-manage-app-visibility">
                <input
                  type="checkbox"
                  aria-label={`显示 ${app.name}`}
                  checked={shown}
                  onChange={(event) => state.show(app.id, event.target.checked)}
                />
                <span>显示</span>
              </label>
            </div>
          );
        })}
        {!filtered.length && <p className="n-config-note">没有匹配的 App。</p>}
      </div>
      <div className="n-dialog-footer">
        <button className="n-button" onClick={state.reset}>
          恢复默认显示
        </button>
        <button className="n-button n-primary" onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}
