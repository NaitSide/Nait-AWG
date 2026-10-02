'use strict';

const net = require('net');
const fs = require('fs/promises');
const { runFile } = require('../utils/exec');
const { parseAwgPeerBlocks } = require('./awgConfigService');

const DEFAULT_CONTAINER_NAME = 'amnezia-awg';
const DEFAULT_INTERFACE = 'awg0';
const DEFAULT_CONFIG_PATH = '/opt/amnezia/awg/awg0.conf';
const DEFAULT_CLIENTS_TABLE_PATH = '/opt/amnezia/awg/clientsTable';
const UNAVAILABLE_ERROR = 'Docker or AWG runtime unavailable';
const ACTIVE_HANDSHAKE_WINDOW_SECONDS = 180;
const UINT32_MAX = 4294967295;
const AWG_BASE_CLIENT_INTERFACE_PARAMETER_NAMES = Object.freeze([
  'Jc',
  'Jmin',
  'Jmax',
  'S1',
  'S2',
  'S3',
  'S4',
  'H1',
  'H2',
  'H3',
  'H4'
]);
const AWG_3_1_REQUIRED_CLIENT_INTERFACE_PARAMETER_NAMES = Object.freeze([
  ...AWG_BASE_CLIENT_INTERFACE_PARAMETER_NAMES,
  'HeaderProtectionKey',
  'RekeyAfterTime',
  'RekeyTimeout',
  'RejectAfterTime',
  'KeepaliveTimeout',
  'MaxHandshakeAttempts',
  'RandomTrailers',
  'DisableCookies'
]);
const AWG_3_1_OPTIONAL_CLIENT_INTERFACE_PARAMETER_NAMES = Object.freeze([
  'ContentPaddingAddition', 'I1', 'I2', 'I3', 'I4', 'I5'
]);
const AWG_CLIENT_INTERFACE_PARAMETER_NAMES = Object.freeze([
  ...AWG_3_1_REQUIRED_CLIENT_INTERFACE_PARAMETER_NAMES,
  ...AWG_3_1_OPTIONAL_CLIENT_INTERFACE_PARAMETER_NAMES
]);
const AWG_CLIENT_INTERFACE_PARAMETER_SET = new Set(AWG_CLIENT_INTERFACE_PARAMETER_NAMES);
const AWG_NUMERIC_INTERFACE_PARAMETER_SET = new Set([
  'Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4'
]);
const AWG_HEADER_INTERFACE_PARAMETER_SET = new Set(['H1', 'H2', 'H3', 'H4']);
const AWG_3_1_RANGE_INTERFACE_PARAMETER_SET = new Set([
  'ContentPaddingAddition',
  'RekeyAfterTime',
  'RekeyTimeout',
  'RejectAfterTime',
  'KeepaliveTimeout',
  'MaxHandshakeAttempts'
]);
const AWG_BOOLEAN_INTERFACE_PARAMETER_SET = new Set(['RandomTrailers', 'DisableCookies']);
const AWG_SPECIAL_JUNK_INTERFACE_PARAMETER_SET = new Set(AWG_3_1_OPTIONAL_CLIENT_INTERFACE_PARAMETER_NAMES);
const AWG_CLIENT_ONLY_INTERFACE_PARAMETER_ALIASES = Object.freeze({
  ClientJc: 'Jc',
  ClientJmin: 'Jmin',
  ClientJmax: 'Jmax'
});
const UINT16_MAX = 65535;
const MAX_SPECIAL_JUNK_LENGTH = 4096;

function getAwgRuntimeConfig() {
  return {
    containerName: process.env.AWG_CONTAINER_NAME || DEFAULT_CONTAINER_NAME,
    interfaceName: process.env.AWG_INTERFACE || DEFAULT_INTERFACE,
    configPath: process.env.AWG_CONFIG_PATH || DEFAULT_CONFIG_PATH,
    clientsTablePath: process.env.AWG_CLIENTS_TABLE_PATH || DEFAULT_CLIENTS_TABLE_PATH
  };
}

function getAwgContainerConfigPath() {
  return process.env.AWG_CONTAINER_CONFIG_PATH || DEFAULT_CONFIG_PATH;
}

function nowIso() {
  return new Date().toISOString();
}

function unavailableStatus(config, error = UNAVAILABLE_ERROR) {
  return {
    status: 'unavailable',
    container: {
      name: config.containerName,
      running: false
    },
    interface: config.interfaceName,
    listenPort: null,
    peersCount: null,
    error,
    timestamp: nowIso()
  };
}

