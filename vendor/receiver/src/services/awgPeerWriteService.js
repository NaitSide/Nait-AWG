'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { runFile } = require('../utils/exec');
const { withDirectoryLock } = require('../utils/lock');
const { deleteExistingPeer } = require('./existingPeerDeleteService');
const { createPeerCreateBackup, createPeerDeleteBackup } = require('./awgBackupService');
const {
  appendPeerBlock,
  ensurePeerCanBeAdded,
  getContainerConfigPath,
  getReceiverTmpDir,
  parseAwgConfig,
  parseAwgPeerBlocks,
  readConfig,
  removePeerBlock,
  restoreConfigFromBackup,
  writeConfigToContainer
} = require('./awgConfigService');
const {
  getAwgRuntimeConfig,
  getAwgStatus,
  getAwgPeers
} = require('./awgService');

function nowIso() {
  return new Date().toISOString();
}

function createFingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex')
    .slice(0, 12);
}

function createError(statusCode, code, message, requestId) {
  return {
    statusCode,
    body: {
      status: 'error',
      code,
      message,
      ...(requestId ? { requestId } : {}),
      timestamp: nowIso()
    }
  };
}

function getLockPath() {
  return path.join(process.env.AWG_LOCK_DIR || '/opt/naitlab/nait_awg_node/receiver/locks', 'awg0.write.lock.d');
}

function getIdempotencyDir() {
  return process.env.AWG_IDEMPOTENCY_DIR || '/opt/naitlab/nait_awg_node/receiver/state/idempotency';
}

function createPayloadFingerprint(payload, options = {}) {
  const safePayload = {
    clientId: payload.clientId,
    clientLabel: payload.clientLabel,
    publicKey: payload.publicKey,
    allowedIp: payload.allowedIp,
    persistentKeepalive: payload.persistentKeepalive
  };
  if (options.includeInitialGateState !== false) {
    safePayload.initialGateState = payload.initialGateState;
  }

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(safePayload), 'utf8')
    .digest('hex');
}

function createDeletePayloadFingerprint(payload) {
  const safePayload = {
    clientId: payload.clientId,
    publicKeyFingerprint: payload.publicKeyFingerprint,
    allowedIp: payload.allowedIp,
    ...(payload.publicKey ? { publicKey: payload.publicKey } : {})
  };

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(safePayload), 'utf8')
    .digest('hex');
}

function idempotencyRecordPath(idempotencyKey) {
  return path.join(getIdempotencyDir(), `${idempotencyKey}.json`);
}

