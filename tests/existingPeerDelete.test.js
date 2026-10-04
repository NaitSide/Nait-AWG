'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { prepareDeletion, deleteExistingPeer } = require('../vendor/receiver/src/services/existingPeerDeleteService');
const { parseAwgPeerBlocks } = require('../vendor/receiver/src/services/awgConfigService');
const key = Buffer.alloc(32, 1).toString('base64');
const otherKey = Buffer.alloc(32, 2).toString('base64');
const hash = crypto.createHash('sha256').update(key).digest('hex');
const target = { publicKey: key, publicKeyFingerprint: hash.slice(0, 12),
  clientId: `awg-existing-${hash.slice(0, 12)}`, allowedIp: '10.8.1.2/32' };

function fixture({ closed = false, tableAbsent = false, legacy = false, failure = '' } = {}) {
  const config = { containerName: 'test-awg', interfaceName: 'awg0', configPath: '/opt/amnezia/awg/awg0.conf', clientsTablePath: '/opt/amnezia/awg/clientsTable' };
  const originalConfig = `[Interface]\nPrivateKey = ${key}\nAddress = 10.8.1.1/24\nListenPort = 40000\n\n[Peer]\n${closed ? '# NaitGateManaged = ' + hash + '\n' : ''}PublicKey = ${key}\nPresharedKey = ${otherKey}\n${closed ? '' : 'AllowedIPs = 10.8.1.2/32\n'}\n[Peer]\nPublicKey = ${otherKey}\nPresharedKey = ${key}\nAllowedIPs = 10.8.1.3/32\n`;
  const table = legacy ? { [key]: { clientName: 'old', extra: 'preserve' }, [otherKey]: { clientName: 'other', extra: 'keep' } }
    : [{ clientId: key, userData: { clientName: 'old' } }, { clientId: otherKey, userData: { clientName: 'other', extra: 'keep' } }];
  const originalTable = tableAbsent ? null : JSON.stringify(table);
  const peersFrom = text => parseAwgPeerBlocks(text).map(peer => ({ publicKey: peer.publicKey, allowedIps: peer.allowedIps }));
  const state = { text: originalConfig, table: originalTable, peers: peersFrom(originalConfig), writes: 0, calls: [], failed: false };
  const backups = new Map();
  const trip = stage => { if (failure === stage && !state.failed) { state.failed = true; throw new Error('Injected failure'); } };
  const d = {
    getAwgRuntimeConfig: () => config,
    getAwgStatus: async () => ({ status: 'ok', listenPort: 40000, peersCount: state.peers.length }),
    getAwgPeers: async () => ({ status: 'ok', peers: structuredClone(state.peers) }),
    readConfig: async () => state.text,
    createPeerDeleteBackup: async () => {
      backups.set('config', state.text); backups.set('table', state.table);
      return { backupId: 'fixture', configBackupPath: 'config', clientsTableBackupPath: state.table === null ? null : 'table' };
    },
    readFile: async path => backups.get(path),
    writeConfigToContainer: async (_, text) => { state.writes++; state.text = text; trip('config'); },
    writeTextToContainer: async (_, text) => { state.writes++; state.table = text; trip('table'); },
    restoreConfigFromBackup: async () => { state.text = backups.get('config'); },
    restoreFileFromBackup: async () => { state.table = backups.get('table'); },
    runFile: async (cmd, args) => {
      state.calls.push(args);
      if (args[2] === 'sh') return { stdout: state.table === null ? 'absent' : 'present' };
      if (args[2] === 'cat') return { stdout: state.table };
      if (args[2] === 'awg') {
        state.peers = state.peers.filter(peer => peer.publicKey !== key);
        trip('runtime');
        if (failure === 'verify') state.peers = [];
        return { stdout: '' };
      }
      if (args[2] === 'bash') { state.peers = peersFrom(state.text); return { stdout: '' }; }
      throw new Error('Unexpected command');
    }
  };
  return { state, d, originalConfig, originalTable, table };
}

for (const closed of [false, true]) test(`delete ${closed ? 'disabled' : 'enabled'} existing client, leaving others persistent after restart`, async () => {
  const item = fixture({ closed });
  const result = await deleteExistingPeer(target, { requestId: 'test' }, item.d);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(item.state.peers, [{ publicKey: otherKey, allowedIps: ['10.8.1.3/32'] }]);
  assert.deepEqual(parseAwgPeerBlocks(item.state.text).map(peer => peer.publicKey), [otherKey]);
  assert.deepEqual(JSON.parse(item.state.table), [item.table[1]]);
  assert.ok(!item.state.text.includes('NaitGateManaged'));
  assert.ok(item.state.calls.every(args => !args.includes('restart')));
});

