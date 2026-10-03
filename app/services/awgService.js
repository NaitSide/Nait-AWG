'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { DatabaseSync } = require('node:sqlite');
const QRCode = require('qrcode');
const { decryptBackup, encryptBackup, plainBackup, validatePassphrase } = require('./backupService');
const { createUsageStore, validState: validUsageState } = require('./usageService');
const { parseClientConfig } = require('./clientConfigService');

const execFileAsync = promisify(execFile);

const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const SAFE_LABEL_PATTERN = /^[a-zA-Z0-9_.-]{1,80}$/;
const CYRILLIC_LATIN = {
  А:'A', Б:'B', В:'V', Г:'G', Д:'D', Е:'E', Ё:'Yo', Ж:'Zh', З:'Z', И:'I', Й:'Y',
  К:'K', Л:'L', М:'M', Н:'N', О:'O', П:'P', Р:'R', С:'S', Т:'T', У:'U', Ф:'F',
  Х:'Kh', Ц:'Ts', Ч:'Ch', Ш:'Sh', Щ:'Sch', Ъ:'', Ы:'Y', Ь:'', Э:'E', Ю:'Yu', Я:'Ya'
};
const CLIENT_PARAMETER_ORDER = [
  'Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4',
  'HeaderProtectionKey', 'ContentPaddingAddition', 'RekeyAfterTime',
  'RekeyTimeout', 'RejectAfterTime', 'KeepaliveTimeout',
  'MaxHandshakeAttempts', 'RandomTrailers', 'DisableCookies', 'I1', 'I2',
  'I3', 'I4', 'I5'
];

function createHttpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || 'http://127.0.0.1:42842'));
  if (!['http:', 'https:'].includes(url.protocol)) throw createHttpError(500, 'invalid_receiver_url', 'Receiver URL must use HTTP(S)');
  return url.toString().replace(/\/$/, '');
}

function createFingerprint(publicKey) {
  return crypto.createHash('sha256').update(String(publicKey)).digest('hex').slice(0, 12);
}

function formatTrafficBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? amount : amount.toFixed(1)} ${units[unit]}`;
}

function makeReceiverClient(env = process.env) {
  const baseUrl = normalizeBaseUrl(env.RECEIVER_URL);
  const apiKey = String(env.RECEIVER_API_KEY || '').trim();

  return async function receiverRequest(route, options = {}) {
    const { timeoutMs = 30000, ...fetchOptions } = options;
    const headers = { accept: 'application/json', ...(fetchOptions.headers || {}) };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetch(`${baseUrl}${route}`, { ...fetchOptions, headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw createHttpError(response.status, payload?.code || 'receiver_error', payload?.message || 'AWG Receiver request failed');
    return payload;
  };
}

function run(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => reject(createHttpError(500, 'keygen_unavailable', 'AWG key generator is unavailable')));
    child.on('close', (code) => {
      if (code !== 0) return reject(createHttpError(500, 'keygen_failed', 'AWG key generator failed'));
      return resolve(stdout.trim());
    });
    child.stdin.end(input);
  });
}

async function generateKeyMaterial(containerName) {
  const base = ['exec', '-i', containerName, 'awg'];
  const privateKey = await run('docker', [...base, 'genkey']);
  const publicKey = await run('docker', [...base, 'pubkey'], `${privateKey}\n`);
  const presharedKey = await run('docker', [...base, 'genpsk']);
  if (![privateKey, publicKey, presharedKey].every((key) => KEY_PATTERN.test(key))) {
    throw createHttpError(500, 'invalid_generated_key', 'AWG key generator returned an invalid key');
  }
  return { privateKey, publicKey, presharedKey };
}

function base64Key(value, name) {
  const key = Buffer.from(String(value || ''), 'base64');
  if (key.length !== 32) throw createHttpError(500, 'invalid_data_key', `${name} must contain 32 random bytes encoded as base64`);
  return key;
}

function encrypt(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

function decrypt(value, key) {
  const [ivText, tagText, ciphertextText] = String(value || '').split('.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw createHttpError(500, 'stored_config_unavailable', 'Stored client configuration cannot be decrypted');
  }
}

function parseIpv4(value) {
  const parts = String(value || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function formatIpv4(value) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function allocateAddress(subnet, interfaceAddress, peers) {
  const [networkText, prefixText] = String(subnet || '').split('/');
  const network = parseIpv4(networkText);
  const prefix = Number(prefixText);
  if (network === null || prefix !== 24) throw createHttpError(409, 'unsupported_tunnel_subnet', 'Nait-AWG MVP currently requires an IPv4 /24 tunnel subnet');
  const used = new Set((peers || []).flatMap((peer) => peer.allowedIps || []).map((cidr) => parseIpv4(String(cidr).split('/')[0])).filter((value) => value !== null));
  used.add(parseIpv4(String(interfaceAddress || '').split('/')[0]));
  for (let host = 2; host < 255; host += 1) {
    const candidate = (network + host) >>> 0;
    if (!used.has(candidate)) return `${formatIpv4(candidate)}/32`;
  }
  throw createHttpError(409, 'address_pool_exhausted', 'No free tunnel address remains');
}

function isHostAddress(value) {
  const [ip, prefix, extra] = String(value || '').split('/');
  return extra === undefined && prefix === '32' && parseIpv4(ip) !== null;
}

function sameIps(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...left].sort(), b = [...right].sort();
  return a.every((ip, index) => ip === b[index]);
}

function assertGateSnapshot(snapshot, address) {
  if (snapshot?.status !== 'ok' || snapshot.readQuality !== 'complete'
      || snapshot.writerStatus !== 'idle' || !snapshot.nodeIncarnation
      || Object.values(snapshot.stepStatuses || {}).some((status) => status === 'running' || status === 'failed_unknown')) {
    throw createHttpError(409, 'gate_unverified', 'Состояние доступа не подтверждено. Ничего не переключено.');
  }
  if (snapshot.classification === 'OPEN' && sameIps(snapshot.persistentAllowedIps, [address])
      && sameIps(snapshot.runtimeAllowedIps, [address])) return 'on';
  if (snapshot.classification === 'CLOSED' && sameIps(snapshot.persistentAllowedIps, [])
      && sameIps(snapshot.runtimeAllowedIps, [])) return 'off';
  throw createHttpError(409, 'gate_state_mismatch', 'Настройки AWG и работающий интерфейс расходятся. Переключение остановлено.');
}

function peerDisplayStatus(peer, accessState) {
  if (accessState === 'off') return 'disabled';
  if (accessState === 'unknown') return 'unknown';
  const hasHandshake = Boolean(peer.latestHandshakeAt);
  const hasTraffic = Number(peer.transferRx || 0) > 0 || Number(peer.transferTx || 0) > 0;
  if (!hasHandshake && !hasTraffic) return 'never';
  return peer.state === 'active' ? 'active' : 'inactive';
}

function safeClientLabel(label) {
  const transliterated = String(label || '').trim().replace(/[А-Яа-яЁё]/g, (char) => {
    const upper = char.toUpperCase();
    const latin = CYRILLIC_LATIN[upper] ?? char;
    return char === upper ? latin : latin.toLowerCase();
  });
  const normalized = transliterated.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!SAFE_LABEL_PATTERN.test(normalized)) throw createHttpError(400, 'invalid_client_label', 'Укажите имя с буквами или цифрами');
  return normalized;
}

function buildConfig({ privateKey, address, profile, presharedKey, endpointHost, dns, allowedIps, keepalive }) {
  const clientParameters = profile.clientInterfaceParameters || {};
  const parameterLines = CLIENT_PARAMETER_ORDER
    .filter((name) => Object.prototype.hasOwnProperty.call(clientParameters, name))
    .map((name) => `${name} = ${clientParameters[name]}`);
  return [
    '[Interface]', `PrivateKey = ${privateKey}`, `Address = ${address}`, `DNS = ${dns}`,
    ...parameterLines, '', '[Peer]', `PublicKey = ${profile.serverPublicKey}`,
    `PresharedKey = ${presharedKey}`, `Endpoint = ${endpointHost}:${profile.listenPort}`,
    `AllowedIPs = ${allowedIps}`, `PersistentKeepalive = ${keepalive}`, ''
  ].join('\n');
}

function createClientStore(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS clients (
      client_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      receiver_label TEXT NOT NULL,
      public_key_fingerprint TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL,
      encrypted_config TEXT,
      status TEXT NOT NULL CHECK(status IN ('active', 'deleted')),
      created_at TEXT NOT NULL,
      deleted_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS clients_active_fingerprint ON clients(status, public_key_fingerprint);
    CREATE TABLE IF NOT EXISTS peer_gate_addresses (
      public_key_fingerprint TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      device_id TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS peer_gate_address ON peer_gate_addresses(address);
  `);

  return {
    snapshot() { return Buffer.from(db.serialize()); },
    snapshotState() {
      return {
        clients: db.prepare(`SELECT client_id AS clientId, label, receiver_label AS receiverLabel,
          public_key_fingerprint AS publicKeyFingerprint, address, encrypted_config AS encryptedConfig,
          status, created_at AS createdAt, deleted_at AS deletedAt FROM clients ORDER BY created_at ASC`).all(),
        gates: db.prepare(`SELECT public_key_fingerprint AS publicKeyFingerprint, public_key AS publicKey,
          device_id AS deviceId, address, created_at AS createdAt FROM peer_gate_addresses`).all()
      };
    },
    listForBackup() {
      return db.prepare(`SELECT label AS name, address AS vpnAddress,
        public_key_fingerprint AS publicKeyFingerprint, status AS recordStatus,
        created_at AS createdAt FROM clients ORDER BY created_at ASC`).all();
    },
    activeByFingerprint() {
      return new Map(db.prepare(`SELECT client_id AS clientId, label, receiver_label AS receiverLabel,
        public_key_fingerprint AS publicKeyFingerprint, address, encrypted_config AS encryptedConfig,
        status, created_at AS createdAt FROM clients WHERE status = 'active'`).all()
        .map((client) => [client.publicKeyFingerprint, client]));
    },
    findActive(fingerprint) {
      return db.prepare(`SELECT client_id AS clientId, label, receiver_label AS receiverLabel,
        public_key_fingerprint AS publicKeyFingerprint, address, encrypted_config AS encryptedConfig,
        status, created_at AS createdAt FROM clients WHERE public_key_fingerprint = ? AND status = 'active'`)
        .get(fingerprint);
    },
    insert(client) {
      db.prepare(`INSERT INTO clients (client_id, label, receiver_label, public_key_fingerprint, address,
        encrypted_config, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`)
        .run(client.clientId, client.label, client.receiverLabel, client.publicKeyFingerprint,
          client.address, client.encryptedConfig, client.createdAt);
    },
    markDeleted(fingerprint) {
      db.prepare(`UPDATE clients SET status = 'deleted', encrypted_config = NULL, deleted_at = ?
        WHERE public_key_fingerprint = ? AND status = 'active'`).run(new Date().toISOString(), fingerprint);
      db.prepare(`DELETE FROM peer_gate_addresses WHERE public_key_fingerprint = ?`).run(fingerprint);
    },
    gateByFingerprint(fingerprint) {
      return db.prepare(`SELECT public_key_fingerprint AS fingerprint, public_key AS publicKey,
        device_id AS deviceId, address FROM peer_gate_addresses WHERE public_key_fingerprint = ?`).get(fingerprint);
    },
    reserveGatePeer(peer) {
      const existing = this.gateByFingerprint(peer.fingerprint);
      if (existing) {
        if (existing.publicKey !== peer.publicKey || existing.deviceId !== peer.deviceId || existing.address !== peer.address) {
          throw createHttpError(409, 'gate_identity_changed', 'Сохранённая идентичность клиента не совпадает с текущей.');
        }
        return;
      }
      db.prepare(`INSERT INTO peer_gate_addresses (public_key_fingerprint, public_key, device_id, address, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(peer.fingerprint, peer.publicKey, peer.deviceId, peer.address, new Date().toISOString());
    },
    reservedAddresses() {
      return db.prepare(`SELECT public_key_fingerprint AS fingerprint, address FROM clients WHERE status = 'active'
        UNION SELECT public_key_fingerprint AS fingerprint, address FROM peer_gate_addresses`).all();
    },
    replace(state) {
      const insertClient = db.prepare(`INSERT INTO clients (client_id, label, receiver_label, public_key_fingerprint,
        address, encrypted_config, status, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertGate = db.prepare(`INSERT INTO peer_gate_addresses (public_key_fingerprint, public_key, device_id,
        address, created_at) VALUES (?, ?, ?, ?, ?)`);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM peer_gate_addresses; DELETE FROM clients;');
        for (const client of state.clients) insertClient.run(client.clientId, client.label, client.receiverLabel,
          client.publicKeyFingerprint, client.address, client.encryptedConfig, client.status, client.createdAt, client.deletedAt);
        for (const gate of state.gates) insertGate.run(gate.publicKeyFingerprint, gate.publicKey, gate.deviceId,
          gate.address, gate.createdAt);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

function createNoteStore(filePath) {
  const read = () => {
    if (!fs.existsSync(filePath)) return { notes: {}, telegrams: {} };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed?.version !== 1 || !parsed.notes || typeof parsed.notes !== 'object' || Array.isArray(parsed.notes)) {
      throw new Error('Invalid peer notes file');
    }
    if (parsed.telegrams !== undefined && (!parsed.telegrams || typeof parsed.telegrams !== 'object' || Array.isArray(parsed.telegrams))) {
      throw new Error('Invalid peer notes file');
    }
    return { notes: parsed.notes, telegrams: parsed.telegrams || {} };
  };
  let { notes, telegrams } = read();
  return {
    snapshot() { return { version: 1, notes: { ...notes }, telegrams: { ...telegrams } }; },
    getNote(fingerprint) { return notes[fingerprint] || ''; },
    getTelegram(fingerprint) { return telegrams[fingerprint] || ''; },
    set(fingerprint, note, telegram) {
      const nextNotes = { ...notes };
      const nextTelegrams = { ...telegrams };
      if (note) nextNotes[fingerprint] = note;
      else delete nextNotes[fingerprint];
      if (telegram) nextTelegrams[fingerprint] = telegram;
      else delete nextTelegrams[fingerprint];
      const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tempPath, JSON.stringify({ version: 1, notes: nextNotes, telegrams: nextTelegrams }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(tempPath, filePath);
        notes = nextNotes;
        telegrams = nextTelegrams;
      } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    },
    replace(value) {
      if (value?.version !== 1 || !value.notes || typeof value.notes !== 'object' || Array.isArray(value.notes)
          || !value.telegrams || typeof value.telegrams !== 'object' || Array.isArray(value.telegrams)
          || Object.entries(value.notes).some(([id, note]) => !/^[a-f0-9]{12}$/.test(id) || typeof note !== 'string' || note.length > 2000)
          || Object.entries(value.telegrams).some(([id, telegram]) => !/^[a-f0-9]{12}$/.test(id) || typeof telegram !== 'string' || telegram.length > 80)) {
        throw createHttpError(400, 'invalid_backup_metadata', 'Заметки в резервной копии повреждены.');
      }
      const nextNotes = { ...value.notes }, nextTelegrams = { ...value.telegrams };
      const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tempPath, JSON.stringify({ version: 1, notes: nextNotes, telegrams: nextTelegrams }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(tempPath, filePath);
        notes = nextNotes;
        telegrams = nextTelegrams;
      } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    }
  };
}

function backupBuffer(value) {
  if (typeof value !== 'string' || value.length < 100 || value.length > 30 * 1024 * 1024
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw createHttpError(400, 'invalid_backup_database', 'База панели в резервной копии повреждена.');
  }
  const result = Buffer.from(value, 'base64');
  if (result.length < 100 || result.length > 20 * 1024 * 1024) {
    throw createHttpError(400, 'invalid_backup_database', 'Размер базы панели в резервной копии недопустим.');
  }
  return result;
}

function prepareRestoreDatabase(encoded) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-restore-'));
  const databasePath = path.join(directory, 'clients.db');
  let database;
  try {
    fs.writeFileSync(databasePath, backupBuffer(encoded), { mode: 0o600, flag: 'wx' });
    database = new DatabaseSync(databasePath, { readOnly: true });
    if (database.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') {
      throw createHttpError(400, 'invalid_backup_database', 'Проверка целостности базы панели не пройдена.');
    }
    const columns = new Set(database.prepare('PRAGMA table_info(clients)').all().map((column) => column.name));
    const gateColumns = new Set(database.prepare('PRAGMA table_info(peer_gate_addresses)').all().map((column) => column.name));
    for (const name of ['client_id', 'label', 'receiver_label', 'public_key_fingerprint', 'address', 'encrypted_config', 'status', 'created_at', 'deleted_at']) {
      if (!columns.has(name)) throw createHttpError(400, 'invalid_backup_database', 'Структура базы панели не поддерживается.');
    }
    for (const name of ['public_key_fingerprint', 'public_key', 'device_id', 'address', 'created_at']) {
      if (!gateColumns.has(name)) throw createHttpError(400, 'invalid_backup_database', 'Структура адресов клиентов не поддерживается.');
    }
    const clients = database.prepare(`SELECT client_id AS clientId, label, receiver_label AS receiverLabel,
      public_key_fingerprint AS publicKeyFingerprint, address, encrypted_config AS encryptedConfig,
      status, created_at AS createdAt, deleted_at AS deletedAt FROM clients ORDER BY created_at ASC`).all();
    const gates = database.prepare(`SELECT public_key_fingerprint AS publicKeyFingerprint, public_key AS publicKey,
      device_id AS deviceId, address, created_at AS createdAt FROM peer_gate_addresses`).all();
    if (clients.length > 10000 || gates.length > 10000) throw createHttpError(400, 'invalid_backup_database', 'В резервной копии слишком много записей.');
    const ids = new Set(), fingerprints = new Set();
    for (const client of clients) {
      if (typeof client.clientId !== 'string' || client.clientId.length < 1 || client.clientId.length > 120
          || typeof client.label !== 'string' || client.label.length < 1 || client.label.length > 80
          || !SAFE_LABEL_PATTERN.test(client.receiverLabel || '') || !/^[a-f0-9]{12}$/.test(client.publicKeyFingerprint || '')
          || !isHostAddress(client.address) || !['active', 'deleted'].includes(client.status)
          || typeof client.createdAt !== 'string' || client.createdAt.length > 64
          || (client.deletedAt !== null && (typeof client.deletedAt !== 'string' || client.deletedAt.length > 64))
          || ids.has(client.clientId) || fingerprints.has(client.publicKeyFingerprint)) {
        throw createHttpError(400, 'invalid_backup_database', 'Записи клиентов в резервной копии повреждены.');
      }
      ids.add(client.clientId); fingerprints.add(client.publicKeyFingerprint);
      // Old client secrets belong to the old server. The migration creates fresh material.
      client.encryptedConfig = null;
    }
    for (const gate of gates) {
      if (!/^[a-f0-9]{12}$/.test(gate.publicKeyFingerprint || '') || !KEY_PATTERN.test(gate.publicKey || '')
          || typeof gate.deviceId !== 'string' || gate.deviceId.length < 1 || gate.deviceId.length > 120
          || !isHostAddress(gate.address) || typeof gate.createdAt !== 'string' || gate.createdAt.length > 64) {
        throw createHttpError(400, 'invalid_backup_database', 'Адреса клиентов в резервной копии повреждены.');
      }
    }
    return { clients, gates };
  } finally {
    database?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function restoredPeerMap(config) {
  const peers = new Map();
  for (const block of String(config || '').split(/^\s*\[Peer\]\s*$/gmi).slice(1)) {
    const publicKey = /^\s*PublicKey\s*=\s*(\S+)\s*$/mi.exec(block)?.[1] || '';
    if (!KEY_PATTERN.test(publicKey)) continue;
    const allowedIps = (/^\s*AllowedIPs\s*=\s*(.*?)\s*$/mi.exec(block)?.[1] || '')
      .split(',').map((value) => value.trim()).filter(Boolean);
    peers.set(createFingerprint(publicKey), allowedIps);
  }
  return peers;
}

function buildRestoreClientsTable(config, database, source) {
  const sourceNames = new Map();
  const values = Array.isArray(source)
    ? source.map((client) => [client?.clientId, client?.userData])
    : source && typeof source === 'object'
      ? Object.entries(source).map(([clientId, value]) => [clientId, value?.userData || value])
      : [];
  for (const [clientId, userData] of values) {
    if (KEY_PATTERN.test(clientId || '') && userData && typeof userData === 'object') sourceNames.set(clientId, userData);
  }
  const labels = new Map(database.clients.map((client) => [client.publicKeyFingerprint, client.label]));
  const blocks = String(config || '').split(/^\s*\[Peer\]\s*$/gmi).slice(1);
  return blocks.map((block, index) => {
    const clientId = /^\s*PublicKey\s*=\s*(\S+)\s*$/mi.exec(block)?.[1] || '';
    if (!KEY_PATTERN.test(clientId)) throw createHttpError(400, 'invalid_backup_awg_config', 'PublicKey клиента в конфиге AWG повреждён.');
    const existing = sourceNames.get(clientId) || {};
    const name = String(existing.clientName || labels.get(createFingerprint(clientId)) || `Client ${index + 1}`)
      .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
    const creationDate = typeof existing.creationDate === 'string' && existing.creationDate.length <= 64
      ? existing.creationDate
      : undefined;
    return { clientId, userData: { clientName: name || `Client ${index + 1}`, ...(creationDate ? { creationDate } : {}) } };
  });
}

function listenPortFromConfig(config, target = false) {
  const matches = [...String(config || '').matchAll(/^\s*ListenPort\s*=\s*(\d+)\s*$/gmi)];
  const port = matches.length === 1 ? Number(matches[0][1]) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw target
      ? createHttpError(409, 'invalid_target_awg_config', 'В конфиге целевого AWG отсутствует корректный порт.')
      : createHttpError(400, 'invalid_backup_awg_config', 'В резервной копии отсутствует корректный порт AWG.');
  }
  return port;
}

function interfaceConfig(config) {
  const text = String(config || '');
  const peer = /^\s*\[Peer\]\s*$/mi.exec(text);
  const part = (peer ? text.slice(0, peer.index) : text).trimEnd();
  if (!/^\s*\[Interface\]\s*$/mi.test(part)) {
    throw createHttpError(400, 'invalid_restore_interface', 'Серверный конфиг AWG повреждён.');
  }
  return `${part}\n`;
}

const OBFUSCATION_NAMES = new Set([...CLIENT_PARAMETER_ORDER, 'ClientJc', 'ClientJmin', 'ClientJmax']);
function obfuscationLine(line) {
  const match = String(line).match(/^\s*(?:[#;]\s*)?([A-Za-z][A-Za-z0-9]*)\s*=/);
  return Boolean(match && OBFUSCATION_NAMES.has(match[1]));
}

function targetInterfaceConfig(target, source, restoreObfuscation) {
  const targetLines = interfaceConfig(target).trimEnd().split(/\r?\n/);
  if (!restoreObfuscation) return `${targetLines.join('\n')}\n`;
  const sourceLines = interfaceConfig(source).split(/\r?\n/).filter(obfuscationLine);
  if (!sourceLines.length) throw createHttpError(400, 'invalid_backup_obfuscation', 'В копии нет параметров обфускации.');
  return `${[...targetLines.filter((line) => !obfuscationLine(line)), ...sourceLines].join('\n')}\n`;
}

function sourceMigrationPeers(config, database, clientsTable, createdAt) {
  const managed = new Map(database.clients.filter((client) => client.status === 'active')
    .map((client) => [client.publicKeyFingerprint, client]));
  const blocks = String(config).split(/^\s*\[Peer\]\s*$/gmi).slice(1);
  const seen = new Set();
  return blocks.map((block, index) => {
    const publicKey = /^\s*PublicKey\s*=\s*(\S+)\s*$/mi.exec(block)?.[1] || '';
    if (!KEY_PATTERN.test(publicKey) || seen.has(publicKey)) {
      throw createHttpError(400, 'invalid_backup_awg_config', 'В копии есть некорректные или повторяющиеся peer.');
    }
    seen.add(publicKey);
    const fingerprint = createFingerprint(publicKey);
    const old = managed.get(fingerprint);
    const table = clientsTable[index];
    const allowedIps = (/^\s*AllowedIPs\s*=\s*(.*?)\s*$/mi.exec(block)?.[1] || '').trim();
    return { oldFingerprint: fingerprint, label: old?.label || table.userData.clientName,
      createdAt: old?.createdAt || table.userData.creationDate || createdAt,
      enabled: Boolean(allowedIps) };
  });
}

function remapTraffic(usageHistory, mappings) {
  const next = { ...usageHistory, peers: {} };
  for (const { oldFingerprint, fingerprint, publicKey } of mappings) {
    const old = usageHistory.peers[oldFingerprint];
    if (old) next.peers[fingerprint] = { ...old, publicKey, lastRx: 0, lastTx: 0 };
  }
  return next;
}

function createAwgService(env = process.env, dependencies = {}) {
  const receiver = makeReceiverClient(env);
  const dataKey = base64Key(env.NAIT_AWG_DATA_KEY, 'NAIT_AWG_DATA_KEY');
  const dataPath = path.resolve(env.NAIT_AWG_DATA_PATH || './data/clients.db');
  const clientStore = createClientStore(dataPath);
  const noteStore = createNoteStore(path.join(path.dirname(dataPath), 'peer-notes.json'));
  const usageStore = createUsageStore(path.join(path.dirname(dataPath), 'traffic-history.json'));
  const endpointHost = String(env.PUBLIC_ENDPOINT_HOST || '').trim();
  const dns = String(env.CLIENT_DNS || '1.1.1.1').trim();
  const allowedIps = String(env.CLIENT_ALLOWED_IPS || '0.0.0.0/0, ::/0').trim();
  const keepalive = Number(env.CLIENT_PERSISTENT_KEEPALIVE || 25);
  const containerName = String(env.AWG_CONTAINER_NAME || 'amnezia-awg').trim();
  const readAwgConfig = dependencies.readAwgConfig || (async () => {
    const { stdout } = await execFileAsync('docker', ['exec', containerName, 'cat', '/opt/amnezia/awg/awg0.conf'],
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', windowsHide: true });
    return stdout;
  });
  const readAwgClientsTable = dependencies.readAwgClientsTable || (dependencies.readAwgConfig ? async () => null : async () => {
    try {
      const { stdout } = await execFileAsync('docker', ['exec', containerName, 'cat', '/opt/amnezia/awg/clientsTable'],
        { timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true });
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  });
  const readPublishedVpnPort = dependencies.readPublishedVpnPort || (async (internalPort) => {
    const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{json .HostConfig.PortBindings}}', containerName],
      { timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true });
    let bindings;
    try { bindings = JSON.parse(stdout); } catch { bindings = null; }
    const ports = bindings?.[`${internalPort}/udp`];
    const published = Array.isArray(ports) ? ports
      .filter((item) => !/^(127\.|::1$)/.test(String(item?.HostIp || '')))
      .map((item) => Number(item?.HostPort)) : [];
    return published.find((port) => Number.isInteger(port) && port > 0 && port <= 65535) || null;
  });
  const newKeyMaterial = dependencies.generateKeyMaterial || (() => generateKeyMaterial(containerName));
  const gateReadCache = new Map();
  let gateQueue = Promise.resolve();
  let backupInProgress = false;
  let restoreInProgress = false;
  let usageSampleInFlight = null;
  let usageTimer = null;
  function withGateLock(task) {
    const result = gateQueue.then(task, task);
    gateQueue = result.catch(() => {});
    return result;
  }

  async function sampleUsage() {
    if (usageSampleInFlight) return usageSampleInFlight;
    const work = (async () => {
      const payload = await (dependencies.readUsagePeers ? dependencies.readUsagePeers() : receiver('/awg/peers'));
      if (payload?.status !== 'ok' || !Array.isArray(payload.peers)) {
        throw createHttpError(503, 'usage_inventory_unavailable', 'Счётчики AWG недоступны.');
      }
      usageStore.record(payload.peers);
    })();
    usageSampleInFlight = work;
    try { return await work; }
    finally { if (usageSampleInFlight === work) usageSampleInFlight = null; }
  }

  function startUsageTracking() {
    if (usageTimer) return;
    const poll = () => sampleUsage().catch((error) => console.warn('[nait-awg] usage_sample_failed', error.code || 'error'));
    poll();
    usageTimer = setInterval(poll, 60000);
    usageTimer.unref?.();
  }

  async function getUsage(fingerprint) {
    if (!/^[a-f0-9]{12}$/.test(fingerprint)) throw createHttpError(400, 'invalid_peer_id', 'Некорректный идентификатор клиента.');
    await sampleUsage();
    const usage = usageStore.summary(fingerprint);
    if (!usage) throw createHttpError(404, 'usage_peer_not_found', 'Статистика клиента не найдена.');
    return usage;
  }

  async function gateRequest(step, body) {
    const gateToken = String(env.AWG_GATE_WRITE_TOKEN || '').trim();
    return receiver(`/awg/gates/${step}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': crypto.randomUUID(),
        ...(step !== 'read' && gateToken ? { 'x-awg-gate-token': gateToken } : {}) },
      body: JSON.stringify(body)
    });
  }

  async function getGateContext(fingerprint, knownInventory = null) {
    if (!/^[a-f0-9]{12}$/.test(fingerprint)) throw createHttpError(400, 'invalid_peer_id', 'Некорректный идентификатор клиента.');
    const inventory = knownInventory || await receiver('/awg/peers');
    if (inventory?.status !== 'ok' || !Array.isArray(inventory.peers)) {
      throw createHttpError(503, 'awg_unavailable', 'Список AWG-клиентов недоступен.');
    }
    const matches = inventory.peers.filter((peer) => createFingerprint(peer.publicKey) === fingerprint);
    if (matches.length !== 1 || !KEY_PATTERN.test(matches[0].publicKey)) {
      throw createHttpError(409, 'peer_identity_unverified', 'Не удалось однозначно определить PublicKey клиента.');
    }
    const peer = matches[0];
    const client = clientStore.findActive(fingerprint);
    const saved = clientStore.gateByFingerprint(fingerprint);
    const address = client?.address || saved?.address || (peer.allowedIps?.length === 1 ? peer.allowedIps[0] : '');
    const deviceId = client?.clientId || saved?.deviceId || `awg-existing-${fingerprint}`;
    if (!isHostAddress(address) || (saved && (saved.publicKey !== peer.publicKey || saved.address !== address || saved.deviceId !== deviceId))) {
      throw createHttpError(409, 'gate_address_unverified', 'Не удалось подтвердить исходный адрес клиента.');
    }
    const identity = { deviceId, deviceGeneration: '1', publicKey: peer.publicKey };
    const snapshot = await gateRequest('read', { ...identity, requestNonce: crypto.randomUUID() });
    if (snapshot.publicKeyFingerprint !== fingerprint) {
      throw createHttpError(409, 'gate_key_mismatch', 'Receiver подтвердил другой PublicKey.');
    }
    const state = assertGateSnapshot(snapshot, address);
    gateReadCache.set(fingerprint, { state, address, publicKey: peer.publicKey, checkedAt: Date.now() });
    return { fingerprint, publicKey: peer.publicKey, deviceId, address, identity, snapshot, state, inventory };
  }

  async function readPeerAccess(fingerprint) {
    const { state, address } = await getGateContext(fingerprint);
    return { state, address };
  }

  async function setPeerAccess(fingerprint, enabled) {
    if (typeof enabled !== 'boolean') throw createHttpError(400, 'invalid_access_target', 'Укажите состояние доступа.');
    return withGateLock(async () => {
      const context = await getGateContext(fingerprint);
      const target = enabled ? 'on' : 'off';
      if (context.state === target) return { state: target, address: context.address, unchanged: true };
      const conflict = clientStore.reservedAddresses().some((entry) => entry.fingerprint !== fingerprint && entry.address === context.address)
        || context.inventory.peers.some((peer) => peer.publicKey !== context.publicKey && (peer.allowedIps || []).includes(context.address));
      if (conflict) throw createHttpError(409, 'duplicate_allowed_ip', 'Адрес уже закреплён за другим клиентом. Доступ не менялся.');
      clientStore.reserveGatePeer(context);

      const operationId = crypto.randomUUID();
      const previousVersion = context.snapshot.acceptedVersion ? BigInt(context.snapshot.acceptedVersion) : 0n;
      const operationVersion = (BigInt(Date.now()) > previousVersion ? BigInt(Date.now()) : previousVersion + 1n).toString();
      const planHash = crypto.createHash('sha256').update(JSON.stringify({ operationId, operationVersion,
        publicKey: context.publicKey, address: context.address, enabled })).digest('hex');
      const base = { ...context.identity, operationId, operationVersion, planHash,
        nodeIncarnation: context.snapshot.nodeIncarnation,
        targetNodeId: enabled ? context.snapshot.nodeId : null,
        targetAllowedIps: enabled ? [context.address] : [] };
      if (enabled && !base.targetNodeId) throw createHttpError(409, 'gate_node_unverified', 'Узел AWG не подтверждён.');
      const fenced = await gateRequest('fence', base);
      if (assertGateSnapshot({ status: 'ok', ...fenced.snapshot }, context.address) !== context.state) {
        throw createHttpError(409, 'gate_changed_during_fence', 'Состояние клиента изменилось во время операции.');
      }
      const clearReceipt = await gateRequest('clear', { ...base,
        expectedAllowedIps: context.state === 'on' ? [context.address] : [], allowedIps: [] });
      const closed = await gateRequest('read', { ...context.identity, requestNonce: crypto.randomUUID() });
      if (closed.publicKeyFingerprint !== fingerprint || assertGateSnapshot(closed, context.address) !== 'off') {
        throw createHttpError(409, 'gate_clear_unverified', 'Закрытие доступа не подтверждено.');
      }
      if (!enabled) return { state: 'off', address: context.address };
      const grantDigest = crypto.createHash('sha256').update(JSON.stringify({ planHash, clearReceipt, closed })).digest('hex');
      await gateRequest('set', { ...base, expectedAllowedIps: [], allowedIps: [context.address], grantDigest });
      const opened = await gateRequest('read', { ...context.identity, requestNonce: crypto.randomUUID() });
      if (opened.publicKeyFingerprint !== fingerprint || assertGateSnapshot(opened, context.address) !== 'on') {
        throw createHttpError(409, 'gate_open_unverified', 'Открытие доступа не подтверждено.');
      }
      return { state: 'on', address: context.address };
    });
  }

  async function listPeers() {
    const payload = await receiver('/awg/peers');
    if (payload.status !== 'ok') throw createHttpError(503, 'awg_unavailable', 'AWG peer inventory is unavailable');
    const managed = clientStore.activeByFingerprint();
    return Promise.all(payload.peers.map(async (peer) => {
      const fingerprint = createFingerprint(peer.publicKey);
      const client = managed.get(fingerprint);
      const saved = clientStore.gateByFingerprint(fingerprint);
      let accessState = 'on';
      if (!Array.isArray(peer.allowedIps) || peer.allowedIps.length === 0) {
        const cached = gateReadCache.get(fingerprint);
        if (cached?.state === 'off' && cached.publicKey === peer.publicKey && Date.now() - cached.checkedAt < 10000) {
          accessState = 'off';
        } else {
          try {
            const checked = await getGateContext(fingerprint, payload);
            accessState = checked.state === 'off' ? 'off' : 'unknown';
          } catch {
            accessState = 'unknown';
          }
        }
      }
      return {
        id: fingerprint,
        publicKeyFingerprint: fingerprint,
        label: client?.label || peer.clientName || `Существующий peer ${saved?.address || peer.allowedIps?.[0] || ''}`.trim(),
        address: client?.address || saved?.address || peer.allowedIps?.[0] || '—',
        latestHandshakeAt: peer.latestHandshakeAt,
        transferRx: peer.transferRx || 0,
        transferTx: peer.transferTx || 0,
        state: peer.state || 'inactive',
        accessState,
        displayStatus: peerDisplayStatus(peer, accessState),
        status: client ? 'active' : 'existing',
        hasConfig: Boolean(client?.encryptedConfig),
        canDelete: Boolean(client?.clientId && !client.clientId.startsWith('awg-existing-')),
        note: noteStore.getNote(fingerprint),
        telegram: noteStore.getTelegram(fingerprint)
      };
    }));
  }

  async function createBackup(passphrase) {
    const encrypted = passphrase !== undefined && passphrase !== null && passphrase !== '';
    if (encrypted) validatePassphrase(passphrase);
    if (backupInProgress || restoreInProgress) throw createHttpError(429, 'backup_busy', 'Резервная копия или восстановление уже выполняется.');
    backupInProgress = true;
    try {
      return await withGateLock(async () => {
      await sampleUsage();
      const before = await readAwgConfig();
      const clientsTableBefore = await readAwgClientsTable();
      if (typeof before !== 'string' || before.length < 100 || before.length > 2 * 1024 * 1024
          || !/^\[Interface\]/m.test(before) || !/^PrivateKey\s*=/m.test(before)) {
        throw createHttpError(503, 'awg_config_unavailable', 'Постоянный конфиг AWG недоступен. Копия не создана.');
      }
      const database = clientStore.snapshot();
      if (database.length < 100 || database.length > 20 * 1024 * 1024) {
        throw createHttpError(503, 'panel_database_unavailable', 'Снимок базы панели недоступен. Копия не создана.');
      }
      const metadata = noteStore.snapshot();
      const users = clientStore.listForBackup().map((client) => {
        const usage = usageStore.summary(client.publicKeyFingerprint);
        return { ...client,
          telegram: metadata.telegrams[client.publicKeyFingerprint] || '',
          note: metadata.notes[client.publicKeyFingerprint] || '',
          usage: usage ? { ...usage,
            received: formatTrafficBytes(usage.receivedBytes),
            sent: formatTrafficBytes(usage.sentBytes) } : null };
      });
      const usageHistory = usageStore.snapshot();
      const after = await readAwgConfig();
      const clientsTableAfter = await readAwgClientsTable();
      if (before !== after || JSON.stringify(clientsTableBefore) !== JSON.stringify(clientsTableAfter)) {
        throw createHttpError(409, 'backup_state_changed', 'Конфигурация AWG изменилась во время снимка. Повторите скачивание.');
      }
      const createdAt = new Date().toISOString();
      const snapshot = { format: 'nait-awg-snapshot', version: 1, createdAt,
        awg: { configFile: 'awg0.conf', config: before, clientsTable: clientsTableBefore },
        panel: { users, database: database.toString('base64'), dataKey: env.NAIT_AWG_DATA_KEY,
          metadata, usageHistory, clientDefaults: { endpointHost, dns, allowedIps, keepalive } } };
      return encrypted ? encryptBackup(snapshot, passphrase, createdAt) : plainBackup(snapshot, createdAt);
      });
    } finally {
      backupInProgress = false;
    }
  }

  async function prepareRestore(envelope, passphrase) {
    let snapshot;
    try {
      snapshot = await decryptBackup(envelope, passphrase);
    } catch (error) {
      if (error.code === 'invalid_backup_passphrase') throw error;
      throw createHttpError(400, 'backup_decryption_failed', envelope?.encryption
        ? 'Не удалось расшифровать копию. Проверьте пароль и целостность файла.'
        : 'Файл резервной копии повреждён или имеет неподдерживаемый формат.');
    }
    if (snapshot?.format !== 'nait-awg-snapshot' || snapshot.version !== 1
        || typeof snapshot.createdAt !== 'string' || !Number.isFinite(new Date(snapshot.createdAt).getTime())) {
      throw createHttpError(400, 'invalid_backup_snapshot', 'Содержимое резервной копии не поддерживается.');
    }
    const config = snapshot.awg?.config;
    if (typeof config !== 'string' || Buffer.byteLength(config, 'utf8') < 100
        || Buffer.byteLength(config, 'utf8') > 2 * 1024 * 1024
        || !/^\[Interface\]/m.test(config) || !/^PrivateKey\s*=/m.test(config)) {
      throw createHttpError(400, 'invalid_backup_awg_config', 'Конфиг AWG в резервной копии повреждён.');
    }
    const listenPort = listenPortFromConfig(config);
    const database = prepareRestoreDatabase(snapshot.panel?.database);
    const configPeers = restoredPeerMap(config);
    for (const client of database.clients.filter((item) => item.status === 'active')) {
      const allowedIps = configPeers.get(client.publicKeyFingerprint);
      if (!allowedIps || (allowedIps.length > 0 && !allowedIps.includes(client.address))) {
        throw createHttpError(400, 'backup_peer_mismatch', 'Клиенты панели не совпадают с peer в конфиге AWG.');
      }
    }
    const clientsTable = buildRestoreClientsTable(config, database, snapshot.awg?.clientsTable);
    const sourcePeers = sourceMigrationPeers(config, database, clientsTable, snapshot.createdAt);
    if (sourcePeers.length > 253) throw createHttpError(400, 'too_many_backup_peers', 'Для переноса доступно не более 253 клиентов.');
    const metadata = snapshot.panel?.metadata;
    const metadataTelegrams = metadata?.telegrams ?? {};
    if (metadata?.version !== 1 || !metadata.notes || typeof metadata.notes !== 'object' || Array.isArray(metadata.notes)
        || !metadataTelegrams || typeof metadataTelegrams !== 'object' || Array.isArray(metadataTelegrams)) {
      throw createHttpError(400, 'invalid_backup_metadata', 'Заметки в резервной копии повреждены.');
    }
    const normalizedMetadata = { version: 1, notes: metadata.notes, telegrams: metadataTelegrams };
    // Validate without touching disk.
    if (Object.entries(normalizedMetadata.notes).some(([id, note]) => !/^[a-f0-9]{12}$/.test(id) || typeof note !== 'string' || note.length > 2000)
        || Object.entries(normalizedMetadata.telegrams).some(([id, telegram]) => !/^[a-f0-9]{12}$/.test(id) || typeof telegram !== 'string' || telegram.length > 80)) {
      throw createHttpError(400, 'invalid_backup_metadata', 'Заметки в резервной копии повреждены.');
    }
    const usageHistory = snapshot.panel?.usageHistory;
    if (!validUsageState(usageHistory)) {
      throw createHttpError(400, 'invalid_backup_usage', 'История трафика в резервной копии повреждена.');
    }
    return { snapshot, config, clientsTable, sourcePeers, database, metadata: normalizedMetadata, usageHistory,
      summary: { createdAt: snapshot.createdAt, encrypted: Boolean(envelope?.encryption),
        clientsCount: sourcePeers.length,
        deletedClientsCount: database.clients.filter((client) => client.status === 'deleted').length,
        peersCount: sourcePeers.length,
        sourceEndpoint: snapshot.panel?.clientDefaults?.endpointHost
          ? `${snapshot.panel.clientDefaults.endpointHost}:${listenPort}`
          : '—' } };
  }

  async function readTargetContext() {
    if (!endpointHost) throw createHttpError(409, 'endpoint_not_configured', 'На целевом сервере не задан PUBLIC_ENDPOINT_HOST.');
    const [config, profile] = await Promise.all([readAwgConfig(), receiver('/awg/profile')]);
    if (profile?.status !== 'ok' || !KEY_PATTERN.test(profile.serverPublicKey || '')
        || !profile.interfaceAddress || !profile.tunnelSubnet) {
      throw createHttpError(409, 'target_awg_unavailable', 'Целевой сервер AWG не готов. Сначала проверьте тестового клиента.');
    }
    if (listenPortFromConfig(config, true) !== profile.listenPort) {
      throw createHttpError(409, 'target_awg_port_mismatch', 'Порт AWG в конфиге и запущенном интерфейсе различается. Сначала восстановите рабочее состояние сервера.');
    }
    const publishedPort = await readPublishedVpnPort(profile.listenPort);
    if (!Number.isInteger(publishedPort) || publishedPort < 1 || publishedPort > 65535) {
      throw createHttpError(409, 'target_awg_port_unpublished', 'VPN-порт AWG не опубликован Docker. Сначала восстановите рабочее состояние сервера.');
    }
    return { config, profile, publishedPort };
  }

  async function inspectBackup(envelope, passphrase) {
    const prepared = await prepareRestore(envelope, passphrase);
    const target = await readTargetContext();
    return { ...prepared.summary, targetEndpoint: `${endpointHost}:${target.publishedPort}`,
      obfuscationAvailable: interfaceConfig(prepared.config).split(/\r?\n/).some(obfuscationLine) };
  }

  async function restoreBackup(envelope, passphrase, options = {}) {
    if (restoreInProgress || backupInProgress) throw createHttpError(429, 'restore_busy', 'Восстановление или резервное копирование уже выполняется.');
    restoreInProgress = true;
    try {
      return await withGateLock(async () => {
        const prepared = await prepareRestore(envelope, passphrase);
        const target = await readTargetContext();
        const restoreObfuscation = options.restoreObfuscation === true;
        const previous = {
          config: target.config,
          database: clientStore.snapshotState(),
          metadata: noteStore.snapshot(),
          usageHistory: usageStore.snapshot(),
          rawClientsTable: await readAwgClientsTable()
        };
        previous.clientsTable = buildRestoreClientsTable(previous.config, previous.database, previous.rawClientsTable);
        const interfaceText = targetInterfaceConfig(target.config, prepared.config, restoreObfuscation);
        const staged = [];
        const reserved = [];
        const usedKeys = new Set();
        for (const sourcePeer of prepared.sourcePeers) {
          const material = await newKeyMaterial();
          if (![material?.privateKey, material?.publicKey, material?.presharedKey].every((key) => KEY_PATTERN.test(key || ''))
              || usedKeys.has(material.publicKey)) {
            throw createHttpError(500, 'invalid_generated_key', 'Генератор ключей вернул некорректный или повторный ключ.');
          }
          usedKeys.add(material.publicKey);
          const address = allocateAddress(target.profile.tunnelSubnet, target.profile.interfaceAddress, reserved);
          reserved.push({ allowedIps: [address] });
          let receiverLabel;
          try { receiverLabel = safeClientLabel(sourcePeer.label); }
          catch { receiverLabel = `Client-${staged.length + 1}`; }
          staged.push({ ...sourcePeer, ...material, address, clientId: `awg-${crypto.randomUUID()}`,
            fingerprint: createFingerprint(material.publicKey), receiverLabel });
        }
        const newConfig = `${interfaceText.trimEnd()}\n\n${staged.map((peer) => [
          '[Peer]', `PublicKey = ${peer.publicKey}`, `PresharedKey = ${peer.presharedKey}`,
          ...(peer.enabled ? [`AllowedIPs = ${peer.address}`] : []), ''
        ].join('\n')).join('\n')}`;
        const newClientsTable = staged.map((peer) => ({ clientId: peer.publicKey,
          userData: { clientName: peer.label, creationDate: peer.createdAt } }));
        const restoreConfig = async (config, clientsTable) => receiver('/awg/restore', {
          method: 'POST', timeoutMs: 180000,
          headers: { 'content-type': 'application/json', 'x-request-id': crypto.randomUUID() },
          body: JSON.stringify({ config, clientsTable })
        });
        await restoreConfig(newConfig, newClientsTable);
        try {
          const profile = await receiver('/awg/profile');
          if (profile?.status !== 'ok' || profile.serverPublicKey !== target.profile.serverPublicKey
              || profile.listenPort !== target.profile.listenPort || profile.interfaceAddress !== target.profile.interfaceAddress) {
            throw createHttpError(409, 'restore_profile_mismatch', 'После переноса профиль AWG изменился неожиданным образом. Выполняется откат.');
          }
          const clientProfile = { ...profile, listenPort: target.publishedPort };
          const state = { clients: [], gates: [] };
          const metadata = { version: 1, notes: {}, telegrams: {} };
          for (const peer of staged) {
            const clientConfig = buildConfig({ privateKey: peer.privateKey, address: peer.address, profile: clientProfile,
              presharedKey: peer.presharedKey, endpointHost, dns, allowedIps, keepalive });
            state.clients.push({ clientId: peer.clientId, label: peer.label, receiverLabel: peer.receiverLabel,
              publicKeyFingerprint: peer.fingerprint, address: peer.address, encryptedConfig: encrypt(clientConfig, dataKey),
              status: 'active', createdAt: peer.createdAt, deletedAt: null });
            state.gates.push({ publicKeyFingerprint: peer.fingerprint, publicKey: peer.publicKey,
              deviceId: peer.clientId, address: peer.address, createdAt: peer.createdAt });
            if (prepared.metadata.notes[peer.oldFingerprint]) metadata.notes[peer.fingerprint] = prepared.metadata.notes[peer.oldFingerprint];
            if (prepared.metadata.telegrams[peer.oldFingerprint]) metadata.telegrams[peer.fingerprint] = prepared.metadata.telegrams[peer.oldFingerprint];
          }
          clientStore.replace(state);
          noteStore.replace(metadata);
          usageStore.replace(remapTraffic(prepared.usageHistory, staged.map((peer) => ({
            oldFingerprint: peer.oldFingerprint, fingerprint: peer.fingerprint, publicKey: peer.publicKey
          }))));
          gateReadCache.clear();
        } catch (error) {
          let rollbackFailed = false;
          try { clientStore.replace(previous.database); } catch { rollbackFailed = true; }
          try { noteStore.replace(previous.metadata); } catch { rollbackFailed = true; }
          try { usageStore.replace(previous.usageHistory); } catch { rollbackFailed = true; }
          try { await restoreConfig(previous.config, previous.clientsTable); } catch { rollbackFailed = true; }
          if (rollbackFailed) {
            throw createHttpError(500, 'restore_rollback_failed', 'Восстановление не завершено, автоматический откат требует ручной проверки.');
          }
          throw createHttpError(500, 'restore_panel_failed', 'Данные панели не восстановлены. Предыдущее состояние возвращено.');
        }
        return { status: 'ok', restoredAt: new Date().toISOString(), ...prepared.summary,
          targetEndpoint: `${endpointHost}:${target.publishedPort}`, restoredObfuscation: restoreObfuscation };
      });
    } finally {
      restoreInProgress = false;
    }
  }

  async function createPeer(input) {
    return withGateLock(() => createPeerUnlocked(input));
  }

  async function createPeerUnlocked(input) {
    const label = String(input?.label || '').trim();
    const receiverLabel = safeClientLabel(label);
    if (!endpointHost) throw createHttpError(500, 'endpoint_not_configured', 'PUBLIC_ENDPOINT_HOST is required');
    if (!Number.isInteger(keepalive) || keepalive < 0 || keepalive > 65535) throw createHttpError(500, 'invalid_keepalive', 'CLIENT_PERSISTENT_KEEPALIVE is invalid');
    const [profile, current] = await Promise.all([receiver('/awg/profile'), receiver('/awg/peers')]);
    if (profile.status !== 'ok' || current.status !== 'ok') throw createHttpError(503, 'awg_unavailable', 'AWG node is unavailable');
    const reserved = clientStore.reservedAddresses().map((entry) => ({ allowedIps: [entry.address] }));
    const address = allocateAddress(profile.tunnelSubnet, profile.interfaceAddress, [...current.peers, ...reserved]);
    const material = await generateKeyMaterial(containerName);
    const clientId = `awg-${crypto.randomUUID()}`;
    const config = buildConfig({ privateKey: material.privateKey, address, profile, presharedKey: material.presharedKey, endpointHost, dns, allowedIps, keepalive });
    const idempotencyKey = crypto.randomUUID();
    await receiver('/awg/peers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-request-id': crypto.randomUUID() },
      body: JSON.stringify({ clientId, clientLabel: receiverLabel, publicKey: material.publicKey, presharedKey: material.presharedKey, allowedIp: address, persistentKeepalive: 0 })
    });
    const fingerprint = createFingerprint(material.publicKey);
    clientStore.insert({ clientId, label, receiverLabel, publicKeyFingerprint: fingerprint, address,
      encryptedConfig: encrypt(config, dataKey), createdAt: new Date().toISOString() });
    return { id: fingerprint, publicKeyFingerprint: fingerprint, label, address, state: 'inactive', status: 'active', hasConfig: true, canDelete: true };
  }

  async function getConfig(fingerprint) {
    const client = clientStore.findActive(fingerprint);
    if (!client?.encryptedConfig) throw createHttpError(404, 'config_unavailable', 'Configuration was not created by Nait-AWG or has been removed');
    return { client, config: decrypt(client.encryptedConfig, dataKey) };
  }

  async function importClientConfig(fingerprint, input) {
    return withGateLock(async () => {
      if (!/^[a-f0-9]{12}$/.test(fingerprint)) throw createHttpError(400, 'invalid_peer_id', 'Некорректный идентификатор клиента.');
      if (clientStore.findActive(fingerprint)) throw createHttpError(409, 'client_config_exists', 'Конфиг этого клиента уже сохранён в панели.');
      const parsed = parseClientConfig(input?.config, CLIENT_PARAMETER_ORDER);
      const [inventory, profile, configBefore] = await Promise.all([receiver('/awg/peers'), receiver('/awg/profile'), readAwgConfig()]);
      if (inventory?.status !== 'ok' || !Array.isArray(inventory.peers) || profile?.status !== 'ok' || typeof configBefore !== 'string') {
        throw createHttpError(503, 'awg_unavailable', 'Не удалось проверить конфиг на текущем сервере.');
      }
      const matches = inventory.peers.filter(peer => createFingerprint(peer.publicKey) === fingerprint);
      if (matches.length !== 1 || matches[0].publicKey !== parsed.publicKey) {
        throw createHttpError(400, 'client_key_mismatch', 'Этот конфиг принадлежит другому клиенту. Выберите исходный конфиг выбранного пользователя.');
      }
      const context = await getGateContext(fingerprint, inventory);
      if (parsed.client.Address !== context.address) throw createHttpError(400, 'client_address_mismatch', 'Адрес в конфиге не совпадает с адресом выбранного клиента.');
      if (parsed.server.PublicKey !== profile.serverPublicKey) throw createHttpError(400, 'client_server_mismatch', 'Этот конфиг принадлежит другому серверу.');
      const port = await readPublishedVpnPort(profile.listenPort);
      if (!port || parsed.server.Endpoint !== `${endpointHost}:${port}`) {
        throw createHttpError(400, 'client_endpoint_mismatch', 'IP или VPN-порт в конфиге не совпадает с текущим сервером.');
      }
      const blocks = configBefore.split(/^\s*\[Peer\]\s*$/gmi).slice(1);
      const targets = blocks.filter(block => /^\s*PublicKey\s*=\s*(\S+)\s*$/mi.exec(block)?.[1] === parsed.publicKey);
      if (targets.length !== 1) throw createHttpError(409, 'peer_identity_unverified', 'Клиент не найден однозначно в серверном конфиге.');
      const psk = /^\s*PresharedKey\s*=\s*(\S+)\s*$/mi.exec(targets[0])?.[1] || '';
      if ((parsed.server.PresharedKey || '') !== psk) throw createHttpError(400, 'client_psk_mismatch', 'Ключ подключения в конфиге не совпадает с серверным.');
      // Amnezia permits separate client junk settings and special junk packets.
      // Compare only shared handshake fields, not Jc/Jmin/Jmax or I1-I5.
      for (const name of ['S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'HeaderProtectionKey']) {
        const expected = profile.clientInterfaceParameters?.[name];
        if (expected !== undefined && String(expected) !== parsed.client[name]) {
          throw createHttpError(400, 'client_obfuscation_mismatch', 'Параметры маскировки в конфиге отличаются от текущего сервера.');
        }
      }
      if (configBefore !== await readAwgConfig()) throw createHttpError(409, 'client_import_state_changed', 'Конфиг сервера изменился во время проверки. Повторите загрузку.');
      const label = matches[0].clientName || `Клиент ${context.address}`;
      let receiverLabel;
      try { receiverLabel = safeClientLabel(label); } catch { receiverLabel = `Client-${fingerprint}`; }
      // Keep the existing gate device identity when attaching configuration.
      clientStore.insert({ clientId: context.deviceId, label, receiverLabel,
        publicKeyFingerprint: fingerprint, address: context.address,
        encryptedConfig: encrypt(parsed.config, dataKey), createdAt: new Date().toISOString() });
      return { status: 'ok', id: fingerprint, hasConfig: true };
    });
  }

  async function getQr(fingerprint) {
    const { config } = await getConfig(fingerprint);
    return QRCode.toString(config, { type: 'svg', width: 512, margin: 1, errorCorrectionLevel: 'M' });
  }

  async function deletePeer(fingerprint) {
    return withGateLock(() => deletePeerUnlocked(fingerprint));
  }

  async function deletePeerUnlocked(fingerprint) {
    const client = clientStore.findActive(fingerprint);
    if (!client || client.clientId.startsWith('awg-existing-')) throw createHttpError(404, 'peer_not_managed', 'Nait-AWG can delete only peers it created');
    await receiver(`/awg/peers/${encodeURIComponent(fingerprint)}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-request-id': crypto.randomUUID() },
      body: JSON.stringify({ clientId: client.clientId, allowedIp: client.address })
    });
    clientStore.markDeleted(fingerprint);
  }

  async function updatePeerMetadata(fingerprint, input) {
    if (!/^[a-f0-9]{12}$/.test(fingerprint)) throw createHttpError(400, 'invalid_peer_id', 'Некорректный идентификатор клиента.');
    if (typeof input?.note !== 'string' || input.note.length > 2000) throw createHttpError(400, 'invalid_note', 'Заметка должна содержать не более 2000 символов.');
    if (typeof input?.telegram !== 'string' || input.telegram.length > 80) throw createHttpError(400, 'invalid_telegram', 'Telegram должен содержать не более 80 символов.');
    const peers = await listPeers();
    if (!peers.some((peer) => peer.id === fingerprint)) throw createHttpError(404, 'peer_not_found', 'Клиент не найден.');
    const note = input.note.trim();
    const telegram = input.telegram.trim();
    noteStore.set(fingerprint, note, telegram);
    return { id: fingerprint, note, telegram };
  }

  async function updatePeerNote(fingerprint, value) {
    return updatePeerMetadata(fingerprint, { note: value, telegram: noteStore.getTelegram(fingerprint) });
  }

  return { listPeers, createPeer, getConfig, getQr, importClientConfig, deletePeer, updatePeerMetadata, updatePeerNote,
    readPeerAccess, setPeerAccess, createBackup, inspectBackup, restoreBackup,
    getUsage, sampleUsage, startUsageTracking, receiver };
}

module.exports = { createHttpError, createAwgService, safeClientLabel };
