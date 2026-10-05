'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { deflateSync } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { parseClientConfig } = require('../app/services/clientConfigService');
const { createAwgService } = require('../app/services/awgService');

function keyPair() {
  const pair = crypto.generateKeyPairSync('x25519');
  return {
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64'),
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
  };
}
const client = keyPair();
const server = keyPair();
const psk = crypto.randomBytes(32).toString('base64');
const fingerprint = crypto.createHash('sha256').update(client.publicKey).digest('hex').slice(0, 12);
const nativeConfig = `[Interface]\nPrivateKey = ${client.privateKey}\nAddress = 10.8.1.2/32\nDNS = 1.1.1.1\nH1 = 10-20\n\n[Peer]\nPublicKey = ${server.publicKey}\nPresharedKey = ${psk}\nEndpoint = 203.0.113.42:40000\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n`;

function vpnExport(overrides = {}) {
  const json = Buffer.from(JSON.stringify({ hostName: '203.0.113.42', userName: '', password: '',
    dns1: '1.1.1.1', dns2: '1.0.0.1', containers: [{ container: 'amnezia-awg2',
      awg: { last_config: JSON.stringify({ config: nativeConfig }) } }], ...overrides }));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(json.length);
  return 'vpn://' + Buffer.concat([size, deflateSync(json)]).toString('base64url');
}

async function fixture() {
  const state = { configChanged: false, closed: false, reads: 0, calls: [] };
  const awgConfig = `[Interface]\nPrivateKey = ${server.privateKey}\nListenPort = 40000\n\n[Peer]\nPublicKey = ${client.publicKey}\nPresharedKey = ${psk}\nAllowedIPs = 10.8.1.2/32\n`;
  const receiver = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    state.calls.push({ method: req.method, url: req.url, payload: body ? JSON.parse(body) : {} });
    const answer = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/awg/peers') return answer({ status: 'ok', peers: [{ publicKey: client.publicKey,
      clientName: 'Старый клиент', allowedIps: state.closed ? [] : ['10.8.1.2/32'] }] });
    if (req.url === '/awg/profile') return answer({ status: 'ok', serverPublicKey: server.publicKey,
      listenPort: 40000, clientInterfaceParameters: { H1: '10-20' } });
    if (req.url === '/awg/gates/read') return answer({ status: 'ok', readQuality: 'complete',
      writerStatus: 'idle', nodeIncarnation: 'test-node', publicKeyFingerprint: fingerprint,
      classification: state.closed ? 'CLOSED' : 'OPEN', persistentAllowedIps: state.closed ? [] : ['10.8.1.2/32'],
      runtimeAllowedIps: state.closed ? [] : ['10.8.1.2/32'] });
    res.statusCode = 500;
    answer({ code: 'unexpected_write' });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-import-test-'));
  const env = { RECEIVER_URL: `http://127.0.0.1:${receiver.address().port}`,
    PUBLIC_ENDPOINT_HOST: '203.0.113.42', NAIT_AWG_DATA_KEY: crypto.randomBytes(32).toString('base64'),
    NAIT_AWG_DATA_PATH: path.join(directory, 'clients.db') };
  const dependencies = { readAwgConfig: async () => {
    state.reads++;
    return awgConfig + (state.configChanged && state.reads > 1 ? '# concurrent edit\n' : '');
  }, readPublishedVpnPort: async () => 40000 };
  return { state, env, dependencies, service: createAwgService(env, dependencies),
    close: () => new Promise(resolve => receiver.close(resolve)) };
}

test('native and Qt-compressed guest exports derive the original client public key', () => {
  assert.equal(parseClientConfig(nativeConfig, ['H1']).publicKey, client.publicKey);
  const parsed = parseClientConfig(vpnExport(), ['H1']);
  assert.equal(parsed.config, nativeConfig);
  assert.equal(parseClientConfig('\uFEFF' + nativeConfig.replace(/\n/g, '\r\n'), ['H1']).config, nativeConfig);
});

