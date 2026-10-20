'use strict';
const net = require('node:net');
function invalid(code = 'invalid_service_catalog') {
  return Object.assign(new Error('Некорректный каталог или выбор сервисов.'), {status: 400, code});
}
function ipv4(value) {
  if (net.isIP(value) !== 4) throw invalid();
  return value.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
}
function cidr(text) {
  if (typeof text !== 'string' || text.length > 32) throw invalid();
  const [host, bits, extra] = text.split('/'), prefix = Number(bits);
  if (extra !== undefined || !/^\d+$/.test(bits || '') || prefix < 1 || prefix > 32) throw invalid();
  const start = ipv4(host), size = 2 ** (32 - prefix);
  if (start % size) throw invalid();
  return {text: host + '/' + prefix, start, end: start + size - 1, prefix};
}
function union(routes) {
  if (!Array.isArray(routes) || routes.length > 4096) throw invalid();
  const sorted = routes.map(cidr).sort((a, b) => a.start - b.start || a.prefix - b.prefix);
  const result = [];
  for (const item of sorted) {
    if (result.length && item.end <= result.at(-1).end) continue;
    result.push(item);
  }
  return result.map(item => item.text);
}
function validateCatalog(value) {
  if (value?.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(value.date || '')
      || !Array.isArray(value.services) || value.services.length > 20) throw invalid();
  if (!Number.isFinite(Date.parse(value.date)) || new Date(value.date).toISOString().slice(0,10) !== value.date) throw invalid();
  const ids = new Set();
  const forbidden = ['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16',
    '172.16.0.0/12','192.168.0.0/16','192.0.2.0/24','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/3'].map(cidr);
  for (const service of value.services) {
    if (!service || typeof service.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(service.id) || ids.has(service.id)
        || !['ru','en'].every(lang => typeof service.name?.[lang] === 'string' && service.name[lang].length > 0 && service.name[lang].length < 120)
        || !['ru','en'].every(lang => typeof service.description?.[lang] === 'string' && service.description[lang].length < 700)
        || typeof service.source !== 'string' || !service.source.startsWith('https://')
        || typeof service.sourceVersion !== 'string' || service.sourceVersion.length < 1 || service.sourceVersion.length > 120
        || typeof service.available !== 'boolean' || !Array.isArray(service.ipv4)) throw invalid();
    ids.add(service.id);
    service.ipv4 = union(service.ipv4);
    if (service.available && !service.ipv4.length) throw invalid();
    for (const route of service.ipv4.map(cidr)) {
      if (route.prefix < 8 || forbidden.some(block => route.start <= block.end && block.start <= route.end)) throw invalid();
    }
  }
  return value;
}
const catalog = validateCatalog(require('../data/service-catalog.json'));
function validateRouting(value, allowUnavailable = false) {
  if (!value || !['all','selected'].includes(value.mode) || !Array.isArray(value.services)
      || value.services.length > catalog.services.length) throw invalid('invalid_routing_policy');
  const ids = [...new Set(value.services)].sort();
  if (ids.some(id => !catalog.services.some(service => service.id === id && (allowUnavailable || service.available)))
      || (value.mode === 'selected' && !ids.length)) throw invalid('empty_or_unavailable_services');
  return {mode: value.mode, services: value.mode === 'all' ? [] : ids};
}
function routesFor(value, dns) {
  const policy = validateRouting(value, Array.isArray(value?.ipv4));
  if (policy.mode === 'all') return '0.0.0.0/0, ::/0';
  const routes = [...(value.ipv4 || policy.services.flatMap(id => catalog.services.find(service => service.id === id).ipv4))];
  for (const address of String(dns || '').split(',').map(item => item.trim()).filter(Boolean)) {
    if (net.isIP(address) !== 4) throw Object.assign(invalid('split_dns_ipv4_required'), {
      message: 'Для выборочных маршрутов нужен DNS с IPv4-адресом.'});
    routes.push(address + '/32');
  }
  return union(routes).join(', ');
}
function freezeRouting(value) {
  const policy = validateRouting(value);
  return {...policy, catalogDate: catalog.date, ipv4: policy.mode === 'selected'
    ? union(policy.services.flatMap(id => catalog.services.find(service => service.id === id).ipv4)) : []};
}
function storedRouting(value) {
  const policy = validateRouting(value, true);
  if (typeof value.catalogDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.catalogDate)) throw invalid();
  const data = validateCatalog({version: 1, date: value.catalogDate, services: [{
    id: 'snapshot', name: {ru: 'snapshot', en: 'snapshot'}, description: {ru: '', en: ''},
    source: 'https://localhost/snapshot', sourceVersion:value.catalogDate, available: policy.mode === 'selected', ipv4: value.ipv4
  }]});
  return {...policy, catalogDate: value.catalogDate, ipv4: data.services[0].ipv4};
}
function checkEndpoint(routes, endpoint) {
  const host = /^([^:]+):\d+$/.exec(endpoint)?.[1];
  if (net.isIP(host || '') !== 4) throw Object.assign(invalid('split_endpoint_ipv4_required'), {
    message:'Для выборочного режима нужен числовой IPv4-адрес VPN-сервера.'});
  const address = ipv4(host);
  if (routes.split(', ').map(cidr).some(route=>address >= route.start && address <= route.end)) {
    throw Object.assign(invalid('split_endpoint_overlap'), {
      message:'Адрес VPN-сервера входит в выбранные маршруты. Выберите другие сервисы или полный режим.'});
  }
}
module.exports = {catalog, validateCatalog, validateRouting, freezeRouting, storedRouting, routesFor, checkEndpoint, union, cidr};
