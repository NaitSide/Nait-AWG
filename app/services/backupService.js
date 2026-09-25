'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const FORMAT = 'nait-awg-backup';
const VERSION = 1;
const KDF = 'scrypt-n32768-r8-p1';
const CIPHER = 'aes-256-gcm';
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function validatePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 256) {
    const error = new Error('Пароль резервной копии должен содержать от 12 до 256 символов.');
    error.status = 400;
    error.code = 'invalid_backup_passphrase';
    throw error;
  }
}

function aad(header) {
  return Buffer.from(JSON.stringify(header), 'utf8');
}

function plainBackup(snapshot, createdAt = new Date().toISOString()) {
  return { format: FORMAT, version: VERSION, createdAt, encryption: null, payload: snapshot };
}

async function encryptBackup(snapshot, passphrase, createdAt = new Date().toISOString()) {
  validatePassphrase(passphrase);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header = { format: FORMAT, version: VERSION, createdAt,
    encryption: { algorithm: CIPHER, kdf: KDF, salt: salt.toString('base64'), iv: iv.toString('base64') } };
  const key = await scrypt(passphrase, salt, 32, SCRYPT_OPTIONS);
  const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8');
  try {
    const cipher = crypto.createCipheriv(CIPHER, key, iv);
    cipher.setAAD(aad(header));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ...header, encryption: { ...header.encryption, tag: cipher.getAuthTag().toString('base64') },
      payload: ciphertext.toString('base64') };
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

async function decryptBackup(envelope, passphrase) {
  const { format, version, createdAt, encryption, payload } = envelope || {};
  if (format !== FORMAT || version !== VERSION || typeof createdAt !== 'string') {
    throw new Error('Неподдерживаемый формат резервной копии.');
  }
  if (encryption === null && payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
  validatePassphrase(passphrase);
  if (encryption?.algorithm !== CIPHER || encryption.kdf !== KDF || typeof payload !== 'string') {
    throw new Error('Неподдерживаемый формат резервной копии.');
  }
  const salt = Buffer.from(encryption.salt || '', 'base64');
  const iv = Buffer.from(encryption.iv || '', 'base64');
  const tag = Buffer.from(encryption.tag || '', 'base64');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error('Некорректный заголовок резервной копии.');
  const header = { format, version, createdAt,
    encryption: { algorithm: CIPHER, kdf: KDF, salt: encryption.salt, iv: encryption.iv } };
  const key = await scrypt(passphrase, salt, 32, SCRYPT_OPTIONS);
  try {
    const decipher = crypto.createDecipheriv(CIPHER, key, iv);
    decipher.setAAD(aad(header));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8'));
  } finally {
    key.fill(0);
  }
}

module.exports = { encryptBackup, decryptBackup, plainBackup, validatePassphrase };
