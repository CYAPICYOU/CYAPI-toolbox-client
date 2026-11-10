import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanupBytes, cleanupTotals } from '../src/lib/cleanup.ts';
import { isToolPage } from '../src/lib/workbenches.ts';

test('cleanup navigation is a persisted tool page', () => {
  assert.equal(isToolPage('cleanup'), true);
  assert.equal(isToolPage('unknown'), false);
  const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /id: 'cleanup'.*label: '空间清理'/);
  assert.match(app, /StorageCleanup key=\{workspace\} workspace=\{workspace\}/);
});

test('selection totals count descendants and ignore IDs outside the scan', () => {
  const items = [
    { id: 'root', title: 'Fixture', updatedAt: 10, bytes: 1024, sessions: 3 },
    { id: 'other', title: 'Other fixture', updatedAt: 20, bytes: 2048, sessions: 1 },
  ];
  assert.deepEqual(cleanupTotals(items, new Set(['root', 'not-in-plan'])), {
    bytes: 1024,
    sessions: 3,
  });
  assert.deepEqual(cleanupTotals(items, new Set()), { bytes: 0, sessions: 0 });
  assert.deepEqual(cleanupTotals(items, new Set(['root', 'other'])), { bytes: 3072, sessions: 4 });
});

test('space formatting is bounded and handles zero and invalid values', () => {
  assert.equal(cleanupBytes(0), '0 B');
  assert.equal(cleanupBytes(Number.NaN), '0 B');
  assert.equal(cleanupBytes(-1), '0 B');
  assert.equal(cleanupBytes(42), '42 B');
  assert.equal(cleanupBytes(1024), '1.0 KB');
  assert.equal(cleanupBytes(1024 ** 3), '1.0 GB');
});

test('settings cache action cannot submit tool session IDs or delete plans', () => {
  const settings = readFileSync(new URL('../src/app/AppSettings.tsx', import.meta.url), 'utf8');
  assert.match(settings, /clearToolboxCache\(\)/);
  assert.doesNotMatch(settings, /runCleanup|scanCleanup|StorageCleanup/);
  const api = readFileSync(new URL('../src/lib/api/cleanup.ts', import.meta.url), 'utf8');
  assert.match(api, /clearToolboxCache = \(\) => call<CleanupOutcome>\('cleanup_toolbox_cache'\)/);
});

test('permanent deletion requires explicit confirmation and invalidates the consumed scan', () => {
  const ui = readFileSync(new URL('../src/app/StorageCleanup.tsx', import.meta.url), 'utf8');
  assert.match(ui, /confirmation !== '删除'/);
  assert.match(ui, /finally[\s\S]*setScan\(undefined\)/);
  assert.match(ui, /永久删除/);
});
