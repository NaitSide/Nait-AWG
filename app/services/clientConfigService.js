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
  if (!text.startsWith('vpn://')) return {text};
  try {
    const encoded = text.slice(6);
    if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(encoded)) throw new Error();
    const compressed = Buffer.from(encoded, 'base64url');
    if (compressed.length < 5 || compressed.readUInt32BE(0) > 256 * 1024) throw new Error();
    const decoded = inflateSync(compressed.subarray(4), { maxOutputLength: 256 * 1024 });
    if (decoded.length !== compressed.readUInt32BE(0)) throw new Error();
    const guest = JSON.parse(decoded.toString('utf8'));
    // Accept a single guest connection, never an app backup or SSH credentials.
    if (!guest || typeof guest!=='object' || Array.isArray(guest) || guest.userName || guest.password
      || Object.hasOwn(guest,'servers') || (guest.format_version!==undefined && guest.format_version!==1)
      || !Array.isArray(guest.containers) || guest.containers.length !== 1) throw new Error();
    if (!['amnezia-awg','amnezia-awg2'].includes(guest.containers[0]?.container)) throw new Error();
    const awg = guest.containers[0].awg;
    const config = typeof awg?.last_config === 'string' ? JSON.parse(awg.last_config) : awg?.last_config;
    if (typeof config?.config !== 'string' || Buffer.byteLength(config.config) > MAX_CONFIG_BYTES) throw new Error();
    if ([guest.dns1,guest.dns2].some(value => value !== undefined && (typeof value !== 'string' || /[\r\n\0$]/.test(value)))) throw new Error();
    return {guest, text: config.config.replace(/\$PRIMARY_DNS/g, guest.dns1 || '1.1.1.1')
      .replace(/\$SECONDARY_DNS/g, guest.dns2 || '1.0.0.1')};
  } catch {
    throw invalid('invalid_client_export', 'Нужен гостевой конфиг AmneziaWG для одного клиента: .conf или .vpn.');
  }
}

function validateGuest(guest, parsed, parameterNames) {
  const fail = () => { throw invalid('inconsistent_client_export', 'Метаданные .vpn не согласованы с конфигом или содержат неподдерживаемые поля.'); };
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const fields = (value, names) => {
    if (!object(value) || Object.keys(value).some(name => !names.includes(name))) fail();
  };
  fields(guest, ['format_version','description','hostName','dns1','dns2','defaultContainer','containers']);
  const container = guest.containers[0];
  fields(container, ['container','awg']);
  const awg = container.awg;
  fields(awg, [...parameterNames,'last_config','port','transport_proto','protocol_version','subnet_address','subnet_cidr','isThirdPartyConfig']);
  const last = typeof awg.last_config === 'string' ? JSON.parse(awg.last_config) : awg.last_config;
  fields(last, [...parameterNames,'config','hostName','port','client_ip','client_priv_key','client_pub_key','clientId',
    'server_pub_key','allowed_ips','psk_key','mtu','persistent_keep_alive']);
  const {client, server, publicKey} = parsed;
  const endpoint = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(server.Endpoint);
  if (!endpoint) fail();
  const host = endpoint[1].replace(/^\[|\]$/g, '');
  const compare = (data, key, expected) => { if (data[key] !== undefined && data[key] !== expected) fail(); };
  compare(guest, 'defaultContainer', container.container);
  compare(guest, 'hostName', host);
  compare(last, 'hostName', host);
  compare(last, 'port', Number(endpoint[2]));
  compare(awg, 'port', endpoint[2]);
  compare(awg, 'transport_proto', 'udp');
  compare(last, 'client_priv_key', client.PrivateKey);
  compare(last, 'client_pub_key', publicKey);
  compare(last, 'clientId', publicKey);
  compare(last, 'server_pub_key', server.PublicKey);
  compare(last, 'psk_key', server.PresharedKey);
  compare(last, 'persistent_keep_alive', server.PersistentKeepalive);
  if (last.client_ip !== undefined && (typeof last.client_ip !== 'string'
      || last.client_ip.replace(/\/32$/, '') !== client.Address.replace(/\/32$/, ''))) fail();
  if (last.allowed_ips !== undefined && (!Array.isArray(last.allowed_ips)
      || JSON.stringify([...last.allowed_ips].sort()) !== JSON.stringify(server.AllowedIPs.split(',').map(ip => ip.trim()).sort()))) fail();
  if (last.mtu !== undefined && (typeof last.mtu !== 'string' || !/^\d+$/.test(last.mtu)
      || Number(last.mtu) < 576 || Number(last.mtu) > 65535 || (client.MTU && last.mtu !== client.MTU))) fail();
  for (const name of parameterNames) {
    // Outer junk settings can intentionally differ from client settings in Amnezia.
    if (last[name] !== undefined && last[name] !== (client[name] ?? '')) fail();
    if (awg[name] !== undefined && typeof awg[name] !== 'string') fail();
  }
  for (const name of ['description','hostName','dns1','dns2']) {
    if (guest[name] !== undefined && typeof guest[name] !== 'string') fail();
  }
  for (const name of ['protocol_version','subnet_address','subnet_cidr']) {
    if (awg[name] !== undefined && typeof awg[name] !== 'string') fail();
  }
  if (awg.isThirdPartyConfig !== undefined && typeof awg.isThirdPartyConfig !== 'boolean') fail();
  return guest;
}

function parseClientConfig(input, parameterNames, { nativeOnly = false } = {}) {
  if (nativeOnly && typeof input === 'string' && input.replace(/^\uFEFF/, '').trim().startsWith('vpn://')) {
    throw invalid('native_config_required', 'Для этой операции нужен исходный .conf AmneziaWG.');
  }
  const {text, guest} = extractNativeConfig(input);
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
  const parsed = { client, server, publicKey, config };
  if (guest) parsed.guest = validateGuest(guest, parsed, parameterNames);
  return parsed;
}

module.exports = { parseClientConfig, MAX_CONFIG_BYTES };
