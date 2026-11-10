import { invoke } from '@tauri-apps/api/core';
import { nativeAvailable } from './native';

export type CleanupWorkspace = 'codex' | 'claude' | 'opencode';
export interface CleanupItem {
  id: string;
  title: string;
  updatedAt: number;
  bytes: number;
  sessions: number;
}
export interface CleanupScan {
  token: string;
  workspace: CleanupWorkspace;
  root: string;
  items: CleanupItem[];
  protectedSessions: number;
  notes: string[];
}
export interface CleanupOutcome {
  deletedSessions: number;
  reclaimedBytes: number;
  errors: string[];
  notes: string[];
}
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!nativeAvailable) throw new Error('空间清理仅在桌面客户端中可用');
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(String(error));
  }
}
export const scanCleanup = (workspace: CleanupWorkspace, days: number) =>
  call<CleanupScan>('cleanup_scan', { workspace, days });
export const runCleanup = (workspace: CleanupWorkspace, token: string, selected: string[]) =>
  call<CleanupOutcome>('cleanup_run', { workspace, token, selected, confirmed: true });
export const clearToolboxCache = () => call<CleanupOutcome>('cleanup_toolbox_cache');