async function readIdempotencyRecord(idempotencyKey) {
  try {
    const content = await fs.readFile(idempotencyRecordPath(idempotencyKey), 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeIdempotencyRecord(idempotencyKey, record) {
  await fs.mkdir(getIdempotencyDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(idempotencyRecordPath(idempotencyKey), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function createPeerFromRecord(record, requestId) {
  return {
    statusCode: 200,
    body: {
      status: 'ok',
      operation: 'create_peer',
      idempotent: true,
      ...(requestId ? { requestId } : {}),
      clientId: record.clientId,
      clientLabel: record.clientLabel,
      publicKeyFingerprint: record.publicKeyFingerprint,
      allowedIp: record.allowedIp,
      initialGateState: record.initialGateState || 'open',
      gateState: record.initialGateState === 'closed' ? 'CLOSED' : 'OPEN',
      persistentKeepalive: record.persistentKeepalive,
      runtime: { verified: true },
      persistentConfig: { verified: true },
      timestamp: nowIso()
    }
  };
}

function deletePeerFromRecord(record, requestId) {
  return {
    statusCode: 200,
    body: {
      status: 'ok',
      operation: 'delete_peer',
      idempotent: true,
      ...(requestId ? { requestId } : {}),
      clientId: record.clientId,
      publicKeyFingerprint: record.publicKeyFingerprint,
      allowedIp: record.allowedIp,
      peersCountBefore: record.peersCountBefore,
      peersCountAfter: record.peersCountAfter,
      runtime: { verified: true },
      persistentConfig: { verified: true },
      timestamp: nowIso()
    }
  };
}

async function assertRuntimeReady(requestId) {
  const status = await getAwgStatus();
  if (status.status !== 'ok' || !status.container.running) {
    throw Object.assign(new Error('AWG runtime is unavailable'), {
      code: 'awg_unavailable',
      statusCode: 409,
      requestId
    });
  }
  if (!Number.isFinite(status.listenPort)) {
    throw Object.assign(new Error('AWG listen port is unavailable'), {
      code: 'listen_port_unavailable',
      statusCode: 409,
      requestId
    });
  }
  return status;
}

async function writePskToContainer(config, requestId, presharedKey) {
  const safeId = String(requestId || `${process.pid}-${Date.now()}`).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const tmpDir = getReceiverTmpDir();
  await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });
  await fs.chmod(tmpDir, 0o700);
  const hostTemp = path.join(tmpDir, `nait-awg-psk.${safeId}`);
  const containerTemp = `/tmp/nait-awg-psk.${safeId}`;

  await fs.writeFile(hostTemp, presharedKey, { mode: 0o600 });
  await runFile('docker', ['cp', hostTemp, `${config.containerName}:${containerTemp}`], {
    timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000)
  });
  await runFile('docker', ['exec', config.containerName, 'chmod', '600', containerTemp], {
    timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000)
  });

  return {
    hostTemp,
    containerTemp
  };
}

async function cleanupPskTemp(config, temp) {
  if (!temp) return;
  await Promise.allSettled([
    temp.hostTemp ? fs.rm(temp.hostTemp, { force: true }) : Promise.resolve(),
    temp.containerTemp ? runFile('docker', ['exec', config.containerName, 'rm', '-f', temp.containerTemp]) : Promise.resolve()
  ]);
}

async function applyPeerRuntime(config, peer, requestId) {
  const temp = await writePskToContainer(config, requestId, peer.presharedKey);
  try {
    const args = [
      'exec',
      config.containerName,
      'awg',
      'set',
      config.interfaceName,
      'peer',
      peer.publicKey,
      'preshared-key',
      temp.containerTemp
    ];

    if (peer.initialGateState !== 'closed') {
      args.push('allowed-ips', peer.allowedIp);
    }

    if (peer.persistentKeepalive > 0) {
      args.push('persistent-keepalive', String(peer.persistentKeepalive));
    }

    await runFile('docker', args, {
      timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000)
    });
  } finally {
    await cleanupPskTemp(config, temp);
  }
}

async function removeRuntimePeer(config, publicKey) {
  await runFile('docker', [
    'exec',
    config.containerName,
    'awg',
    'set',
    config.interfaceName,
    'peer',
    publicKey,
    'remove'
  ], {
    timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000)
  });
}

function findDeleteTargetPeer(configText, target) {
  const blocks = parseAwgPeerBlocks(configText);
  const fingerprintMatches = blocks.filter((peer) => createFingerprint(peer.publicKey) === target.publicKeyFingerprint);

  if (!fingerprintMatches.length) {
    const error = new Error('Target peer was not found in config');
    error.code = 'peer_not_found';
    error.statusCode = 404;
    throw error;
  }

  if (fingerprintMatches.length > 1) {
    const error = new Error('Public key fingerprint matched multiple peers');
    error.code = 'peer_fingerprint_ambiguous';
    error.statusCode = 409;
    throw error;
  }

  const peer = fingerprintMatches[0];

  if ((peer.allowedIps || []).length > 0 && !(peer.allowedIps || []).includes(target.allowedIp)) {
    const error = new Error('Target peer allowedIp mismatch');
    error.code = 'peer_allowed_ip_mismatch';
    error.statusCode = 409;
    throw error;
  }

  if (((peer.allowedIps || []).length === 0 || peer.clientId) && peer.clientId !== target.clientId) {
    const error = new Error('Target peer clientId mismatch');
    error.code = 'peer_client_id_mismatch';
    error.statusCode = 409;
    throw error;
  }

  return peer;
}

