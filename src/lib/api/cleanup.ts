import { invoke } from '@tauri-apps/api/core';
import { nativeAvailable } from './native';

export type CleanupWorkspace = 'codex' | 'claude' | 'opencode';
export interface CleanupItem {
  id: string;
  title: string;
  updatedAt: number;
  bytes: number;
  sessions: number;
  category: 'logs' | 'sessions' | 'cache' | 'temporary' | 'other';
  kind: 'file' | 'session' | 'logDatabase' | 'protected';
  path: string;
  files: number;
  records: number;
  minUpdatedAt: number;
  deletable: boolean;
  reason: string;
  estimated: boolean;
}
export interface CleanupRange {
  since?: number;
  until?: number;
}
export interface CleanupScan {
  token: string;
  workspace: CleanupWorkspace;
  root: string;
  items: CleanupItem[];
  roots: { path: string; label: string; exists: boolean }[];
  categories: { id: CleanupItem['category']; title: string; bytes: number; files: number }[];
  totalBytes: number;
  partial: boolean;
  notes: string[];
}
export interface CleanupOutcome {
  deletedSessions: number;
  deletedFiles: number;
  deletedRecords: number;
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
export const scanCleanup = (workspace: CleanupWorkspace) =>
  call<CleanupScan>('cleanup_scan', { workspace });
export const runCleanup = (
  workspace: CleanupWorkspace,
  token: string,
  selected: string[],
  range: CleanupRange,
) => call<CleanupOutcome>('cleanup_run', { workspace, token, selected, range, confirmed: true });
export const clearToolboxCache = () => call<CleanupOutcome>('cleanup_toolbox_cache');
