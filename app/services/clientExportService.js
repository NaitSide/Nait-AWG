'use strict';
const { deflateSync } = require('node:zlib');
const { parseClientConfig } = require('./clientConfigService');
const { protocolVersion } = require('./clientProfileService');

// Guest AmneziaVPN export: Qt qCompress = big-endian uncompressed length + zlib.
// Uses only the saved client profile, never server SSH credentials or other clients.
function createAmneziaGuest(config, label, parameterNames, options = {}) {
  const { client, server, publicKey } = parseClientConfig(config, parameterNames, { nativeOnly: true });
  const endpoint = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(server.Endpoint);
  if (!endpoint || Number(endpoint[2]) < 1 || Number(endpoint[2]) > 65535) {
    throw Object.assign(new Error('Некорректный Endpoint в сохранённом конфиге.'), { status: 400, code: 'invalid_client_endpoint' });
  }
  const host = endpoint[1].replace(/^\[|\]$/g, '');
  const port = Number(endpoint[2]);
  const params = Object.fromEntries(parameterNames.filter(name => client[name] !== undefined && (options.legacy || client[name] !== '')).map(name => [name, client[name]]));
  const dnsValues = (client.DNS || '').split(',').map(value => value.trim());
  const dns = options.legacy ? dnsValues : dnsValues.filter(Boolean);
  const nativeConfig = options.legacy || !client.DNS || dns.length > 2 ? config
    : config.replace(/^\s*DNS\s*=.*$/m, `DNS = $PRIMARY_DNS${dns.length > 1 ? ', $SECONDARY_DNS' : ''}`);
  const mtu = client.MTU || options.mtu;
  const clientConfig = { ...params, config: nativeConfig, hostName: host, port,
    client_ip: client.Address.split('/')[0], client_priv_key: client.PrivateKey,
    client_pub_key: publicKey, clientId: publicKey, server_pub_key: server.PublicKey,
    allowed_ips: server.AllowedIPs.split(',').map(ip => ip.trim()),
    ...(server.PresharedKey ? { psk_key: server.PresharedKey } : {}),
    ...(mtu ? { mtu: String(mtu) } : {}),
    ...(server.PersistentKeepalive ? { persistent_keep_alive: server.PersistentKeepalive } : {}) };
  const protocol = options.legacy ? (client.HeaderProtectionKey ? '3.1' : client.S3 || client.S4 ? '2' : '1') : protocolVersion(client);
  const container = options.container || 'amnezia-awg2';
  const serverParameters = options.serverParameters || client;
  const outerParams = options.legacy ? params : Object.fromEntries(parameterNames
    .filter(name => serverParameters[name] !== undefined && String(serverParameters[name]) !== '')
    .map(name => [name,String(serverParameters[name])]));
  const guest = { format_version: 1, description: label, hostName: host,
    ...(dns[0] || options.legacy ? {dns1: dns[0] || ''} : {}),
    ...(dns[1] || options.legacy ? {dns2: dns[1] || ''} : {}), defaultContainer: container,
    containers: [{ container, awg: { ...outerParams,
      ...(!options.legacy ? Object.fromEntries(['I1','I2','I3','I4','I5'].map(name => [name, String(serverParameters[name] || '')])) : {}),
      ...(options.subnetAddress ? {subnet_address: options.subnetAddress} : {}),
      port: String(port), transport_proto: 'udp', ...(protocol ? {protocol_version: protocol} : {}),
      last_config: JSON.stringify(clientConfig) } }] };
  return guest;
}

function encodeAmneziaGuest(guest, label = guest.description) {
  guest = {...guest, description: label};
  const plain = Buffer.from(JSON.stringify(guest), 'utf8');
  const header = Buffer.alloc(4); header.writeUInt32BE(plain.length);
  return 'vpn://' + Buffer.concat([header, deflateSync(plain, { level: 8 })]).toString('base64url');
}
function buildAmneziaVpn(config, label, parameterNames, options = {}) {
  return encodeAmneziaGuest(createAmneziaGuest(config, label, parameterNames, options));
}
module.exports = { buildAmneziaVpn, createAmneziaGuest, encodeAmneziaGuest };
