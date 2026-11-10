import type { CleanupItem } from './api/cleanup';

export function cleanupTotals(items: CleanupItem[], selection: ReadonlySet<string>) {
  return items.reduce(
    (total, item) =>
      selection.has(item.id)
        ? { bytes: total.bytes + item.bytes, sessions: total.sessions + item.sessions }
        : total,
    { bytes: 0, sessions: 0 },
  );
}

export function cleanupBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const unit = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4));
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
