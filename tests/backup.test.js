'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { encryptBackup, decryptBackup, plainBackup } = require('../app/services/backupService');
const { createSoloService } = require('../app/services/soloService');

const password = 'a-long-test-password-123';
const config = `[Interface]\nPrivateKey = ${crypto.randomBytes(32).toString('base64')}\nAddress = 10.8.1.1/24\nListenPort = 55424\nJc = 4\nJmin = 40\nJmax = 70\n\n[Peer]\nPublicKey = ${crypto.randomBytes(32).toString('base64')}\nAllowedIPs = 10.8.1.2/32\n`;

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
  const env = { SOLO_DATA_KEY: crypto.randomBytes(32).toString('base64'),
    SOLO_DATA_PATH: path.join(directory, 'clients.db'), PUBLIC_ENDPOINT_HOST: 'vpn.example.test', CLIENT_DNS: '9.9.9.9' };
  fs.writeFileSync(path.join(directory, 'peer-notes.json'), JSON.stringify({ version: 1,
    notes: { aabbccddeeff: 'test note' }, telegrams: { aabbccddeeff: '@example' } }));
  const usagePublicKey = crypto.randomBytes(32).toString('base64');
  const service = createSoloService(env, { readAwgConfig: async () => config,
    readUsagePeers: async () => ({ status: 'ok', peers: [{ publicKey: usagePublicKey, transferRx: 100, transferTx: 200 }] }) });
  const fixtureDb = new DatabaseSync(env.SOLO_DATA_PATH);
  fixtureDb.prepare(`INSERT INTO clients (client_id, label, receiver_label, public_key_fingerprint,
    address, encrypted_config, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'solo-test', 'iPhone_RED', 'iPhone_RED', 'aabbccddeeff', '10.8.1.25/32', 'fixture', 'active', '2026-09-23T00:00:00.000Z');
  const usageFingerprint = crypto.createHash('sha256').update(usagePublicKey).digest('hex').slice(0, 12);
  fixtureDb.prepare(`INSERT INTO clients (client_id, label, receiver_label, public_key_fingerprint,
    address, encrypted_config, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'usage-test', 'UsageTest', 'UsageTest', usageFingerprint, '10.8.1.26/32', 'fixture', 'active', '2026-09-23T00:00:00.000Z');
  fixtureDb.close();
  const envelope = await service.createBackup(password);
  const snapshot = await decryptBackup(envelope, password);
  assert.equal(snapshot.awg.config, config);
  assert.equal(snapshot.awg.configFile, 'awg0.conf');
  assert.equal(snapshot.panel.dataKey, env.SOLO_DATA_KEY);
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
  const env = { SOLO_DATA_KEY: crypto.randomBytes(32).toString('base64'), SOLO_DATA_PATH: path.join(directory, 'clients.db') };
  let reads = 0;
  const service = createSoloService(env, { readAwgConfig: async () => { reads += 1; return reads === 1 ? config : config + '# changed\n'; },
    readUsagePeers: async () => ({ status: 'ok', peers: [] }) });
  await assert.rejects(service.createBackup(password), { code: 'backup_state_changed' });
  assert.equal(reads, 2);
});