async function verifyPeerDeleted(config, target, previousStatus) {
  const [status, peers] = await Promise.all([
    getAwgStatus(),
    getAwgPeers()
  ]);

  const runtimePeer = peers.peers.find((item) => createFingerprint(item.publicKey) === target.publicKeyFingerprint);
  const runtimeAllowedIp = peers.peers.some((item) => (item.allowedIps || []).includes(target.allowedIp));

  if (status.status !== 'ok' || status.listenPort !== previousStatus.listenPort || runtimePeer || runtimeAllowedIp) {
    const error = new Error('Peer delete verification failed');
    error.code = 'peer_delete_verify_failed';
    error.statusCode = 409;
    throw error;
  }

  if (status.peersCount !== previousStatus.peersCount - 1) {
    const error = new Error('Unexpected peers count after delete');
    error.code = 'unexpected_peers_count';
    error.statusCode = 409;
    throw error;
  }

  const configText = await readConfig(config);
  const matchingConfigPeers = parseAwgPeerBlocks(configText).filter((peer) => (
    createFingerprint(peer.publicKey) === target.publicKeyFingerprint ||
    (peer.allowedIps || []).includes(target.allowedIp)
  ));

  if (matchingConfigPeers.length) {
    const error = new Error('Target peer still exists in config');
    error.code = 'peer_still_in_config';
    error.statusCode = 409;
    throw error;
  }

  return { status };
}

function peerBlockToRuntimePeer(peer) {
  return {
    publicKey: peer.publicKey,
    presharedKey: peer.presharedKey,
    allowedIp: peer.allowedIps[0] || null,
    initialGateState: peer.allowedIps.length ? 'open' : 'closed',
    persistentKeepalive: peer.persistentKeepalive || 0
  };
}

async function verifyPeerCreated(config, peer, previousPeersCount) {
  const [status, peers] = await Promise.all([
    getAwgStatus(),
    getAwgPeers()
  ]);

  const runtimePeer = peers.peers.find((item) => item.publicKey === peer.publicKey);
  const expectedClosed = peer.initialGateState === 'closed';
  const runtimeAllowedIps = runtimePeer?.allowedIps || [];
  const runtimeMatches = expectedClosed
    ? runtimeAllowedIps.length === 0
    : runtimeAllowedIps.includes(peer.allowedIp);

  if (status.status !== 'ok' || status.listenPort !== previousPeersCount.listenPort || !runtimePeer || !runtimeMatches) {
    const error = new Error('Peer verification failed');
    error.code = 'peer_verify_failed';
    error.statusCode = 409;
    throw error;
  }

  if (status.peersCount !== previousPeersCount.peersCount + 1) {
    const error = new Error('Unexpected peers count after create');
    error.code = 'unexpected_peers_count';
    error.statusCode = 409;
    throw error;
  }

  const configText = await readConfig(config);
  const parsed = parseAwgConfig(configText);
  const persistedPeer = parsed.peers.find((item) => item.publicKey === peer.publicKey);
  const persistedAllowedIps = persistedPeer?.allowedIps || [];
  if (!persistedPeer || (expectedClosed ? persistedAllowedIps.length !== 0 : !persistedAllowedIps.includes(peer.allowedIp))) {
    const error = new Error('Persistent peer verification failed');
    error.code = 'peer_persistent_verify_failed';
    error.statusCode = 409;
    throw error;
  }
  ensurePeerCanBeAdded({
    hasInterface: parsed.hasInterface,
    peers: parsed.peers.filter((item) => item.publicKey !== peer.publicKey),
    interfaceAddresses: parsed.interfaceAddresses
  }, peer);

  return {
    status,
    runtimePeer
  };
}

