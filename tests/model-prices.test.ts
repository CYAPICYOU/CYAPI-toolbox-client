import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modelPrice,
  setDeliveredPrices,
  usageCost,
  validDeliveredPrices,
} from '../src/lib/usage.ts';
import type { UsageRecord } from '../src/lib/usage.ts';

const row = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  id: 'r',
  sessionId: 's',
  model: 'glm-5.3-flash-free',
  project: 'F:/project',
  time: new Date(2026, 10, 11, 12).getTime(),
  input: 1000,
  output: 200,
  cachedInput: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  reasoningOutput: 0,
  reportedCost: null,
  ...overrides,
});

test('delivered official prices win over the built-in table but never over custom prices', () => {
  const official = {
    'glm-5.3-flash-free': { input: 1, output: 4, cacheRead: 0.2, cacheWrite: 1, cacheWrite1h: 2 },
    'gpt-5': { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, cacheWrite1h: 9 },
  };
  setDeliveredPrices(official);
  try {
    assert.deepEqual(modelPrice('glm-5.3-flash-free', {}), official['glm-5.3-flash-free']);
    assert.equal(usageCost(row(), {}).kind, 'reference');
    assert.equal(usageCost(row(), {}).usd, (1000 * 1 + 200 * 4) / 1e6);
    // A custom price still takes precedence for both display and cost.
    const custom = { input: 2, output: 8, cacheRead: 1, cacheWrite: 2, cacheWrite1h: 3 };
    assert.deepEqual(modelPrice('glm-5.3-flash-free', { 'glm-5.3-flash-free': custom }), custom);
    assert.equal(usageCost(row(), { 'glm-5.3-flash-free': custom }).kind, 'configured');
    // Delivered entries replace the built-in reference for the same model.
    assert.deepEqual(modelPrice('gpt-5', {}), official['gpt-5']);
    // Unknown delivered models still fall back to the built-in table.
    assert.ok(modelPrice('gpt-4o', {}));
  } finally {
    setDeliveredPrices({});
  }
});

test('delivered manifests are validated before use', () => {
  assert.equal(validDeliveredPrices(null), null);
  assert.equal(validDeliveredPrices({}), null);
  assert.equal(validDeliveredPrices({ schema: 1, updatedAt: '2026-11-11T00:00:00.000Z' }), null);
  assert.equal(
    validDeliveredPrices({
      schema: 1,
      updatedAt: '2026-11-11T00:00:00.000Z',
      prices: { bad: { input: -1 } },
    }),
    null,
  );
  const delivered = validDeliveredPrices({
    schema: 1,
    updatedAt: '2026-11-11T00:00:00.000Z',
    prices: {
      'glm-5.3-flash-free': { input: 1, output: 4, cacheRead: 0.2, cacheWrite: 1, cacheWrite1h: 2 },
    },
  });
  assert.ok(delivered);
  assert.equal(delivered.updatedAt, '2026-11-11T00:00:00.000Z');
  assert.equal(delivered.prices['glm-5.3-flash-free'].output, 4);
});
