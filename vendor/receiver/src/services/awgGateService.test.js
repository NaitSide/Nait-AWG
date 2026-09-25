'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAwgGateService, isGateWriteEnabled, parseRuntimePeerSummaries, writeDurableFile } = require('./awgGateService');
const { parseAwgPeerBlocks } = require('./awgConfigService');

const NODE_INCARNATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLAN_HASH = 'b'.repeat(64);
const GRANT_DIGEST = 'c'.repeat(64);
const ALLOWED_IP = '10.8.1.9/32';
const NODE_ID = 'test-node';

function syntheticKey(byte) {
  return Buffer.alloc(32, byte).toString('base64');
}

function clone(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function createFixture(initialAllowedIps = [], actualNodeId = NODE_ID) {
  const publicKey = syntheticKey(3);
  const otherKey = syntheticKey(4);
  const allowedLine = initialAllowedIps.length ? `AllowedIPs = ${initialAllowedIps.join(', ')}\n` : '';
  let configText = `[Interface]\nPrivateKey = hidden\nAddress = 10.8.1.1/24\n\n[Peer]\n# NaitVPN clientId=device-one\nPublicKey = ${publicKey}\nPresharedKey = hidden-psk\n${allowedLine}PersistentKeepalive = 0\n\n[Peer]\nPublicKey = ${otherKey}\nPresharedKey = neighbour-psk\nAllowedIPs = 10.8.1.8/32\n`;
  let runtimeAllowedIps = [...initialAllowedIps];
  let state = null;
  let failNextRuntimeSet = false;
  const calls = [];

  const service = createAwgGateService({
    getConfig: () => ({ containerName: 'test-awg', interfaceName: 'awg0', configPath: '/test/awg0.conf' }),
    readConfig: async () => configText,
    writeConfig: async (_config, nextConfig) => {
      calls.push(['writeConfig', nextConfig]);
      configText = nextConfig;
    },
    readRuntimePeers: async () => [
      { publicKey, allowedIps: [...runtimeAllowedIps] },
      { publicKey: otherKey, allowedIps: ['10.8.1.8/32'] }
    ],
    setRuntimeAllowedIps: async (_config, targetKey, allowedIps) => {
      calls.push(['setRuntimeAllowedIps', targetKey, [...allowedIps]]);
      assert.equal(targetKey, publicKey);
      if (failNextRuntimeSet) {
        failNextRuntimeSet = false;
        throw new Error('injected runtime failure');
      }
      runtimeAllowedIps = [...allowedIps];
    },
    writeStartupMarker: async (_config, _identity, _state, status, allowedIps) => {
      calls.push(['writeStartupMarker', status, [...allowedIps]]);
    },
    readState: async () => clone(state),
    writeState: async (_key, nextState) => {
      calls.push(['writeState', nextState.acceptedVersion, Object.values(nextState.steps || {}).map((step) => step.status).join(',')]);
      state = clone(nextState);
    },
    getNodeIncarnation: async () => NODE_INCARNATION,
    getNodeId: () => actualNodeId,
    withLock: async (task) => task(),
    isWriteEnabled: () => true
  });

  return {
    service,
    publicKey,
    otherKey,
    calls,
    get configText() { return configText; },
    set configText(value) { configText = value; },
    get runtimeAllowedIps() { return [...runtimeAllowedIps]; },
    set runtimeAllowedIps(value) { runtimeAllowedIps = [...value]; },
    get state() { return clone(state); },
    set state(value) { state = clone(value); },
    failRuntimeOnce() { failNextRuntimeSet = true; }
  };
}

function identity(fixture) {
  return {
    deviceId: 'device-one',
    deviceGeneration: '1',
    publicKey: fixture.publicKey
  };
}

function operation(fixture, version, idByte = '1') {
  return {
    ...identity(fixture),
    operationId: `${idByte.repeat(8)}-${idByte.repeat(4)}-4${idByte.repeat(3)}-8${idByte.repeat(3)}-${idByte.repeat(12)}`,
    operationVersion: String(version),
    planHash: PLAN_HASH,
    nodeIncarnation: NODE_INCARNATION,
    targetNodeId: NODE_ID,
    targetAllowedIps: [ALLOWED_IP]
  };
}

test('runtime parser splits both spaces and commas without losing a peer with empty AllowedIPs', () => {
  const first = syntheticKey(1);
  const second = syntheticKey(2);
  assert.deepEqual(parseRuntimePeerSummaries(
    `${first}\n${second}\n`,
    `${first}\t10.8.1.2/32 fd42:88:1::2/128\n${second}\t\n`
  ), [
    { publicKey: first, allowedIps: ['10.8.1.2/32', 'fd42:88:1::2/128'] },
    { publicKey: second, allowedIps: [] }
  ]);
});

test('gate writes require both write flags and a non-placeholder Receiver API key', () => {
  const enabled = {
    AWG_WRITE_ENABLED: 'true',
    AWG_GATE_WRITE_ENABLED: 'true',
    RECEIVER_API_KEY: 'synthetic-test-only'
  };
  assert.equal(isGateWriteEnabled(enabled), true);
  assert.equal(isGateWriteEnabled({ ...enabled, AWG_WRITE_ENABLED: 'false' }), false);
  assert.equal(isGateWriteEnabled({ ...enabled, AWG_GATE_WRITE_ENABLED: 'false' }), false);
  assert.equal(isGateWriteEnabled({ ...enabled, RECEIVER_API_KEY: '' }), false);
  assert.equal(isGateWriteEnabled({ ...enabled, RECEIVER_API_KEY: 'change-me' }), false);
});

test('durable state replacement leaves one complete target and no temporary files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nait-gate-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'nested', 'peer.json');

  await writeDurableFile(target, '{"version":1}\n');
  await writeDurableFile(target, '{"version":2}\n');

  assert.equal(await fs.readFile(target, 'utf8'), '{"version":2}\n');
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['peer.json']);
});

