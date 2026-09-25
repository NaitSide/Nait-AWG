'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const net = require('net');
const path = require('path');
const { runFile } = require('../utils/exec');
const { withDirectoryLock } = require('../utils/lock');
const {
  getContainerConfigPath,
  ensurePeerGateManaged,
  getReceiverTmpDir,
  parseAwgPeerBlocks,
  readConfig,
  replacePeerAllowedIps,
  writeConfigToContainer
} = require('./awgConfigService');
const { getAwgRuntimeConfig } = require('./awgService');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WG_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,120}$/;
const VERSION_PATTERN = /^[1-9][0-9]{0,39}$/;
const PLAN_HASH_PATTERN = /^[a-f0-9]{64}$/i;

function nowIso() {
  return new Date().toISOString();
}

function createError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 12);
}

function fullDigest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function payloadDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function normalizeAllowedIps(values) {
  return Array.from(new Set((values || []).map((item) => String(item).trim()).filter(Boolean))).sort();
}

function equalAllowedIps(left, right) {
  const a = normalizeAllowedIps(left);
  const b = normalizeAllowedIps(right);
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function parseRuntimeAllowedIps(value) {
  if (!value || String(value).trim() === '(none)') return [];
  return normalizeAllowedIps(String(value).trim().split(/[,\s]+/));
}

function parseRuntimePeerSummaries(peersOutput, allowedIpsOutput) {
  const publicKeys = String(peersOutput || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const allowedByKey = new Map();

  String(allowedIpsOutput || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
    const [publicKey, ...rest] = line.split(/\s+/);
    if (publicKey) allowedByKey.set(publicKey, parseRuntimeAllowedIps(rest.join(' ')));
  });

  return publicKeys.map((publicKey) => ({
    publicKey,
    allowedIps: allowedByKey.get(publicKey) || []
  }));
}

function parseIpv4(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => /^\d+$/.test(part) ? Number(part) : -1);
  if (bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]) >>> 0;
}

