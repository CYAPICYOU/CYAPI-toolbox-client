import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cleanupBytes,
  cleanupTotals,
  cleanupRange,
  inCleanupRange,
  selectableCleanupItems,
} from '../src/lib/cleanup.ts';
import type { CleanupItem } from '../src/lib/api/cleanup.ts';
import { isToolPage } from '../src/lib/workbenches.ts';

const item = (overrides: Partial<CleanupItem> = {}): CleanupItem => ({
  id: 'root',
  title: 'Fixture',
  updatedAt: 300,
  minUpdatedAt: 100,
  bytes: 1024,
  sessions: 3,
  category: 'sessions',
  kind: 'session',
  path: '',
  files: 2,
  records: 0,
  deletable: true,
  reason: '',
  estimated: false,
  ...overrides,
});

test('cleanup is a tool page but navigation and rendering require experimental opt-in', () => {
  assert.equal(isToolPage('cleanup'), true);
  assert.equal(isToolPage('unknown'), false);
  const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /\[experimental, setExperimental\] = useState\(false\)/);
  assert.match(app, /experimental \? \[\{ id: 'cleanup'/);
  assert.match(app, /page === 'cleanup' && !desktopTool && experimental/);
  assert.match(app, /StorageCleanup key=\{workspace\} workspace=\{workspace\}/);
  const settings = readFileSync(new URL('../src/app/AppSettings.tsx', import.meta.url), 'utf8');
  assert.match(settings, /开发阶段/);
  assert.match(settings, /disabled=\{!riskAccepted \|\| experimental.busy\}/);
  const backend = readFileSync(new URL('../src-tauri/src/cleanup.rs', import.meta.url), 'utf8');
  assert.match(
    backend,
    /fn cleanup_scan[\s\S]*?settings::require_enabled\(\)\?;[\s\S]*?scan\(&workspace\)/,
  );
  assert.match(
    backend,
    /fn cleanup_run[\s\S]*?settings::require_enabled\(\)\?;[\s\S]*?run\(&workspace/,
  );
  assert.match(backend, /if !enabled[\s\S]*?\.clear\(\)/);
});

test('selection totals ignore foreign and protected IDs, and count descendants and files', () => {
  const items = [
    item(),
    item({ id: 'other', bytes: 2048, sessions: 1, files: 1 }),
    item({ id: 'protected', deletable: false }),
  ];
  assert.deepEqual(cleanupTotals(items, new Set(['root', 'not-in-plan', 'protected'])), {
    bytes: 1024,
    sessions: 3,
    files: 2,
    items: 1,
  });
  assert.deepEqual(cleanupTotals(items, new Set()), { bytes: 0, sessions: 0, files: 0, items: 0 });
  assert.deepEqual(cleanupTotals(items, new Set(['root', 'other'])), {
    bytes: 3072,
    sessions: 4,
    files: 3,
    items: 2,
  });
});

test('all-time is the default; presets mean older-than, not a fixed scan retention policy', () => {
  assert.deepEqual(cleanupRange('all'), {});
  for (const days of [7, 30, 90, 180] as const) {
    assert.deepEqual(cleanupRange(`older${days}`, '', '', 200 * 86400000), {
      until: (200 - days) * 86400000,
    });
  }
  assert.equal(inCleanupRange(item(), {}), true);
  assert.equal(inCleanupRange(item(), { since: 100, until: 301 }), true);
  assert.equal(inCleanupRange(item(), { since: 101 }), false);
  assert.equal(inCleanupRange(item(), { until: 300 }), false);
  assert.equal(inCleanupRange(item({ minUpdatedAt: 0 }), {}), false);
});

test('custom dates are local calendar days with an inclusive end date', () => {
  assert.deepEqual(cleanupRange('custom', '2026-06-01', '2026-06-02'), {
    since: new Date(2026, 5, 1).getTime(),
    until: new Date(2026, 5, 3).getTime(),
  });
  assert.deepEqual(cleanupRange('custom', '', '2026-06-02'), {
    until: new Date(2026, 5, 3).getTime(),
  });
  for (const [from, to] of [
    ['', ''],
    ['2026-02-30', ''],
    ['invalid', ''],
    ['2026-06-03', '2026-06-01'],
  ]) {
    assert.equal(cleanupRange('custom', from, to), null);
  }
});

test('log databases are selectable on range overlap and only records are deleted', () => {
  const db = item({ kind: 'logDatabase', records: 5, sessions: 0 });
  assert.equal(inCleanupRange(db, { since: 150, until: 250 }), true);
  assert.equal(inCleanupRange(db, { until: 100 }), false);
  assert.equal(inCleanupRange(db, { since: 301 }), false);
  assert.equal(inCleanupRange(item({ ...db, records: 0 }), {}), false);
  assert.deepEqual(
    selectableCleanupItems([db, item({ deletable: false }), item()], { until: 200 }),
    [db],
  );
  assert.deepEqual(selectableCleanupItems([db], null), []);
});

test('space formatting is bounded and handles zero and invalid values', () => {
  assert.equal(cleanupBytes(0), '0 B');
  assert.equal(cleanupBytes(Number.NaN), '0 B');
  assert.equal(cleanupBytes(-1), '0 B');
  assert.equal(cleanupBytes(42), '42 B');
  assert.equal(cleanupBytes(1024), '1.0 KB');
  assert.equal(cleanupBytes(1024 ** 3), '1.0 GB');
});

test('settings cache action remains limited to toolbox-owned cache', () => {
  const settings = readFileSync(new URL('../src/app/AppSettings.tsx', import.meta.url), 'utf8');
  assert.match(settings, /clearToolboxCache\(\)/);
  assert.doesNotMatch(settings, /runCleanup|scanCleanup|StorageCleanup/);
  const api = readFileSync(new URL('../src/lib/api/cleanup.ts', import.meta.url), 'utf8');
  assert.match(api, /clearToolboxCache = \(\) => call<CleanupOutcome>\('cleanup_toolbox_cache'\)/);
});

test('permanent deletion requires confirmation and consumes the scan, with range passed to backend', () => {
  const ui = readFileSync(new URL('../src/app/StorageCleanup.tsx', import.meta.url), 'utf8');
  assert.match(ui, /confirmation !== '删除'/);
  assert.match(ui, /finally[\s\S]*setScan\(undefined\)/);
  assert.match(ui, /永久删除/);
  assert.match(ui, /runCleanup\(workspace, scan.token, \[\.\.\.selected\], range\)/);
  assert.match(ui, /useState<CleanupPeriod>\('all'\)/);
});