function normalizeLines(output) {
  return String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function isContainerRunning(containerName) {
  const { stdout } = await runFile('docker', [
    'ps',
    '--filter',
    `name=^/${containerName}$`,
    '--filter',
    'status=running',
    '--format',
    '{{.Names}}'
  ]);

  return normalizeLines(stdout).includes(containerName);
}

async function getAwgShow(config) {
  const { stdout } = await runFile('docker', [
    'exec',
    config.containerName,
    'awg',
    'show',
    config.interfaceName
  ]);

  return stdout;
}

async function getAwgField(config, field) {
  try {
    const { stdout } = await runFile('docker', [
      'exec',
      config.containerName,
      'awg',
      'show',
      config.interfaceName,
      field
    ]);

    return stdout;
  } catch {
    return null;
  }
}

async function getAwgPublicKey(config) {
  const { stdout } = await runFile('docker', [
    'exec',
    config.containerName,
    'awg',
    'show',
    config.interfaceName,
    'public-key'
  ]);

  return validateWireGuardPublicKey(stdout);
}

async function getAwgConfigText(config) {
  try {
    const { stdout } = await runFile('docker', [
      'exec',
      config.containerName,
      'cat',
      config.configPath
    ], {
      maxBuffer: 1024 * 1024
    });

    if (stdout) return stdout;
  } catch {}

  if (await fileExistsOnHost(config.configPath)) {
    return fs.readFile(config.configPath, 'utf8');
  }

  throw createProfileError('awg_config_not_found');
}

function cleanAmneziaClientName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return name ? name.slice(0, 80) : null;
}

function parseAmneziaClientNames(text) {
  let source;
  try {
    source = JSON.parse(String(text || ''));
  } catch {
    return new Map();
  }

  const entries = Array.isArray(source)
    ? source.map((client) => [client?.clientId, client?.userData?.clientName])
    : source && typeof source === 'object'
      ? Object.entries(source).map(([clientId, value]) => [clientId, value?.userData?.clientName ?? value?.clientName])
      : [];
  const names = new Map();
  for (const [clientId, rawName] of entries) {
    let publicKey;
    try {
      publicKey = validateWireGuardPublicKey(clientId);
    } catch {
      continue;
    }
    const name = cleanAmneziaClientName(rawName);
    if (name) names.set(publicKey, name);
  }
  return names;
}

async function getAmneziaClientNames(config) {
  try {
    const { stdout } = await runFile('docker', [
      'exec',
      config.containerName,
      'cat',
      config.clientsTablePath
    ], {
      maxBuffer: 1024 * 1024
    });
    return parseAmneziaClientNames(stdout);
  } catch {
    return new Map();
  }
}

async function getInterfaceAddressProfile(config) {
  const { stdout } = await runFile('docker', [
    'exec',
    config.containerName,
    'ip',
    '-j',
    'address',
    'show',
    'dev',
    config.interfaceName
  ]);

  return parseInterfaceAddressFromIpJson(stdout);
}

function parseAwgShow(output) {
  const listenPortMatch = String(output || '').match(/^\s*listening port:\s*(\d+)\s*$/im);
  const peerMatches = String(output || '').match(/^peer:\s+/gim) || [];

  return {
    listenPort: listenPortMatch ? Number(listenPortMatch[1]) : null,
    peersCount: peerMatches.length
  };
}

function parseListenPort(output) {
  const value = Number(String(output || '').trim());
  return Number.isFinite(value) ? value : null;
}

function createProfileError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateWireGuardPublicKey(value) {
  const publicKey = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(publicKey)) {
    throw createProfileError('invalid_awg_server_public_key');
  }

  const decoded = Buffer.from(publicKey, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== publicKey) {
    throw createProfileError('invalid_awg_server_public_key');
  }

  return publicKey;
}

function ipv4ToInt(address) {
  const parts = String(address || '').split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw createProfileError('invalid_ipv4_address');
  }

  return (
    ((parts[0] << 24) >>> 0)
    + ((parts[1] << 16) >>> 0)
    + ((parts[2] << 8) >>> 0)
    + parts[3]
  ) >>> 0;
}

function intToIpv4(value) {
  const number = value >>> 0;
  return [
    (number >>> 24) & 255,
    (number >>> 16) & 255,
    (number >>> 8) & 255,
    number & 255
  ].join('.');
}

