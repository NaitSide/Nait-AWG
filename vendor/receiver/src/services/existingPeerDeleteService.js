'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const { runFile } = require('../utils/exec');
const { createPeerDeleteBackup } = require('./awgBackupService');
const { getAwgRuntimeConfig, getAwgStatus, getAwgPeers } = require('./awgService');
const { getContainerConfigPath, parseAwgPeerBlocks, readConfig, removePeerBlock,
  writeConfigToContainer, writeTextToContainer, restoreConfigFromBackup, restoreFileFromBackup } = require('./awgConfigService');

function fail(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}
function digest(key) { return crypto.createHash('sha256').update(key).digest('hex'); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function inventory(peers) {
  return peers.map(peer => [peer.publicKey, [...(peer.allowedIps || [])].sort()]).sort((a, b) => a[0].localeCompare(b[0]));
}

function prepareDeletion(configText, tableText, target, runtimePeers) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(target.publicKey || '')
      || digest(target.publicKey).slice(0, 12) !== target.publicKeyFingerprint
      || target.clientId !== `awg-existing-${target.publicKeyFingerprint}`) {
    throw fail('peer_identity_unverified', 'Existing client identity does not match its full public key');
  }
  const peers = parseAwgPeerBlocks(configText);
  const matches = peers.filter(peer => digest(peer.publicKey).slice(0, 12) === target.publicKeyFingerprint);
  const runtimeMatches = runtimePeers.filter(peer => digest(peer.publicKey).slice(0, 12) === target.publicKeyFingerprint);
  if (matches.length !== 1 || runtimeMatches.length !== 1
      || matches[0].publicKey !== target.publicKey || runtimeMatches[0].publicKey !== target.publicKey) {
    throw fail('peer_identity_unverified', 'Target client must match exactly one persistent and runtime peer');
  }
  const peer = matches[0];
  const ips = peer.allowedIps || [];
  if (!same([...ips].sort(), [...(runtimeMatches[0].allowedIps || [])].sort())
      || (ips.length && (ips.length !== 1 || ips[0] !== target.allowedIp))
      || peers.some(other => other.publicKey !== peer.publicKey && other.allowedIps.includes(target.allowedIp))) {
    throw fail('peer_allowed_ip_mismatch', 'Client address or runtime state is inconsistent');
  }
  // A closed peer has no AllowedIPs. The gate marker binds it to the exact key;
  // the panel supplies the previously reserved original address.
  if (!ips.length && !peer.lines.some(line => line.trim() === `# NaitGateManaged = ${digest(peer.publicKey)}`)) {
    throw fail('peer_closed_identity_unverified', 'Closed client has no verified gate marker');
  }
  if (peer.clientId && peer.clientId !== target.clientId) {
    throw fail('peer_client_id_mismatch', 'Client belongs to a different managed identity');
  }
  if (!same(inventory(peers), inventory(runtimePeers))) {
    throw fail('peers_diverged', 'Persistent and runtime peer inventories differ');
  }
  let nextTable = null;
  if (tableText !== null) {
    let table;
    try { table = JSON.parse(tableText); } catch { throw fail('invalid_clients_table', 'Amnezia clients table is unreadable'); }
    if (Array.isArray(table)) {
      if (table.some(entry => !entry || typeof entry !== 'object' || typeof entry.clientId !== 'string')) {
        throw fail('invalid_clients_table', 'Amnezia clients table entries are invalid');
      }
      nextTable = table.filter(entry => entry.clientId !== peer.publicKey);
    } else if (table && typeof table === 'object') {
      nextTable = Object.fromEntries(Object.entries(table).filter(([key]) => key !== peer.publicKey));
    } else throw fail('invalid_clients_table', 'Amnezia clients table has an unsupported format');
  }
  return { publicKey: peer.publicKey, nextConfig: removePeerBlock(configText, peer),
    nextTable: nextTable === null ? null : `${JSON.stringify(nextTable, null, 2)}\n`,
    remaining: runtimePeers.filter(item => item.publicKey !== peer.publicKey) };
}

function defaultDependencies() {
  return { getAwgRuntimeConfig, getAwgStatus, getAwgPeers, readConfig, createPeerDeleteBackup,
    writeConfigToContainer, writeTextToContainer, restoreConfigFromBackup, restoreFileFromBackup,
    readFile: path => fs.readFile(path, 'utf8'), runFile };
}

