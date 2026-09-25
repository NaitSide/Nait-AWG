'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLinuxProcessIdentity(pid) {
  try {
    const [bootId, stat] = await Promise.all([
      fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      fs.readFile(`/proc/${pid}/stat`, 'utf8')
    ]);
    const closingParen = stat.lastIndexOf(')');
    const fields = closingParen >= 0 ? stat.slice(closingParen + 1).trim().split(/\s+/) : [];
    const processStartTime = fields[19];
    if (!bootId.trim() || !/^\d+$/.test(processStartTime || '')) return null;
    return { bootId: bootId.trim(), processStartTime };
  } catch {
    return null;
  }
}

async function probeOwner(owner) {
  if (!owner || owner.schemaVersion !== 1 || !Number.isInteger(owner.pid)
      || typeof owner.bootId !== 'string' || typeof owner.processStartTime !== 'string') {
    return 'unknown';
  }

  let bootId;
  try {
    bootId = String(await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  } catch {
    return 'unknown';
  }
  if (bootId !== owner.bootId) return 'dead';

  const identity = await readLinuxProcessIdentity(owner.pid);
  if (!identity) {
    try {
      await fs.access(`/proc/${owner.pid}`);
      return 'unknown';
    } catch (error) {
      return error && error.code === 'ENOENT' ? 'dead' : 'unknown';
    }
  }
  return identity.processStartTime === owner.processStartTime ? 'alive' : 'dead';
}

async function writeOwner(lockDir, owner) {
  const ownerPath = path.join(lockDir, 'owner.json');
  const handle = await fs.open(ownerPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOwner(lockDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function quarantineDeadLock(lockDir, token) {
  const quarantinePath = `${lockDir}.stale.${Date.now()}.${token}`;
  try {
    await fs.rename(lockDir, quarantinePath);
    return true;
  } catch (error) {
    if (error && ['ENOENT', 'EEXIST'].includes(error.code)) return false;
    throw error;
  }
}

async function releaseOwnedLock(lockDir, token) {
  const owner = await readOwner(lockDir);
  if (!owner || owner.token !== token) {
    const error = new Error('AWG write lock ownership was lost');
    error.code = 'write_lock_ownership_lost';
    error.statusCode = 423;
    throw error;
  }
  await fs.unlink(path.join(lockDir, 'owner.json'));
  await fs.rmdir(lockDir);
}

async function withDirectoryLock(lockDir, options, task) {
  const timeoutMs = Number(options.timeoutMs || 15000);
  const intervalMs = Number(options.intervalMs || 250);
  const startedAt = Date.now();
  const token = crypto.randomBytes(12).toString('hex');
  const readCurrentIdentity = options.readCurrentIdentity || (() => readLinuxProcessIdentity(process.pid));
  const inspectOwner = options.probeOwner || probeOwner;

  await fs.mkdir(path.dirname(lockDir), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      const identity = await readCurrentIdentity();
      await writeOwner(lockDir, {
        schemaVersion: 1,
        token,
        pid: process.pid,
        bootId: identity && identity.bootId,
        processStartTime: identity && identity.processStartTime,
        createdAt: new Date().toISOString()
      });
      break;
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;
      const owner = await readOwner(lockDir);
      if (await inspectOwner(owner) === 'dead') {
        if (await quarantineDeadLock(lockDir, token)) continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const lockError = new Error('AWG write lock is busy');
        lockError.code = 'write_lock_busy';
        lockError.statusCode = 423;
        throw lockError;
      }
      await sleep(intervalMs);
    }
  }

  try {
    return await task();
  } finally {
    await releaseOwnedLock(lockDir, token);
  }
}

module.exports = {
  probeOwner,
  readLinuxProcessIdentity,
  withDirectoryLock
};
