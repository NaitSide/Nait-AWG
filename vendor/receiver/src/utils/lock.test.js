'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { withDirectoryLock } = require('./lock');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nait-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, lockDir: path.join(root, 'awg0.write.lock.d') };
}

const currentIdentity = async () => ({ bootId: 'boot-a', processStartTime: '100' });

test('owned directory lock publishes metadata and removes only its own directory', async (t) => {
  const { lockDir } = await fixture(t);
  const result = await withDirectoryLock(lockDir, { readCurrentIdentity: currentIdentity }, async () => {
    const owner = JSON.parse(await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8'));
    assert.equal(owner.bootId, 'boot-a');
    assert.equal(owner.processStartTime, '100');
    assert.match(owner.token, /^[a-f0-9]{24}$/);
    return 'ok';
  });

  assert.equal(result, 'ok');
  await assert.rejects(fs.access(lockDir), (error) => error.code === 'ENOENT');
});

test('live and unknown lock owners are never removed on timeout', async (t) => {
  const { lockDir } = await fixture(t);
  await fs.mkdir(lockDir);
  await fs.writeFile(path.join(lockDir, 'owner.json'), '{"schemaVersion":1}\n');

  await assert.rejects(
    withDirectoryLock(lockDir, { timeoutMs: 5, intervalMs: 1, probeOwner: async () => 'alive' }, async () => {}),
    (error) => error.code === 'write_lock_busy'
  );
  await fs.access(lockDir);

  await assert.rejects(
    withDirectoryLock(lockDir, { timeoutMs: 5, intervalMs: 1, probeOwner: async () => 'unknown' }, async () => {}),
    (error) => error.code === 'write_lock_busy'
  );
  await fs.access(lockDir);
});

test('provably dead owner is atomically quarantined before a new lock is acquired', async (t) => {
  const { root, lockDir } = await fixture(t);
  await fs.mkdir(lockDir);
  await fs.writeFile(path.join(lockDir, 'owner.json'), '{"schemaVersion":1,"pid":10}\n');

  await withDirectoryLock(lockDir, {
    readCurrentIdentity: currentIdentity,
    probeOwner: async () => 'dead'
  }, async () => {});

  const entries = await fs.readdir(root);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^awg0\.write\.lock\.d\.stale\./);
});

test('release fails closed if the owner token changed', async (t) => {
  const { lockDir } = await fixture(t);
  await assert.rejects(
    withDirectoryLock(lockDir, { readCurrentIdentity: currentIdentity }, async () => {
      await fs.writeFile(path.join(lockDir, 'owner.json'), '{"schemaVersion":1,"token":"other"}\n');
    }),
    (error) => error.code === 'write_lock_ownership_lost'
  );
  await fs.access(lockDir);
});
