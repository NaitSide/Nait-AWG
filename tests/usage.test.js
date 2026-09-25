'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUsageStore } = require('../app/services/usageService');

const publicKey = crypto.randomBytes(32).toString('base64');
const id = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 12);
const peer = (rx, tx) => ({ publicKey, transferRx: rx, transferTx: tx });

test('usage history preserves totals, monthly deltas and counter resets in JSON', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-usage-test-'));
  const file = path.join(directory, 'traffic-history.json');
  const store = createUsageStore(file);
  store.record([peer(100, 200)], '2026-09-30T23:50:00.000Z');
  assert.deepEqual(store.summary(id).months, []);
  assert.equal(store.summary(id).receivedBytes, 200);
  store.record([peer(150, 260)], '2026-09-30T23:59:00.000Z');
  store.record([peer(180, 300)], '2026-10-01T00:01:00.000Z');
  assert.deepEqual(store.summary(id).months, [
    { month: '2026-10', receivedBytes: 40, sentBytes: 30 },
    { month: '2026-09', receivedBytes: 60, sentBytes: 50 }
  ]);
  assert.equal(store.summary(id).receivedBytes, 300);
  assert.equal(store.summary(id).sentBytes, 180);
  const reopened = createUsageStore(file);
  reopened.record([peer(10, 20)], '2026-11-01T00:01:00.000Z');
  assert.equal(reopened.summary(id).receivedBytes, 320);
  assert.equal(reopened.summary(id).sentBytes, 190);
  assert.equal(reopened.summary(id).months[0].month, '2026-11');
  assert.equal(reopened.summary(id).beforeTrackingReceivedBytes, 200);
  assert.equal(reopened.summary(id).beforeTrackingSentBytes, 100);
  assert.match(fs.readFileSync(file, 'utf8'), /"2026-10"/);
});

test('invalid samples do not overwrite history and corrupt history is not reset', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-usage-invalid-test-'));
  const file = path.join(directory, 'traffic-history.json');
  const store = createUsageStore(file);
  store.record([peer(100, 200)]);
  const original = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.record([peer(-1, 200)]), { code: 'usage_invalid_counter' });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  fs.writeFileSync(file, '{broken');
  const corrupted = createUsageStore(file);
  assert.throws(() => corrupted.snapshot(), { code: 'usage_unavailable' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
