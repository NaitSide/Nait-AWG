'use strict';
const {PACKET_NAMES, validatePackets, generateSignature} = require('./signatureService');
const {storedRouting, routesFor, checkEndpoint} = require('./routingService');
const {readProfile, PARAMETER_NAMES, protocolVersion} = require('./clientProfileService');
const {parseClientConfig, MAX_CONFIG_BYTES} = require('./clientConfigService');
function failure(code = 'invalid_client_policy', status = 400) {
  const message = code === 'client_policy_changed' ? 'Настройки изменились. Загрузите их заново перед сохранением.'
    : code === 'client_policy_too_large' ? 'Выбранные настройки создают слишком большой конфиг. Сократите выбор сервисов или пакеты.'
    : 'Некорректные настройки клиента. Загрузите настройки заново.';
  return Object.assign(new Error(message), {status, code});
}
const emptyState = () => ({version: 1, revision: 0, obfuscation: null, routing: null, clients: {}});
function masking(value) {
  if (!value || !['none','quic','dns','custom'].includes(value.profile)) throw failure();
  const packets = validatePackets(value.packets);
  if (value.profile === 'none' && Object.keys(packets).length) throw failure();
  if (['dns','quic'].includes(value.profile) && (!packets.I1 || Object.keys(packets).length !== 1)) throw failure();
  // Prepared packets are saved, never regenerated during export.
  return {profile: value.profile, packets};
}
function binding(value, type) {
  if (!value || !['inherit','preserve','override'].includes(value.mode)) throw failure();
  return value.mode === 'override' ? {mode: 'override', value: type === 'routing'
    ? storedRouting(value.value) : masking(value.value)} : {mode: value.mode};
}
function validateState(value) {
  if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !value.clients || typeof value.clients !== 'object' || Array.isArray(value.clients)
      || Object.keys(value.clients).length > 10000) throw failure();
  const result = {...emptyState(), revision: value.revision,
    routing: value.routing === null ? null : storedRouting(value.routing),
    obfuscation: value.obfuscation === null ? null : masking(value.obfuscation)};
  for (const [id, item] of Object.entries(value.clients)) {
    if (!/^[a-f0-9]{12}$/.test(id) || !item || typeof item !== 'object') throw failure();
    result.clients[id] = {};
    for (const type of ['routing','obfuscation']) if (item[type] !== undefined) result.clients[id][type] = binding(item[type], type);
  }
  return result;
}
function selected(state, id, type) {
  const choice = state.clients[id]?.[type];
  if (choice?.mode === 'preserve') return null;
  if (choice?.mode === 'override') return choice.value;
  return state[type];
}
function fields(config, target, values) {
  const newline = config.includes('\r\n') ? '\r\n' : '\n';
  const lines = config.split(/\r?\n/), out = [];
  let inside = false, inserted = false;
  const insert = () => {
    if (inserted) return;
    for (const [name, value] of Object.entries(values)) if (value !== undefined && value !== '') out.push(name + ' = ' + value);
    inserted = true;
  };
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) { if (inside) insert(); inside = header[1] === target; }
    const pair = /^\s*([A-Za-z0-9]+)\s*=/.exec(line);
    if (inside && pair && Object.hasOwn(values, pair[1])) continue;
    out.push(line);
  }
  if (inside) insert();
  return out.join(newline);
}
function effectiveProfile(text, state, id) {
  const profile = readProfile(text), mask = selected(state, id, 'obfuscation'), routing = selected(state, id, 'routing');
  if (!mask && !routing) return profile;
  const parsed = parseClientConfig(profile.config, PARAMETER_NAMES, {nativeOnly: true});
  const packets = mask ? Object.fromEntries(PACKET_NAMES.map(name => [name, mask.packets[name] || ''])) : null;
  const routes = routing ? routesFor(routing, parsed.client.DNS, parsed.server.Endpoint) : null;
  if (routing?.mode === 'selected') checkEndpoint(routes, parsed.server.Endpoint);
  let config = profile.config;
  if (packets) config = fields(config, 'Interface', packets);
  if (routes) config = fields(config, 'Peer', {AllowedIPs: routes});
  if (Buffer.byteLength(config) > MAX_CONFIG_BYTES) throw failure('client_policy_too_large');
  if (!profile.guest) return {...profile, config};
  const guest = structuredClone(profile.guest), awg = guest.containers[0].awg;
  const wasString = typeof awg.last_config === 'string';
  const last = wasString ? JSON.parse(awg.last_config) : awg.last_config;
  if (packets) {
    last.config = fields(last.config, 'Interface', packets);
    for (const name of PACKET_NAMES) {
      awg[name] = packets[name];
      if (packets[name]) last[name] = packets[name]; else delete last[name];
    }
    const version = protocolVersion({...parsed.client, ...packets});
    if (version) awg.protocol_version = version; else delete awg.protocol_version;
  }
  if (routes) {
    last.config = fields(last.config, 'Peer', {AllowedIPs: routes});
    last.allowed_ips = routes.split(', ');
  }
  awg.last_config = wasString ? JSON.stringify(last) : last;
  if (Buffer.byteLength(JSON.stringify(guest)) > 256 * 1024) throw failure('client_policy_too_large');
  return {...profile, config, guest};
}
function migratePolicies(source, target, mappings, restoreObfuscation) {
  const result = emptyState();
  result.revision = target.revision + 1;
  result.routing = source.routing || target.routing;
  result.obfuscation = restoreObfuscation ? source.obfuscation : target.obfuscation;
  for (const peer of mappings) {
    const old = source.clients[peer.oldFingerprint];
    result.clients[peer.fingerprint] = {routing:{mode:'inherit'},obfuscation:{mode:'inherit'}};
    if (!old) continue;
    if (old.routing) result.clients[peer.fingerprint].routing = old.routing;
    if (restoreObfuscation && old.obfuscation) result.clients[peer.fingerprint].obfuscation = old.obfuscation;
  }
  return validateState(result);
}
module.exports = {emptyState, masking, binding, validateState, selected, effectiveProfile, fields, migratePolicies, failure, generateSignature};
