'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { inflateSync } = require('node:zlib');
const { buildAmneziaVpn } = require('../app/services/clientExportService');
const { parseClientConfig } = require('../app/services/clientConfigService');
const privateKey = crypto.randomBytes(32).toString('base64');
const serverKey = crypto.randomBytes(32).toString('base64');
const psk = crypto.randomBytes(32).toString('base64');
const params = ['Jc','S3','H1','I1','HeaderProtectionKey'];
const native = `[Interface]\nPrivateKey = ${privateKey}\nAddress = 10.8.1.2/32\nDNS = 1.1.1.1, 1.0.0.1\nMTU = 1376\nJc = 4\nHeaderProtectionKey = 12345\n\n[Peer]\nPublicKey = ${serverKey}\nPresharedKey = ${psk}\nEndpoint = 203.0.113.42:40000\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25-35\n`;
function unpack(text) {
  assert.match(text, /^vpn:\/\/[A-Za-z0-9_-]+$/);
  const bytes = Buffer.from(text.slice(6), 'base64url');
  const plain = inflateSync(bytes.subarray(4));
  assert.equal(bytes.readUInt32BE(0), plain.length);
  return JSON.parse(plain);
}
test('AmneziaVPN guest export round-trips native keys, endpoint, DNS and AWG 3.1 settings', () => {
  const exportText = buildAmneziaVpn(native, 'Тестовый клиент', params);
  const guest = unpack(exportText);
  assert.equal(guest.description, 'Тестовый клиент');
  assert.equal(guest.defaultContainer, 'amnezia-awg2');
  assert.equal(guest.containers.length, 1);
  const awg = guest.containers[0].awg;
  assert.equal(awg.protocol_version, '3.1');
  assert.equal(awg.port, '40000');
  const saved = JSON.parse(awg.last_config);
  assert.equal(saved.config, native);
  assert.equal(saved.client_priv_key, privateKey);
  assert.equal(saved.server_pub_key, serverKey);
  assert.equal(saved.psk_key, psk);
  assert.equal(saved.port, 40000);
  assert.equal(saved.client_ip, '10.8.1.2');
  assert.equal(saved.persistent_keep_alive, '25-35');
  assert.equal(saved.mtu, '1376');
  assert.equal(saved.HeaderProtectionKey, '12345');
  assert.deepEqual(saved.allowed_ips, ['0.0.0.0/0', '::/0']);
  assert.equal(guest.dns1, '1.1.1.1'); assert.equal(guest.dns2, '1.0.0.1');
  assert.equal(parseClientConfig(exportText, params).publicKey, parseClientConfig(native, params).publicKey);
  for (const key of ['userName','password','server_priv_key','servers']) assert.equal(Object.hasOwn(guest,key), false);
  assert.equal(Object.hasOwn(saved, 'server_priv_key'), false);
});
test('IPv6 endpoint and absent optional fields stay valid in a guest export', () => {
  const stripped = native.replace(/DNS = .*\n|MTU = .*\n|PresharedKey = .*\n|PersistentKeepalive = .*\n/g, '')
    .replace('203.0.113.42:40000', '[2001:db8::1]:51820');
  const guest = unpack(buildAmneziaVpn(stripped, 'IPv6', params));
  const saved = JSON.parse(guest.containers[0].awg.last_config);
  assert.equal(guest.hostName, '2001:db8::1');
  assert.equal(saved.port, 51820);
  assert.equal(saved.psk_key, undefined);
  assert.equal(guest.dns1, '');
});
test('export refuses malformed endpoints and unsupported native fields', () => {
  for (const endpoint of ['203.0.113.42', 'host:0', 'host:65536', 'host:abc']) {
    assert.throws(() => buildAmneziaVpn(native.replace('203.0.113.42:40000', endpoint), 'Bad', params), { code:'invalid_client_endpoint' });
  }
  assert.throws(() => buildAmneziaVpn(native.replace('[Interface]', '[Interface]\nPostUp = echo bad'), 'Bad', params));
});
