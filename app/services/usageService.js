'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{12}$/;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function usageError(message, code = 'usage_unavailable') {
  const error = new Error(message);
  error.status = 503;
  error.code = code;
  return error;
}

function fingerprint(publicKey) {
  return crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 12);
}

function bytes(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw usageError('Некорректные счётчики AWG.', 'usage_invalid_counter');
  return number;
}

function validState(value) {
  return value?.version === 1 && value.peers && typeof value.peers === 'object' && !Array.isArray(value.peers)
    && Object.entries(value.peers).every(([id, peer]) => FINGERPRINT_PATTERN.test(id)
      && KEY_PATTERN.test(peer?.publicKey || '') && peer.months && typeof peer.months === 'object' && !Array.isArray(peer.months)
      && Number.isSafeInteger(peer.lastRx) && peer.lastRx >= 0
      && Number.isSafeInteger(peer.lastTx) && peer.lastTx >= 0
      && Number.isSafeInteger(peer.totalRx) && peer.totalRx >= 0
      && Number.isSafeInteger(peer.totalTx) && peer.totalTx >= 0
      && Object.entries(peer.months).every(([month, totals]) => /^\d{4}-\d{2}$/.test(month)
        && Number.isSafeInteger(totals?.rx) && totals.rx >= 0
        && Number.isSafeInteger(totals?.tx) && totals.tx >= 0));
}

function createUsageStore(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let state = { version: 1, startedAt: null, updatedAt: null, peers: {} };
  let readFailure = null;
  try {
    if (fs.existsSync(filePath)) {
      if (fs.statSync(filePath).size > MAX_FILE_BYTES) throw new Error('Usage file is too large');
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!validState(loaded)) {
        throw new Error('Usage file has an unsupported format');
      }
      state = loaded;
    }
  } catch {
    readFailure = usageError('Файл истории трафика повреждён. Учёт остановлен; исходный файл не изменён.');
  }

  function available() {
    if (readFailure) throw readFailure;
  }

  function persist(next) {
    const serialized = JSON.stringify(next, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw usageError('Файл истории трафика превысил допустимый размер.');
    const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tempPath, serialized, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tempPath, filePath);
      state = next;
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }

  function record(peers, observedAt = new Date()) {
    available();
    if (!Array.isArray(peers)) throw usageError('Список клиентов AWG недоступен.');
    const at = new Date(observedAt);
    if (!Number.isFinite(at.getTime())) throw usageError('Некорректное время измерения трафика.');
    const stamp = at.toISOString();
    const month = stamp.slice(0, 7);
    const next = structuredClone(state);
    const seen = new Set();
    for (const peer of peers) {
      if (!KEY_PATTERN.test(peer?.publicKey || '')) throw usageError('Не удалось проверить PublicKey клиента.');
      const id = fingerprint(peer.publicKey);
      if (seen.has(id)) throw usageError('Неоднозначный fingerprint клиента.', 'usage_identity_collision');
      seen.add(id);
      const rx = bytes(peer.transferRx ?? 0);
      const tx = bytes(peer.transferTx ?? 0);
      const prior = next.peers[id];
      if (!prior) {
        next.peers[id] = { publicKey: peer.publicKey, firstObservedAt: stamp, lastObservedAt: stamp,
          lastRx: rx, lastTx: tx, totalRx: rx, totalTx: tx,
          preTrackingRx: rx, preTrackingTx: tx, months: {} };
        continue;
      }
      if (prior.publicKey !== peer.publicKey) throw usageError('Fingerprint клиента совпал с другим PublicKey.', 'usage_identity_collision');
      const addedRx = rx >= prior.lastRx ? rx - prior.lastRx : rx;
      const addedTx = tx >= prior.lastTx ? tx - prior.lastTx : tx;
      prior.totalRx += addedRx;
      prior.totalTx += addedTx;
      if (!Number.isSafeInteger(prior.totalRx) || !Number.isSafeInteger(prior.totalTx)) throw usageError('Переполнение счётчика трафика.');
      if (addedRx || addedTx) {
        const bucket = prior.months[month] || { rx: 0, tx: 0 };
        bucket.rx += addedRx;
        bucket.tx += addedTx;
        prior.months[month] = bucket;
      }
      prior.lastRx = rx;
      prior.lastTx = tx;
      prior.lastObservedAt = stamp;
    }
    if (!next.startedAt) next.startedAt = stamp;
    next.updatedAt = stamp;
    persist(next);
  }

  function summary(id) {
    available();
    const peer = state.peers[id];
    if (!peer) return null;
    return { firstObservedAt: peer.firstObservedAt, lastObservedAt: peer.lastObservedAt,
      receivedBytes: peer.totalTx, sentBytes: peer.totalRx,
      beforeTrackingReceivedBytes: peer.preTrackingTx, beforeTrackingSentBytes: peer.preTrackingRx,
      months: Object.entries(peer.months).sort(([left], [right]) => right.localeCompare(left))
        .map(([month, totals]) => ({ month, receivedBytes: totals.tx, sentBytes: totals.rx })) };
  }

  function replace(value) {
    if (!validState(value)) throw usageError('История трафика в резервной копии повреждена.', 'invalid_backup_usage');
    persist(structuredClone(value));
    readFailure = null;
  }

  return { record, replace, summary, snapshot() { available(); return structuredClone(state); } };
}

module.exports = { createUsageStore, validState };
