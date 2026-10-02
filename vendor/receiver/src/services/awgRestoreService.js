'use strict';

const crypto = require('crypto');
const path = require('path');
const { runFile } = require('../utils/exec');
const { withDirectoryLock } = require('../utils/lock');
const { createConfigRestoreBackup } = require('./awgBackupService');
const {
  getContainerConfigPath,
  parseAwgConfig,
  readConfig,
  restoreFileFromBackup,
  restoreConfigFromBackup,
  writeConfigToContainer,
  writeTextToContainer
} = require('./awgConfigService');
const { getAwgPeers, getAwgRuntimeConfig, getAwgStatus } = require('./awgService');

const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

function response(statusCode, code, message, requestId) {
  return {
    statusCode,
    body: {
      status: statusCode < 400 ? 'ok' : 'error',
      ...(code ? { code } : {}),
      ...(message ? { message } : {}),
      ...(requestId ? { requestId } : {}),
      timestamp: new Date().toISOString()
    }
  };
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 12);
}

function validateRestoreConfig(value) {
  const configText = typeof value === 'string' ? value : '';
  if (Buffer.byteLength(configText, 'utf8') < 100 || Buffer.byteLength(configText, 'utf8') > MAX_CONFIG_BYTES) {
    throw Object.assign(new Error('AWG config size is invalid'), { code: 'invalid_restore_config', statusCode: 400 });
  }
  if (!/^\s*\[Interface\]/m.test(configText) || !/^\s*PrivateKey\s*=\s*[A-Za-z0-9+/]{43}=\s*$/mi.test(configText)) {
    throw Object.assign(new Error('AWG interface or private key is missing'), { code: 'invalid_restore_config', statusCode: 400 });
  }
  const parsed = parseAwgConfig(configText);
  const ports = [...configText.matchAll(/^\s*ListenPort\s*=\s*(\d+)\s*$/gmi)];
  const listenPort = ports.length === 1 ? Number(ports[0][1]) : NaN;
  if (!parsed.hasInterface || parsed.interfaceAddresses.length !== 1
      || !Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw Object.assign(new Error('AWG config must contain one interface address'), { code: 'invalid_restore_config', statusCode: 400 });
  }
  const keys = new Set();
  const addresses = new Set();
  for (const peer of parsed.peers) {
    if (!KEY_PATTERN.test(peer.publicKey) || keys.has(peer.publicKey)) {
      throw Object.assign(new Error('AWG peer public key is invalid or duplicated'), { code: 'invalid_restore_config', statusCode: 400 });
    }
    keys.add(peer.publicKey);
    for (const allowedIp of peer.allowedIps) {
      if (addresses.has(allowedIp)) {
        throw Object.assign(new Error('AWG peer address is duplicated'), { code: 'invalid_restore_config', statusCode: 400 });
      }
      addresses.add(allowedIp);
    }
  }
  return { configText, parsed: { ...parsed, listenPort } };
}

function validateClientsTable(value, configPeers) {
  if (!Array.isArray(value) || value.length !== configPeers.length || value.length > 10000) {
    throw Object.assign(new Error('Amnezia clients table does not match the AWG config'), { code: 'invalid_clients_table', statusCode: 400 });
  }
  const expected = new Set(configPeers.map((peer) => peer.publicKey));
  const seen = new Set();
  const normalized = value.map((client) => {
    const clientId = String(client?.clientId || '').trim();
    const clientName = String(client?.userData?.clientName || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
    if (!KEY_PATTERN.test(clientId) || !expected.has(clientId) || seen.has(clientId) || !clientName) {
      throw Object.assign(new Error('Amnezia client entry is invalid'), { code: 'invalid_clients_table', statusCode: 400 });
    }
    seen.add(clientId);
    const creationDate = typeof client?.userData?.creationDate === 'string' && client.userData.creationDate.length <= 64
      ? client.userData.creationDate
      : undefined;
    return { clientId, userData: { clientName, ...(creationDate ? { creationDate } : {}) } };
  });
  return normalized;
}

function lockPath() {
  return path.join(process.env.AWG_LOCK_DIR || '/opt/naitlab/nait_awg_node/receiver/locks', 'awg0.write.lock.d');
}

async function syncRuntime(config) {
  await runFile('docker', [
    'exec', config.containerName, 'bash', '-c',
    'awg syncconf "$1" <(awg-quick strip "$2")', 'bash', config.interfaceName, getContainerConfigPath(config)
  ], { timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000) });
}

