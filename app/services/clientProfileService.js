'use strict';

// Rules verified against AmneziaVPN 5.0.3.0 (de93650), not one server's export.
const PARAMETER_NAMES = [
  'Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4',
  'HeaderProtectionKey', 'ContentPaddingAddition', 'RekeyAfterTime',
  'RekeyTimeout', 'RejectAfterTime', 'KeepaliveTimeout', 'MaxHandshakeAttempts',
  'RandomTrailers', 'DisableCookies', 'I1', 'I2', 'I3', 'I4', 'I5'
];
const AWG3_NAMES = ['HeaderProtectionKey', 'ContentPaddingAddition', 'RekeyAfterTime',
  'RekeyTimeout', 'RejectAfterTime', 'KeepaliveTimeout', 'MaxHandshakeAttempts'];
const enabled = value => Boolean(String(value ?? '').trim()) && String(value).trim().toLowerCase() !== 'off';

function protocolVersion(parameters) {
  if (AWG3_NAMES.some(name => String(parameters[name] ?? '').trim())
      || ['RandomTrailers', 'DisableCookies'].some(name => enabled(parameters[name]))) return '3.1';
  if (['S3', 'S4'].some(name => String(parameters[name] ?? '').trim())
      || ['H1', 'H2', 'H3', 'H4'].some(name => String(parameters[name] ?? '').includes('-'))) return '2';
  if (['I1', 'I2', 'I3', 'I4', 'I5'].some(name => String(parameters[name] ?? '').trim())) return '1.5';
  return '';
}

function policyError(message) {
  return Object.assign(new Error(message), {status: 500, code: 'invalid_client_export_settings'});
}

function clientSettings(env, parameters) {
  // The web panel has no client OS. Select an explicit export policy; imports keep their own MTU.
  const platform = String(env.CLIENT_EXPORT_PLATFORM || 'desktop').trim();
  if (!['desktop', 'mobile'].includes(platform)) throw policyError('CLIENT_EXPORT_PLATFORM must be desktop or mobile');
  const mtu = String(env.CLIENT_MTU || (platform === 'mobile' ? '1280' : '1376')).trim();
  if (!/^\d+$/.test(mtu) || Number(mtu) < 576 || Number(mtu) > 65535) throw policyError('CLIENT_MTU is invalid');
  const version = protocolVersion(parameters);
  const requested = String(env.CLIENT_PERSISTENT_KEEPALIVE ?? 'auto').trim();
  const keepalive = !requested || requested === 'auto' ? (version === '3.1' ? '25-35' : '25') : requested;
  const range = /^(\d+)(?:-(\d+))?$/.exec(keepalive);
  if (!range || Number(range[1]) > 65535 || (range[2] !== undefined
      && (version !== '3.1' || Number(range[2]) > 65535 || Number(range[2]) < Number(range[1])))) {
    throw policyError('CLIENT_PERSISTENT_KEEPALIVE must be a valid value or an AWG 3.1 range');
  }
  const dns = String(env.CLIENT_DNS || '1.1.1.1, 1.0.0.1').trim();
  const allowedIps = String(env.CLIENT_ALLOWED_IPS || '0.0.0.0/0, ::/0').trim();
  if (/[\r\n\0]/.test(dns + allowedIps)) throw policyError('Client DNS and routes must be single-line values');
  return {dns, allowedIps, keepalive, mtu};
}

function saveProfile(config, guest) {
  return JSON.stringify({format: 'nait-awg-client-profile', version: 1, config, guest});
}

function readProfile(text) {
  // Existing encrypted_config entries remain native text. No startup migration or rewrite.
  if (!text.trimStart().startsWith('{')) return {config: text, legacy: true};
  const profile = JSON.parse(text);
  if (profile?.format !== 'nait-awg-client-profile' || profile.version !== 1
      || typeof profile.config !== 'string' || !profile.guest) throw policyError('Stored client profile is invalid');
  return profile;
}

function rewriteProfile(text, parameters) {
  const rules = require('./obfuscationRules');
  const profile = readProfile(text);
  const config = rules.rewrite(profile.config, parameters, true);
  if (profile.legacy) return config;
  const guest = structuredClone(profile.guest);
  const awg = guest.containers[0].awg;
  const last = typeof awg.last_config === 'string' ? JSON.parse(awg.last_config) : awg.last_config;
  last.config = rules.rewrite(last.config, parameters, true);
  for (const name of PARAMETER_NAMES) {
    if (parameters[name] !== undefined && String(parameters[name]) !== '') {
      awg[name] = last[name] = String(parameters[name]);
    } else {
      delete last[name];
      if (/^I[1-5]$/.test(name)) awg[name] = '';
      else delete awg[name];
    }
  }
  const version = protocolVersion(parameters);
  if (version) awg.protocol_version = version;
  else delete awg.protocol_version;
  awg.last_config = JSON.stringify(last);
  return saveProfile(config, guest);
}

module.exports = {PARAMETER_NAMES, protocolVersion, clientSettings, saveProfile, readProfile, rewriteProfile};
