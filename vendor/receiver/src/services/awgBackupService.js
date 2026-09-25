'use strict';

const fs = require('fs/promises');
const path = require('path');
const { runFile } = require('../utils/exec');

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
}

function getBackupRoot() {
  return process.env.AWG_RECEIVER_BACKUP_DIR || process.env.AWG_BACKUP_DIR || '/opt/naitlab/nait_awg_node/receiver/backups';
}

async function chmodSafe(target) {
  await fs.chmod(target, 0o600);
}

async function copyFromContainerIfExists(config, containerPath, target) {
  try {
    await runFile('docker', [
      'exec',
      config.containerName,
      'test',
      '-f',
      containerPath
    ], {
      timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000)
    });
    await runFile('docker', [
      'cp',
      `${config.containerName}:${containerPath}`,
      target
    ], {
      timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000)
    });
    await chmodSafe(target);
    return true;
  } catch (error) {
    return false;
  }
}

async function createPeerBackup(config, containerConfigPath, operation) {
  const backupId = timestampId();
  const backupDir = path.join(getBackupRoot(), operation, backupId);
  const configDir = path.posix.dirname(containerConfigPath);
  const files = [
    path.posix.basename(containerConfigPath),
    'wireguard_psk.key',
    'wireguard_server_private_key.key',
    'wireguard_server_public_key.key'
  ];

  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  await fs.chmod(backupDir, 0o700);

  const copied = [];
  for (const file of files) {
    const didCopy = await copyFromContainerIfExists(config, path.posix.join(configDir, file), path.join(backupDir, file));
    if (didCopy) copied.push(file);
  }

  const configFileName = path.posix.basename(containerConfigPath);
  if (!copied.includes(configFileName)) {
    const error = new Error('AWG config backup failed');
    error.code = 'config_backup_failed';
    error.statusCode = 409;
    throw error;
  }

  const { stdout } = await runFile('docker', ['inspect', config.containerName], {
    timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000),
    maxBuffer: 2 * 1024 * 1024
  });

  const inspectPath = path.join(backupDir, `${config.containerName}.inspect.json`);
  await fs.writeFile(inspectPath, stdout, { mode: 0o600 });

  const metadata = {
    backupId,
    createdAt: new Date().toISOString(),
    operation,
    containerConfigPath,
    copied,
    containerName: config.containerName,
    interfaceName: config.interfaceName
  };

  await fs.writeFile(path.join(backupDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });

  return {
    backupId,
    backupDir,
    configBackupPath: path.join(backupDir, 'awg0.conf')
  };
}

async function createPeerCreateBackup(config, containerConfigPath) {
  return createPeerBackup(config, containerConfigPath, 'peer_create');
}

async function createPeerDeleteBackup(config, containerConfigPath) {
  return createPeerBackup(config, containerConfigPath, 'peer_delete');
}

module.exports = {
  createPeerCreateBackup,
  createPeerDeleteBackup
};