test('legacy clientsTable preserves all unrelated metadata', async () => {
  const item = fixture({ legacy: true });
  await deleteExistingPeer(target, {}, item.d);
  assert.deepEqual(JSON.parse(item.state.table), { [otherKey]: item.table[otherKey] });
});
test('absent clientsTable is not fabricated', async () => {
  const item = fixture({ tableAbsent: true });
  await deleteExistingPeer(target, {}, item.d);
  assert.equal(item.state.table, null);
});
test('invalid table aborts before any write', async () => {
  const item = fixture(); item.state.table = 'broken JSON';
  await assert.rejects(deleteExistingPeer(target, {}, item.d), { code: 'invalid_clients_table' });
  assert.equal(item.state.writes, 0);
});
test('missing table backup aborts before any write', async () => {
  const item = fixture(); const backup = item.d.createPeerDeleteBackup;
  item.d.createPeerDeleteBackup = async () => ({ ...(await backup()), clientsTableBackupPath: null });
  await assert.rejects(deleteExistingPeer(target, {}, item.d), { code: 'clients_table_backup_failed' });
  assert.equal(item.state.writes, 0);
});
test('reject mismatched key, address, fingerprint and unmarked closed client', () => {
  const item = fixture();
  for (const bad of [{ ...target, publicKey: otherKey }, { ...target, allowedIp: '10.8.1.3/32' },
    { ...target, publicKeyFingerprint: '000000000000' }, { ...target, clientId: 'someone-else' }]) {
    assert.throws(() => prepareDeletion(item.state.text, item.state.table, bad, item.state.peers));
  }
  const closed = fixture({ closed: true });
  assert.throws(() => prepareDeletion(closed.state.text.replace(`# NaitGateManaged = ${hash}\n`, ''), closed.state.table, target, closed.state.peers), { code: 'peer_closed_identity_unverified' });
});
test('runtime/config divergence aborts before any write', async () => {
  const item = fixture(); item.state.peers[1].allowedIps = [];
  await assert.rejects(deleteExistingPeer(target, {}, item.d), { code: 'peers_diverged' });
  assert.equal(item.state.writes, 0);
});
for (const failure of ['config', 'table', 'runtime', 'verify']) test(`rollback restores config, clientsTable and runtime after ${failure} failure`, async () => {
  const item = fixture({ failure, closed: true });
  await assert.rejects(deleteExistingPeer(target, {}, item.d));
  assert.equal(item.state.text, item.originalConfig);
  assert.equal(item.state.table, item.originalTable);
  assert.deepEqual(item.state.peers, parseAwgPeerBlocks(item.originalConfig).map(peer => ({ publicKey: peer.publicKey, allowedIps: peer.allowedIps })));
});
test('rollback failure is explicit and does not report success', async () => {
  const item = fixture({ failure: 'runtime' });
  item.d.restoreConfigFromBackup = async () => { throw new Error('restore failed'); };
  await assert.rejects(deleteExistingPeer(target, {}, item.d), { code: 'peer_delete_rollback_failed' });
});

test('idempotency commit failure rolls back server changes', async () => {
  const item = fixture();
  await assert.rejects(deleteExistingPeer(target, { commit: async () => { throw new Error('Cannot save receipt'); } }, item.d));
  assert.equal(item.state.text, item.originalConfig);
  assert.equal(item.state.table, item.originalTable);
  assert.equal(item.state.peers.length, 2);
});

test('configuration changing during backup prevents deletion', async () => {
  const item = fixture();
  const original = item.d.createPeerDeleteBackup;
  item.d.createPeerDeleteBackup = async () => {
    const backup = await original();
    item.state.text += '# concurrent change\n';
    return backup;
  };
  await assert.rejects(deleteExistingPeer(target, {}, item.d), { code: 'config_changed' });
  assert.equal(item.state.writes, 0);
});

test('duplicate target identity is rejected without changing the server', async () => {
  const item = fixture(); item.state.peers.push(structuredClone(item.state.peers[0]));
  await assert.rejects(deleteExistingPeer(target, {}, item.d), { code: 'peer_identity_unverified' });
  assert.equal(item.state.writes, 0);
});