async function createPeer(payload, context) {
  const requestId = context.requestId;
  const config = getAwgRuntimeConfig();
  const containerConfigPath = getContainerConfigPath(config);
  const peer = {
    idempotencyKey: payload.idempotencyKey,
    clientId: payload.clientId,
    clientLabel: payload.clientLabel,
    publicKey: context.raw.publicKey,
    presharedKey: context.raw.presharedKey,
    allowedIp: payload.allowedIp,
    initialGateState: payload.initialGateState || 'open',
    persistentKeepalive: payload.persistentKeepalive
  };
  const payloadFingerprint = createPayloadFingerprint(peer);
  const lockTimeoutMs = Number(process.env.AWG_LOCK_TIMEOUT_MS || 15000);

  return withDirectoryLock(getLockPath(), { timeoutMs: lockTimeoutMs }, async () => {
    const existing = await readIdempotencyRecord(peer.idempotencyKey);
    if (existing) {
      const legacyOpenFingerprint = peer.initialGateState === 'open'
        ? createPayloadFingerprint(peer, { includeInitialGateState: false })
        : null;
      const legacyOpenMatch = !existing.initialGateState
        && legacyOpenFingerprint === existing.payloadFingerprint;
      if (existing.payloadFingerprint !== payloadFingerprint && !legacyOpenMatch) {
        return createError(409, 'idempotency_conflict', 'Idempotency-Key was already used with different payload', requestId);
      }
      return createPeerFromRecord(existing, requestId);
    }

    const previousStatus = await assertRuntimeReady(requestId);
    const originalConfig = await readConfig(config, requestId);
    const parsedConfig = parseAwgConfig(originalConfig);
    ensurePeerCanBeAdded(parsedConfig, peer);

    const backup = await createPeerCreateBackup(config, containerConfigPath);
    const nextConfig = appendPeerBlock(originalConfig, peer);
    const nextParsed = parseAwgConfig(nextConfig);
    if (!nextParsed.peers.some((item) => item.publicKey === peer.publicKey && (peer.initialGateState === 'closed'
      ? item.allowedIps.length === 0 : item.allowedIps.includes(peer.allowedIp)))) {
      return createError(409, 'config_validation_failed', 'Generated AWG config did not include expected peer', requestId);
    }

    let configWritten = false;
    let runtimeApplied = false;

    try {
      await writeConfigToContainer(config, nextConfig, requestId);
      configWritten = true;
      await applyPeerRuntime(config, peer, requestId);
      runtimeApplied = true;

      await verifyPeerCreated(config, peer, {
        listenPort: previousStatus.listenPort,
        peersCount: previousStatus.peersCount
      });

      const record = {
        status: 'created',
        payloadFingerprint,
        clientId: peer.clientId,
        clientLabel: peer.clientLabel,
        publicKeyFingerprint: createFingerprint(peer.publicKey),
        allowedIp: peer.allowedIp,
        initialGateState: peer.initialGateState,
        persistentKeepalive: peer.persistentKeepalive,
        backupId: backup.backupId,
        createdAt: nowIso()
      };

      await writeIdempotencyRecord(peer.idempotencyKey, record);

      return {
        statusCode: 200,
        body: {
          status: 'ok',
          operation: 'create_peer',
          idempotent: false,
          ...(requestId ? { requestId } : {}),
          clientId: peer.clientId,
          clientLabel: peer.clientLabel,
          publicKeyFingerprint: record.publicKeyFingerprint,
          allowedIp: peer.allowedIp,
          initialGateState: peer.initialGateState,
          gateState: peer.initialGateState === 'closed' ? 'CLOSED' : 'OPEN',
          persistentKeepalive: peer.persistentKeepalive,
          peersCountBefore: previousStatus.peersCount,
          peersCountAfter: previousStatus.peersCount + 1,
          backup: { id: backup.backupId },
          runtime: { verified: true },
          persistentConfig: { verified: true },
          timestamp: nowIso()
        }
      };
    } catch (error) {
      if (configWritten) {
        await restoreConfigFromBackup(config, backup.configBackupPath, requestId).catch(() => {});
      }
      if (runtimeApplied) {
        await removeRuntimePeer(config, peer.publicKey).catch(() => {});
      }
      throw error;
    }
  });
}