test('CLEAR removes an exact mixed IPv4/IPv6 set and persists no empty AllowedIPs line', async () => {
  const mixed = [ALLOWED_IP, 'fd42:88:1::9/128'];
  const fixture = createFixture(mixed);
  const current = operation(fixture, 1, '1');
  await fixture.service.fenceGate(current);
  const result = await fixture.service.clearGate({ ...current, expectedAllowedIps: mixed, allowedIps: [] });

  assert.equal(result.snapshot.classification, 'CLOSED');
  assert.deepEqual(fixture.runtimeAllowedIps, []);
  assert.deepEqual(parseAwgPeerBlocks(fixture.configText).find((peer) => peer.publicKey === fixture.publicKey).allowedIps, []);
  assert.doesNotMatch(fixture.configText, /^AllowedIPs\s*=\s*$/m);
});

test('read reports persistent/runtime fact without exposing the full public key or PSK', async () => {
  const fixture = createFixture([ALLOWED_IP]);
  const snapshot = await fixture.service.readGate({ ...identity(fixture), requestNonce: 'read-1' });

  assert.equal(snapshot.classification, 'OPEN');
  assert.equal(snapshot.readQuality, 'complete');
  assert.equal(snapshot.requestNonce, 'read-1');
  assert.equal(snapshot.snapshotSequence, '1');
  assert.match(snapshot.receiverInstanceId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(snapshot.persistentAllowedIps, [ALLOWED_IP]);
  assert.deepEqual(snapshot.runtimeAllowedIps, [ALLOWED_IP]);
  assert.equal(snapshot.acceptedVersion, null);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, new RegExp(fixture.publicKey.replace(/[+/]/g, '\\$&')));
  assert.doesNotMatch(serialized, /hidden-psk/);
});

