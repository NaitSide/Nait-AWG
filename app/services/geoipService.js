'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const rules = require('./geoipRules');
const MAX_DOWNLOAD_BYTES = 512 * 1024;
async function download(fetcher, url, signal) {
  const response = await fetcher(url, {redirect:'error', signal, headers:{accept:'text/plain, application/octet-stream'}});
  if (!response.ok || !response.body) throw rules.failure('geoip_download_failed', 'Не удалось обновить GeoIP. Предыдущие данные сохранены.');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_DOWNLOAD_BYTES)) throw rules.failure();
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_DOWNLOAD_BYTES) throw rules.failure();
    chunks.push(chunk);
  }
  // Content-Length is the compressed length when HTTP content encoding is used.
  if (declared !== null && !response.headers.get('content-encoding') && size !== Number(declared)) throw rules.failure();
  return Buffer.concat(chunks);
}
function createGeoipService({filePath, fetch:fetcher = globalThis.fetch, now = () => Date.now()} = {}) {
  let current = null, pending = null, attemptedAt = -Infinity;
  if (filePath && fs.existsSync(filePath)) {
    try {
      if (fs.statSync(filePath).size > 1024 * 1024) throw rules.failure();
      current = rules.validateSnapshot(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch { /* A broken cache cannot become an enabled policy. Saved policies retain their snapshots. */ }
  }
  function snapshot(hash) {
    if (!current || current.hash !== hash) throw rules.failure('geoip_snapshot_unavailable', 'Загрузите GeoIP заново: выбранная версия списка недоступна.');
    return structuredClone(current);
  }
  function refresh() {
    if (pending) return pending;
    if (now() - attemptedAt < 60000) throw Object.assign(rules.failure('geoip_rate_limited', 'Повторить обновление GeoIP можно через минуту.'), {status:429});
    attemptedAt = now();
    pending = (async () => {
      const signal = AbortSignal.timeout(20000);
      // Two fixed URLs; MD5 detects incomplete or inconsistent source downloads, HTTPS authenticates the source.
      const body = await download(fetcher, rules.SOURCE, signal);
      const checksums = await download(fetcher, rules.CHECKSUM_SOURCE, signal);
      const candidate = rules.parseDownload(body, checksums.toString('utf8'), now(), current);
      if (filePath) {
        fs.mkdirSync(path.dirname(filePath), {recursive:true, mode:0o700});
        const temporary = filePath + '.' + crypto.randomUUID() + '.tmp';
        try {
          fs.writeFileSync(temporary, JSON.stringify(candidate)+'\n', {mode:0o600, flag:'wx'});
          fs.renameSync(temporary, filePath);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
      current = candidate;
      return rules.metadata(current);
    })().catch(error => {
      if (error.code?.startsWith('geoip_') || error.code === 'invalid_geoip_snapshot') throw error;
      throw rules.failure('geoip_download_failed', 'Не удалось обновить GeoIP. Предыдущие данные сохранены.');
    }).finally(() => {pending = null;});
    return pending;
  }
  return {status:() => rules.metadata(current), snapshot, refresh};
}
module.exports = {createGeoipService};
