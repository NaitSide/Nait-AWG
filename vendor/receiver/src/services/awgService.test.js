'use strict';

const assert = require('assert');
const test = require('node:test');
const {
  buildPersistentPeerSummaries,
  getAwgContainerConfigPath,
  getAwgProtocolVersion,
  getIpv4Network,
  parseAwgClientInterfaceParameters,
  parseAllowedIps,
  parseInterfaceAddressFromIpJson,
  validateWireGuardPublicKey
} = require('./awgService');
const { parseAwgConfig } = require('./awgConfigService');
const { getConfigPeerSummaries } = require('./awgPeerService');

function syntheticKey(byte) {
  return Buffer.alloc(32, byte).toString('base64');
}

function syntheticAwgConfig(overrides = {}) {
  const params = {
    Jc: '4',
    Jmin: '40',
    Jmax: '1280',
    S1: '111',
    S2: '222',
    S3: '333',
    S4: '444',
    H1: '555-556',
    H2: '666',
    H3: '777-778',
    H4: '888',
    HeaderProtectionKey: syntheticKey(6),
    ContentPaddingAddition: '10-100',
    RekeyAfterTime: '100-120',
    RekeyTimeout: '3-7',
    RejectAfterTime: '150-180',
    KeepaliveTimeout: '5-15',
    MaxHandshakeAttempts: '15-20',
    RandomTrailers: 'on',
    DisableCookies: 'on',
    ...overrides
  };

  return `
[Interface]
PrivateKey = ${syntheticKey(9)}
Address = 10.8.1.1/24
ListenPort = 55424
${Object.entries(params).map(([name, value]) => `${name} = ${value}`).join('\n')}
# I1 = <r 2><b 0x0102>
# I2 =
Unknown = 999

[Peer]
PublicKey = ${syntheticKey(8)}
  `;
}

function syntheticSplitJunkAwgConfig() {
  return syntheticAwgConfig({ Jc: '0', Jmin: '0', Jmax: '0' }).replace(
    'Jmax = 0',
    'Jmax = 0\n# ClientJc = 4\n# ClientJmin = 10\n# ClientJmax = 50'
  );
}

test('getAwgContainerConfigPath keeps host and container config paths separate', () => {
  const previous = process.env.AWG_CONTAINER_CONFIG_PATH;
  process.env.AWG_CONTAINER_CONFIG_PATH = '/opt/amnezia/awg/awg0.conf';
  try {
    assert.equal(getAwgContainerConfigPath(), '/opt/amnezia/awg/awg0.conf');
  } finally {
    if (previous === undefined) delete process.env.AWG_CONTAINER_CONFIG_PATH;
    else process.env.AWG_CONTAINER_CONFIG_PATH = previous;
  }
});

test('parseAllowedIps accepts AWG space-separated and config comma-separated lists', () => {
  assert.deepEqual(parseAllowedIps('10.8.1.2/32 fd42:88:1::2/128'), ['10.8.1.2/32', 'fd42:88:1::2/128']);
  assert.deepEqual(parseAllowedIps('10.8.1.2/32, fd42:88:1::2/128'), ['10.8.1.2/32', 'fd42:88:1::2/128']);
  assert.deepEqual(parseAllowedIps('(none)'), []);
});

test('getConfigPeerSummaries reads the persistent config by its container path', async () => {
  const previous = process.env.AWG_CONTAINER_CONFIG_PATH;
  process.env.AWG_CONTAINER_CONFIG_PATH = '/opt/amnezia/awg/awg0.conf';
  try {
    const peers = await getConfigPeerSummaries({
      containerName: 'amnezia-awg',
      configPath: '/opt/naitlab/nait_awg_node/awg/awg0.conf'
    }, async (command, args) => {
      assert.equal(command, 'docker');
      assert.equal(args[0], 'exec');
      assert.equal(args[1], 'amnezia-awg');
      assert.equal(args.at(-1), '/opt/amnezia/awg/awg0.conf');
      return { stdout: `${syntheticKey(8)}\t10.8.1.2/32\n` };
    });

    assert.deepEqual(peers, [{
      publicKey: syntheticKey(8),
      allowedIps: ['10.8.1.2/32']
    }]);
  } finally {
    if (previous === undefined) delete process.env.AWG_CONTAINER_CONFIG_PATH;
    else process.env.AWG_CONTAINER_CONFIG_PATH = previous;
  }
});