test('fence, clear, set and retry preserve peer identity and enforce monotonic versions', async () => {
  const fixture = createFixture([ALLOWED_IP]);
  const first = operation(fixture, 1, '1');

  const fenced = await fixture.service.fenceGate(first);
  assert.equal(fenced.idempotent, false);
  assert.equal(fenced.snapshot.classification, 'OPEN');
  assert.equal((await fixture.service.fenceGate(first)).idempotent, true);

  const cleared = await fixture.service.clearGate({ ...first, expectedAllowedIps: [ALLOWED_IP], allowedIps: [] });
  assert.equal(cleared.snapshot.classification, 'CLOSED');
  assert.deepEqual(fixture.runtimeAllowedIps, []);
  const closedPeers = parseAwgPeerBlocks(fixture.configText);
  assert.deepEqual(closedPeers.find((peer) => peer.publicKey === fixture.publicKey).allowedIps, []);
  assert.equal(closedPeers.find((peer) => peer.publicKey === fixture.publicKey).presharedKey, 'hidden-psk');
  assert.deepEqual(closedPeers.find((peer) => peer.publicKey === fixture.otherKey).allowedIps, ['10.8.1.8/32']);

  const second = operation(fixture, 2, '2');
  await fixture.service.fenceGate(second);
  await fixture.service.clearGate({ ...second, expectedAllowedIps: [], allowedIps: [] });
  const opened = await fixture.service.setGate({ ...second, expectedAllowedIps: [], allowedIps: [ALLOWED_IP], grantDigest: GRANT_DIGEST });
  assert.equal(opened.snapshot.classification, 'OPEN');
  assert.deepEqual(fixture.runtimeAllowedIps, [ALLOWED_IP]);
  assert.match(fixture.configText, /PresharedKey = hidden-psk\nAllowedIPs = 10\.8\.1\.9\/32/);
  assert.match(fixture.configText, /# NaitGateManaged = [a-f0-9]{64}/);
  assert.deepEqual(
    fixture.calls.filter((call) => call[0] === 'writeStartupMarker').map((call) => call[1]),
    ['PENDING', 'CLOSED', 'PENDING', 'CLOSED', 'PENDING', 'OPEN']
  );

  const mutationsBeforeRetry = fixture.calls.filter((call) => ['writeConfig', 'setRuntimeAllowedIps'].includes(call[0])).length;
  const retry = await fixture.service.setGate({ ...second, expectedAllowedIps: [], allowedIps: [ALLOWED_IP], grantDigest: GRANT_DIGEST });
  assert.equal(retry.idempotent, true);
  assert.equal(fixture.calls.filter((call) => ['writeConfig', 'setRuntimeAllowedIps'].includes(call[0])).length, mutationsBeforeRetry);

  const third = operation(fixture, 3, '3');
  await fixture.service.fenceGate(third);
  await assert.rejects(
    fixture.service.setGate({ ...second, expectedAllowedIps: [], allowedIps: [ALLOWED_IP], grantDigest: GRANT_DIGEST }),
    (error) => error.code === 'stale_operation'
  );
});

test('same version cannot be rebound to another operation or plan', async () => {
  const fixture = createFixture([]);
  await fixture.service.fenceGate(operation(fixture, 7, '1'));
  await assert.rejects(
    fixture.service.fenceGate(operation(fixture, 7, '2')),
    (error) => error.code === 'operation_version_conflict'
  );
});

test('SET requires a terminal CLEAR in the same version and the local target plan', async () => {
  const fixture = createFixture([]);
  const current = operation(fixture, 1, '1');
  await fixture.service.fenceGate(current);

  await assert.rejects(
    fixture.service.setGate({ ...current, expectedAllowedIps: [], allowedIps: [ALLOWED_IP], grantDigest: GRANT_DIGEST }),
    (error) => error.code === 'current_clear_required'
  );

  await fixture.service.clearGate({ ...current, expectedAllowedIps: [], allowedIps: [] });
  await assert.rejects(
    fixture.service.setGate({
      ...current,
      targetNodeId: 'another-node',
      expectedAllowedIps: [],
      allowedIps: [ALLOWED_IP],
      grantDigest: GRANT_DIGEST
    }),
    (error) => error.code === 'fence_required'
  );
});

test('SET rejects a valid fenced plan on a receiver that is not the target', async () => {
  const fixture = createFixture([], 'wrong-node');
  const current = operation(fixture, 1, '1');
  await fixture.service.fenceGate(current);
  await fixture.service.clearGate({ ...current, expectedAllowedIps: [], allowedIps: [] });

  await assert.rejects(
    fixture.service.setGate({ ...current, expectedAllowedIps: [], allowedIps: [ALLOWED_IP], grantDigest: GRANT_DIGEST }),
    (error) => error.code === 'set_target_mismatch'
  );
});

test('SET rejects an address owned by another runtime peer before writing intent', async () => {
  const fixture = createFixture([]);
  const current = {
    ...operation(fixture, 1, '1'),
    targetAllowedIps: ['10.8.1.8/32']
  };
  await fixture.service.fenceGate(current);
  await fixture.service.clearGate({ ...current, expectedAllowedIps: [], allowedIps: [] });
  const stateBefore = fixture.state;

  await assert.rejects(
    fixture.service.setGate({
      ...current,
      expectedAllowedIps: [],
      allowedIps: ['10.8.1.8/32'],
      grantDigest: GRANT_DIGEST
    }),
    (error) => error.code === 'duplicate_allowed_ip'
  );
  assert.equal(fixture.state.steps.set, undefined);
  assert.deepEqual(fixture.state, stateBefore);
});

test('operation status is safe, step-specific, and superseded by a higher fence', async () => {
  const fixture = createFixture([]);
  const first = operation(fixture, 1, '1');
  assert.equal((await fixture.service.getOperation({ ...first, stepId: 'clear' })).operationStatus, 'not_seen');
  await fixture.service.fenceGate(first);
  assert.equal((await fixture.service.getOperation({ ...first, stepId: 'fence' })).operationStatus, 'applied');
  assert.equal((await fixture.service.getOperation({ ...first, stepId: 'clear' })).operationStatus, 'not_seen');
  await fixture.service.clearGate({ ...first, expectedAllowedIps: [], allowedIps: [] });
  const applied = await fixture.service.getOperation({ ...first, stepId: 'clear' });
  assert.equal(applied.operationStatus, 'applied');
  assert.equal(JSON.stringify(applied).includes(fixture.publicKey), false);

  await fixture.service.fenceGate(operation(fixture, 2, '2'));
  assert.equal((await fixture.service.getOperation({ ...first, stepId: 'clear' })).operationStatus, 'superseded');
});

test('a historical CLEAR retry cannot close a SET completed in the same version', async () => {
  const fixture = createFixture([]);
  const current = operation(fixture, 1, '1');
  const clear = { ...current, expectedAllowedIps: [], allowedIps: [] };
  await fixture.service.fenceGate(current);
  await fixture.service.clearGate(clear);
  await fixture.service.setGate({ ...current, expectedAllowedIps: [], allowedIps: [ALLOWED_IP], grantDigest: GRANT_DIGEST });

  await assert.rejects(fixture.service.clearGate(clear), (error) => error.code === 'operation_phase_conflict');
  assert.deepEqual(fixture.runtimeAllowedIps, [ALLOWED_IP]);
});

test('SET refuses a non-CLOSED expected state before any config or runtime mutation', async () => {
  const fixture = createFixture([ALLOWED_IP]);
  const current = operation(fixture, 1, '1');
  await fixture.service.fenceGate(current);
  await fixture.service.clearGate({ ...current, expectedAllowedIps: [ALLOWED_IP], allowedIps: [] });
  fixture.configText = fixture.configText.replace('PersistentKeepalive = 0', `AllowedIPs = ${ALLOWED_IP}\nPersistentKeepalive = 0`);
  fixture.runtimeAllowedIps = [ALLOWED_IP];
  const mutationsBefore = fixture.calls.filter((call) => ['writeConfig', 'setRuntimeAllowedIps'].includes(call[0])).length;

  await assert.rejects(
    fixture.service.setGate({ ...current, expectedAllowedIps: [], allowedIps: [ALLOWED_IP], grantDigest: GRANT_DIGEST }),
    (error) => error.code === 'gate_state_mismatch'
  );
  assert.equal(fixture.calls.filter((call) => ['writeConfig', 'setRuntimeAllowedIps'].includes(call[0])).length, mutationsBefore);
});

test('failed SET is recovered to CLOSED and cannot be replayed', async () => {
  const fixture = createFixture([]);
  const current = operation(fixture, 1, '1');
  await fixture.service.fenceGate(current);
  await fixture.service.clearGate({ ...current, expectedAllowedIps: [], allowedIps: [] });
  fixture.failRuntimeOnce();

  await assert.rejects(
    fixture.service.setGate({ ...current, expectedAllowedIps: [], allowedIps: [ALLOWED_IP], grantDigest: GRANT_DIGEST }),
    (error) => error.code === 'gate_set_failed_closed'
  );
  assert.deepEqual(fixture.runtimeAllowedIps, []);
  assert.doesNotMatch(fixture.configText, /^AllowedIPs\s*=\s*$/m);
  assert.equal(fixture.state.steps.set.status, 'aborted_closed');
  assert.equal(fixture.calls.filter((call) => call[0] === 'writeStartupMarker').at(-1)[1], 'CLOSED');
  await assert.rejects(
    fixture.service.setGate({ ...current, expectedAllowedIps: [], allowedIps: [ALLOWED_IP], grantDigest: GRANT_DIGEST }),
    (error) => error.code === 'operation_aborted_closed'
  );
});

test('higher fence resolves an interrupted divergent mutation to CLOSED before advancing', async () => {
  const fixture = createFixture([ALLOWED_IP]);
  fixture.runtimeAllowedIps = [];
  fixture.state = {
    schemaVersion: 2,
    deviceId: 'device-one',
    deviceGeneration: '1',
    publicKeyHash: require('crypto').createHash('sha256').update(fixture.publicKey).digest('hex'),
    publicKeyFingerprint: 'unused',
    nodeIncarnation: NODE_INCARNATION,
    acceptedVersion: '1',
    operationId: operation(fixture, 1, '1').operationId,
    planHash: PLAN_HASH,
    targetNodeId: NODE_ID,
    targetAllowedIps: [ALLOWED_IP],
    appliedVersion: null,
    appliedAllowedIps: [],
    grant: null,
    steps: {
      set: {
        kind: 'set',
        stepId: 'set',
        requestFingerprint: 'running-request',
        grantDigest: GRANT_DIGEST,
        status: 'running',
        beforeAllowedIps: [],
        desiredAllowedIps: [ALLOWED_IP],
        startedAt: new Date().toISOString()
      }
    },
    updatedAt: new Date().toISOString()
  };

  const next = await fixture.service.fenceGate(operation(fixture, 2, '2'));
  assert.equal(next.snapshot.classification, 'CLOSED');
  assert.equal(next.snapshot.acceptedVersion, '2');
  assert.deepEqual(fixture.runtimeAllowedIps, []);
  assert.deepEqual(parseAwgPeerBlocks(fixture.configText).find((peer) => peer.publicKey === fixture.publicKey).allowedIps, []);
});

test('write-disabled service and stale node incarnation fail closed', async () => {
  const fixture = createFixture([]);
  const disabled = createAwgGateService({ isWriteEnabled: () => false });
  await assert.rejects(disabled.fenceGate(operation(fixture, 1, '1')), (error) => error.code === 'write_disabled');

  await assert.rejects(
    fixture.service.fenceGate({ ...operation(fixture, 1, '1'), nodeIncarnation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    (error) => error.code === 'node_incarnation_mismatch'
  );

  const current = operation(fixture, 1, '1');
  await fixture.service.fenceGate(current);
  fixture.state = { ...fixture.state, nodeIncarnation: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
  await assert.rejects(
    fixture.service.readGate(identity(fixture)),
    (error) => error.code === 'gate_state_incarnation_conflict'
  );
});
