'use strict';

// Fresh-node defaults reuse the validated panel editor, not a second set of rules.
const fs = require('node:fs');
const path = require('node:path');
const { generate, rewrite } = require('../vendor/receiver/src/services/obfuscationRules');
const { parseAwgClientInterfaceParameters } = require('../vendor/receiver/src/services/awgService');

function key(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(text)
    || Buffer.from(text, 'base64').toString('base64') !== text
    || Buffer.from(text, 'base64').every(byte => byte === 0)) throw new Error('Invalid generated AWG key.');
  return text;
}
function render(privateKey, headerKey, port) {
  key(privateKey); key(headerKey);
  if (!/^\d{1,5}$/.test(String(port)) || Number(port) < 1024 || Number(port) > 65535) throw new Error('Invalid AWG UDP port.');
  const values = generate({
    ContentPaddingAddition: '10-100', RekeyAfterTime: '100-120', RekeyTimeout: '3-7',
    RejectAfterTime: '150-180', KeepaliveTimeout: '5-15', MaxHandshakeAttempts: '15-20',
    RandomTrailers: 'on', DisableCookies: 'on',
    I1: '<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>'
  });
  values.HeaderProtectionKey = headerKey;
  const config = rewrite(`[Interface]\nPrivateKey = ${privateKey}\nAddress = 10.8.1.0/24\nListenPort = ${Number(port)}\nJc = 0\nJmin = 0\nJmax = 0\n`, values);
  // Fail before persisting a profile that the Receiver cannot export.
  parseAwgClientInterfaceParameters(config);
  return config;
}
function assertRoutes(routes) {
  if (!Array.isArray(routes)) throw new Error('Cannot inspect host routes.');
  const target = (10 * 2 ** 24 + 8 * 2 ** 16 + 1 * 2 ** 8) >>> 0;
  for (const route of routes) {
    if (!route.dst || route.dst === 'default') continue;
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/.exec(route.dst);
    if (!match) throw new Error('Cannot inspect an IPv4 route.');
    const octets = match[1].split('.').map(Number), prefix = Number(match[2] ?? 32);
    if (octets.some(n => n > 255) || prefix > 32) throw new Error('Invalid IPv4 route.');
    if (prefix === 0) continue;
    const mask = (0xffffffff << (32 - Math.min(prefix, 24))) >>> 0;
    const ip = octets.reduce((sum, n) => (sum * 256 + n) >>> 0, 0);
    if ((ip & mask) === (target & mask)) throw new Error('VPN subnet 10.8.1.0/24 overlaps a host route.');
  }
}
function writeState(directory, privateKey, publicKey, headerKey, port) {
  key(publicKey);
  const config = render(privateKey, headerKey, port);
  fs.mkdirSync(directory, { mode: 0o700 }); // exclusive: never replace existing node state
  for (const [name, text] of Object.entries({
    'awg0.conf': config, 'wireguard_server_private_key.key': privateKey + '\n',
    'wireguard_server_public_key.key': publicKey + '\n', clientsTable: '[]\n'
  })) fs.writeFileSync(path.join(directory, name), text, { mode: 0o600, flag: 'wx' });
}
if (require.main === module) {
  try {
    const input = fs.readFileSync(0, 'utf8');
    if (process.argv[2] === 'routes') assertRoutes(JSON.parse(input));
    else if (process.argv[2] === 'write') {
      const [privateKey, publicKey, headerKey] = input.trim().split('\n');
      writeState(process.argv[3], privateKey, publicKey, headerKey, process.argv[4]);
    } else throw new Error('Unknown fresh-node operation.');
  } catch { console.error('Fresh AWG configuration check failed; no secret values are printed.'); process.exitCode = 1; }
}
module.exports = { render, writeState, assertRoutes };