test('full access, backups, multiple connections and oversized compressed data are rejected', () => {
  for (const value of [vpnExport({ userName: 'root', password: 'ssh-password' }),
    vpnExport({ containers: [] }), vpnExport({ containers: [{}, {}] }),
    JSON.stringify({ servers: [nativeConfig] }), 'vpn://invalid', 'x'.repeat(65537)]) {
    assert.throws(() => parseClientConfig(value, ['H1']), { status: 400 });
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(300000);
  assert.throws(() => parseClientConfig('vpn://' + Buffer.concat([size, deflateSync(Buffer.alloc(300000))]).toString('base64url'), ['H1']));
});

test('duplicate keys, extra peer sections and shell hooks cannot enter exported configs', () => {
  for (const value of [nativeConfig + '[Peer]\nPublicKey = ' + server.publicKey,
    nativeConfig.replace('[Interface]', '[Interface]\nPostUp = echo example'),
    nativeConfig.replace('Address =', 'PrivateKey = ' + client.privateKey + '\nAddress =')]) {
    assert.throws(() => parseClientConfig(value, ['H1']), { code: 'invalid_client_config' });
  }
});

test('import preserves existing peer identity and stores only encrypted config, surviving restart', async () => {
  const item = await fixture();
  try {
    await item.service.importClientConfig(fingerprint, { config: nativeConfig });
    const peer = (await item.service.listPeers())[0];
    assert.equal(peer.hasConfig, true);
    assert.equal(peer.label, 'Старый клиент');
    assert.equal(peer.canDelete, true);
    assert.equal((await item.service.getConfig(fingerprint)).config, nativeConfig);
    assert.match(await item.service.getQr(fingerprint), /<svg/);
    const db = new DatabaseSync(item.env.NAIT_AWG_DATA_PATH, { readOnly: true });
    const stored = db.prepare('SELECT client_id, encrypted_config FROM clients').get();
    db.close();
    assert.equal(stored.client_id, `awg-existing-${fingerprint}`);
    assert.ok(!stored.encrypted_config.includes(client.privateKey));
    const restarted = createAwgService(item.env, item.dependencies);
    assert.equal((await restarted.getConfig(fingerprint)).config, nativeConfig);
    assert.deepEqual(await restarted.readPeerAccess(fingerprint), { state: 'on', address: '10.8.1.2/32' });
    assert.ok(item.state.calls.every(call => call.method === 'GET' || call.url === '/awg/gates/read'));
    await assert.rejects(restarted.importClientConfig(fingerprint, { config: nativeConfig }), { code: 'client_config_exists' });
  } finally { await item.close(); }
});

test('an already disabled external peer stays disabled and keeps its gate device identity on import', async () => {
  const item = await fixture();
  try {
    const db = new DatabaseSync(item.env.NAIT_AWG_DATA_PATH);
    db.prepare('INSERT INTO peer_gate_addresses VALUES (?, ?, ?, ?, ?)')
      .run(fingerprint, client.publicKey, `awg-existing-${fingerprint}`, '10.8.1.2/32', new Date().toISOString());
    db.close();
    item.state.closed = true;
    await item.service.importClientConfig(fingerprint, { config: nativeConfig });
    const restarted = createAwgService(item.env, item.dependencies);
    assert.deepEqual(await restarted.readPeerAccess(fingerprint), { state: 'off', address: '10.8.1.2/32' });
    assert.equal((await restarted.listPeers())[0].displayStatus, 'disabled');
    assert.ok(item.state.calls.filter(call => call.url === '/awg/gates/read')
      .every(call => call.payload.deviceId === `awg-existing-${fingerprint}`));
  } finally { await item.close(); }
});

for (const [title, replace, code] of [
  ['a different client private key', text => text.replace(client.privateKey, keyPair().privateKey), 'client_key_mismatch'],
  ['a different server', text => text.replace(server.publicKey, keyPair().publicKey), 'client_server_mismatch'],
  ['a wrong address', text => text.replace('10.8.1.2/32', '10.8.1.3/32'), 'client_address_mismatch'],
  ['a wrong VPN port', text => text.replace(':40000', ':40001'), 'client_endpoint_mismatch'],
  ['a wrong preshared key', text => text.replace(psk, crypto.randomBytes(32).toString('base64')), 'client_psk_mismatch'],
  ['different handshake parameters', text => text.replace('H1 = 10-20', 'H1 = 30-40'), 'client_obfuscation_mismatch']
]) test(`rejects ${title} without storing or changing peer data`, async () => {
  const item = await fixture();
  try {
    await assert.rejects(item.service.importClientConfig(fingerprint, { config: replace(nativeConfig) }), { code });
    assert.equal((await item.service.listPeers())[0].hasConfig, false);
    assert.ok(item.state.calls.every(call => call.method === 'GET' || call.url === '/awg/gates/read'));
  } finally { await item.close(); }
});

test('concurrent AWG edits abort import before saving client secrets', async () => {
  const item = await fixture();
  try {
    item.state.configChanged = true;
    await assert.rejects(item.service.importClientConfig(fingerprint, { config: nativeConfig }), { code: 'client_import_state_changed' });
    assert.equal((await item.service.listPeers())[0].hasConfig, false);
  } finally { await item.close(); }
});

test('guest VPN import is validated by contents, not filename, and preserves existing access', async () => {
  const item = await fixture();
  try {
    await assert.rejects(item.service.importClientConfig(fingerprint, { config: '{"backup":true}', fileName: 'client.conf' }), { code: 'invalid_client_config' });
    assert.equal((await item.service.listPeers())[0].hasConfig, false);
    await item.service.importClientConfig(fingerprint,{config:vpnExport(),fileName:'client.conf'});
    assert.equal((await item.service.getConfig(fingerprint)).config,nativeConfig);
    assert.deepEqual(await item.service.readPeerAccess(fingerprint),{state:'on',address:'10.8.1.2/32'});
    assert.ok(item.state.calls.every(call=>call.method==='GET'||call.url==='/awg/gates/read'));
  } finally { await item.close(); }
});
test('VPN admin access, another protocol, unknown format and backup data never enter the store',async()=>{
  const item=await fixture();
  try{
    for(const config of [vpnExport({password:'ssh-secret'}),vpnExport({servers:[]}),vpnExport({format_version:2}),
      vpnExport({containers:[{container:'amnezia-openvpn',awg:{last_config:JSON.stringify({config:nativeConfig})}}]})]){
      await assert.rejects(item.service.importClientConfig(fingerprint,{config}),{code:'invalid_client_export'});
    }
    const other=keyPair();
    const bytes=Buffer.from(JSON.stringify({containers:[{container:'amnezia-awg2',awg:{last_config:JSON.stringify({config:nativeConfig.replace(client.privateKey,other.privateKey)})}}]}));
    const size=Buffer.alloc(4);size.writeUInt32BE(bytes.length);
    await assert.rejects(item.service.importClientConfig(fingerprint,{config:'vpn://'+Buffer.concat([size,deflateSync(bytes)]).toString('base64url')}),{code:'client_key_mismatch'});
    assert.equal((await item.service.listPeers())[0].hasConfig,false);
  }finally{await item.close();}
});

test('valid native contents are accepted independently of filename', async () => {
  const item = await fixture();
  try {
    await item.service.importClientConfig(fingerprint, { config: nativeConfig, fileName: 'anything.txt' });
    assert.equal((await item.service.listPeers())[0].hasConfig, true);
    assert.ok(item.state.calls.every(call => call.method === 'GET' || call.url === '/awg/gates/read'));
  } finally { await item.close(); }
});