test('validateWireGuardPublicKey accepts base64 32-byte keys', () => {
  assert.equal(validateWireGuardPublicKey(syntheticKey(1)), syntheticKey(1));
});

test('validateWireGuardPublicKey rejects malformed keys', () => {
  assert.throws(() => validateWireGuardPublicKey('not-a-key'), /invalid_awg_server_public_key/);
  assert.throws(() => validateWireGuardPublicKey(Buffer.alloc(31, 1).toString('base64')), /invalid_awg_server_public_key/);
});

test('getIpv4Network computes network from address and prefix', () => {
  assert.equal(getIpv4Network('10.8.1.1', 24), '10.8.1.0/24');
  assert.equal(getIpv4Network('10.8.1.129', 25), '10.8.1.128/25');
});

test('parseAwgConfig accepts a freshly installed interface without bootstrap peers', () => {
  const parsed = parseAwgConfig(`
[Interface]
PrivateKey = ${syntheticKey(9)}
Address = 10.8.1.0/24
ListenPort = 33339
HeaderProtectionKey = ${syntheticKey(6)}
`);

  assert.equal(parsed.hasInterface, true);
  assert.deepEqual(parsed.interfaceAddresses, ['10.8.1.0/24']);
  assert.deepEqual(parsed.peers, []);
});

test('parseInterfaceAddressFromIpJson returns one usable AWG IPv4 CIDR and tunnel subnet', () => {
  const payload = JSON.stringify([
    {
      ifname: 'awg0',
      addr_info: [
        { family: 'inet', local: '127.0.0.1', prefixlen: 8 },
        { family: 'inet6', local: 'fd00::1', prefixlen: 64 },
        { family: 'inet', local: '10.8.1.1', prefixlen: 24 }
      ]
    }
  ]);

  assert.deepEqual(parseInterfaceAddressFromIpJson(payload), {
    interfaceAddress: '10.8.1.1/24',
    tunnelSubnet: '10.8.1.0/24'
  });
});

test('parseInterfaceAddressFromIpJson reports controlled errors', () => {
  assert.throws(
    () => parseInterfaceAddressFromIpJson(JSON.stringify([{ addr_info: [{ family: 'inet6', local: 'fd00::1', prefixlen: 64 }] }])),
    /awg_interface_address_not_found/
  );
  assert.throws(
    () => parseInterfaceAddressFromIpJson(JSON.stringify([{ addr_info: [
      { family: 'inet', local: '10.8.1.1', prefixlen: 24 },
      { family: 'inet', local: '10.8.2.1', prefixlen: 24 }
    ] }])),
    /ambiguous_awg_interface_address/
  );
  assert.throws(() => parseInterfaceAddressFromIpJson('{'), /invalid_ip_address_output/);
});

