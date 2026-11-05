'use strict';
const crypto = require('node:crypto');
const {range, collapseIPv4} = require('./ipv4Inverter');
const SOURCE = 'https://www.ipdeny.com/ipblocks/data/aggregated/ru-aggregated.zone';
const CHECKSUM_SOURCE = 'https://www.ipdeny.com/ipblocks/data/aggregated/MD5SUM';
const MAX_NETWORKS = 16384;
const forbidden = ['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16',
  '172.16.0.0/12','192.168.0.0/16','192.0.2.0/24','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/3'].map(range);
function failure(code = 'invalid_geoip_snapshot', message = 'Список GeoIP не прошёл проверку. Предыдущие данные сохранены.') {
  return Object.assign(new Error(message), {status:400, code});
}
function networkList(ipv4) {
  if (!Array.isArray(ipv4) || ipv4.length < 1000 || ipv4.length > MAX_NETWORKS) throw failure();
  for (const text of ipv4) {
    if (typeof text !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}\/(?:[89]|[12]\d|3[0-2])$/.test(text)) throw failure();
    const block = range(text);
    if (collapseIPv4([text])[0] !== text || forbidden.some(other => other.start <= block.end && block.start <= other.end)) throw failure();
  }
  const normalized = collapseIPv4(ipv4);
  const coverage = normalized.reduce((sum, text) => {const block = range(text); return sum + block.end - block.start + 1;}, 0);
  if (coverage < 5000000 || coverage > 100000000) throw failure();
  return {ipv4:normalized, coverage};
}
function digest(ipv4) { return crypto.createHash('sha256').update(ipv4.join('\n')+'\n').digest('hex'); }
function validateSnapshot(value) {
  if (!value || value.source !== SOURCE || !Number.isFinite(Date.parse(value.updatedAt)) || !/^[a-f0-9]{64}$/.test(value.hash || '')) throw failure();
  const {ipv4, coverage} = networkList(value.ipv4);
  if (value.hash !== digest(ipv4)) throw failure();
  return {source:SOURCE, updatedAt:new Date(value.updatedAt).toISOString(), hash:value.hash, count:ipv4.length, coverage, ipv4};
}
function metadata(value) {
  if (!value) return null;
  const {source, updatedAt, hash, count} = value;
  return {source, updatedAt, hash, count};
}
function reference(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean') throw failure();
  if (!value.enabled) return {enabled:false};
  if (!/^[a-f0-9]{64}$/.test(value.hash || '')) throw failure();
  return {enabled:true, hash:value.hash};
}
function parseDownload(buffer, checksum, now, previous) {
  const text = new TextDecoder('utf-8', {fatal:true}).decode(buffer);
  const expected = /^([a-f0-9]{32})\s+\*?(?:\.\/)?ru-aggregated\.zone\s*$/mi.exec(checksum)?.[1].toLowerCase();
  if (!expected || crypto.createHash('md5').update(buffer).digest('hex') !== expected || !text.endsWith('\n')) throw failure();
  const lines = text.trim().split(/\r?\n/);
  const {ipv4, coverage} = networkList(lines);
  if (previous && (ipv4.length < previous.count * .75 || ipv4.length > previous.count * 1.25 || coverage < previous.coverage * .75 || coverage > previous.coverage * 1.25)) {
    throw failure('geoip_unexpected_change', 'Список GeoIP сильно изменился и не был применён. Предыдущие данные сохранены.');
  }
  return validateSnapshot({source:SOURCE, updatedAt:new Date(now).toISOString(), hash:digest(ipv4), ipv4});
}
module.exports = {SOURCE, CHECKSUM_SOURCE, MAX_NETWORKS, failure, validateSnapshot, metadata, reference, parseDownload};
