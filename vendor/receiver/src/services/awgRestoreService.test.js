'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const test = require('node:test');
const { validateClientsTable, validateRestoreConfig } = require('./awgRestoreService');

const key = (byte) => Buffer.alloc(32, byte).toString('base64');
const valid = `[Interface]\nPrivateKey = ${key(1)}\nAddress = 10.8.1.0/24\nListenPort = 42820\n\n[Peer]\nPublicKey = ${key(2)}\nPresharedKey = ${key(3)}\nAllowedIPs = 10.8.1.1/32\n`;

test('restore config validation accepts one complete AWG interface', () => {
  const result = validateRestoreConfig(valid);
  assert.equal(result.parsed.hasInterface, true);
  assert.equal(result.parsed.listenPort, 42820);
  assert.equal(result.parsed.peers.length, 1);
  assert.equal(result.parsed.peers[0].publicKey, key(2));
});

test('restore config validation rejects missing secrets and duplicate peer identity', () => {
  assert.throws(() => validateRestoreConfig(valid.replace(/^PrivateKey.*$/m, '')), { code: 'invalid_restore_config' });
  assert.throws(() => validateRestoreConfig(valid.replace(/^ListenPort.*$/m, '')), { code: 'invalid_restore_config' });
  assert.throws(() => validateRestoreConfig(valid.replace('ListenPort = 42820', 'ListenPort = 70000')), { code: 'invalid_restore_config' });
  assert.throws(() => validateRestoreConfig(`${valid}\n[Peer]\nPublicKey = ${key(2)}\nAllowedIPs = 10.8.1.2/32\n`),
    { code: 'invalid_restore_config' });
  assert.throws(() => validateRestoreConfig(`${valid}\n[Peer]\nPublicKey = ${key(4)}\nAllowedIPs = 10.8.1.1/32\n`),
    { code: 'invalid_restore_config' });
});

test('clients table validation keeps only supported Amnezia metadata', () => {
  const clients = validateClientsTable([{ clientId: key(2), userData: {
    clientName: ' Restored phone ', creationDate: '2026-10-02T00:00:00.000Z', injected: 'drop me'
  } }], [{ publicKey: key(2) }]);
  assert.deepEqual(clients, [{ clientId: key(2), userData: {
    clientName: 'Restored phone', creationDate: '2026-10-02T00:00:00.000Z'
  } }]);
});