async function deletePeer(payload, context) {
  const requestId = context.requestId;
  const config = getAwgRuntimeConfig();
  const containerConfigPath = getContainerConfigPath(config);
  const target = {
    idempotencyKey: payload.idempotencyKey,
    clientId: payload.clientId,
    publicKeyFingerprint: payload.publicKeyFingerprint,
    allowedIp: payload.allowedIp,
    ...(payload.publicKey ? { publicKey: payload.publicKey } : {})
  };
  const payloadFingerprint = createDeletePayloadFingerprint(target);
  const lockTimeoutMs = Number(process.env.AWG_LOCK_TIMEOUT_MS || 15000);

  return withDirectoryLock(getLockPath(), { timeoutMs: lockTimeoutMs }, async () => {
    const existing = await readIdempotencyRecord(target.idempotencyKey);
    if (existing) {
      if (existing.payloadFingerprint !== payloadFingerprint) {
        return createError(409, 'idempotency_conflict', 'Idempotency-Key was already used with different payload', requestId);
      }
      return deletePeerFromRecord(existing, requestId);
    }

    if (payload.publicKey) return deleteExistingPeer(payload, { ...context,
      commit: details => writeIdempotencyRecord(target.idempotencyKey, {
        status: 'deleted', payloadFingerprint, clientId: target.clientId,
        publicKeyFingerprint: target.publicKeyFingerprint, allowedIp: target.allowedIp,
        ...details, createdAt: nowIso()
      }) });

    const previousStatus = await assertRuntimeReady(requestId);
    if (previousStatus.peersCount <= 0) {
      return createError(404, 'peer_not_found', 'Target peer was not found', requestId);
    }

    const originalConfig = await readConfig(config, requestId);
    const targetPeer = findDeleteTargetPeer(originalConfig, target);
    const runtimePeers = await getAwgPeers();
    if (runtimePeers.status !== 'ok') {
      return createError(409, 'peers_unavailable', 'AWG peer list is unavailable', requestId);
    }
    const runtimePeer = runtimePeers.peers.find((item) => createFingerprint(item.publicKey) === target.publicKeyFingerprint);
    if (!runtimePeer || ((runtimePeer.allowedIps || []).length > 0
      && !(runtimePeer.allowedIps || []).includes(target.allowedIp))) {
      return createError(409, 'peer_not_in_runtime', 'Target peer was not found in runtime', requestId);
    }

    const backup = await createPeerDeleteBackup(config, containerConfigPath);
    const nextConfig = removePeerBlock(originalConfig, targetPeer);
    const nextMatches = parseAwgPeerBlocks(nextConfig).filter((peer) => (
      createFingerprint(peer.publicKey) === target.publicKeyFingerprint ||
      (peer.allowedIps || []).includes(target.allowedIp)
    ));
    if (nextMatches.length) {
      return createError(409, 'config_validation_failed', 'Generated AWG config still contains target peer', requestId);
    }

    let configWritten = false;
    let runtimeRemoved = false;

    try {
      await writeConfigToContainer(config, nextConfig, requestId);
      configWritten = true;
      await removeRuntimePeer(config, targetPeer.publicKey);
      runtimeRemoved = true;

      await verifyPeerDeleted(config, target, previousStatus);

      const record = {
        status: 'deleted',
        payloadFingerprint,
        clientId: target.clientId,
        publicKeyFingerprint: target.publicKeyFingerprint,
        allowedIp: target.allowedIp,
        peersCountBefore: previousStatus.peersCount,
        peersCountAfter: previousStatus.peersCount - 1,
        backupId: backup.backupId,
        createdAt: nowIso()
      };

      await writeIdempotencyRecord(target.idempotencyKey, record);

      return {
        statusCode: 200,
        body: {
          status: 'ok',
          operation: 'delete_peer',
          idempotent: false,
          ...(requestId ? { requestId } : {}),
          clientId: target.clientId,
          publicKeyFingerprint: target.publicKeyFingerprint,
          allowedIp: target.allowedIp,
          peersCountBefore: previousStatus.peersCount,
          peersCountAfter: previousStatus.peersCount - 1,
          backup: { id: backup.backupId },
          runtime: { verified: true },
          persistentConfig: { verified: true },
          timestamp: nowIso()
        }
      };
    } catch (error) {
      if (configWritten) {
        await restoreConfigFromBackup(config, backup.configBackupPath, requestId).catch(() => {});
      }
      if (runtimeRemoved) {
        const restorePeer = peerBlockToRuntimePeer(targetPeer);
        if (restorePeer.publicKey && restorePeer.presharedKey) {
          await applyPeerRuntime(config, restorePeer, requestId).catch(() => {});
        }
      }
      throw error;
    }
  });
}

module.exports = {
  createPeer,
  deletePeer
};