function getIpv4Network(address, prefixLength) {
  const prefix = Number(prefixLength);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw createProfileError('invalid_awg_interface_prefix');
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return `${intToIpv4(ipv4ToInt(address) & mask)}/${prefix}`;
}

function isUsableAwgIpv4Address(address) {
  if (net.isIP(address) !== 4) return false;
  if (address === '0.0.0.0') return false;
  if (address.startsWith('127.')) return false;
  if (address.startsWith('169.254.')) return false;
  return true;
}

function parseInterfaceAddressFromIpJson(output) {
  let parsed;
  try {
    parsed = JSON.parse(String(output || ''));
  } catch {
    throw createProfileError('invalid_ip_address_output');
  }

  const interfaces = Array.isArray(parsed) ? parsed : [];
  const addresses = interfaces
    .flatMap((item) => Array.isArray(item.addr_info) ? item.addr_info : [])
    .filter((item) => item && item.family === 'inet')
    .map((item) => ({
      address: String(item.local || item.address || '').trim(),
      prefixLength: Number(item.prefixlen)
    }))
    .filter((item) => isUsableAwgIpv4Address(item.address)
      && Number.isInteger(item.prefixLength)
      && item.prefixLength >= 0
      && item.prefixLength <= 32);

  if (addresses.length === 0) {
    throw createProfileError('awg_interface_address_not_found');
  }

  if (addresses.length > 1) {
    throw createProfileError('ambiguous_awg_interface_address');
  }

  const [selected] = addresses;

  return {
    interfaceAddress: `${selected.address}/${selected.prefixLength}`,
    tunnelSubnet: getIpv4Network(selected.address, selected.prefixLength)
  };
}

function parseAwgClientInterfaceParameters(configText) {
  const params = {};
  let section = null;

  String(configText || '').split(/\r?\n/).forEach((rawLine) => {
    let line = rawLine.trim();
    if (!line) return;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      return;
    }

    if (section !== 'interface') return;
    const isComment = line.startsWith('#') || line.startsWith(';');
    if (isComment) line = line.replace(/^[#;]\s*/, '');
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) return;

    const rawName = line.slice(0, separatorIndex).trim();
    const name = isComment
      ? AWG_CLIENT_ONLY_INTERFACE_PARAMETER_ALIASES[rawName] || rawName
      : rawName;
    const value = line.slice(separatorIndex + 1).trim();
    if (AWG_CLIENT_INTERFACE_PARAMETER_SET.has(name)
      && (!isComment
        || AWG_SPECIAL_JUNK_INTERFACE_PARAMETER_SET.has(name)
        || Object.prototype.hasOwnProperty.call(AWG_CLIENT_ONLY_INTERFACE_PARAMETER_ALIASES, rawName))
      && value) {
      params[name] = value;
    }
  });

  const normalized = {};
  for (const name of AWG_3_1_REQUIRED_CLIENT_INTERFACE_PARAMETER_NAMES) {
    const invalidParameter = () => createProfileError(
      'awg_client_parameters_unavailable',
      `awg_client_parameters_unavailable: invalid_or_missing_awg_client_parameter:${name}`
    );
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw invalidParameter();
    }

    const text = String(params[name] ?? '').trim();
    if (AWG_NUMERIC_INTERFACE_PARAMETER_SET.has(name)) {
      if (!/^\d+$/.test(text)) {
        throw invalidParameter();
      }
      const parsed = Number(text);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > UINT32_MAX) {
        throw invalidParameter();
      }
      normalized[name] = parsed;
      continue;
    }

    if (name === 'HeaderProtectionKey') {
      try {
        normalized[name] = validateWireGuardPublicKey(text);
      } catch {
        throw invalidParameter();
      }
      continue;
    }

    if (AWG_BOOLEAN_INTERFACE_PARAMETER_SET.has(name)) {
      if (!/^(?:on|off|0|1)$/i.test(text)) {
        throw invalidParameter();
      }
      normalized[name] = text.toLowerCase();
      continue;
    }

    if (!AWG_HEADER_INTERFACE_PARAMETER_SET.has(name)
      && !AWG_3_1_RANGE_INTERFACE_PARAMETER_SET.has(name)) {
      throw createProfileError('awg_client_parameters_unavailable');
    }

    const match = text.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
      throw invalidParameter();
    }
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    const max = AWG_HEADER_INTERFACE_PARAMETER_SET.has(name) ? UINT32_MAX : UINT16_MAX;
    if (
      !Number.isSafeInteger(start) || start < 0 || start > max ||
      !Number.isSafeInteger(end) || end < 0 || end > max ||
      start > end
    ) {
      throw invalidParameter();
    }
    normalized[name] = text;
  }

  for (const name of AWG_3_1_OPTIONAL_CLIENT_INTERFACE_PARAMETER_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(params, name)) continue;
    const text = String(params[name] || '').trim();
    if (name === 'ContentPaddingAddition') {
      const match = text.match(/^(\d+)(?:-(\d+))?$/);
      const start = match ? Number(match[1]) : NaN;
      const end = match ? Number(match[2] === undefined ? match[1] : match[2]) : NaN;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end > UINT16_MAX || start > end) {
        throw createProfileError(
          'awg_client_parameters_unavailable',
          'awg_client_parameters_unavailable: invalid_or_missing_awg_client_parameter:ContentPaddingAddition'
        );
      }
      normalized[name] = text;
      continue;
    }
    if (!text || text.length > MAX_SPECIAL_JUNK_LENGTH || /[\r\n\0]/.test(text)) {
      throw createProfileError('awg_client_parameters_unavailable');
    }
    normalized[name] = text;
  }

  if (normalized.Jmin > normalized.Jmax) {
    throw createProfileError('awg_client_parameters_unavailable', 'awg_client_parameters_unavailable: invalid_awg_client_parameter_range:Jmin-Jmax');
  }

  return normalized;
}

