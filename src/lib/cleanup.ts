import type { CleanupItem, CleanupRange } from './api/cleanup';

export type CleanupPeriod = 'all' | 'older7' | 'older30' | 'older90' | 'older180' | 'custom';

export function cleanupRange(
  period: CleanupPeriod,
  from = '',
  to = '',
  now = Date.now(),
): CleanupRange | null {
  if (period === 'all') return {};
  if (period !== 'custom') return { until: now - Number(period.slice(5)) * 86_400_000 };
  const day = (input: string, end: boolean) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return NaN;
    const [year, month, date] = input.split('-').map(Number);
    const value = new Date(year, month - 1, date);
    if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== date)
      return NaN;
    if (end) value.setDate(value.getDate() + 1);
    return value.getTime();
  };
  if (!from && !to) return null;
  const since = from ? day(from, false) : undefined;
  const until = to ? day(to, true) : undefined;
  if (
    (since !== undefined && (!Number.isFinite(since) || since < 0)) ||
    (until !== undefined && (!Number.isFinite(until) || until < 0)) ||
    (since ?? 0) >= (until ?? Infinity)
  )
    return null;
  return { ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}) };
}

export function inCleanupRange(item: CleanupItem, range: CleanupRange): boolean {
  if (item.kind === 'logDatabase')
    return (
      item.records > 0 &&
      item.updatedAt >= (range.since ?? 0) &&
      item.minUpdatedAt < (range.until ?? Infinity)
    );
  return (
    item.minUpdatedAt > 0 &&
    item.minUpdatedAt >= (range.since ?? 0) &&
    item.updatedAt < (range.until ?? Infinity)
  );
}

export function selectableCleanupItems(
  items: CleanupItem[],
  range: CleanupRange | null,
): CleanupItem[] {
  return range ? items.filter((item) => item.deletable && inCleanupRange(item, range)) : [];
}

export function cleanupTotals(items: CleanupItem[], selection: ReadonlySet<string>) {
  return items.reduce(
    (total, item) =>
      selection.has(item.id) && item.deletable
        ? {
            bytes: total.bytes + item.bytes,
            sessions: total.sessions + item.sessions,
            files: total.files + item.files,
            items: total.items + 1,
          }
        : total,
    { bytes: 0, sessions: 0, files: 0, items: 0 },
  );
}

export function cleanupBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const unit = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4));
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
