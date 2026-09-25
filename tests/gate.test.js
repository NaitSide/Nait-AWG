'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createSoloService } = require('../app/services/soloService');

const ADDRESS = '10.8.1.42/32';
const GATE_TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const PUBLIC_KEY = crypto.randomBytes(32).toString('base64');
const FINGERPRINT = crypto.createHash('sha256').update(PUBLIC_KEY).digest('hex').slice(0, 12);

async function fixture() {
  const calls = [];
  const state = { runtime: [ADDRESS], persistent: [ADDRESS], divergentAfterClear: false,
    peer2: null, version: null, planHash: null, operationId: null,
    peerState: 'inactive', latestHandshakeAt: null, transferRx: 0, transferTx: 0 };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : {};
    const answer = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/awg/peers' && req.method === 'GET') {
      answer(200, { status: 'ok', peers: [
        { publicKey: PUBLIC_KEY, allowedIps: state.runtime, state: state.peerState,
          latestHandshakeAt: state.latestHandshakeAt, transferRx: state.transferRx, transferTx: state.transferTx },
        ...(state.peer2 ? [{ publicKey: state.peer2, allowedIps: [ADDRESS] }] : [])
      ] });
      return;
    }
    const step = req.url?.split('/').pop();
    if (!req.url?.startsWith('/awg/gates/')) return answer(404, { code: 'not_found' });
    calls.push({ step, payload, token: req.headers['x-awg-gate-token'] || '' });
    if (payload.publicKey !== PUBLIC_KEY) return answer(409, { code: 'key_mismatch' });
    const snapshot = () => ({ status: 'ok', nodeId: 'test-node', nodeIncarnation: '954c3fae-9b17-4ec3-999f-62630a1ba390',
      publicKeyFingerprint: FINGERPRINT, readQuality: 'complete', writerStatus: 'idle', stepStatuses: {},
      acceptedVersion: state.version, classification: JSON.stringify(state.persistent) === JSON.stringify(state.runtime)
        ? state.runtime.length ? 'OPEN' : 'CLOSED' : 'DIVERGED',
      persistentAllowedIps: state.persistent, runtimeAllowedIps: state.runtime });
    if (step === 'read') return answer(200, snapshot());
    if (step === 'fence') {
      state.version = payload.operationVersion;
      state.planHash = payload.planHash;
      state.operationId = payload.operationId;
      return answer(200, { status: 'ok', snapshot: snapshot() });
    }
    if (payload.operationVersion !== state.version || payload.planHash !== state.planHash
        || payload.operationId !== state.operationId) return answer(409, { code: 'fence_required' });
    if (step === 'clear') {
      if (JSON.stringify(payload.expectedAllowedIps) !== JSON.stringify(state.runtime)) {
        return answer(409, { code: 'gate_state_mismatch' });
      }
      state.runtime = [];
      state.persistent = state.divergentAfterClear ? [ADDRESS] : [];
      return answer(200, { status: 'ok', snapshot: snapshot() });
    }
    if (step === 'set') {
      if (state.runtime.length || state.persistent.length) return answer(409, { code: 'not_closed' });
      state.runtime = [ADDRESS];
      state.persistent = [ADDRESS];
      return answer(200, { status: 'ok', snapshot: snapshot() });
    }
    answer(404, { code: 'not_found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-gate-test-'));
  const env = { RECEIVER_URL: `http://127.0.0.1:${server.address().port}`,
    SOLO_DATA_KEY: crypto.randomBytes(32).toString('base64'), SOLO_DATA_PATH: path.join(directory, 'clients.db'),
    AWG_GATE_WRITE_TOKEN: GATE_TOKEN };
  return { calls, state, env, service: createSoloService(env),
    close: () => new Promise((resolve) => server.close(resolve)) };
}

test('OFF and ON preserve the peer and restore its exact address after independent reads', async () => {
  const item = await fixture();
  try {
    assert.deepEqual(await item.service.readPeerAccess(FINGERPRINT), { state: 'on', address: ADDRESS });
    assert.deepEqual(await item.service.setPeerAccess(FINGERPRINT, false), { state: 'off', address: ADDRESS });
    assert.deepEqual(item.state.runtime, []);
    assert.deepEqual(item.state.persistent, []);
    assert.equal((await item.service.listPeers())[0].address, ADDRESS);
    assert.deepEqual(await createSoloService(item.env).readPeerAccess(FINGERPRINT), { state: 'off', address: ADDRESS });
    assert.deepEqual(await item.service.setPeerAccess(FINGERPRINT, true), { state: 'on', address: ADDRESS });
    assert.deepEqual(item.state.runtime, [ADDRESS]);
    assert.deepEqual(item.state.persistent, [ADDRESS]);
    const writes = item.calls.filter((call) => ['fence', 'clear', 'set'].includes(call.step));
    assert.deepEqual(writes.map((call) => call.step), ['fence', 'clear', 'fence', 'clear', 'set']);
    assert.ok(writes.every((call) => call.token === GATE_TOKEN));
    assert.ok(item.calls.filter((call) => call.step === 'read').every((call) => !call.token));
    assert.equal(writes[1].payload.expectedAllowedIps[0], ADDRESS);
    assert.equal(writes[4].payload.allowedIps[0], ADDRESS);
    assert.equal((await item.service.setPeerAccess(FINGERPRINT, true)).unchanged, true);
    assert.equal(item.calls.filter((call) => call.step === 'set').length, 1);
  } finally { await item.close(); }
});

test('diverged persistent and runtime state never returns success', async () => {
  const item = await fixture();
  try {
    item.state.divergentAfterClear = true;
    await assert.rejects(item.service.setPeerAccess(FINGERPRINT, false), { code: 'gate_state_mismatch' });
    await assert.rejects(item.service.readPeerAccess(FINGERPRINT), { code: 'gate_state_mismatch' });
    assert.equal(item.calls.some((call) => call.step === 'set'), false);
  } finally { await item.close(); }
});

test('an address held by another peer blocks ON', async () => {
  const item = await fixture();
  try {
    await item.service.setPeerAccess(FINGERPRINT, false);
    item.state.peer2 = crypto.randomBytes(32).toString('base64');
    await assert.rejects(item.service.setPeerAccess(FINGERPRINT, true), { code: 'duplicate_allowed_ip' });
    assert.equal(item.calls.some((call) => call.step === 'set'), false);
  } finally { await item.close(); }
});

test('display status separates confirmed access from handshake activity', async () => {
  const item = await fixture();
  try {
    assert.equal((await item.service.listPeers())[0].displayStatus, 'never');
    item.state.latestHandshakeAt = new Date().toISOString();
    item.state.transferRx = 1024;
    item.state.peerState = 'active';
    assert.equal((await item.service.listPeers())[0].displayStatus, 'active');
    await item.service.setPeerAccess(FINGERPRINT, false);
    const blocked = (await item.service.listPeers())[0];
    assert.equal(blocked.accessState, 'off');
    assert.equal(blocked.state, 'active');
    assert.equal(blocked.displayStatus, 'disabled');
    await item.service.setPeerAccess(FINGERPRINT, true);
    item.state.peerState = 'inactive';
    assert.equal((await item.service.listPeers())[0].displayStatus, 'inactive');
  } finally { await item.close(); }
});