test('parseAwgClientInterfaceParameters extracts only whitelisted AWG client params', () => {
  const params = parseAwgClientInterfaceParameters(syntheticAwgConfig());

  assert.deepEqual(params, {
    Jc: 4,
    Jmin: 40,
    Jmax: 1280,
    S1: 111,
    S2: 222,
    S3: 333,
    S4: 444,
    H1: '555-556',
    H2: '666',
    H3: '777-778',
    H4: '888',
    HeaderProtectionKey: syntheticKey(6),
    ContentPaddingAddition: '10-100',
    RekeyAfterTime: '100-120',
    RekeyTimeout: '3-7',
    RejectAfterTime: '150-180',
    KeepaliveTimeout: '5-15',
    MaxHandshakeAttempts: '15-20',
    RandomTrailers: 'on',
    DisableCookies: 'on',
    I1: '<r 2><b 0x0102>'
  });
  assert.equal(Object.prototype.hasOwnProperty.call(params, 'PrivateKey'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(params, 'ListenPort'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(params, 'Unknown'), false);
});

test('parseAwgClientInterfaceParameters keeps client junk enabled when server junk is disabled', () => {
  const params = parseAwgClientInterfaceParameters(syntheticSplitJunkAwgConfig());

  assert.equal(params.Jc, 4);
  assert.equal(params.Jmin, 10);
  assert.equal(params.Jmax, 50);
});

test('parseAwgClientInterfaceParameters reports controlled errors for missing or invalid params', () => {
  assert.throws(
    () => parseAwgClientInterfaceParameters('[Interface]\nJc = 1\n'),
    /awg_client_parameters_unavailable/
  );
  assert.throws(
    () => parseAwgClientInterfaceParameters(syntheticAwgConfig({ S2: 'bad' })),
    /awg_client_parameters_unavailable/
  );
  assert.throws(
    () => parseAwgClientInterfaceParameters(syntheticAwgConfig({ Jmin: '41', Jmax: '40' })),
    /awg_client_parameters_unavailable/
  );
});

test('parseAwgClientInterfaceParameters validates H single and range values', () => {
  assert.equal(parseAwgClientInterfaceParameters(syntheticAwgConfig()).H1, '555-556');
  assert.equal(parseAwgClientInterfaceParameters(syntheticAwgConfig()).H2, '666');
  assert.throws(
    () => parseAwgClientInterfaceParameters(syntheticAwgConfig({ H1: 'bad-range' })),
    /awg_client_parameters_unavailable/
  );
  assert.throws(
    () => parseAwgClientInterfaceParameters(syntheticAwgConfig({ H1: '556-555' })),
    /awg_client_parameters_unavailable/
  );
  assert.throws(
    () => parseAwgClientInterfaceParameters(syntheticAwgConfig({ H1: '4294967296' })),
    /awg_client_parameters_unavailable/
  );
});

test('parseAwgClientInterfaceParameters extracts complete AWG 3.1 params and commented special junk', () => {
  const params = parseAwgClientInterfaceParameters(syntheticAwgConfig());

  assert.equal(params.HeaderProtectionKey, syntheticKey(6));
  assert.equal(params.ContentPaddingAddition, '10-100');
  assert.equal(params.RekeyAfterTime, '100-120');
  assert.equal(params.RekeyTimeout, '3-7');
  assert.equal(params.RejectAfterTime, '150-180');
  assert.equal(params.KeepaliveTimeout, '5-15');
  assert.equal(params.MaxHandshakeAttempts, '15-20');
  assert.equal(params.RandomTrailers, 'on');
  assert.equal(params.DisableCookies, 'on');
  assert.equal(params.I1, '<r 2><b 0x0102>');
  assert.equal(Object.prototype.hasOwnProperty.call(params, 'I2'), false);
  assert.equal(getAwgProtocolVersion(params), '3.1');
});

test('parseAwgClientInterfaceParameters rejects partial or malformed AWG 3.1 params', () => {
  assert.throws(
    () => parseAwgClientInterfaceParameters(syntheticAwgConfig().replace(/^RekeyTimeout.*$/m, '')),
    /awg_client_parameters_unavailable/
  );
  assert.throws(
    () => parseAwgClientInterfaceParameters(syntheticAwgConfig({ RekeyTimeout: '3-70000' })),
    /awg_client_parameters_unavailable/
  );
  assert.throws(
    () => parseAwgClientInterfaceParameters(syntheticAwgConfig({ RandomTrailers: 'maybe' })),
    /awg_client_parameters_unavailable/
  );
  assert.equal(getAwgProtocolVersion(parseAwgClientInterfaceParameters(syntheticAwgConfig())), '3.1');
});
test('buildPersistentPeerSummaries returns only public peer identity and allowed IPs', () => {
  const config = `${syntheticAwgConfig()}
PresharedKey = ${syntheticKey(7)}
AllowedIPs = 10.8.1.2/32
PersistentKeepalive = 25
`;
  const summaries = buildPersistentPeerSummaries(config);

  assert.deepEqual(summaries, [{
    publicKey: syntheticKey(8),
    allowedIps: ['10.8.1.2/32']
  }]);
  const serialized = JSON.stringify(summaries);
  assert.doesNotMatch(serialized, /PrivateKey|PresharedKey|ListenPort|persistentKeepalive/);
});
