'use strict';

const crypto = require('node:crypto');
const { inflateSync } = require('node:zlib');

const MAX_CONFIG_BYTES = 64 * 1024;
const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

function invalid(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

function extractNativeConfig(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_CONFIG_BYTES) {
    throw invalid('invalid_client_config', 'Выберите конфиг одного клиента размером до 64 КБ.');
  }
  const text = input.replace(/^\uFEFF/, '').trim();
  if (!text.startsWith('vpn://')) return text;
  try {
    const encoded = text.slice(6);
    if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(encoded)) throw new Error();
    const compressed = Buffer.from(encoded, 'base64url');
    if (compressed.length < 5 || compressed.readUInt32BE(0) > 256 * 1024) throw new Error();
    const decoded = inflateSync(compressed.subarray(4), { maxOutputLength: 256 * 1024 });
    if (decoded.length !== compressed.readUInt32BE(0)) throw new Error();
    const guest = JSON.parse(decoded.toString('utf8'));
    // Accept a single guest connection, never an app backup or SSH credentials.
    if (guest.userName || guest.password || !Array.isArray(guest.containers) || guest.containers.length !== 1) throw new Error();
    const awg = guest.containers[0].awg;
    const config = typeof awg?.last_config === 'string' ? JSON.parse(awg.last_config) : awg?.last_config;
    if (typeof config?.config !== 'string' || Buffer.byteLength(config.config) > MAX_CONFIG_BYTES) throw new Error();
    return config.config.replace(/\$PRIMARY_DNS/g, guest.dns1 || '1.1.1.1')
      .replace(/\$SECONDARY_DNS/g, guest.dns2 || '1.0.0.1');
  } catch {
    throw invalid('invalid_client_export', 'Нужен гостевой конфиг AmneziaWG для одного клиента: .conf или .vpn.');
  }
}

function parseClientConfig(input, parameterNames, { nativeOnly = false } = {}) {
  if (nativeOnly && typeof input === 'string' && input.replace(/^\uFEFF/, '').trim().startsWith('vpn://')) {
    throw invalid('native_config_required', 'Выберите исходный .conf для приложения AmneziaWG. Формат AmneziaVPN пока не поддерживается.');
  }
  const text = extractNativeConfig(input);
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw invalid('invalid_client_config', 'Файл не является клиентским конфигом AmneziaWG.');
  }
  const sections = { Interface: Object.create(null), Peer: Object.create(null) };
  const allowed = {
    Interface: new Set(['PrivateKey', 'Address', 'DNS', 'MTU', ...parameterNames]),
    Peer: new Set(['PublicKey', 'PresharedKey', 'Endpoint', 'AllowedIPs', 'PersistentKeepalive'])
  };
  const seen = new Set();
  let section;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    const header = /^\[(Interface|Peer)\]$/.exec(line);
    if (header) {
      if (seen.has(header[1]) || (header[1] === 'Peer' && !seen.has('Interface'))) {
        throw invalid('invalid_client_config', 'Нужен конфиг с одним подключением AmneziaWG.');
      }
      section = header[1];
      seen.add(section);
      continue;
    }
    const field = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(line);
    if (!section || !field || !allowed[section].has(field[1]) || Object.hasOwn(sections[section], field[1])) {
      throw invalid('invalid_client_config', 'Конфиг содержит неподдерживаемые или повторяющиеся параметры.');
    }
    sections[section][field[1]] = field[2].trim();
  }
  const client = sections.Interface;
  const server = sections.Peer;
  if (seen.size !== 2 || !KEY_PATTERN.test(client.PrivateKey || '') || !KEY_PATTERN.test(server.PublicKey || '')
      || !client.Address || !server.Endpoint || !server.AllowedIPs
      || (server.PresharedKey && !KEY_PATTERN.test(server.PresharedKey))) {
    throw invalid('invalid_client_config', 'В конфиге не хватает ключей, адреса или параметров подключения.');
  }
  // X25519 public key derivation is local; no shell commands receive PrivateKey.
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(client.PrivateKey, 'base64')]),
    format: 'der', type: 'pkcs8'
  });
  const publicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const config = ['Interface', 'Peer'].map(name => `[${name}]\n${Object.entries(sections[name])
    .map(([key, value]) => `${key} = ${value}`).join('\n')}`).join('\n\n') + '\n';
  return { client, server, publicKey, config };
}

module.exports = { parseClientConfig, MAX_CONFIG_BYTES };
