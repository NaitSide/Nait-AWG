'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { runFile } = require('../utils/exec');

function getContainerConfigPath(config) {
  return process.env.AWG_CONTAINER_CONFIG_PATH || config.configPath || '/opt/amnezia/awg/awg0.conf';
}

function getReceiverTmpDir() {
  return process.env.AWG_RECEIVER_TMP_DIR || '/opt/naitlab/nait_awg_node/receiver/tmp';
}

function getReceiverGroupId() {
  const configured = String(process.env.AWG_CONFIG_GROUP_ID || '').trim();
  if (configured) {
    const groupId = Number(configured);
    if (Number.isInteger(groupId) && groupId >= 0) return groupId;
    throw new Error('AWG_CONFIG_GROUP_ID must be a non-negative integer');
  }

  if (typeof process.getgid === 'function') return process.getgid();
  throw new Error('Receiver group id is unavailable');
}

function buildConfigInstallArgs(containerName, sourcePath, targetPath, groupId) {
  if (!Number.isInteger(groupId) || groupId < 0) {
    throw new Error('Receiver group id must be a non-negative integer');
  }

  return [
    'exec',
    containerName,
    'sh',
    '-c',
    'chmod 640 "$1" && chown "0:$3" "$1" && sync && mv "$1" "$2" && sync',
    'sh',
    sourcePath,
    targetPath,
    String(groupId)
  ];
}

function getSafeRequestId(requestId) {
  return String(requestId || `${process.pid}-${Date.now()}`).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function ensureReceiverTmpDir() {
  const tmpDir = getReceiverTmpDir();
  await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });
  await fs.chmod(tmpDir, 0o700);
  return tmpDir;
}

function normalizeLine(value) {
  return String(value || '').trim();
}

function isSection(line, name) {
  return new RegExp(`^\\[${name}\\]$`, 'i').test(normalizeLine(line));
}