// Called with the Receiver's AWG write lock already held.
async function deleteExistingPeer(target, { requestId, commit }, dependencies = defaultDependencies()) {
  const d = dependencies;
  const config = d.getAwgRuntimeConfig();
  const beforeStatus = await d.getAwgStatus();
  const beforeInventory = await d.getAwgPeers();
  if (beforeStatus.status !== 'ok' || beforeInventory.status !== 'ok') {
    throw fail('peers_unavailable', 'AWG inventory is unavailable');
  }
  const originalConfig = await d.readConfig(config, requestId);
  // Backups capture clientsTable when present. A failed copy must never silently
  // turn an existing table into an "absent" table.
  const { stdout: exists } = await d.runFile('docker', ['exec', config.containerName, 'sh', '-c',
    'if [ -f "$1" ]; then printf present; else printf absent; fi', 'sh', config.clientsTablePath]);
  if (!['present', 'absent'].includes(exists.trim())) throw fail('clients_table_unavailable', 'Cannot inspect clients table');
  const backup = await d.createPeerDeleteBackup(config, getContainerConfigPath(config));
  if (exists.trim() === 'present' && !backup.clientsTableBackupPath) {
    throw fail('clients_table_backup_failed', 'Cannot back up existing clients table');
  }
  if (await d.readFile(backup.configBackupPath) !== originalConfig) {
    throw fail('config_changed', 'AWG configuration changed during backup');
  }
  const tableText = backup.clientsTableBackupPath ? await d.readFile(backup.clientsTableBackupPath) : null;
  const plan = prepareDeletion(originalConfig, tableText, target, beforeInventory.peers);
  async function readTable() {
    return (await d.runFile('docker', ['exec', config.containerName, 'cat', config.clientsTablePath], { maxBuffer: 2 * 1024 * 1024 })).stdout;
  }
  if (await d.readConfig(config, requestId) !== originalConfig || (tableText !== null && await readTable() !== tableText)) {
    throw fail('config_changed', 'Server data changed before deletion');
  }
  let mutationStarted = false;
  try {
    mutationStarted = true; // Writes may succeed remotely even when their reply fails.
    await d.writeConfigToContainer(config, plan.nextConfig, requestId);
    if (plan.nextTable !== null) await d.writeTextToContainer(config, plan.nextTable, config.clientsTablePath, requestId, 'clientsTable');
    await d.runFile('docker', ['exec', config.containerName, 'awg', 'set', config.interfaceName, 'peer', plan.publicKey, 'remove']);
    const afterStatus = await d.getAwgStatus();
    const afterInventory = await d.getAwgPeers();
    if (afterStatus.status !== 'ok' || afterInventory.status !== 'ok'
        || afterStatus.listenPort !== beforeStatus.listenPort
        || !same(inventory(afterInventory.peers), inventory(plan.remaining))
        || await d.readConfig(config, requestId) !== plan.nextConfig
        || (plan.nextTable !== null && await readTable() !== plan.nextTable)) {
      throw fail('peer_delete_verify_failed', 'Client deletion or preservation of other clients was not verified');
    }
    if (commit) await commit({ backupId: backup.backupId,
      peersCountBefore: beforeInventory.peers.length, peersCountAfter: plan.remaining.length });
    return { statusCode: 200, body: { status: 'ok', operation: 'delete_peer', requestId,
      publicKeyFingerprint: target.publicKeyFingerprint, backup: { id: backup.backupId },
      runtime: { verified: true }, persistentConfig: { verified: true }, clientsTable: { verified: true } } };
  } catch (error) {
    if (mutationStarted) {
      try {
        await d.restoreConfigFromBackup(config, backup.configBackupPath, requestId);
        if (backup.clientsTableBackupPath) await d.restoreFileFromBackup(config, backup.clientsTableBackupPath, config.clientsTablePath, requestId);
        await d.runFile('docker', ['exec', config.containerName, 'bash', '-c',
          'awg syncconf "$1" <(awg-quick strip "$2")', 'bash', config.interfaceName, getContainerConfigPath(config)]);
        const restored = await d.getAwgPeers();
        if (restored.status !== 'ok' || !same(inventory(restored.peers), inventory(beforeInventory.peers))
            || await d.readConfig(config, requestId) !== originalConfig
            || (tableText !== null && await readTable() !== tableText)) throw new Error('Rollback verification failed');
      } catch {
        throw fail('peer_delete_rollback_failed', 'Deletion failed and automatic rollback could not be verified; server backup retained');
      }
    }
    throw error;
  }
}

module.exports = { prepareDeletion, deleteExistingPeer };
