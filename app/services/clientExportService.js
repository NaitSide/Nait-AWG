'use strict';
const { deflateSync } = require('node:zlib');
const { parseClientConfig } = require('./clientConfigService');

// Guest AmneziaVPN export: Qt qCompress = big-endian uncompressed length + zlib.
// Uses only the saved client profile, never server SSH credentials or other clients.
function buildAmneziaVpn(config, label, parameterNames) {
  const { client, server, publicKey } = parseClientConfig(config, parameterNames, { nativeOnly: true });
  const endpoint = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(server.Endpoint);
  if (!endpoint || Number(endpoint[2]) < 1 || Number(endpoint[2]) > 65535) {
    throw Object.assign(new Error('Некорректный Endpoint в сохранённом конфиге.'), { status: 400, code: 'invalid_client_endpoint' });
  }
  const host = endpoint[1].replace(/^\[|\]$/g, '');
  const port = Number(endpoint[2]);
  const params = Object.fromEntries(parameterNames.filter(name => client[name] !== undefined).map(name => [name, client[name]]));
  const clientConfig = { ...params, config, hostName: host, port,
    client_ip: client.Address.split('/')[0], client_priv_key: client.PrivateKey,
    client_pub_key: publicKey, clientId: publicKey, server_pub_key: server.PublicKey,
    allowed_ips: server.AllowedIPs.split(',').map(ip => ip.trim()),
    ...(server.PresharedKey ? { psk_key: server.PresharedKey } : {}),
    ...(client.MTU ? { mtu: client.MTU } : {}),
    ...(server.PersistentKeepalive ? { persistent_keep_alive: server.PersistentKeepalive } : {}) };
  const dns = (client.DNS || '').split(',').map(value => value.trim());
  const protocol = client.HeaderProtectionKey ? '3.1' : client.S3 || client.S4 ? '2' : '1';
  const guest = { format_version: 1, description: label, hostName: host,
    dns1: dns[0] || '', dns2: dns[1] || '', defaultContainer: 'amnezia-awg2',
    containers: [{ container: 'amnezia-awg2', awg: { ...params, port: String(port),
      transport_proto: 'udp', protocol_version: protocol, last_config: JSON.stringify(clientConfig) } }] };
  const plain = Buffer.from(JSON.stringify(guest), 'utf8');
  const header = Buffer.alloc(4); header.writeUInt32BE(plain.length);
  return 'vpn://' + Buffer.concat([header, deflateSync(plain, { level: 8 })]).toString('base64url');
}
module.exports = { buildAmneziaVpn };
