'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  appendPeerBlock,
  buildConfigInstallArgs,
  ensurePeerGateManaged,
  getReceiverGroupId,
  replacePeerAllowedIps
} = require('./awgConfigService');
const { validateCreatePeerRequest } = require('./awgPeerService');

function createRequest(body) {
  return {
    body,
    get(name) {
      return name === 'idempotency-key' ? '123e4567-e89b-42d3-a456-426614174000' : '';
    }
  };
}

test('server peers always disable persistent keepalive while accepting a client policy', () => {
  const key = `${'A'.repeat(43)}=`;
  const validation = validateCreatePeerRequest(createRequest({
    clientId: 'test-client',
    clientLabel: 'test-client',
    publicKey: key,
    presharedKey: key,
    allowedIp: '10.8.1.10/32',
    persistentKeepalive: 25
  }));

  assert.equal(validation.ok, true);
  assert.equal(validation.normalized.persistentKeepalive, 0);

  const serverConfig = appendPeerBlock('[Interface]\nPrivateKey = hidden\n', {
    ...validation.normalized,
    publicKey: key,
    presharedKey: key
  });
  assert.doesNotMatch(serverConfig, /PersistentKeepalive/);
});

test('a managed peer can be created CLOSED without a transient server-side AllowedIPs grant', () => {
  const key = Buffer.alloc(32, 17).toString('base64');
  const validation = validateCreatePeerRequest(createRequest({
    clientId: 'test-client',
    clientLabel: 'test-client-fra',
    publicKey: key,
    presharedKey: key,
    allowedIp: '10.8.1.10/32',
    initialGateState: 'closed'
  }));

  assert.equal(validation.ok, true);
  assert.equal(validation.normalized.initialGateState, 'closed');
  const serverConfig = appendPeerBlock('[Interface]\nPrivateKey = hidden\n', {
    ...validation.normalized,
    publicKey: key,
    presharedKey: key
  });
  assert.match(serverConfig, /# NaitGateManaged = [a-f0-9]{64}/);
  assert.doesNotMatch(serverConfig, /^AllowedIPs\s*=/m);
  assert.match(serverConfig, new RegExp(`PublicKey = ${key.replace(/[+]/g, '\\+')}`));
});

test('create-peer validation rejects an unknown initial gate state', () => {
  const key = Buffer.alloc(32, 18).toString('base64');
  const validation = validateCreatePeerRequest(createRequest({
    clientId: 'test-client',
    clientLabel: 'test-client-fra',
    publicKey: key,
    presharedKey: key,
    allowedIp: '10.8.1.10/32',
    initialGateState: 'half-open'
  }));
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.code === 'invalid_initial_gate_state'));
});

test('config install keeps the profile private and readable by the Receiver group', () => {
  assert.deepEqual(
    buildConfigInstallArgs('amnezia-awg', '/tmp/awg0.next', '/opt/amnezia/awg/awg0.conf', 1001),
    [
      'exec',
      'amnezia-awg',
      'sh',
      '-c',
      'chmod 640 "$1" && chown "0:$3" "$1" && sync && mv "$1" "$2" && sync',
      'sh',
      '/tmp/awg0.next',
      '/opt/amnezia/awg/awg0.conf',
      '1001'
    ]
  );
});

test('config install rejects an invalid Receiver group id', () => {
  assert.throws(
    () => buildConfigInstallArgs('amnezia-awg', '/tmp/source', '/tmp/target', -1),
    /non-negative integer/
  );
});

test('configured Receiver group id is parsed as an integer', () => {
  const previous = process.env.AWG_CONFIG_GROUP_ID;
  process.env.AWG_CONFIG_GROUP_ID = '1001';
  try {
    assert.equal(getReceiverGroupId(), 1001);
  } finally {
    if (previous === undefined) delete process.env.AWG_CONFIG_GROUP_ID;
    else process.env.AWG_CONFIG_GROUP_ID = previous;
  }
});

test('invalid configured Receiver group id fails closed', () => {
  const previous = process.env.AWG_CONFIG_GROUP_ID;
  process.env.AWG_CONFIG_GROUP_ID = 'root';
  try {
    assert.throws(() => getReceiverGroupId(), /non-negative integer/);
  } finally {
    if (previous === undefined) delete process.env.AWG_CONFIG_GROUP_ID;
    else process.env.AWG_CONFIG_GROUP_ID = previous;
  }
});

for (const operation of ['writeConfigToContainer', 'restoreConfigFromBackup']) {
  test(`${operation} actually installs config with Receiver-readable permissions`, async () => {
    const calls = [];
    const sandbox = {
      module: { exports: {} },
      process: { env: { AWG_CONTAINER_CONFIG_PATH: '/container/awg0.conf', AWG_RECEIVER_TMP_DIR: '/receiver/tmp' }, pid: 42, getgid: () => 1001 },
      require(name) {
        if (name === 'crypto') return require('crypto');
        if (name === 'path') return path.posix;
        if (name === 'fs/promises') return Object.fromEntries(['mkdir','chmod','writeFile','rm'].map(method => [method, async (...args) => { calls.push([method, ...args]); }]));
        if (name === '../utils/exec') return { runFile: async (...args) => { calls.push(['runFile', ...args]); return { stdout: '' }; } };
        throw new Error(`Unexpected dependency ${name}`);
      }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'awgConfigService.js'), 'utf8'), sandbox);
    await sandbox.module.exports[operation]({ containerName: 'amnezia-awg', configPath: '/host/awg0.conf' }, operation === 'writeConfigToContainer' ? 'synthetic-config' : '/backup/awg0.conf', 'test-1');
    const commands = calls.filter(call => call[0] === 'runFile');
    assert.equal(commands.length, 2);
    const copy = commands[0], install = commands[1];
    assert.equal(copy[1], 'docker'); assert.equal(copy[2][0], 'cp');
    assert.equal(install[1], 'docker');
    assert.deepEqual(Array.from(install[2].slice(0, 6)), ['exec', 'amnezia-awg', 'sh', '-c', 'chmod 640 "$1" && chown "0:$3" "$1" && sync && mv "$1" "$2" && sync', 'sh']);
    assert.equal(copy[2][2], `amnezia-awg:${install[2][6]}`);
    assert.equal(install[2][7], '/container/awg0.conf');
    assert.equal(install[2][8], '1001');
    if (operation === 'writeConfigToContainer') assert.ok(calls.some(call => call[0] === 'rm' && call[1] === copy[2][1]));
    else assert.equal(copy[2][1], '/backup/awg0.conf');
  });
}

