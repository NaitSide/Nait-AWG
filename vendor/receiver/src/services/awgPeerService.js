'use strict';

const crypto = require('crypto');
const { runFile } = require('../utils/exec');
const {
  getAwgRuntimeConfig,
  getAwgStatus,
  getAwgProfile,
  getAwgPeers
} = require('./awgService');
const {
  getContainerConfigPath,
  parseAwgPeerBlocks,
  readConfig
} = require('./awgConfigService');
const { createPeer, deletePeer } = require('./awgPeerWriteService');

const UUID_LIKE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_LABEL_PATTERN = /^[a-zA-Z0-9_.-]{1,80}$/;
const SAFE_CLIENT_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,120}$/;
const WG_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{12}$/i;

function nowIso() {
  return new Date().toISOString();
}

function isWriteEnabled() {
  return String(process.env.AWG_WRITE_ENABLED || '').trim().toLowerCase() === 'true';
}

function createErrorResponse(statusCode, code, message, requestId) {
  return {
    statusCode,
    body: {
      status: 'error',
      code,
      message,
      ...(requestId ? { requestId } : {}),
      timestamp: nowIso()
    }
  };
}

function createFingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex')
    .slice(0, 12);
}

function getRequestId(req) {
  return String(req.get('x-request-id') || '').trim();
}

function getIdempotencyKey(req) {
  return String(req.get('idempotency-key') || '').trim();
}

