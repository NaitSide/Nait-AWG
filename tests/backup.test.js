'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { encryptBackup, decryptBackup, plainBackup } = require('../app/services/backupService');
const { createAwgService } = require('../app/services/awgService');

const password = 'a-long-test-password-123';
const config = `[Interface]\nPrivateKey = ${crypto.randomBytes(32).toString('base64')}\nAddress = 10.8.1.1/24\nListenPort = 55424\nJc = 4\nJmin = 40\nJmax = 70\n\n[Peer]\nPublicKey = ${crypto.randomBytes(32).toString('base64')}\nAllowedIPs = 10.8.1.2/32\n`;

function encryptStoredConfig(value, encodedKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(encodedKey, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

test('backup envelope round-trips and detects a wrong password or tampering', async () => {
  const snapshot = { awg: { config }, panel: { metadata: { notes: { abc: 'note' } } } };
  const envelope = await encryptBackup(snapshot, password);
  assert.equal(envelope.format, 'nait-awg-backup');
  assert.equal(envelope.version, 1);
  assert.equal(envelope.encryption.algorithm, 'aes-256-gcm');
  assert.doesNotMatch(JSON.stringify(envelope), /PrivateKey|note/);
  assert.deepEqual(await decryptBackup(envelope, password), snapshot);
  await assert.rejects(decryptBackup(envelope, 'different-password-123'));
  await assert.rejects(decryptBackup({ ...envelope, createdAt: '2000-01-01T00:00:00.000Z' }, password));
  const mutated = { ...envelope, payload: 'A' + envelope.payload.slice(1) };
  await assert.rejects(decryptBackup(mutated, password));
  await assert.rejects(encryptBackup(snapshot, 'short'), { code: 'invalid_backup_passphrase' });
});

test('plain backup is readable JSON without a password', async () => {
  const snapshot = { awg: { config }, panel: { metadata: { notes: { abc: 'note' } } } };
  const envelope = plainBackup(snapshot);
  assert.equal(envelope.encryption, null);
  assert.match(JSON.stringify(envelope), /PrivateKey/);
  assert.deepEqual(await decryptBackup(envelope), snapshot);
});

test('service snapshot contains an intact SQLite database, metadata and exact AWG config', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-backup-test-'));
  const env = { NAIT_AWG_DATA_KEY: crypto.randomBytes(32).toString('base64'),
    NAIT_AWG_DATA_PATH: path.join(directory, 'clients.db'), PUBLIC_ENDPOINT_HOST: 'vpn.example.test', CLIENT_DNS: '9.9.9.9' };
  fs.writeFileSync(path.join(directory, 'peer-notes.json'), JSON.stringify({ version: 1,
    notes: { aabbccddeeff: 'test note' }, telegrams: { aabbccddeeff: '@example' } }));
  const usagePublicKey = crypto.randomBytes(32).toString('base64');
  const service = createAwgService(env, { readAwgConfig: async () => config,
    readUsagePeers: async () => ({ status: 'ok', peers: [{ publicKey: usagePublicKey, transferRx: 100, transferTx: 200 }] }) });
  const fixtureDb = new DatabaseSync(env.NAIT_AWG_DATA_PATH);
  fixtureDb.prepare(`INSERT INTO clients (client_id, label, receiver_label, public_key_fingerprint,
    address, encrypted_config, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'awg-test', 'iPhone_RED', 'iPhone_RED', 'aabbccddeeff', '10.8.1.25/32', 'fixture', 'active', '2026-09-23T00:00:00.000Z');
  const usageFingerprint = crypto.createHash('sha256').update(usagePublicKey).digest('hex').slice(0, 12);
  fixtureDb.prepare(`INSERT INTO clients (client_id, label, receiver_label, public_key_fingerprint,
    address, encrypted_config, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'usage-test', 'UsageTest', 'UsageTest', usageFingerprint, '10.8.1.26/32', 'fixture', 'active', '2026-09-23T00:00:00.000Z');
  fixtureDb.close();
  const envelope = await service.createBackup(password);
  const snapshot = await decryptBackup(envelope, password);
  assert.equal(snapshot.awg.config, config);
  assert.equal(snapshot.awg.configFile, 'awg0.conf');
  assert.equal(snapshot.panel.dataKey, env.NAIT_AWG_DATA_KEY);
  assert.equal(snapshot.panel.clientDefaults.endpointHost, 'vpn.example.test');
  assert.equal(snapshot.panel.clientDefaults.dns, '9.9.9.9');
  assert.equal(snapshot.panel.metadata.notes.aabbccddeeff, 'test note');
  assert.equal(snapshot.panel.metadata.telegrams.aabbccddeeff, '@example');
  assert.equal(snapshot.panel.usageHistory.version, 1);
  assert.deepEqual(snapshot.panel.users[0], { name: 'iPhone_RED', vpnAddress: '10.8.1.25/32',
    publicKeyFingerprint: 'aabbccddeeff', recordStatus: 'active', createdAt: '2026-09-23T00:00:00.000Z',
    telegram: '@example', note: 'test note', usage: null });
  assert.equal(snapshot.panel.users[1].usage.receivedBytes, 200);
  assert.equal(snapshot.panel.users[1].usage.sentBytes, 100);
  assert.equal(snapshot.panel.users[1].usage.received, '200 B');
  assert.equal(snapshot.panel.users[1].usage.sent, '100 B');
  const copiedPath = path.join(directory, 'copied.db');
  fs.writeFileSync(copiedPath, Buffer.from(snapshot.panel.database, 'base64'));
  const copied = new DatabaseSync(copiedPath);
  assert.equal(copied.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.ok(copied.prepare("SELECT name FROM sqlite_master WHERE name = 'peer_gate_addresses'").get());
  copied.close();
  const plain = await service.createBackup();
  assert.equal(plain.encryption, null);
  assert.equal(plain.payload.awg.config, config);
  assert.equal(plain.payload.panel.metadata.notes.aabbccddeeff, 'test note');
  assert.equal(plain.payload.panel.users[0].name, 'iPhone_RED');
});

test('service rejects an AWG config that changes during snapshot', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-backup-race-test-'));
  const env = { NAIT_AWG_DATA_KEY: crypto.randomBytes(32).toString('base64'), NAIT_AWG_DATA_PATH: path.join(directory, 'clients.db') };
  let reads = 0;
  const service = createAwgService(env, { readAwgConfig: async () => { reads += 1; return reads === 1 ? config : config + '# changed\n'; },
    readUsagePeers: async () => ({ status: 'ok', peers: [] }) });
  await assert.rejects(service.createBackup(password), { code: 'backup_state_changed' });
  assert.equal(reads, 2);
});

test('migration replaces peers with fresh keys while retaining target port and metadata', async () => {
  const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-restore-source-'));
  const targetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-restore-target-'));
  const sourceDataKey = crypto.randomBytes(32).toString('base64');
  const targetDataKey = crypto.randomBytes(32).toString('base64');
  const peerPublicKey = /^PublicKey\s*=\s*(.+)$/m.exec(config)[1];
  const amneziaPublicKey = crypto.randomBytes(32).toString('base64');
  const sourceConfig = `${config}\n[Peer]\nPublicKey = ${amneziaPublicKey}\nAllowedIPs = 10.8.1.3/32\n`;
  const fingerprint = crypto.createHash('sha256').update(peerPublicKey).digest('hex').slice(0, 12);
  const clientConfig = `[Interface]\nPrivateKey = ${crypto.randomBytes(32).toString('base64')}\nAddress = 10.8.1.2/32\n\n[Peer]\nPublicKey = ${crypto.randomBytes(32).toString('base64')}\nEndpoint = old.example.test:55424\n`;
  const sourceEnv = { NAIT_AWG_DATA_KEY: sourceDataKey, NAIT_AWG_DATA_PATH: path.join(sourceDirectory, 'clients.db') };
  fs.writeFileSync(path.join(sourceDirectory, 'peer-notes.json'), JSON.stringify({ version: 1,
    notes: { [fingerprint]: 'Восстановленная заметка' }, telegrams: { [fingerprint]: '@restored' } }));
  const source = createAwgService(sourceEnv, { readAwgConfig: async () => sourceConfig,
    readAwgClientsTable: async () => [
      { clientId: peerPublicKey, userData: { clientName: 'Restored phone' } },
      { clientId: amneziaPublicKey, userData: { clientName: 'Amnezia import', creationDate: '2026-09-26T00:00:00.000Z' } }
    ],
    readUsagePeers: async () => ({ status: 'ok', peers: [{ publicKey: peerPublicKey, transferRx: 10, transferTx: 20 }] }) });
  const sourceDb = new DatabaseSync(sourceEnv.NAIT_AWG_DATA_PATH);
  sourceDb.prepare(`INSERT INTO clients (client_id, label, receiver_label, public_key_fingerprint,
    address, encrypted_config, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'awg-restored', 'Restored phone', 'Restored-phone', fingerprint, '10.8.1.2/32',
    encryptStoredConfig(clientConfig, sourceDataKey), 'active', '2026-09-25T00:00:00.000Z');
  sourceDb.close();
  const backup = await source.createBackup();

  const serverPublicKey = crypto.randomBytes(32).toString('base64');
  const targetPrivateKey = crypto.randomBytes(32).toString('base64');
  const targetOriginal = config.replace(/^PrivateKey = .*$/m, `PrivateKey = ${targetPrivateKey}`)
    .replace('Address = 10.8.1.1/24', 'Address = 10.9.0.1/24')
    .replace('ListenPort = 55424', 'ListenPort = 47282').replace('Jc = 4', 'Jc = 9');
  let activeConfig = targetOriginal;
  let activeTable = [];
  const generatedMaterials = [];
  let failProfileAfterRestore = false;
  let failNextProfile = false;
  const receiver = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/awg/restore' && req.method === 'POST') {
      ({ config: activeConfig, clientsTable: activeTable } = JSON.parse(body));
      if (failProfileAfterRestore) { failNextProfile = true; failProfileAfterRestore = false; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/awg/peers') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', peers: [{ publicKey: peerPublicKey, allowedIps: ['10.8.1.2/32'], transferRx: 10, transferTx: 20 }] }));
      return;
    }
    if (req.url === '/awg/profile') {
      res.setHeader('content-type', 'application/json');
      const reportedPublicKey = failNextProfile ? crypto.randomBytes(32).toString('base64') : serverPublicKey;
      failNextProfile = false;
      res.end(JSON.stringify({ status: 'ok', serverPublicKey: reportedPublicKey, listenPort: Number(/^ListenPort = (\d+)$/m.exec(activeConfig)[1]),
        interfaceAddress: '10.9.0.1/24', tunnelSubnet: '10.9.0.0/24',
        clientInterfaceParameters: { Jc: Number(/^Jc = (\d+)$/m.exec(activeConfig)[1]) } }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  try {
    const targetEnv = { NAIT_AWG_DATA_KEY: targetDataKey, NAIT_AWG_DATA_PATH: path.join(targetDirectory, 'clients.db'),
      PUBLIC_ENDPOINT_HOST: 'new.example.test',
      RECEIVER_URL: `http://127.0.0.1:${receiver.address().port}` };
    const target = createAwgService(targetEnv, { readAwgConfig: async () => activeConfig,
      readAwgClientsTable: async () => activeTable,
      readPublishedVpnPort: async (internalPort) => internalPort === 47282 ? 47282 : null,
      generateKeyMaterial: async () => {
        const generated = { privateKey: crypto.randomBytes(32).toString('base64'),
          publicKey: crypto.randomBytes(32).toString('base64'), presharedKey: crypto.randomBytes(32).toString('base64') };
        generatedMaterials.push(generated);
        return generated;
      } });
    const summary = await target.inspectBackup(backup);
    assert.equal(summary.clientsCount, 2);
    assert.equal(summary.peersCount, 2);
    assert.equal(summary.targetEndpoint, 'new.example.test:47282');
    const restored = await target.restoreBackup(backup);
    assert.equal(restored.status, 'ok');
    assert.match(activeConfig, new RegExp(`PrivateKey = ${targetPrivateKey.replace(/[+]/g, '\\+')}`));
    assert.match(activeConfig, /ListenPort = 47282/);
    assert.match(activeConfig, /Jc = 9/);
    assert.doesNotMatch(activeConfig, /Jc = 4/);
    assert.doesNotMatch(activeConfig, new RegExp(peerPublicKey.replace(/[+]/g, '\\+')));
    const newFingerprint = crypto.createHash('sha256').update(generatedMaterials[0].publicKey).digest('hex').slice(0, 12);
    const importedFingerprint = crypto.createHash('sha256').update(generatedMaterials[1].publicKey).digest('hex').slice(0, 12);
    const freshConfig = (await target.getConfig(newFingerprint)).config;
    assert.match(freshConfig, /Endpoint = new.example.test:47282/);
    assert.match(freshConfig, /Address = 10.9.0.2\/32/);
    assert.match(freshConfig, /Jc = 9/);
    assert.match(freshConfig, new RegExp(serverPublicKey.replace(/[+]/g, '\\+')));
    assert.doesNotMatch(freshConfig, /old.example.test/);
    assert.match((await target.getConfig(importedFingerprint)).config, /Endpoint = new.example.test:47282/);
    await assert.rejects(target.getConfig(fingerprint), { code: 'config_unavailable' });
    const after = await target.createBackup();
    assert.equal(after.payload.panel.users[0].name, 'Restored phone');
    assert.equal(after.payload.panel.metadata.notes[newFingerprint], 'Восстановленная заметка');
    assert.equal(after.payload.panel.metadata.telegrams[newFingerprint], '@restored');
    assert.equal(after.payload.panel.users[0].usage.receivedBytes, 20);
    assert.equal(after.payload.awg.clientsTable[0].userData.clientName, 'Restored phone');
    assert.equal(after.payload.awg.clientsTable[1].userData.clientName, 'Amnezia import');
    const withOldObfuscation = await target.restoreBackup(backup, null, { restoreObfuscation: true });
    assert.equal(withOldObfuscation.restoredObfuscation, true);
    assert.match(activeConfig, /Jc = 4/);
    const reissuedFingerprint = crypto.createHash('sha256').update(generatedMaterials[2].publicKey).digest('hex').slice(0, 12);
    assert.match((await target.getConfig(reissuedFingerprint)).config, /Jc = 4/);
    activeConfig = activeConfig.replace('ListenPort = 47282', 'ListenPort = 55424');
    await assert.rejects(target.inspectBackup(backup), { code: 'target_awg_port_unpublished' });
    activeConfig = activeConfig.replace('ListenPort = 55424', 'ListenPort = 47282');
    const beforeFailedRestore = activeConfig;
    failProfileAfterRestore = true;
    await assert.rejects(target.restoreBackup(backup), { code: 'restore_panel_failed' });
    assert.equal(activeConfig, beforeFailedRestore);
    assert.match((await target.getConfig(reissuedFingerprint)).config, /Jc = 4/);
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test('restore inspection rejects a damaged embedded panel database', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-invalid-restore-'));
  const env = { NAIT_AWG_DATA_KEY: crypto.randomBytes(32).toString('base64'),
    NAIT_AWG_DATA_PATH: path.join(directory, 'clients.db') };
  const service = createAwgService(env, { readAwgConfig: async () => config,
    readUsagePeers: async () => ({ status: 'ok', peers: [] }) });
  const backup = await service.createBackup();
  backup.payload.panel.database = Buffer.from('not a sqlite database').toString('base64');
  await assert.rejects(service.inspectBackup(backup), { code: 'invalid_backup_database' });
});