async function verifyRuntime(expected) {
  const [status, inventory] = await Promise.all([getAwgStatus(), getAwgPeers()]);
  if (status.status !== 'ok' || inventory.status !== 'ok' || inventory.peers.length !== expected.peers.length
      || status.listenPort !== expected.listenPort) {
    throw Object.assign(new Error('AWG runtime verification failed'), { code: 'restore_verify_failed', statusCode: 409 });
  }
  const actual = new Map(inventory.peers.map((peer) => [peer.publicKey, [...(peer.allowedIps || [])].sort()]));
  for (const peer of expected.peers) {
    const allowedIps = actual.get(peer.publicKey);
    if (!allowedIps || JSON.stringify(allowedIps) !== JSON.stringify([...(peer.allowedIps || [])].sort())) {
      throw Object.assign(new Error('Restored AWG peers do not match the backup'), { code: 'restore_verify_failed', statusCode: 409 });
    }
  }
  return status;
}

async function verifyClientsTable(config, expected) {
  const { stdout } = await runFile('docker', ['exec', config.containerName, 'cat', config.clientsTablePath], {
    timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000), maxBuffer: 1024 * 1024
  });
  const actual = JSON.parse(stdout);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw Object.assign(new Error('Amnezia clients table verification failed'), { code: 'restore_verify_failed', statusCode: 409 });
  }
}

async function restoreAwgConfig(req) {
  const requestId = String(req.get('x-request-id') || '').trim();
  if (String(process.env.AWG_WRITE_ENABLED || '').trim().toLowerCase() !== 'true') {
    return response(403, 'write_disabled', 'AWG write operations are disabled', requestId);
  }
  let validated;
  try {
    validated = validateRestoreConfig(req.body?.config);
    validated.clientsTable = validateClientsTable(req.body?.clientsTable, validated.parsed.peers);
  } catch (error) {
    return response(error.statusCode || 400, error.code || 'invalid_restore_config', error.message, requestId);
  }
  const config = getAwgRuntimeConfig();
  return withDirectoryLock(lockPath(), { timeoutMs: Number(process.env.AWG_LOCK_TIMEOUT_MS || 15000) }, async () => {
    const currentStatus = await getAwgStatus();
    if (currentStatus.status !== 'ok' || !currentStatus.container.running) {
      return response(409, 'awg_unavailable', 'AWG runtime is unavailable', requestId);
    }
    const currentConfig = await readConfig(config, requestId);
    const unchanged = currentConfig === validated.configText;
    const backup = await createConfigRestoreBackup(config, getContainerConfigPath(config));
    let written = false;
    let tableWritten = false;
    try {
      await writeConfigToContainer(config, validated.configText, requestId);
      written = true;
      await writeTextToContainer(config, `${JSON.stringify(validated.clientsTable, null, 2)}\n`, config.clientsTablePath, requestId, 'clientsTable');
      tableWritten = true;
      await syncRuntime(config);
      const status = await verifyRuntime(validated.parsed);
      await verifyClientsTable(config, validated.clientsTable);
      return { statusCode: 200, body: { ...response(200, null, null, requestId).body,
        operation: 'restore_config', unchanged, peersCount: status.peersCount,
        backup: { id: backup.backupId } } };
    } catch (error) {
      let rollbackFailed = false;
      if (written) {
        try { await restoreConfigFromBackup(config, backup.configBackupPath, requestId); }
        catch { rollbackFailed = true; }
        try { await syncRuntime(config); }
        catch { rollbackFailed = true; }
      }
      if (tableWritten) {
        if (backup.clientsTableBackupPath) {
          try { await restoreFileFromBackup(config, backup.clientsTableBackupPath, config.clientsTablePath, requestId); }
          catch { rollbackFailed = true; }
        } else {
          try { await runFile('docker', ['exec', config.containerName, 'rm', '-f', config.clientsTablePath]); }
          catch { rollbackFailed = true; }
        }
      }
      if (rollbackFailed) return response(500, 'restore_rollback_failed', 'AWG restore rollback requires manual verification', requestId);
      return response(error.statusCode || 500, error.code || 'restore_failed', error.statusCode ? error.message : 'AWG config restore failed', requestId);
    }
  });
}

module.exports = { restoreAwgConfig, validateClientsTable, validateRestoreConfig };