function parseIpv4(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return null;

  const bytes = parts.map((part) => {
    if (!/^\d+$/.test(part)) return null;
    const number = Number(part);
    return Number.isInteger(number) && number >= 0 && number <= 255 ? number : null;
  });

  if (bytes.some((part) => part === null)) return null;
  return (((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]) >>> 0;
}

function parseIpv4Cidr(value) {
  const [address, prefixText] = String(value || '').split('/');
  const prefix = Number(prefixText);
  const ip = parseIpv4(address);

  if (ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  return { address, ip, prefix };
}

function subnetMask(prefix) {
  if (prefix === 0) return 0;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

function getNetworkRange(cidr) {
  const parsed = parseIpv4Cidr(cidr);
  if (!parsed) return null;

  const mask = subnetMask(parsed.prefix);
  const network = (parsed.ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  return {
    ...parsed,
    network,
    broadcast
  };
}

function validateAllowedIp(value, vpnSubnet) {
  const peer = parseIpv4Cidr(value);
  const subnet = getNetworkRange(vpnSubnet);

  if (!peer || peer.prefix !== 32) return 'allowedIp must be an IPv4 /32 CIDR';
  if (!subnet) return 'AWG_VPN_SUBNET is invalid';
  if (peer.ip < subnet.network || peer.ip > subnet.broadcast) return 'allowedIp must belong to AWG_VPN_SUBNET';
  if (peer.ip === subnet.network) return 'allowedIp must not be the network address';
  if (peer.ip === subnet.broadcast) return 'allowedIp must not be the broadcast address';
  return null;
}

function normalizeRequestedKeepalive(value) {
  if (value === undefined || value === null || value === '') return 25;
  return value;
}

function normalizeInitialGateState(value) {
  const state = String(value || 'open').trim().toLowerCase();
  return state === 'open' || state === 'closed' ? state : null;
}

function validationError(field, code, message) {
  return { field, code, message };
}

function validateCreatePeerRequest(req) {
  const body = req.body || {};
  const errors = [];
  const idempotencyKey = getIdempotencyKey(req);
  const vpnSubnet = process.env.AWG_VPN_SUBNET || '10.8.1.0/24';
  const requestedKeepalive = normalizeRequestedKeepalive(body.persistentKeepalive);
  const initialGateState = normalizeInitialGateState(body.initialGateState);

  if (!UUID_LIKE_PATTERN.test(idempotencyKey)) {
    errors.push(validationError('Idempotency-Key', 'invalid_idempotency_key', 'Idempotency-Key header must be a UUID'));
  }

  if (!SAFE_CLIENT_ID_PATTERN.test(String(body.clientId || ''))) {
    errors.push(validationError('clientId', 'invalid_client_id', 'clientId must match [a-zA-Z0-9_.:-]{1,120}'));
  }

  if (!SAFE_LABEL_PATTERN.test(String(body.clientLabel || ''))) {
    errors.push(validationError('clientLabel', 'invalid_client_label', 'clientLabel must match [a-zA-Z0-9_.-]{1,80}'));
  }

  if (!WG_KEY_PATTERN.test(String(body.publicKey || ''))) {
    errors.push(validationError('publicKey', 'invalid_public_key', 'publicKey must look like a WG/AWG base64 key'));
  }

  if (!WG_KEY_PATTERN.test(String(body.presharedKey || ''))) {
    errors.push(validationError('presharedKey', 'invalid_preshared_key', 'presharedKey must look like a WG/AWG base64 key'));
  }

  const allowedIpError = validateAllowedIp(body.allowedIp, vpnSubnet);
  if (allowedIpError) {
    errors.push(validationError('allowedIp', 'invalid_allowed_ip', allowedIpError));
  }

  if (!initialGateState) {
    errors.push(validationError('initialGateState', 'invalid_initial_gate_state', 'initialGateState must be open or closed'));
  }

  if (!Number.isInteger(requestedKeepalive) || requestedKeepalive < 0 || requestedKeepalive > 65535) {
    errors.push(validationError('persistentKeepalive', 'invalid_persistent_keepalive', 'persistentKeepalive must be an integer from 0 to 65535'));
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized: {
      idempotencyKey,
      clientId: String(body.clientId || '').trim(),
      clientLabel: String(body.clientLabel || '').trim(),
      publicKeyFingerprint: createFingerprint(body.publicKey),
      allowedIp: String(body.allowedIp || '').trim(),
      initialGateState: initialGateState || 'open',
      // PersistentKeepalive belongs to the client configuration. Applying it to
      // the server peer creates periodic outgoing packets after the client stops.
      persistentKeepalive: 0
    }
  };
}

function validateDeletePeerRequest(req, options = {}) {
  const body = req.body || {};
  const errors = [];
  if (body.publicKey !== undefined && !WG_KEY_PATTERN.test(String(body.publicKey))) {
    errors.push(validationError('publicKey', 'invalid_public_key', 'publicKey must be a WireGuard public key'));
  }
  const idempotencyKey = getIdempotencyKey(req);
  const publicKeyFingerprint = String(req.params.publicKeyFingerprint || body.publicKeyFingerprint || '').trim();

  if (options.requireIdempotency && !UUID_LIKE_PATTERN.test(idempotencyKey)) {
    errors.push(validationError('Idempotency-Key', 'invalid_idempotency_key', 'Idempotency-Key header must be a UUID'));
  }

  if (!FINGERPRINT_PATTERN.test(publicKeyFingerprint)) {
    errors.push(validationError('publicKeyFingerprint', 'invalid_public_key_fingerprint', 'publicKeyFingerprint must be a 12-character hex fingerprint'));
  }

  if (!SAFE_CLIENT_ID_PATTERN.test(String(body.clientId || ''))) {
    errors.push(validationError('clientId', 'invalid_client_id', 'clientId must match [a-zA-Z0-9_.:-]{1,120}'));
  }

  const allowedIp = parseIpv4Cidr(body.allowedIp);
  if (!allowedIp || allowedIp.prefix !== 32) {
    errors.push(validationError('allowedIp', 'invalid_allowed_ip', 'allowedIp must be an IPv4 /32 CIDR'));
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized: {
      idempotencyKey,
      clientId: String(body.clientId || '').trim(),
      publicKeyFingerprint: publicKeyFingerprint.toLowerCase(),
      ...(body.publicKey !== undefined ? { publicKey: String(body.publicKey) } : {}),
      allowedIp: String(body.allowedIp || '').trim()
    }
  };
}

function parseConfigPeerSummaries(output) {
  return String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [publicKey, allowedIpsRaw = ''] = line.split('\t');
      return {
        publicKey,
        allowedIps: allowedIpsRaw
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      };
    })
    .filter((peer) => peer.publicKey || peer.allowedIps.length);
}

async function getConfigPeerSummaries(config, runFileImpl = runFile) {
  const awkProgram = [
    'BEGIN { pk=""; ips="" }',
    '/^\\[Peer\\]/ { if (pk != "" || ips != "") print pk "\\t" ips; pk=""; ips=""; next }',
    '/^\\[/ { if (pk != "" || ips != "") print pk "\\t" ips; pk=""; ips=""; next }',
    '/^[[:space:]]*PublicKey[[:space:]]*=/ { sub(/^[^=]*=[[:space:]]*/, "", $0); pk=$0; next }',
    '/^[[:space:]]*AllowedIPs[[:space:]]*=/ { sub(/^[^=]*=[[:space:]]*/, "", $0); ips=$0; next }',
    'END { if (pk != "" || ips != "") print pk "\\t" ips }'
  ].join(' ');

  const { stdout } = await runFileImpl('docker', [
    'exec',
    config.containerName,
    'awk',
    awkProgram,
    getContainerConfigPath(config)
  ], {
    timeoutMs: Number(process.env.AWG_CREATE_PEER_TIMEOUT_MS || 30000)
  });

  return parseConfigPeerSummaries(stdout);
}

function hasRuntimeDuplicate(peers, publicKey, allowedIp) {
  const duplicatePublicKey = peers.some((peer) => peer.publicKey === publicKey);
  const duplicateAllowedIp = peers.some((peer) => (peer.allowedIps || []).includes(allowedIp));
  return { duplicatePublicKey, duplicateAllowedIp };
}

function hasConfigDuplicate(peers, publicKey, allowedIp) {
  const duplicatePublicKey = peers.some((peer) => peer.publicKey === publicKey);
  const duplicateAllowedIp = peers.some((peer) => (peer.allowedIps || []).includes(allowedIp));
  return { duplicatePublicKey, duplicateAllowedIp };
}

function findConfigDeleteTarget(configPeers, target) {
  const fingerprintMatches = configPeers.filter((peer) => createFingerprint(peer.publicKey) === target.publicKeyFingerprint);

  if (!fingerprintMatches.length) return { error: 'peer_not_found' };
  if (fingerprintMatches.length > 1) return { error: 'peer_fingerprint_ambiguous' };

  const peer = fingerprintMatches[0];
  if ((peer.allowedIps || []).length > 0 && !(peer.allowedIps || []).includes(target.allowedIp)) {
    return { error: 'peer_allowed_ip_mismatch' };
  }
  if (((peer.allowedIps || []).length === 0 || peer.clientId) && peer.clientId !== target.clientId) {
    return { error: 'peer_client_id_mismatch' };
  }

  return { peer };
}

function findRuntimeDeleteTarget(runtimePeers, target) {
  const fingerprintMatches = runtimePeers.filter((peer) => createFingerprint(peer.publicKey) === target.publicKeyFingerprint);

  if (!fingerprintMatches.length) return { error: 'peer_not_found' };
  if (fingerprintMatches.length > 1) return { error: 'peer_fingerprint_ambiguous' };

  const peer = fingerprintMatches[0];
  if ((peer.allowedIps || []).length > 0 && !(peer.allowedIps || []).includes(target.allowedIp)) {
    return { error: 'peer_allowed_ip_mismatch' };
  }

  return { peer };
}

function deleteTargetErrorResponse(errorCode, requestId) {
  const messages = {
    peer_not_found: 'Target peer was not found',
    peer_fingerprint_ambiguous: 'Public key fingerprint matched multiple peers',
    peer_allowed_ip_mismatch: 'Target peer allowedIp mismatch',
    peer_client_id_mismatch: 'Target peer clientId mismatch'
  };
  const statusCodes = {
    peer_not_found: 404,
    peer_fingerprint_ambiguous: 409,
    peer_allowed_ip_mismatch: 409,
    peer_client_id_mismatch: 409
  };

  return createErrorResponse(statusCodes[errorCode] || 409, errorCode || 'target_validation_failed', messages[errorCode] || 'Target peer validation failed', requestId);
}

function firstValidationError(errors) {
  return errors[0] || {
    code: 'validation_failed',
    message: 'Create peer request is invalid'
  };
}

async function createAwgPeerSkeleton(req) {
  const requestId = getRequestId(req);

  if (!isWriteEnabled()) {
    return createErrorResponse(403, 'write_disabled', 'AWG write operations are disabled', requestId);
  }

  const validation = validateCreatePeerRequest(req);
  if (!validation.ok) {
    const firstError = firstValidationError(validation.errors);
    return {
      statusCode: 400,
      body: {
        status: 'error',
        code: firstError.code,
        message: firstError.message,
        errors: validation.errors,
        ...(requestId ? { requestId } : {}),
        timestamp: nowIso()
      }
    };
  }

  try {
    return await createPeer(validation.normalized, {
      requestId,
      raw: {
        publicKey: req.body.publicKey,
        presharedKey: req.body.presharedKey
      }
    });
  } catch (error) {
    return createErrorResponse(error.statusCode || 500, error.code || 'create_peer_failed', error.statusCode ? error.message : 'AWG peer creation failed', requestId);
  }
}

async function deleteAwgPeerSkeleton(req) {
  const requestId = getRequestId(req);

  if (!isWriteEnabled()) {
    return createErrorResponse(403, 'write_disabled', 'AWG write operations are disabled', requestId);
  }

  const validation = validateDeletePeerRequest(req, { requireIdempotency: true });
  if (!validation.ok) {
    const firstError = firstValidationError(validation.errors);
    return {
      statusCode: 400,
      body: {
        status: 'error',
        code: firstError.code,
        message: firstError.message,
        errors: validation.errors,
        ...(requestId ? { requestId } : {}),
        timestamp: nowIso()
      }
    };
  }

  try {
    return await deletePeer(validation.normalized, { requestId });
  } catch (error) {
    return createErrorResponse(error.statusCode || 500, error.code || 'delete_peer_failed', error.statusCode ? error.message : 'AWG peer deletion failed', requestId);
  }
}

async function dryRunCreateAwgPeer(req) {
  const requestId = getRequestId(req);
  const validation = validateCreatePeerRequest(req);

  if (!validation.ok) {
    const firstError = firstValidationError(validation.errors);
    return {
      statusCode: 400,
      body: {
        status: 'error',
        code: firstError.code,
        message: firstError.message,
        errors: validation.errors,
        ...(requestId ? { requestId } : {}),
        timestamp: nowIso()
      }
    };
  }

  const config = getAwgRuntimeConfig();
  const [status, profile, runtimePeers] = await Promise.all([
    getAwgStatus(),
    getAwgProfile(),
    getAwgPeers()
  ]);

  if (status.status !== 'ok' || !status.container.running) {
    return createErrorResponse(409, 'awg_unavailable', 'AWG runtime is unavailable', requestId);
  }

  if (!Number.isFinite(status.listenPort)) {
    return createErrorResponse(409, 'listen_port_unavailable', 'AWG listen port is unavailable', requestId);
  }

  if (!profile.configInsideContainer) {
    return createErrorResponse(409, 'persistent_config_missing', 'Persistent AWG config is not available inside container', requestId);
  }

  if (runtimePeers.status !== 'ok') {
    return createErrorResponse(409, 'peers_unavailable', 'AWG peer list is unavailable', requestId);
  }

  const configPeers = await getConfigPeerSummaries(config);
  const runtimeDuplicates = hasRuntimeDuplicate(runtimePeers.peers, req.body.publicKey, req.body.allowedIp);
  const configDuplicates = hasConfigDuplicate(configPeers, req.body.publicKey, req.body.allowedIp);
  const duplicatePublicKey = runtimeDuplicates.duplicatePublicKey || configDuplicates.duplicatePublicKey;
  const duplicateAllowedIp = runtimeDuplicates.duplicateAllowedIp || configDuplicates.duplicateAllowedIp;

  if (duplicatePublicKey) {
    return createErrorResponse(409, 'duplicate_public_key', 'Public key is already used', requestId);
  }

  if (duplicateAllowedIp) {
    return createErrorResponse(409, 'duplicate_allowed_ip', 'Allowed IP is already used', requestId);
  }

  return {
    statusCode: 200,
    body: {
      status: 'ok',
      operation: 'create_peer_dry_run',
      writeEnabled: isWriteEnabled(),
      ...(requestId ? { requestId } : {}),
      plan: {
        wouldCreatePeer: true,
        clientId: validation.normalized.clientId,
        clientLabel: validation.normalized.clientLabel,
        publicKeyFingerprint: validation.normalized.publicKeyFingerprint,
        allowedIp: validation.normalized.allowedIp,
        initialGateState: validation.normalized.initialGateState,
        persistentKeepalive: validation.normalized.persistentKeepalive
      },
      checks: {
        containerRunning: true,
        interface: status.interface,
        listenPort: status.listenPort,
        duplicatePublicKey: false,
        duplicateAllowedIp: false,
        persistentConfigPresent: profile.configInsideContainer
      },
      timestamp: nowIso()
    }
  };
}

async function dryRunDeleteAwgPeer(req) {
  const requestId = getRequestId(req);
  const validation = validateDeletePeerRequest(req, { requireIdempotency: false });

  if (!validation.ok) {
    const firstError = firstValidationError(validation.errors);
    return {
      statusCode: 400,
      body: {
        status: 'error',
        code: firstError.code,
        message: firstError.message,
        errors: validation.errors,
        ...(requestId ? { requestId } : {}),
        timestamp: nowIso()
      }
    };
  }

  const config = getAwgRuntimeConfig();
  const [status, profile, runtimePeers] = await Promise.all([
    getAwgStatus(),
    getAwgProfile(),
    getAwgPeers()
  ]);

  if (status.status !== 'ok' || !status.container.running) {
    return createErrorResponse(409, 'awg_unavailable', 'AWG runtime is unavailable', requestId);
  }

  if (!Number.isFinite(status.listenPort)) {
    return createErrorResponse(409, 'listen_port_unavailable', 'AWG listen port is unavailable', requestId);
  }

  if (!profile.configInsideContainer) {
    return createErrorResponse(409, 'persistent_config_missing', 'Persistent AWG config is not available inside container', requestId);
  }

  if (runtimePeers.status !== 'ok') {
    return createErrorResponse(409, 'peers_unavailable', 'AWG peer list is unavailable', requestId);
  }

  const configText = await readConfig(config, requestId);
  const configTarget = findConfigDeleteTarget(parseAwgPeerBlocks(configText), validation.normalized);
  if (configTarget.error) return deleteTargetErrorResponse(configTarget.error, requestId);

  const runtimeTarget = findRuntimeDeleteTarget(runtimePeers.peers, validation.normalized);
  if (runtimeTarget.error) return deleteTargetErrorResponse(runtimeTarget.error, requestId);

  return {
    statusCode: 200,
    body: {
      status: 'ok',
      operation: 'delete_peer_dry_run',
      wouldDeletePeer: true,
      ...(requestId ? { requestId } : {}),
      target: {
        clientId: validation.normalized.clientId,
        publicKeyFingerprint: validation.normalized.publicKeyFingerprint,
        allowedIp: validation.normalized.allowedIp
      },
      checks: {
        targetInRuntime: true,
        targetInConfig: true,
        listenPort: status.listenPort,
        peersCountBefore: status.peersCount,
        peersCountAfter: Math.max(0, status.peersCount - 1)
      },
      timestamp: nowIso()
    }
  };
}

module.exports = {
  createAwgPeerSkeleton,
  dryRunCreateAwgPeer,
  deleteAwgPeerSkeleton,
  dryRunDeleteAwgPeer,
  getConfigPeerSummaries,
  validateCreatePeerRequest
};