function validateIpv4AllowedIp(value) {
  const [address, prefixText, extra] = String(value || '').split('/');
  const ip = parseIpv4(address);
  const prefix = Number(prefixText);
  if (extra !== undefined || ip === null || prefix !== 32 || net.isIP(address) !== 4) {
    throw createError(400, 'invalid_allowed_ips', 'allowedIps must contain one IPv4 /32 CIDR');
  }

  const subnetText = process.env.AWG_VPN_SUBNET || '10.8.1.0/24';
  const [subnetAddress, subnetPrefixText] = subnetText.split('/');
  const subnetIp = parseIpv4(subnetAddress);
  const subnetPrefix = Number(subnetPrefixText);
  if (subnetIp === null || !Number.isInteger(subnetPrefix) || subnetPrefix < 0 || subnetPrefix > 32) {
    throw createError(409, 'invalid_awg_vpn_subnet', 'AWG_VPN_SUBNET is invalid');
  }
  const mask = subnetPrefix === 0 ? 0 : (0xffffffff << (32 - subnetPrefix)) >>> 0;
  const network = (subnetIp & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  if (ip < network || ip > broadcast || ip === network || ip === broadcast || ip === ((network + 1) >>> 0)) {
    throw createError(400, 'invalid_allowed_ips', 'allowedIps must contain a usable IPv4 /32 inside AWG_VPN_SUBNET');
  }
  return `${address}/32`;
}

function validateExpectedAllowedIp(value) {
  const cidr = String(value || '').trim();
  const slash = cidr.lastIndexOf('/');
  const address = slash > 0 ? cidr.slice(0, slash) : '';
  const prefixText = slash > 0 ? cidr.slice(slash + 1) : '';
  const family = net.isIP(address);
  const prefix = Number(prefixText);
  const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : -1;
  if (!/^\d+$/.test(prefixText) || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw createError(400, 'invalid_expected_allowed_ips', 'expectedAllowedIps must contain valid IPv4 or IPv6 CIDRs');
  }
  return `${address}/${prefix}`;
}

function validatePublicKey(value) {
  const publicKey = String(value || '').trim();
  if (!WG_KEY_PATTERN.test(publicKey)) throw createError(400, 'invalid_public_key', 'publicKey is invalid');
  try {
    if (Buffer.from(publicKey, 'base64').length !== 32) throw new Error('length');
  } catch {
    throw createError(400, 'invalid_public_key', 'publicKey is invalid');
  }
  return publicKey;
}

function requireSafeId(value, field) {
  const normalized = String(value || '').trim();
  if (!SAFE_ID_PATTERN.test(normalized)) throw createError(400, `invalid_${field}`, `${field} is invalid`);
  return normalized;
}

function validateIdentity(payload) {
  return {
    deviceId: requireSafeId(payload.deviceId, 'device_id'),
    deviceGeneration: requireSafeId(payload.deviceGeneration, 'device_generation'),
    publicKey: validatePublicKey(payload.publicKey)
  };
}

function validateRead(payload) {
  const identity = validateIdentity(payload);
  const requestNonce = payload.requestNonce === undefined
    ? null
    : requireSafeId(payload.requestNonce, 'request_nonce');
  return { ...identity, requestNonce };
}

function validateOperation(payload, mode) {
  const identity = validateIdentity(payload);
  const operationId = String(payload.operationId || '').trim().toLowerCase();
  const operationVersion = String(payload.operationVersion || '').trim();
  const planHash = String(payload.planHash || '').trim().toLowerCase();
  const nodeIncarnation = String(payload.nodeIncarnation || '').trim().toLowerCase();
  const targetNodeId = payload.targetNodeId === null
    ? null
    : requireSafeId(payload.targetNodeId, 'target_node_id');

  if (!UUID_PATTERN.test(operationId)) throw createError(400, 'invalid_operation_id', 'operationId must be a UUID');
  if (!VERSION_PATTERN.test(operationVersion)) throw createError(400, 'invalid_operation_version', 'operationVersion must be a positive decimal string');
  if (!PLAN_HASH_PATTERN.test(planHash)) throw createError(400, 'invalid_plan_hash', 'planHash must be a 64-character hex digest');
  if (!UUID_PATTERN.test(nodeIncarnation)) throw createError(400, 'invalid_node_incarnation', 'nodeIncarnation must be a UUID');
  if (!Array.isArray(payload.targetAllowedIps) || payload.targetAllowedIps.length > 1) {
    throw createError(400, 'invalid_target_allowed_ips', 'targetAllowedIps must be an array with zero or one IPv4 /32');
  }
  const targetAllowedIps = payload.targetAllowedIps.map(validateIpv4AllowedIp);
  if ((targetNodeId === null) !== (targetAllowedIps.length === 0)) {
    throw createError(400, 'invalid_target_plan', 'targetNodeId and targetAllowedIps must either both identify a target or both be empty');
  }

  const normalized = {
    ...identity,
    operationId,
    operationVersion,
    planHash,
    nodeIncarnation,
    targetNodeId,
    targetAllowedIps,
    stepId: mode
  };

  if (mode === 'clear' || mode === 'set') {
    if (!Array.isArray(payload.expectedAllowedIps) || payload.expectedAllowedIps.length > 8) {
      throw createError(400, 'invalid_expected_allowed_ips', 'expectedAllowedIps must contain at most eight exact CIDRs');
    }
    normalized.expectedAllowedIps = normalizeAllowedIps(payload.expectedAllowedIps.map(validateExpectedAllowedIp));
    if (mode === 'set') {
      if (normalized.expectedAllowedIps.length !== 0) {
        throw createError(409, 'set_requires_closed_gate', 'SET requires expectedAllowedIps to be empty');
      }
      if (!Array.isArray(payload.allowedIps) || payload.allowedIps.length !== 1) {
        throw createError(400, 'invalid_allowed_ips', 'SET requires exactly one IPv4 /32 in allowedIps');
      }
      normalized.allowedIps = payload.allowedIps.map(validateIpv4AllowedIp);
      const grantDigest = String(payload.grantDigest || '').trim().toLowerCase();
      if (!PLAN_HASH_PATTERN.test(grantDigest)) {
        throw createError(400, 'invalid_grant_digest', 'SET requires a 64-character grantDigest');
      }
      normalized.grantDigest = grantDigest;
    } else {
      if (payload.allowedIps !== undefined && (!Array.isArray(payload.allowedIps) || payload.allowedIps.length !== 0)) {
        throw createError(400, 'invalid_allowed_ips', 'CLEAR allowedIps must be omitted or empty');
      }
      normalized.allowedIps = [];
    }
  }

  return normalized;
}

function validateOperationQuery(payload) {
  const identity = validateIdentity(payload);
  const operationId = String(payload.operationId || '').trim().toLowerCase();
  const operationVersion = String(payload.operationVersion || '').trim();
  const planHash = String(payload.planHash || '').trim().toLowerCase();
  const nodeIncarnation = String(payload.nodeIncarnation || '').trim().toLowerCase();
  const stepId = String(payload.stepId || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(operationId)) throw createError(400, 'invalid_operation_id', 'operationId must be a UUID');
  if (!VERSION_PATTERN.test(operationVersion)) throw createError(400, 'invalid_operation_version', 'operationVersion must be a positive decimal string');
  if (!PLAN_HASH_PATTERN.test(planHash)) throw createError(400, 'invalid_plan_hash', 'planHash must be a 64-character hex digest');
  if (!UUID_PATTERN.test(nodeIncarnation)) throw createError(400, 'invalid_node_incarnation', 'nodeIncarnation must be a UUID');
  if (!['fence', 'clear', 'set'].includes(stepId)) throw createError(400, 'invalid_step_id', 'stepId must be fence, clear, or set');
  return { ...identity, operationId, operationVersion, planHash, nodeIncarnation, stepId };
}

function getGateStateDir() {
  return process.env.AWG_GATE_STATE_DIR || path.join(
    process.env.AWG_IDEMPOTENCY_DIR
      ? path.dirname(process.env.AWG_IDEMPOTENCY_DIR)
      : '/opt/naitlab/nait_awg_node/receiver/state',
    'gates'
  );
}

function statePathForPublicKey(publicKey) {
  return path.join(getGateStateDir(), `peer-${fullDigest(publicKey)}.json`);
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!error || !['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function writeDurableFile(targetPath, content) {
  const directory = path.dirname(targetPath);
  const tempPath = path.join(directory, `${path.basename(targetPath)}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  let handle;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, targetPath);
    await fs.chmod(targetPath, 0o600);
    await fsyncDirectory(directory);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function readState(publicKey) {
  try {
    const parsed = JSON.parse(await fs.readFile(statePathForPublicKey(publicKey), 'utf8'));
    if (!parsed || ![1, 2].includes(parsed.schemaVersion)) throw new Error('unsupported schema');
    return parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw createError(409, 'gate_state_unavailable', 'Gate state is missing, corrupt, or unsupported');
  }
}

async function writeState(publicKey, state) {
  await writeDurableFile(statePathForPublicKey(publicKey), `${JSON.stringify(state, null, 2)}\n`);
}

async function getNodeIncarnation() {
  const configured = String(process.env.AWG_NODE_INCARNATION || '').trim().toLowerCase();
  if (configured) {
    if (!UUID_PATTERN.test(configured)) throw createError(409, 'invalid_node_incarnation_config', 'AWG_NODE_INCARNATION must be a UUID');
    return configured;
  }

  const target = path.join(getGateStateDir(), 'node-incarnation');
  try {
    const existing = String(await fs.readFile(target, 'utf8')).trim().toLowerCase();
    if (!UUID_PATTERN.test(existing)) throw new Error('invalid');
    return existing;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw createError(409, 'node_incarnation_unavailable', 'Node incarnation state is invalid');
  }

  const created = crypto.randomUUID();
  await writeDurableFile(target, `${created}\n`);
  return created;
}

function getWriteLockPath() {
  return path.join(process.env.AWG_LOCK_DIR || '/opt/naitlab/nait_awg_node/receiver/locks', 'awg0.write.lock.d');
}

async function readRuntimePeers(config) {
  const timeoutMs = Number(process.env.AWG_GATE_TIMEOUT_MS || process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000);
  const [peers, allowed] = await Promise.all([
    runFile('docker', ['exec', config.containerName, 'awg', 'show', config.interfaceName, 'peers'], { timeoutMs }),
    runFile('docker', ['exec', config.containerName, 'awg', 'show', config.interfaceName, 'allowed-ips'], { timeoutMs })
  ]);
  return parseRuntimePeerSummaries(peers.stdout, allowed.stdout);
}

async function setRuntimeAllowedIps(config, publicKey, allowedIps) {
  const timeoutMs = Number(process.env.AWG_GATE_TIMEOUT_MS || process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000);
  await runFile('docker', [
    'exec', config.containerName, 'awg', 'set', config.interfaceName,
    'peer', publicKey, 'allowed-ips', normalizeAllowedIps(allowedIps).join(',')
  ], { timeoutMs });
}

function buildStartupMarker(identity, state, status, allowedIps) {
  if (!['PENDING', 'CLOSED', 'OPEN'].includes(status)) {
    throw createError(500, 'invalid_startup_marker_status', 'Startup marker status is invalid');
  }
  const normalizedAllowedIps = normalizeAllowedIps(allowedIps);
  if (status === 'OPEN' && normalizedAllowedIps.length === 0) {
    throw createError(500, 'invalid_startup_marker_state', 'OPEN startup marker requires AllowedIPs');
  }
  if (status !== 'OPEN' && normalizedAllowedIps.length !== 0) {
    throw createError(500, 'invalid_startup_marker_state', 'Non-OPEN startup marker cannot contain AllowedIPs');
  }
  return [
    'schema=1',
    `public_key=${identity.publicKey}`,
    `public_key_hash=${fullDigest(identity.publicKey)}`,
    `node_incarnation=${state.nodeIncarnation}`,
    `status=${status}`,
    `allowed_ips=${normalizedAllowedIps.join(',')}`,
    `accepted_version=${state.acceptedVersion || ''}`,
    `applied_version=${state.appliedVersion || ''}`,
    `plan_hash=${state.planHash || ''}`,
    `grant_digest=${state.grant && state.grant.grantDigest ? state.grant.grantDigest : ''}`,
    ''
  ].join('\n');
}

async function writeStartupMarker(config, identity, state, status, allowedIps, requestId) {
  const tmpDir = getReceiverTmpDir();
  const safeId = String(requestId || `${process.pid}-${Date.now()}`).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const publicKeyHash = fullDigest(identity.publicKey);
  const configDir = path.posix.dirname(getContainerConfigPath(config));
  const targetPath = path.posix.join(configDir, `.nait-gate-${publicKeyHash}.state`);
  const containerTempPath = `${targetPath}.tmp.${safeId}`;
  const localTempPath = path.join(tmpDir, `.nait-gate-${publicKeyHash}.${safeId}.${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });
  await fs.chmod(tmpDir, 0o700);
  await fs.writeFile(localTempPath, buildStartupMarker(identity, state, status, allowedIps), { mode: 0o600 });
  try {
    const timeoutMs = Number(process.env.AWG_GATE_TIMEOUT_MS || process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000);
    await runFile('docker', ['cp', localTempPath, `${config.containerName}:${containerTempPath}`], { timeoutMs });
    await runFile('docker', [
      'exec', config.containerName, 'sh', '-c',
      'chmod 600 "$1" && chown 0:0 "$1" && sync && mv "$1" "$2" && sync',
      'sh', containerTempPath, targetPath
    ], { timeoutMs });
  } finally {
    await fs.rm(localTempPath, { force: true });
  }
}

function assertIdentityBinding(state, identity) {
  if (!state) return;
  const publicKeyHash = fullDigest(identity.publicKey);
  if (state.deviceId !== identity.deviceId || state.deviceGeneration !== identity.deviceGeneration || state.publicKeyHash !== publicKeyHash) {
    throw createError(409, 'gate_identity_conflict', 'Stored gate identity does not match the request');
  }
}

function assertStoredNodeIncarnation(state, actual) {
  if (state && state.nodeIncarnation !== actual) {
    throw createError(409, 'gate_state_incarnation_conflict', 'Gate journal belongs to another node incarnation');
  }
}

function classifySnapshot(persistentMatches, runtimeMatches) {
  if (persistentMatches.length === 0 && runtimeMatches.length === 0) return 'MISSING';
  if (persistentMatches.length !== 1 || runtimeMatches.length !== 1) return 'DIVERGED';
  const persistentAllowedIps = normalizeAllowedIps(persistentMatches[0].allowedIps);
  const runtimeAllowedIps = normalizeAllowedIps(runtimeMatches[0].allowedIps);
  if (!equalAllowedIps(persistentAllowedIps, runtimeAllowedIps)) return 'DIVERGED';
  return persistentAllowedIps.length ? 'OPEN' : 'CLOSED';
}

function publicState(state) {
  if (!state) return {
    acceptedVersion: null,
    acceptedPlanHash: null,
    acceptedTarget: null,
    appliedVersion: null,
    writerStatus: 'idle',
    stepStatuses: {},
    appliedGrant: null
  };
  return {
    acceptedVersion: state.acceptedVersion,
    acceptedPlanHash: state.planHash,
    acceptedTarget: state.acceptedVersion === null
      ? null
      : {
          nodeId: state.targetNodeId,
          allowedIps: normalizeAllowedIps(state.targetAllowedIps)
        },
    appliedVersion: state.appliedVersion || null,
    writerStatus: Object.values(state.steps || {}).some((step) => step && step.status === 'running') ? 'running' : 'idle',
    stepStatuses: Object.fromEntries(Object.entries(state.steps || {}).map(([name, step]) => [name, step.status])),
    appliedGrant: state.grant
      ? {
          operationVersion: state.grant.operationVersion,
          planHash: state.grant.planHash,
          grantDigest: state.grant.grantDigest,
          allowedIps: normalizeAllowedIps(state.grant.allowedIps)
        }
      : null
  };
}

async function readSnapshot(deps, config, identity, state, nodeIncarnation, context = {}) {
  const requestId = typeof context === 'string' ? context : context.requestId;
  const [configText, runtimePeers] = await Promise.all([
    deps.readConfig(config, requestId),
    deps.readRuntimePeers(config, requestId)
  ]);
  const persistentMatches = parseAwgPeerBlocks(configText).filter((peer) => peer.publicKey === identity.publicKey);
  const runtimeMatches = runtimePeers.filter((peer) => peer.publicKey === identity.publicKey);
  if (persistentMatches.length === 1 && persistentMatches[0].clientId
      && persistentMatches[0].clientId !== identity.deviceId) {
    throw createError(409, 'gate_identity_conflict', 'Config peer identity does not match the request');
  }
  const classification = classifySnapshot(persistentMatches, runtimeMatches);

  return {
    nodeId: process.env.NODE_ID || null,
    nodeIncarnation,
    deviceId: identity.deviceId,
    deviceGeneration: identity.deviceGeneration,
    publicKeyFingerprint: fingerprint(identity.publicKey),
    readQuality: 'complete',
    receiverInstanceId: deps.receiverInstanceId,
    snapshotSequence: deps.nextSnapshotSequence(),
    requestNonce: identity.requestNonce || (typeof context === 'object' ? context.requestNonce : null) || null,
    classification,
    persistentAllowedIps: persistentMatches.length === 1 ? normalizeAllowedIps(persistentMatches[0].allowedIps) : null,
    runtimeAllowedIps: runtimeMatches.length === 1 ? normalizeAllowedIps(runtimeMatches[0].allowedIps) : null,
    ...publicState(state),
    observedAt: nowIso()
  };
}

async function assertAllowedIpsAvailable(deps, config, publicKey, desiredAllowedIps) {
  const [configText, runtimePeers] = await Promise.all([
    deps.readConfig(config),
    deps.readRuntimePeers(config)
  ]);
  const desired = normalizeAllowedIps(desiredAllowedIps);
  const persistentConflict = parseAwgPeerBlocks(configText).some((peer) => peer.publicKey !== publicKey
    && (peer.allowedIps || []).some((allowedIp) => desired.includes(allowedIp)));
  const runtimeConflict = runtimePeers.some((peer) => peer.publicKey !== publicKey
    && (peer.allowedIps || []).some((allowedIp) => desired.includes(allowedIp)));
  if (persistentConflict || runtimeConflict) {
    throw createError(409, 'duplicate_allowed_ip', 'Desired AllowedIPs are already assigned to another peer');
  }
}

function baseState(identity, nodeIncarnation) {
  return {
    schemaVersion: 2,
    deviceId: identity.deviceId,
    deviceGeneration: identity.deviceGeneration,
    publicKeyHash: fullDigest(identity.publicKey),
    publicKeyFingerprint: fingerprint(identity.publicKey),
    nodeIncarnation,
    acceptedVersion: null,
    operationId: null,
    planHash: null,
    targetNodeId: null,
    targetAllowedIps: [],
    appliedVersion: null,
    appliedAllowedIps: [],
    grant: null,
    steps: {},
    updatedAt: nowIso()
  };
}

function normalizeStoredState(state) {
  if (!state) return state;
  if (state.schemaVersion === 1) {
    const legacyMutation = state.mutation;
    state.schemaVersion = 2;
    state.steps = legacyMutation && legacyMutation.stepId
      ? { [legacyMutation.stepId]: legacyMutation }
      : {};
    state.targetNodeId = state.targetNodeId || null;
    state.targetAllowedIps = normalizeAllowedIps(state.targetAllowedIps || []);
    state.appliedAllowedIps = normalizeAllowedIps(state.appliedAllowedIps || []);
    state.grant = state.grant || null;
    delete state.mutation;
  }
  state.steps = state.steps || {};
  return state;
}

function assertNodeIncarnation(operation, actual) {
  if (operation.nodeIncarnation !== actual) {
    throw createError(409, 'node_incarnation_mismatch', 'The requested node incarnation is stale');
  }
}

function compareVersions(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

async function applyDesired(deps, config, publicKey, desiredAllowedIps, requestId, managePeer = false) {
  const currentConfig = await deps.readConfig(config, requestId);
  let nextConfig = replacePeerAllowedIps(currentConfig, publicKey, desiredAllowedIps);
  if (managePeer) nextConfig = ensurePeerGateManaged(nextConfig, publicKey, fullDigest(publicKey));
  if (nextConfig !== currentConfig) await deps.writeConfig(config, nextConfig, requestId);
  await deps.setRuntimeAllowedIps(config, publicKey, desiredAllowedIps);
}

function assertSnapshotMatches(snapshot, expectedAllowedIps) {
  if (!['OPEN', 'CLOSED'].includes(snapshot.classification)
      || !equalAllowedIps(snapshot.persistentAllowedIps, expectedAllowedIps)
      || !equalAllowedIps(snapshot.runtimeAllowedIps, expectedAllowedIps)) {
    throw createError(409, 'gate_state_mismatch', 'Persistent/runtime gate state does not match the expected AllowedIPs');
  }
}

async function forceClosed(deps, config, identity, state, requestId, nodeIncarnation) {
  await deps.writeStartupMarker(config, identity, state, 'PENDING', [], requestId);
  await applyDesired(deps, config, identity.publicKey, [], requestId, true);
  const snapshot = await readSnapshot(deps, config, identity, state, nodeIncarnation);
  assertSnapshotMatches(snapshot, []);
  return snapshot;
}

function getRunningStep(state) {
  const running = Object.entries((state && state.steps) || {}).filter(([, step]) => step && step.status === 'running');
  if (running.length > 1) {
    throw createError(409, 'gate_journal_conflict', 'Gate journal contains multiple running writers');
  }
  return running.length ? { name: running[0][0], record: running[0][1] } : null;
}

function stableMarkerForState(state) {
  const allowedIps = state && state.grant ? normalizeAllowedIps(state.grant.allowedIps) : [];
  return allowedIps.length ? { status: 'OPEN', allowedIps } : { status: 'CLOSED', allowedIps: [] };
}

async function recoverInterruptedMutation(deps, config, identity, state, requestId, nodeIncarnation) {
  const running = getRunningStep(state);
  if (!running) return state;
  const mutation = running.record;
  try {
    const observed = await readSnapshot(deps, config, identity, state, nodeIncarnation);
    if (equalAllowedIps(observed.persistentAllowedIps, mutation.desiredAllowedIps)
        && equalAllowedIps(observed.runtimeAllowedIps, mutation.desiredAllowedIps)
        && ['OPEN', 'CLOSED'].includes(observed.classification)) {
      state.steps[running.name] = {
        ...mutation,
        status: 'applied_recovered',
        finishedAt: nowIso(),
        recovery: 'desired_state_observed'
      };
      state.appliedVersion = state.acceptedVersion;
      state.appliedAllowedIps = normalizeAllowedIps(mutation.desiredAllowedIps);
      state.grant = running.name === 'set'
        ? {
            operationVersion: state.acceptedVersion,
            operationId: state.operationId,
            planHash: state.planHash,
            grantDigest: mutation.grantDigest,
            allowedIps: normalizeAllowedIps(mutation.desiredAllowedIps)
          }
        : null;
      state.updatedAt = nowIso();
      await deps.writeState(identity.publicKey, state);
      await deps.writeStartupMarker(
        config,
        identity,
        state,
        running.name === 'set' ? 'OPEN' : 'CLOSED',
        state.appliedAllowedIps,
        requestId
      );
      return state;
    }

    await forceClosed(deps, config, identity, state, requestId, nodeIncarnation);
    state.steps[running.name] = {
      ...mutation,
      status: running.name === 'clear' ? 'applied_recovered' : 'aborted_closed',
      finishedAt: nowIso(),
      recovery: 'forced_closed'
    };
    state.appliedVersion = state.acceptedVersion;
    state.appliedAllowedIps = [];
    state.grant = null;
    state.updatedAt = nowIso();
    await deps.writeState(identity.publicKey, state);
    await deps.writeStartupMarker(config, identity, state, 'CLOSED', [], requestId);
    return state;
  } catch {
    state.steps[running.name] = {
      ...mutation,
      status: 'failed_unknown',
      finishedAt: nowIso(),
      recovery: 'close_failed'
    };
    state.updatedAt = nowIso();
    await deps.writeState(identity.publicKey, state).catch(() => {});
    throw createError(409, 'gate_recovery_required', 'An interrupted gate mutation could not be proven closed');
  }
}

async function recoverUncertainMutation(deps, config, identity, state, requestId, nodeIncarnation) {
  const uncertain = Object.entries((state && state.steps) || {})
    .filter(([, step]) => step && step.status === 'failed_unknown');
  if (!uncertain.length) return state;
  if (uncertain.length > 1) {
    throw createError(409, 'gate_journal_conflict', 'Gate journal contains multiple unknown mutations');
  }
  const [name, mutation] = uncertain[0];
  try {
    await forceClosed(deps, config, identity, state, requestId, nodeIncarnation);
    state.steps[name] = {
      ...mutation,
      status: name === 'clear' ? 'applied_recovered' : 'aborted_closed',
      finishedAt: nowIso(),
      recovery: 'forced_closed_after_unknown'
    };
    state.appliedVersion = state.acceptedVersion;
    state.appliedAllowedIps = [];
    state.grant = null;
    state.updatedAt = nowIso();
    await deps.writeState(identity.publicKey, state);
    await deps.writeStartupMarker(config, identity, state, 'CLOSED', [], requestId);
    return state;
  } catch {
    throw createError(409, 'gate_recovery_required', 'An unknown gate mutation could not be proven closed');
  }
}

async function recoverGateJournal(deps, config, identity, state, requestId, nodeIncarnation) {
  state = await recoverInterruptedMutation(deps, config, identity, state, requestId, nodeIncarnation);
  return recoverUncertainMutation(deps, config, identity, state, requestId, nodeIncarnation);
}

function createAwgGateService(overrides = {}) {
  let snapshotSequence = 0n;
  const deps = {
    getConfig: getAwgRuntimeConfig,
    readConfig,
    writeConfig: writeConfigToContainer,
    readRuntimePeers,
    setRuntimeAllowedIps,
    writeStartupMarker,
    readState,
    writeState,
    getNodeIncarnation,
    getNodeId: () => requireSafeId(process.env.NODE_ID, 'node_id'),
    receiverInstanceId: crypto.randomUUID(),
    nextSnapshotSequence: () => String(++snapshotSequence),
    withLock: (task) => withDirectoryLock(
      getWriteLockPath(),
      { timeoutMs: Number(process.env.AWG_LOCK_TIMEOUT_MS || 15000) },
      task
    ),
    isWriteEnabled: () => isGateWriteEnabled(process.env),
    ...overrides
  };

  async function readGate(payload, context = {}) {
    const identity = validateRead(payload || {});
    return deps.withLock(async () => {
      const nodeIncarnation = await deps.getNodeIncarnation();
      const state = normalizeStoredState(await deps.readState(identity.publicKey));
      assertIdentityBinding(state, identity);
      assertStoredNodeIncarnation(state, nodeIncarnation);
      return readSnapshot(deps, deps.getConfig(), identity, state, nodeIncarnation, context.requestId);
    });
  }

  async function getOperation(payload) {
    const query = validateOperationQuery(payload || {});
    return deps.withLock(async () => {
      const nodeIncarnation = await deps.getNodeIncarnation();
      assertNodeIncarnation(query, nodeIncarnation);
      const state = normalizeStoredState(await deps.readState(query.publicKey));
      assertIdentityBinding(state, query);
      assertStoredNodeIncarnation(state, nodeIncarnation);

      let operationStatus = 'not_seen';
      if (state && state.acceptedVersion !== null) {
        const comparison = compareVersions(query.operationVersion, state.acceptedVersion);
        if (comparison < 0) operationStatus = 'superseded';
        else if (comparison === 0) {
          if (state.operationId !== query.operationId || state.planHash !== query.planHash) {
            throw createError(409, 'operation_version_conflict', 'Operation version is bound to a different operation or plan');
          }
          if (query.stepId === 'fence') operationStatus = 'applied';
          else {
            const status = state.steps[query.stepId] && state.steps[query.stepId].status;
            if (status === 'running') operationStatus = 'running';
            else if (['applied', 'applied_recovered'].includes(status)) operationStatus = 'applied';
            else if (status === 'aborted_closed') operationStatus = 'aborted';
            else if (status === 'failed_unknown') operationStatus = 'failed_unknown';
          }
        }
      }

      return {
        operation: 'get_gate_operation',
        operationId: query.operationId,
        operationVersion: query.operationVersion,
        stepId: query.stepId,
        operationStatus,
        nodeId: deps.getNodeId(),
        nodeIncarnation,
        deviceId: query.deviceId,
        deviceGeneration: query.deviceGeneration,
        publicKeyFingerprint: fingerprint(query.publicKey)
      };
    });
  }

  async function fenceGate(payload, context = {}) {
    if (!deps.isWriteEnabled()) throw createError(403, 'write_disabled', 'AWG write operations are disabled');
    const operation = validateOperation(payload || {}, 'fence');
    return deps.withLock(async () => {
      const config = deps.getConfig();
      const nodeIncarnation = await deps.getNodeIncarnation();
      assertNodeIncarnation(operation, nodeIncarnation);
      let state = normalizeStoredState(await deps.readState(operation.publicKey));
      assertIdentityBinding(state, operation);
      assertStoredNodeIncarnation(state, nodeIncarnation);

      if (state && state.acceptedVersion !== null) {
        const comparison = compareVersions(operation.operationVersion, state.acceptedVersion);
        if (comparison < 0) throw createError(409, 'stale_operation', 'Operation version is below the accepted fence');
        if (comparison === 0) {
          if (state.operationId !== operation.operationId || state.planHash !== operation.planHash
              || state.targetNodeId !== operation.targetNodeId
              || !equalAllowedIps(state.targetAllowedIps, operation.targetAllowedIps)) {
            throw createError(409, 'operation_version_conflict', 'Operation version is already bound to a different plan');
          }
          state = await recoverGateJournal(deps, config, operation, state, context.requestId, nodeIncarnation);
          const snapshot = await readSnapshot(deps, config, operation, state, nodeIncarnation);
          return { operation: 'fence_gate', idempotent: true, snapshot };
        }
        state = await recoverGateJournal(deps, config, operation, state, context.requestId, nodeIncarnation);
      }

      const next = state || baseState(operation, nodeIncarnation);
      next.acceptedVersion = operation.operationVersion;
      next.operationId = operation.operationId;
      next.planHash = operation.planHash;
      next.targetNodeId = operation.targetNodeId;
      next.targetAllowedIps = normalizeAllowedIps(operation.targetAllowedIps);
      next.steps = {};
      next.updatedAt = nowIso();
      await deps.writeState(operation.publicKey, next);
      const snapshot = await readSnapshot(deps, config, operation, next, nodeIncarnation);
      return { operation: 'fence_gate', idempotent: false, snapshot };
    });
  }

  async function mutateGate(payload, mode, context = {}) {
    if (!deps.isWriteEnabled()) throw createError(403, 'write_disabled', 'AWG write operations are disabled');
    const operation = validateOperation(payload || {}, mode);
    const requestFingerprint = payloadDigest({
      operationId: operation.operationId,
      operationVersion: operation.operationVersion,
      planHash: operation.planHash,
      mode,
      expectedAllowedIps: operation.expectedAllowedIps,
      allowedIps: operation.allowedIps,
      targetNodeId: operation.targetNodeId,
      targetAllowedIps: operation.targetAllowedIps,
      grantDigest: operation.grantDigest || null,
      publicKeyHash: fullDigest(operation.publicKey)
    });

    return deps.withLock(async () => {
      const config = deps.getConfig();
      const nodeIncarnation = await deps.getNodeIncarnation();
      assertNodeIncarnation(operation, nodeIncarnation);
      let state = normalizeStoredState(await deps.readState(operation.publicKey));
      assertIdentityBinding(state, operation);
      assertStoredNodeIncarnation(state, nodeIncarnation);
      if (!state || state.acceptedVersion !== operation.operationVersion
          || state.operationId !== operation.operationId || state.planHash !== operation.planHash
          || state.targetNodeId !== operation.targetNodeId
          || !equalAllowedIps(state.targetAllowedIps, operation.targetAllowedIps)) {
        if (state && state.acceptedVersion !== null
            && compareVersions(operation.operationVersion, state.acceptedVersion) < 0) {
          throw createError(409, 'stale_operation', 'Operation version is below the accepted fence');
        }
        throw createError(409, 'fence_required', 'The exact operation fence must be accepted before mutation');
      }

      const running = getRunningStep(state);
      if (running && running.name !== mode) {
        state = await recoverInterruptedMutation(deps, config, operation, state, context.requestId, nodeIncarnation);
      }

      if (mode === 'clear' && state.steps.set) {
        throw createError(409, 'operation_phase_conflict', 'CLEAR after SET requires a newer fenced operation');
      }

      let step = state.steps[mode];
      if (step) {
        if (step.requestFingerprint !== requestFingerprint) {
          throw createError(409, 'idempotency_conflict', 'This operation step already has a different payload');
        }
        if (step.status === 'running') {
          state = await recoverInterruptedMutation(deps, config, operation, state, context.requestId, nodeIncarnation);
          step = state.steps[mode];
        }
        if (['applied', 'applied_recovered'].includes(step.status)) {
          const snapshot = await readSnapshot(deps, config, operation, state, nodeIncarnation);
          assertSnapshotMatches(snapshot, operation.allowedIps);
          return { operation: `${mode}_gate`, idempotent: true, recovered: step.status === 'applied_recovered', snapshot };
        }
        if (step.status === 'aborted_closed') {
          throw createError(409, 'operation_aborted_closed', 'The failed SET was recovered to CLOSED');
        }
        throw createError(409, 'gate_recovery_required', 'The previous mutation result is unknown');
      }

      if (mode === 'set') {
        const clearStep = state.steps.clear;
        if (!clearStep || !['applied', 'applied_recovered'].includes(clearStep.status)) {
          throw createError(409, 'current_clear_required', 'SET requires a terminal CLEAR receipt in the same operation version');
        }
        if (operation.targetNodeId !== deps.getNodeId()
            || !equalAllowedIps(operation.allowedIps, operation.targetAllowedIps)) {
          throw createError(409, 'set_target_mismatch', 'SET is not authorized for this node or AllowedIPs');
        }
        await assertAllowedIpsAvailable(deps, config, operation.publicKey, operation.allowedIps);
      }

      const before = await readSnapshot(deps, config, operation, state, nodeIncarnation);
      assertSnapshotMatches(before, operation.expectedAllowedIps);
      state.steps[mode] = {
        kind: mode,
        stepId: mode,
        requestFingerprint,
        ...(operation.grantDigest ? { grantDigest: operation.grantDigest } : {}),
        status: 'running',
        beforeAllowedIps: normalizeAllowedIps(operation.expectedAllowedIps),
        desiredAllowedIps: normalizeAllowedIps(operation.allowedIps),
        startedAt: nowIso()
      };
      state.updatedAt = nowIso();
      await deps.writeStartupMarker(config, operation, state, 'PENDING', [], context.requestId);
      try {
        await deps.writeState(operation.publicKey, state);
      } catch (error) {
        const stable = stableMarkerForState(state);
        await deps.writeStartupMarker(
          config,
          operation,
          state,
          stable.status,
          stable.allowedIps,
          context.requestId
        ).catch(() => {});
        throw error;
      }

      try {
        await applyDesired(deps, config, operation.publicKey, operation.allowedIps, context.requestId, true);
        const after = await readSnapshot(deps, config, operation, state, nodeIncarnation);
        assertSnapshotMatches(after, operation.allowedIps);
        state.steps[mode] = { ...state.steps[mode], status: 'applied', finishedAt: nowIso() };
        state.appliedVersion = operation.operationVersion;
        state.appliedAllowedIps = normalizeAllowedIps(operation.allowedIps);
        state.grant = mode === 'set'
          ? {
              operationVersion: operation.operationVersion,
              operationId: operation.operationId,
              planHash: operation.planHash,
              grantDigest: operation.grantDigest,
              allowedIps: normalizeAllowedIps(operation.allowedIps)
            }
          : null;
        state.updatedAt = nowIso();
        await deps.writeState(operation.publicKey, state);
        await deps.writeStartupMarker(
          config,
          operation,
          state,
          mode === 'set' ? 'OPEN' : 'CLOSED',
          operation.allowedIps,
          context.requestId
        );
        const snapshot = { ...after, ...publicState(state) };
        return { operation: `${mode}_gate`, idempotent: false, recovered: false, snapshot };
      } catch {
        try {
          await forceClosed(deps, config, operation, state, context.requestId, nodeIncarnation);
          state.steps[mode] = {
            ...state.steps[mode],
            status: mode === 'clear' ? 'applied_recovered' : 'aborted_closed',
            finishedAt: nowIso(),
            recovery: 'forced_closed'
          };
          state.appliedVersion = operation.operationVersion;
          state.appliedAllowedIps = [];
          state.grant = null;
          state.updatedAt = nowIso();
          await deps.writeState(operation.publicKey, state);
          await deps.writeStartupMarker(config, operation, state, 'CLOSED', [], context.requestId);
          const snapshot = await readSnapshot(deps, config, operation, state, nodeIncarnation);
          if (mode === 'clear') return { operation: 'clear_gate', idempotent: false, recovered: true, snapshot };
          throw createError(409, 'gate_set_failed_closed', 'SET failed and the peer was recovered to CLOSED');
        } catch (recoveryError) {
          if (recoveryError && recoveryError.code === 'gate_set_failed_closed') throw recoveryError;
          state.steps[mode] = {
            ...state.steps[mode],
            status: 'failed_unknown',
            finishedAt: nowIso(),
            recovery: 'close_failed'
          };
          state.updatedAt = nowIso();
          await deps.writeState(operation.publicKey, state).catch(() => {});
          throw createError(409, 'gate_mutation_unknown', 'Gate mutation failed and CLOSED could not be proven');
        }
      }
    });
  }

  return {
    readGate,
    getOperation,
    fenceGate,
    clearGate: (payload, context) => mutateGate(payload, 'clear', context),
    setGate: (payload, context) => mutateGate(payload, 'set', context)
  };
}

function isGateWriteEnabled(env = process.env) {
  const enabled = (name) => String(env[name] || '').trim().toLowerCase() === 'true';
  const receiverApiKey = String(env.RECEIVER_API_KEY || '').trim();
  return enabled('AWG_WRITE_ENABLED')
    && enabled('AWG_GATE_WRITE_ENABLED')
    && receiverApiKey.length > 0
    && receiverApiKey !== 'change-me';
}

const defaultService = createAwgGateService();

function safeErrorResponse(error, requestId) {
  const statusCode = error && error.statusCode ? error.statusCode : 500;
  return {
    statusCode,
    body: {
      status: 'error',
      code: error && error.code ? error.code : 'gate_operation_failed',
      message: statusCode < 500 && error && error.message ? error.message : 'AWG gate operation failed',
      ...(requestId ? { requestId } : {}),
      timestamp: nowIso()
    }
  };
}

async function runRequest(method, req) {
  const requestId = String(req.get('x-request-id') || '').trim();
  try {
    const result = await defaultService[method](req.body || {}, { requestId });
    return {
      statusCode: 200,
      body: {
        status: 'ok',
        ...result,
        ...(requestId ? { requestId } : {}),
        timestamp: nowIso()
      }
    };
  } catch (error) {
    return safeErrorResponse(error, requestId);
  }
}

module.exports = {
  clearAwgGate: (req) => runRequest('clearGate', req),
  createAwgGateService,
  fenceAwgGate: (req) => runRequest('fenceGate', req),
  getAwgGateOperation: (req) => runRequest('getOperation', req),
  isGateWriteEnabled,
  parseRuntimeAllowedIps,
  parseRuntimePeerSummaries,
  readAwgGate: (req) => runRequest('readGate', req),
  setAwgGate: (req) => runRequest('setGate', req),
  validateOperation,
  writeDurableFile
};