function getAwgProtocolVersion(clientInterfaceParameters) {
  if (!Object.prototype.hasOwnProperty.call(clientInterfaceParameters, 'HeaderProtectionKey')) {
    throw createProfileError('awg_client_parameters_unavailable');
  }
  return '3.1';
}

function parsePeerList(output) {
  return normalizeLines(output);
}

function parsePeerValueMap(output, parser = (value) => value) {
  const map = new Map();

  normalizeLines(output).forEach((line) => {
    const [peer, ...rest] = line.split(/\s+/);
    if (!peer) return;
    map.set(peer, parser(rest.join(' ').trim(), rest));
  });

  return map;
}

function parseAllowedIps(value) {
  if (!value || value === '(none)') return [];
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseLatestHandshake(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp * 1000).toISOString();
}

function parseTransfer(_value, parts) {
  const rx = Number(parts[0]);
  const tx = Number(parts[1]);
  return {
    rx: Number.isFinite(rx) ? rx : 0,
    tx: Number.isFinite(tx) ? tx : 0
  };
}

function parseKeepalive(value) {
  if (!value || value === 'off' || value === '(none)') return null;
  return value;
}

function getPeerState(latestHandshakeAt) {
  if (!latestHandshakeAt) return 'inactive';

  const handshakeTime = new Date(latestHandshakeAt).getTime();
  if (!Number.isFinite(handshakeTime)) return 'unknown';

  const ageSeconds = (Date.now() - handshakeTime) / 1000;
  return ageSeconds >= 0 && ageSeconds <= ACTIVE_HANDSHAKE_WINDOW_SECONDS ? 'active' : 'inactive';
}