test('closing a peer removes AllowedIPs without changing its identity, PSK, or neighbours', () => {
  const firstKey = `${'A'.repeat(43)}=`;
  const secondKey = `${'B'.repeat(43)}=`;
  const config = `[Interface]\nPrivateKey = hidden\n\n[Peer]\nPublicKey = ${firstKey}\nPresharedKey = secret-one\nAllowedIPs = 10.8.1.2/32\nPersistentKeepalive = 25\n\n[Peer]\nPublicKey = ${secondKey}\nPresharedKey = secret-two\nAllowedIPs = 10.8.1.3/32\n`;
  const closed = replacePeerAllowedIps(config, firstKey, []);

  const firstBlock = closed.slice(closed.indexOf(`[Peer]\nPublicKey = ${firstKey}`), closed.indexOf(`\n[Peer]\nPublicKey = ${secondKey}`));
  assert.match(firstBlock, new RegExp(`PublicKey = ${firstKey.replace(/[+]/g, '\\+')}`));
  assert.match(firstBlock, /PresharedKey = secret-one/);
  assert.doesNotMatch(firstBlock, /AllowedIPs\s*=/);
  assert.match(firstBlock, /PersistentKeepalive = 25/);
  assert.match(closed, /PresharedKey = secret-two\nAllowedIPs = 10\.8\.1\.3\/32/);
  assert.doesNotMatch(closed, /^AllowedIPs\s*=\s*$/m);
});

test('opening a closed peer inserts one canonical AllowedIPs line after its PSK', () => {
  const key = `${'C'.repeat(43)}=`;
  const closed = `[Interface]\nPrivateKey = hidden\n\n[Peer]\nPublicKey = ${key}\nPresharedKey = secret\n# keep this comment\n`;
  const opened = replacePeerAllowedIps(closed, key, ['10.8.1.9/32']);

  assert.match(opened, /PresharedKey = secret\nAllowedIPs = 10\.8\.1\.9\/32\n# keep this comment/);
  assert.equal((opened.match(/^AllowedIPs\s*=/gm) || []).length, 1);
});

test('gate config mutation rejects duplicate AllowedIPs lines and duplicate full public keys', () => {
  const key = `${'D'.repeat(43)}=`;
  assert.throws(
    () => replacePeerAllowedIps(`[Peer]\nPublicKey = ${key}\nAllowedIPs = 10.8.1.2/32\nAllowedIPs = 10.8.1.3/32\n`, key, []),
    (error) => error.code === 'duplicate_allowed_ips_lines'
  );
  assert.throws(
    () => replacePeerAllowedIps(`[Peer]\nPublicKey = ${key}\n\n[Peer]\nPublicKey = ${key}\n`, key, []),
    (error) => error.code === 'peer_public_key_ambiguous'
  );
});

test('gate config mutation rejects an AllowedIP already owned by a neighbouring peer', () => {
  const targetKey = Buffer.alloc(32, 21).toString('base64');
  const neighbourKey = Buffer.alloc(32, 22).toString('base64');
  const config = `[Interface]\nPrivateKey = hidden\n\n[Peer]\nPublicKey = ${targetKey}\nPresharedKey = target-psk\n\n[Peer]\nPublicKey = ${neighbourKey}\nPresharedKey = neighbour-psk\nAllowedIPs = 10.8.1.8/32\n`;

  assert.throws(
    () => replacePeerAllowedIps(config, targetKey, ['10.8.1.8/32']),
    (error) => error.code === 'duplicate_allowed_ip'
  );
});

test('gate enrollment adds one immutable management marker without changing peer material', () => {
  const publicKey = Buffer.alloc(32, 31).toString('base64');
  const hash = 'a'.repeat(64);
  const config = `[Interface]\nPrivateKey = hidden\n\n[Peer]\n# NaitVPN clientId=device-one\nPublicKey = ${publicKey}\nPresharedKey = hidden-psk\n`;
  const enrolled = ensurePeerGateManaged(config, publicKey, hash);

  assert.match(enrolled, new RegExp(`\\[Peer\\]\\n# NaitGateManaged = ${hash}\\n# NaitVPN`));
  assert.match(enrolled, /PresharedKey = hidden-psk/);
  assert.equal(ensurePeerGateManaged(enrolled, publicKey, hash), enrolled);
  assert.throws(
    () => ensurePeerGateManaged(enrolled, publicKey, 'b'.repeat(64)),
    (error) => error.code === 'gate_management_marker_conflict'
  );
});