function parseKeyValue(line) {
  const match = String(line || '').match(/^\s*([^=#;]+?)\s*=\s*(.*?)\s*$/);
  if (!match) return null;
  return {
    key: match[1].trim(),
    value: match[2].trim()
  };
}

function parseAwgConfig(configText) {
  const lines = String(configText || '').split(/\r?\n/);
  const peers = [];
  const interfaceAddresses = [];
  let currentSection = null;
  let currentPeer = null;
  let hasInterface = false;

  for (const line of lines) {
    const trimmed = normalizeLine(line);

    if (/^\[.*\]$/.test(trimmed)) {
      if (currentPeer) peers.push(currentPeer);
      currentPeer = null;
      currentSection = trimmed.replace(/^\[/, '').replace(/\]$/, '');
      if (/^Interface$/i.test(currentSection)) hasInterface = true;
      if (/^Peer$/i.test(currentSection)) currentPeer = { publicKey: '', allowedIps: [] };
      continue;
    }

    const pair = parseKeyValue(line);
    if (!pair) continue;

    if (/^Interface$/i.test(currentSection) && /^Address$/i.test(pair.key)) {
      interfaceAddresses.push(...pair.value.split(',').map((item) => item.trim()).filter(Boolean));
    }

    if (/^Peer$/i.test(currentSection) && currentPeer) {
      if (/^PublicKey$/i.test(pair.key)) currentPeer.publicKey = pair.value;
      if (/^AllowedIPs$/i.test(pair.key)) {
        currentPeer.allowedIps = pair.value.split(',').map((item) => item.trim()).filter(Boolean);
      }
    }
  }

  if (currentPeer) peers.push(currentPeer);

  return {
    hasInterface,
    peers: peers.filter((peer) => peer.publicKey || peer.allowedIps.length),
    interfaceAddresses
  };
}

function parseClientIdFromComments(lines) {
  for (const line of lines) {
    const match = String(line || '').match(/clientId=([a-zA-Z0-9_.:-]{1,120})/);
    if (match) return match[1];
  }
  return null;
}

function parseAwgPeerBlocks(configText) {
  const lines = String(configText || '').split(/\r?\n/);
  const blocks = [];
  let current = null;

  function finishCurrent(endIndex) {
    if (!current) return;
    current.endIndex = endIndex;
    current.clientId = parseClientIdFromComments(current.lines);
    blocks.push(current);
    current = null;
  }

  lines.forEach((line, index) => {
    const trimmed = normalizeLine(line);

    if (/^\[.*\]$/.test(trimmed)) {
      finishCurrent(index);
      if (isSection(trimmed, 'Peer')) {
        current = {
          startIndex: index,
          endIndex: index + 1,
          lines: [line],
          publicKey: '',
          presharedKey: '',
          allowedIps: [],
          persistentKeepalive: null,
          clientId: null
        };
      }
      return;
    }

    if (!current) return;
    current.lines.push(line);

    const pair = parseKeyValue(line);
    if (!pair) return;

    if (/^PublicKey$/i.test(pair.key)) current.publicKey = pair.value;
    if (/^PresharedKey$/i.test(pair.key)) current.presharedKey = pair.value;
    if (/^AllowedIPs$/i.test(pair.key)) {
      current.allowedIps = pair.value.split(',').map((item) => item.trim()).filter(Boolean);
    }
    if (/^PersistentKeepalive$/i.test(pair.key)) {
      const keepalive = Number(pair.value);
      current.persistentKeepalive = Number.isInteger(keepalive) ? keepalive : null;
    }
  });

  finishCurrent(lines.length);
  return blocks.filter((peer) => peer.publicKey || peer.allowedIps.length);
}

function removePeerBlock(configText, targetPeer) {
  const lines = String(configText || '').split(/\r?\n/);
  const nextLines = [];
  let index = 0;

  while (index < lines.length) {
    if (index === targetPeer.startIndex) {
      index = targetPeer.endIndex;
      while (nextLines.length && normalizeLine(nextLines[nextLines.length - 1]) === '') {
        nextLines.pop();
      }
      continue;
    }
    nextLines.push(lines[index]);
    index += 1;
  }

  return `${nextLines.join('\n').replace(/\s*$/, '\n')}`;
}

function replacePeerAllowedIps(configText, publicKey, desiredAllowedIps) {
  const text = String(configText || '');
  const blocks = parseAwgPeerBlocks(text);
  const matches = blocks.filter((peer) => peer.publicKey === publicKey);

  if (!matches.length) {
    const error = new Error('Target peer was not found in config');
    error.code = 'peer_not_found';
    error.statusCode = 404;
    throw error;
  }
  if (matches.length > 1) {
    const error = new Error('Target public key matched multiple config peers');
    error.code = 'peer_public_key_ambiguous';
    error.statusCode = 409;
    throw error;
  }

  const desired = Array.from(new Set((desiredAllowedIps || []).map((item) => String(item).trim()).filter(Boolean)));
  const target = matches[0];
  const conflictingPeer = blocks.find((peer) => peer.publicKey !== publicKey
    && (peer.allowedIps || []).some((allowedIp) => desired.includes(allowedIp)));
  if (conflictingPeer) {
    const error = new Error('Desired AllowedIPs are already assigned to another config peer');
    error.code = 'duplicate_allowed_ip';
    error.statusCode = 409;
    throw error;
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const blockLines = lines.slice(target.startIndex, target.endIndex);
  const allowedIndexes = [];

  blockLines.forEach((line, index) => {
    const pair = parseKeyValue(line);
    if (pair && /^AllowedIPs$/i.test(pair.key)) allowedIndexes.push(index);
  });

  if (allowedIndexes.length > 1) {
    const error = new Error('Target peer has multiple AllowedIPs lines');
    error.code = 'duplicate_allowed_ips_lines';
    error.statusCode = 409;
    throw error;
  }

  if (allowedIndexes.length === 1) {
    const index = allowedIndexes[0];
    if (desired.length) blockLines[index] = `AllowedIPs = ${desired.join(', ')}`;
    else blockLines.splice(index, 1);
  } else if (desired.length) {
    let insertAfter = blockLines.findIndex((line) => {
      const pair = parseKeyValue(line);
      return pair && /^PresharedKey$/i.test(pair.key);
    });
    if (insertAfter < 0) {
      insertAfter = blockLines.findIndex((line) => {
        const pair = parseKeyValue(line);
        return pair && /^PublicKey$/i.test(pair.key);
      });
    }
    if (insertAfter < 0) {
      const error = new Error('Target peer has no PublicKey line');
      error.code = 'invalid_peer_block';
      error.statusCode = 409;
      throw error;
    }
    blockLines.splice(insertAfter + 1, 0, `AllowedIPs = ${desired.join(', ')}`);
  }

  lines.splice(target.startIndex, target.endIndex - target.startIndex, ...blockLines);
  return lines.join(newline);
}

function ensurePeerGateManaged(configText, publicKey, publicKeyHash) {
  const text = String(configText || '');
  const blocks = parseAwgPeerBlocks(text);
  const matches = blocks.filter((peer) => peer.publicKey === publicKey);
  if (matches.length !== 1) {
    const error = new Error(matches.length ? 'Target public key matched multiple config peers' : 'Target peer was not found in config');
    error.code = matches.length ? 'peer_public_key_ambiguous' : 'peer_not_found';
    error.statusCode = matches.length ? 409 : 404;
    throw error;
  }
  if (!/^[a-f0-9]{64}$/.test(String(publicKeyHash || ''))) {
    const error = new Error('Gate public key hash is invalid');
    error.code = 'invalid_gate_public_key_hash';
    error.statusCode = 409;
    throw error;
  }

  const target = matches[0];
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const blockLines = lines.slice(target.startIndex, target.endIndex);
  const markerIndexes = [];
  let existingHash = null;
  blockLines.forEach((line, index) => {
    const marker = String(line || '').match(/^\s*#\s*NaitGateManaged\s*=\s*([a-f0-9]{64})\s*$/i);
    if (marker) {
      markerIndexes.push(index);
      existingHash = marker[1].toLowerCase();
    }
  });
  if (markerIndexes.length > 1 || (existingHash && existingHash !== publicKeyHash)) {
    const error = new Error('Target peer has conflicting gate management markers');
    error.code = 'gate_management_marker_conflict';
    error.statusCode = 409;
    throw error;
  }
  if (!markerIndexes.length) {
    blockLines.splice(1, 0, `# NaitGateManaged = ${publicKeyHash}`);
    lines.splice(target.startIndex, target.endIndex - target.startIndex, ...blockLines);
  }
  return lines.join(newline);
}

function ipAddressOnly(value) {
  return String(value || '').split('/')[0].trim();
}

async function copyConfigFromContainer(config, requestId, suffix = 'read') {
  const tmpDir = await ensureReceiverTmpDir();
  const safeId = getSafeRequestId(requestId);
  const containerConfigPath = getContainerConfigPath(config);
  const localPath = path.join(tmpDir, `awg0.conf.${suffix}.${safeId}.${Date.now()}`);

  await runFile('docker', [
    'cp',
    `${config.containerName}:${containerConfigPath}`,
    localPath
  ], {
    timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000)
  });
  await fs.chmod(localPath, 0o600);

  return {
    localPath,
    containerConfigPath
  };
}

async function readConfigFromContainer(config, requestId) {
  const copied = await copyConfigFromContainer(config, requestId, 'read');
  try {
    return await fs.readFile(copied.localPath, 'utf8');
  } finally {
    await fs.rm(copied.localPath, { force: true });
  }
}

async function readConfig(configOrPath, requestId) {
  if (typeof configOrPath === 'string') {
    return fs.readFile(configOrPath, 'utf8');
  }
  return readConfigFromContainer(configOrPath, requestId);
}

function ensurePeerCanBeAdded(parsedConfig, peer) {
  if (!parsedConfig.hasInterface) {
    const error = new Error('AWG config has no Interface section');
    error.code = 'config_missing_interface';
    error.statusCode = 409;
    throw error;
  }

  if (parsedConfig.peers.some((item) => item.publicKey === peer.publicKey)) {
    const error = new Error('Public key is already used');
    error.code = 'duplicate_public_key';
    error.statusCode = 409;
    throw error;
  }

  if (parsedConfig.peers.some((item) => (item.allowedIps || []).includes(peer.allowedIp))) {
    const error = new Error('Allowed IP is already used');
    error.code = 'duplicate_allowed_ip';
    error.statusCode = 409;
    throw error;
  }

  const peerAddress = ipAddressOnly(peer.allowedIp);
  if (parsedConfig.interfaceAddresses.some((item) => ipAddressOnly(item) === peerAddress)) {
    const error = new Error('Allowed IP is reserved by interface address');
    error.code = 'reserved_interface_ip';
    error.statusCode = 400;
    throw error;
  }
}

function buildPeerBlock(peer) {
  const comment = `# NaitVPN clientId=${peer.clientId} clientLabel=${peer.clientLabel} idempotencyKey=${peer.idempotencyKey}`;
  const closed = peer.initialGateState === 'closed';
  const publicKeyHash = crypto.createHash('sha256').update(peer.publicKey, 'utf8').digest('hex');
  const keepalive = Number(peer.persistentKeepalive);
  const lines = [
    '',
    '[Peer]',
    ...(closed ? [`# NaitGateManaged = ${publicKeyHash}`] : []),
    comment,
    `PublicKey = ${peer.publicKey}`,
    `PresharedKey = ${peer.presharedKey}`,
    ...(!closed ? [`AllowedIPs = ${peer.allowedIp}`] : [])
  ];

  if (Number.isInteger(keepalive) && keepalive > 0) {
    lines.push(`PersistentKeepalive = ${keepalive}`);
  }

  return `${lines.join('\n')}\n`;
}

function appendPeerBlock(configText, peer) {
  const base = String(configText || '').replace(/\s*$/, '\n');
  return `${base}${buildPeerBlock(peer)}`;
}

async function writeConfigToContainer(config, configText, requestId) {
  const tmpDir = await ensureReceiverTmpDir();
  const safeId = getSafeRequestId(requestId);
  const containerConfigPath = getContainerConfigPath(config);
  const containerTempPath = `${containerConfigPath}.tmp.${safeId}`;
  const localTempPath = path.join(tmpDir, `awg0.conf.write.${safeId}.${Date.now()}`);
  const receiverGroupId = getReceiverGroupId();

  await fs.writeFile(localTempPath, configText, { mode: 0o600 });
  await fs.chmod(localTempPath, 0o600);

  try {
    await runFile('docker', [
      'cp',
      localTempPath,
      `${config.containerName}:${containerTempPath}`
    ], {
      timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000)
    });

    await runFile('docker', buildConfigInstallArgs(
      config.containerName,
      containerTempPath,
      containerConfigPath,
      receiverGroupId
    ), {
      timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000)
    });
  } finally {
    await fs.rm(localTempPath, { force: true });
  }
}

async function restoreConfigFromBackup(config, backupPath, requestId) {
  const safeId = getSafeRequestId(requestId);
  const containerConfigPath = getContainerConfigPath(config);
  const containerTempPath = `${containerConfigPath}.rollback.${safeId}`;
  const receiverGroupId = getReceiverGroupId();

  await runFile('docker', [
    'cp',
    backupPath,
    `${config.containerName}:${containerTempPath}`
  ], {
    timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000)
  });

  await runFile('docker', buildConfigInstallArgs(
    config.containerName,
    containerTempPath,
    containerConfigPath,
    receiverGroupId
  ), {
    timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000)
  });
}

module.exports = {
  appendPeerBlock,
  buildConfigInstallArgs,
  copyConfigFromContainer,
  ensurePeerCanBeAdded,
  ensurePeerGateManaged,
  getContainerConfigPath,
  getReceiverGroupId,
  getReceiverTmpDir,
  parseAwgConfig,
  parseAwgPeerBlocks,
  readConfig,
  readConfigFromContainer,
  replacePeerAllowedIps,
  removePeerBlock,
  restoreConfigFromBackup,
  writeConfigToContainer
};