async function fileExistsOnHost(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function fileExistsInsideContainer(config, path) {
  try {
    await runFile('docker', [
      'exec',
      config.containerName,
      'test',
      '-f',
      path
    ]);
    return true;
  } catch {
    return false;
  }
}

async function getAwgStatus() {
  const config = getAwgRuntimeConfig();

  try {
    const running = await isContainerRunning(config.containerName);
    if (!running) return unavailableStatus(config);

    const awgOutput = await getAwgShow(config);
    const awgStatus = parseAwgShow(awgOutput);

    return {
      status: 'ok',
      container: {
        name: config.containerName,
        running: true
      },
      interface: config.interfaceName,
      listenPort: awgStatus.listenPort,
      peersCount: awgStatus.peersCount,
      timestamp: nowIso()
    };
  } catch {
    return unavailableStatus(config);
  }
}

async function getAwgProfile() {
  const config = getAwgRuntimeConfig();
  const status = await getAwgStatus();
  const running = status.container.running;
  const [hostConfigPresent, configInsideContainer] = await Promise.all([
    fileExistsOnHost(config.configPath),
    running ? fileExistsInsideContainer(config, getAwgContainerConfigPath()) : Promise.resolve(false)
  ]);

  const baseProfile = {
    ...status,
    profileVersion: 2,
    configPath: config.configPath,
    configInsideContainer,
    hostConfigPresent
  };

  if (status.status !== 'ok' || !running) {
    return baseProfile;
  }

  try {
    const [addressProfile, serverPublicKey, clientInterfaceParameters] = await Promise.all([
      getInterfaceAddressProfile(config),
      getAwgPublicKey(config),
      getAwgConfigText(config).then(parseAwgClientInterfaceParameters)
    ]);
    const observedAt = nowIso();

    return {
      ...baseProfile,
      interfaceAddress: addressProfile.interfaceAddress,
      tunnelSubnet: addressProfile.tunnelSubnet,
      serverPublicKey,
      clientInterfaceParameters,
      protocolVersion: getAwgProtocolVersion(clientInterfaceParameters),
      observedAt,
      timestamp: observedAt
    };
  } catch (error) {
    return {
      ...baseProfile,
      status: 'error',
      error: error.code || 'awg_profile_unavailable',
      ...(error.code === 'awg_client_parameters_unavailable' ? {
        errorDetail: error.message.replace(/^awg_client_parameters_unavailable:\s*/, '')
      } : {}),
      timestamp: nowIso()
    };
  }
}

function buildPersistentPeerSummaries(configText) {
  return parseAwgPeerBlocks(configText).map((peer) => ({
    publicKey: peer.publicKey,
    allowedIps: peer.allowedIps
  }));
}
async function getAwgPeers() {
  const config = getAwgRuntimeConfig();

  try {
    const running = await isContainerRunning(config.containerName);
    if (!running) {
      return {
        status: 'unavailable',
        peers: [],
        error: UNAVAILABLE_ERROR,
        timestamp: nowIso()
      };
    }

    const [
      peersOutput,
      allowedIpsOutput,
      endpointsOutput,
      latestHandshakesOutput,
      transferOutput,
      keepaliveOutput,
      persistentConfigText,
      clientNames
    ] = await Promise.all([
      getAwgField(config, 'peers'),
      getAwgField(config, 'allowed-ips'),
      getAwgField(config, 'endpoints'),
      getAwgField(config, 'latest-handshakes'),
      getAwgField(config, 'transfer'),
      getAwgField(config, 'persistent-keepalive'),
      getAwgConfigText(config).catch(() => null),
      getAmneziaClientNames(config)
    ]);

    let peerPublicKeys = peersOutput === null ? [] : parsePeerList(peersOutput);

    if (!peerPublicKeys.length) {
      const awgOutput = await getAwgShow(config);
      peerPublicKeys = normalizeLines(awgOutput)
        .filter((line) => line.startsWith('peer:'))
        .map((line) => line.replace(/^peer:\s*/, '').trim())
        .filter(Boolean);
    }

    const allowedIps = parsePeerValueMap(allowedIpsOutput, parseAllowedIps);
    const endpoints = parsePeerValueMap(endpointsOutput, (value) => value && value !== '(none)' ? value : null);
    const latestHandshakes = parsePeerValueMap(latestHandshakesOutput, parseLatestHandshake);
    const transfers = parsePeerValueMap(transferOutput, parseTransfer);
    const keepalives = parsePeerValueMap(keepaliveOutput, parseKeepalive);

    const peers = peerPublicKeys.map((publicKey) => {
      const transfer = transfers.get(publicKey) || { rx: 0, tx: 0 };
      const latestHandshakeAt = latestHandshakes.get(publicKey) || null;

      return {
        publicKey,
        clientName: clientNames.get(publicKey) || null,
        allowedIps: allowedIps.get(publicKey) || [],
        endpoint: endpoints.get(publicKey) || null,
        latestHandshakeAt,
        transferRx: transfer.rx,
        transferTx: transfer.tx,
        persistentKeepalive: keepalives.get(publicKey) || null,
        state: getPeerState(latestHandshakeAt)
      };
    });

    return {
      status: 'ok',
      peers,
      persistentPeers: persistentConfigText ? buildPersistentPeerSummaries(persistentConfigText) : null,
      timestamp: nowIso()
    };
  } catch {
    return {
      status: 'unavailable',
      peers: [],
      error: UNAVAILABLE_ERROR,
      timestamp: nowIso()
    };
  }
}

module.exports = {
  getAwgContainerConfigPath,
  getAwgRuntimeConfig,
  getAwgStatus,
  getAwgProfile,
  buildPersistentPeerSummaries,
  parseAmneziaClientNames,
  getAwgPeers,
  getIpv4Network,
  parseInterfaceAddressFromIpJson,
  parseAwgClientInterfaceParameters,
  parseAllowedIps,
  getAwgProtocolVersion,
  validateWireGuardPublicKey
};
