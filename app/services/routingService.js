'use strict';
const net = require('node:net');
const {invertIPv4}=require('./ipv4Inverter');
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
      || !Array.isArray(value.services) || value.services.length > 48) throw invalid();
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
    if(service.category!==undefined&&service.category!=='direct')throw invalid();
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
const LOCAL_NETWORKS = ['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16'];
const PRIVATE_BLOCKS = [...LOCAL_NETWORKS,'0.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16',
  '192.0.2.0/24','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/3'].map(cidr);
function publicAddress(address) {
  if (net.isIP(address) !== 4) return false;
  const number = ipv4(address);
  return !PRIVATE_BLOCKS.some(block => number >= block.start && number <= block.end);
}
function customRows(value = []) {
  if (!Array.isArray(value) || value.length > 30) throw invalid('invalid_custom_routes');
  const ids = new Set();
  return value.map(row => {
    if (!row || typeof row.id !== 'string' || !/^custom-[a-z0-9-]{1,50}$/.test(row.id) || ids.has(row.id)
        || typeof row.name !== 'string' || !row.name.trim() || row.name.trim().length > 80
        || /[\u0000-\u001f\u007f]/.test(row.name) || typeof row.enabled !== 'boolean'
        || !Array.isArray(row.ipv4) || !row.ipv4.length || row.ipv4.length > 256) throw invalid('invalid_custom_routes');
    ids.add(row.id);
    const routes = union(row.ipv4.map(address => typeof address === 'string' && net.isIP(address) === 4 ? address + '/32' : address));
    return {id:row.id,name:row.name.trim(),enabled:row.enabled,ipv4:routes};
  });
}
function resolvedServices(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > catalog.services.length) throw invalid();
  return Object.fromEntries(Object.entries(value).map(([id, item]) => {
    if (!catalog.services.some(service => service.id === id) || !item || !Array.isArray(item.ipv4)
        || item.ipv4.length > 256 || !item.ipv4.length || !Number.isFinite(Date.parse(item.updatedAt))
        || !Array.isArray(item.sources) || !item.sources.length || item.sources.length > 3 || item.sources.some(source => !['Google','Cloudflare','Yandex'].includes(source))) throw invalid();
    const routes = union(item.ipv4);
    if (routes.some(route => !route.endsWith('/32') || !publicAddress(route.slice(0,-3)))) throw invalid();
    return [id, {ipv4:routes,updatedAt:new Date(item.updatedAt).toISOString(),sources:[...new Set(item.sources)].sort()}];
  }));
}
function serviceExtras(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > catalog.services.length) throw invalid('invalid_service_extras');
  return Object.fromEntries(Object.entries(value).map(([id, ips]) => {
    if (!catalog.services.some(s => s.id === id) || !Array.isArray(ips) || !ips.length) throw invalid('invalid_service_extras');
    return [id, customRows([{id:'custom-extra',name:id,enabled:true,ipv4:ips}])[0].ipv4];
  }));
}
function validateRouting(value, allowUnavailable = false) {
  if (!value || !['all','selected','excluded'].includes(value.mode) || !Array.isArray(value.services)
      || value.services.length > catalog.services.length) throw invalid('invalid_routing_policy');
  const ids = [...new Set(value.services)].sort();
  const custom = customRows(value.custom), resolved = resolvedServices(value.resolved), extras = serviceExtras(value.extras);
  if (value.bypassLocal !== undefined && typeof value.bypassLocal !== 'boolean') throw invalid();
  if (ids.some(id => !catalog.services.some(service => service.id === id && (allowUnavailable || service.available || resolved[id]?.ipv4.length || extras[id]?.length)))
      || (value.mode === 'selected' && !ids.length && !custom.some(row => row.enabled))) throw invalid('empty_or_unavailable_services');
  let choices;
  if(value.choices!==undefined){
    if(!value.choices||typeof value.choices!=='object'||Array.isArray(value.choices)||Object.keys(value.choices).some(key=>!['selected','excluded'].includes(key)))throw invalid();
    choices=Object.fromEntries(Object.entries(value.choices).map(([key,item])=>{
      if(!item||!Array.isArray(item.services)||item.services.length>catalog.services.length||item.services.some(id=>!catalog.services.some(s=>s.id===id))||!Array.isArray(item.custom)||item.custom.length>30||item.custom.some(id=>!custom.some(row=>row.id===id)))throw invalid();
      return [key,{services:[...new Set(item.services)].sort(),custom:[...new Set(item.custom)].sort()}];
    }));
  }
  return {...(choices?{choices}:{}),mode:value.mode,services:value.mode === 'all' ? [] : ids,
    ...(value.extras !== undefined ? {extras} : {}), ...(value.custom !== undefined ? {custom} : {}), ...(value.resolved !== undefined ? {resolved} : {}),
    ...(value.bypassLocal !== undefined ? {bypassLocal:value.bypassLocal} : {})};
}
function addressText(number) { return [24,16,8,0].map(shift => Math.floor(number / 2 ** shift) % 256).join('.'); }
function subtract(routes, exclusions) {
  const blocks = exclusions.map(cidr), result = [];
  function visit(start, prefix) {
    const end = start + 2 ** (32-prefix) - 1;
    if (blocks.some(block => block.start <= start && block.end >= end)) return;
    if (!blocks.some(block => block.start <= end && block.end >= start)) {result.push(addressText(start)+'/'+prefix);return;}
    visit(start,prefix+1);visit(start+2 ** (31-prefix),prefix+1);
  }
  for (const route of routes) {
    if (route === '0.0.0.0/0') visit(0,0);
    else {const item=cidr(route);visit(item.start,item.prefix);}
  }
  return result;
}
// ::/0 except IPv6 unique-local and link-local networks. Public IPv6 stays tunneled in full mode.
function publicIpv6Routes() {
  const blocks = [[0xfc00n << 112n,0xfdffn << 112n | ((1n<<112n)-1n)],
    [0xfe80n << 112n,0xfebfn << 112n | ((1n<<112n)-1n)]];
  const result=[];
  function visit(start,prefix) {
    const end=start+(1n<<BigInt(128-prefix))-1n;
    if(blocks.some(([lo,hi])=>lo<=start&&hi>=end))return;
    if(!blocks.some(([lo,hi])=>lo<=end&&hi>=start)) {
      const hex=start.toString(16).padStart(32,'0');
      result.push((hex.match(/.{4}/g).map(part=>parseInt(part,16).toString(16)).join(':'))+'/'+prefix);return;
    }
    visit(start,prefix+1);visit(start+(1n<<BigInt(127-prefix)),prefix+1);
  }
  visit(0n,0);return result;
}
function routesFor(value, dns, endpoint) {
  const policy = validateRouting(value, Array.isArray(value?.ipv4));
  if(policy.mode==='excluded'){
    const host=endpointHost(endpoint),exclusions=value.ipv4||freezeRouting(value).ipv4;
    const parsedDns=String(dns||'').split(',').map(s=>s.trim()).filter(Boolean);
    for(const address of parsedDns){
      if(net.isIP(address)!==4)throw Object.assign(invalid('split_dns_ipv4_required'),{message:'Для выборочных маршрутов нужен DNS с IPv4-адресом.'});
      if(publicAddress(address)&&exclusions.map(cidr).some(block=>ipv4(address)>=block.start&&ipv4(address)<=block.end))throw Object.assign(invalid('excluded_dns_overlap'),{message:'DNS входит в исключения. Выберите другой DNS или измените исключения.'});
    }
    const result=invertIPv4([...exclusions,host+'/32',...(policy.bypassLocal?LOCAL_NETWORKS:[])]);
    if(!result.length)throw invalid('empty_or_unavailable_services');
    return result.join(', ');
  }
  if (policy.mode === 'all') {
    if (!policy.bypassLocal) return '0.0.0.0/0, ::/0';
    const host = endpointHost(endpoint);
    return [...subtract(['0.0.0.0/0'],[...LOCAL_NETWORKS,host+'/32']),...publicIpv6Routes()].join(', ');
  }
  const routes = [...(value.ipv4 || freezeRouting(value).ipv4)];
  for (const address of String(dns || '').split(',').map(item => item.trim()).filter(Boolean)) {
    if (net.isIP(address) !== 4) throw Object.assign(invalid('split_dns_ipv4_required'), {
    message: 'Для выборочных маршрутов нужен DNS с IPv4-адресом.'});
    if (!policy.bypassLocal || !LOCAL_NETWORKS.map(cidr).some(block => ipv4(address) >= block.start && ipv4(address) <= block.end)) routes.push(address + '/32');
  }
  const result = policy.bypassLocal ? subtract(union(routes),LOCAL_NETWORKS) : union(routes);
  if (!result.length) throw invalid('empty_or_unavailable_services');
  return result.join(', ');
}
function freezeRouting(value) {
  const policy = validateRouting(value);
  return {...policy, catalogDate: catalog.date, ipv4: policy.mode !== 'all'
    ? union([...policy.services.flatMap(id => [...catalog.services.find(service => service.id === id).ipv4,...(policy.resolved?.[id]?.ipv4 || []),...(policy.extras?.[id] || [])]),
      ...(policy.custom || []).filter(row=>row.enabled).flatMap(row=>row.ipv4)]) : []};
}
function storedRouting(value) {
  const policy = validateRouting(value, true);
  if (typeof value.catalogDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.catalogDate)) throw invalid();
  if (!Number.isFinite(Date.parse(value.catalogDate)) || new Date(value.catalogDate).toISOString().slice(0,10) !== value.catalogDate) throw invalid();
  const routes = union(value.ipv4);
  if ((policy.mode === 'selected' && !routes.length) || (policy.mode === 'all' && routes.length)) throw invalid();
  const manual=[...(policy.custom || []).filter(row=>row.enabled).flatMap(row=>row.ipv4),...policy.services.flatMap(id=>policy.extras?.[id] || [])].map(cidr);
  for(const route of routes.map(cidr)) {
    if(manual.some(block=>block.start<=route.start&&block.end>=route.end))continue;
    if(route.prefix<8 || PRIVATE_BLOCKS.some(block=>block.start<=route.end&&block.end>=route.start))throw invalid();
  }
  return {...policy,catalogDate:value.catalogDate,ipv4:routes};
}
function endpointHost(endpoint) {
  const host = /^([^:]+):\d+$/.exec(endpoint)?.[1];
  if (net.isIP(host || '') !== 4) throw Object.assign(invalid('split_endpoint_ipv4_required'), {
    message:'Для раздельного туннелирования нужен числовой IPv4-адрес VPN-сервера.'});
  return host;
}
function checkEndpoint(routes, endpoint) {
  const address = ipv4(endpointHost(endpoint));
  if (routes.split(', ').map(cidr).some(route=>address >= route.start && address <= route.end)) {
    throw Object.assign(invalid('split_endpoint_overlap'), {
      message:'Адрес VPN-сервера входит в выбранные маршруты. Выберите другие сервисы или полный режим.'});
  }
}
module.exports = {catalog, validateCatalog, validateRouting, freezeRouting, storedRouting, routesFor, checkEndpoint, union, cidr, LOCAL_NETWORKS, publicAddress, subtract};
