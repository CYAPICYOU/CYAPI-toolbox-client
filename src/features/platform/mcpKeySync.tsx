import { useEffect } from 'react';
import { nativeAvailable, syncMcpKey } from '../../lib/api/native';
import { loadKeys } from './keyStore';

/**
 * Keep the loopback MCP server in step with the Key list.
 *
 * The server is only useful while the app runs, so it holds the active Key in
 * memory; it is cleared when no Key is selected or when the window closes. The
 * Key never enters a file, so removing a Key immediately disables the tools.
 */
export function McpKeySync() {
  useEffect(() => {
    if (!nativeAvailable) return;
    let cancelled = false;
    const push = () => {
      const state = loadKeys();
      const active = state.keys.find((entry) => entry.id === state.activeId && !entry.temporary);
      void syncMcpKey(active?.key ?? null).catch(() => {});
    };
    push();
    window.addEventListener('cyapi-keys-changed', push);
    // A temporary Key is never persisted, so a stored-key change is the only
    // event that can alter the active credential from another page.
    const clear = () => {
      if (!cancelled) void syncMcpKey(null).catch(() => {});
    };
    window.addEventListener('pagehide', clear);
    return () => {
      cancelled = true;
      window.removeEventListener('cyapi-keys-changed', push);
      window.removeEventListener('pagehide', clear);
      clear();
    };
  }, []);
  return null;
}
