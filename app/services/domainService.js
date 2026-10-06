'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { domainError, validateDomainSettings, validateCertificate } = require('./domainRules');

const SOCKET_PATH = '/run/nait-awg-domain/helper.sock';
const CERT_ROOT = '/var/lib/nait-awg-domain/certificates';

function createDomainService({ socketPath = SOCKET_PATH, certRoot = CERT_ROOT, enabled = true } = {}) {
  let server;
  let fingerprint = '';
  let appliedDomain = '';
  let generation = 0;
  let syncing;

  function request(method, body) {
    if (!enabled) return Promise.reject(domainError('domain_unavailable', 'Подключение домена доступно после обновления через установщик.', 503));
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : '';
      const req = http.request({ socketPath, path: '/domain', method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; if (text.length > 16384) res.destroy(); });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const result = JSON.parse(text);
            if (res.statusCode >= 400) return reject(domainError(result.code || 'domain_failed', result.message || 'Не удалось подключить домен.', res.statusCode));
            resolve(result);
          } catch { reject(domainError('domain_unavailable', 'Служба сертификатов недоступна. Текущий доступ сохранён.', 503)); }
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error('domain helper timeout')));
      req.on('error', () => reject(domainError('domain_unavailable', 'Служба сертификатов недоступна. Текущий доступ сохранён.', 503)));
      req.end(data);
    });
  }

  async function sync(state) {
    if (!server || !state.active || state.active.fingerprint === fingerprint) return;
    if (!Number.isSafeInteger(state.active.generation) || state.active.generation < 1) throw new Error('invalid certificate generation');
    if (state.active.generation < generation) return;
    const { revision, domain } = state.active;
    if (!/^[a-f0-9]{32}$/.test(revision)) throw new Error('invalid certificate revision');
    const base = path.join(certRoot, revision);
    const [key, cert] = await Promise.all(['key.pem', 'cert.pem'].map(file => fs.promises.readFile(path.join(base, file))));
    const checked = validateCertificate(key, cert, domain);
    if (checked.fingerprint !== state.active.fingerprint) throw new Error('certificate fingerprint mismatch');
    server.setSecureContext({ key, cert, minVersion: 'TLSv1.2' });
    fingerprint = checked.fingerprint;
    appliedDomain = domain;
    generation = state.active.generation;
  }

  async function status() {
    const state = await request('GET');
    // Serialize context updates so a slow read cannot replace a newer certificate.
    if (!syncing) syncing = sync(state).finally(() => { syncing = undefined; });
    try { await syncing; }
    catch { throw domainError('domain_apply_failed', 'Не удалось подключить сертификат к панели. Прежний доступ сохранён.', 503); }
    const active = state.active;
    return { available: true, domain: active?.domain || '', email: active?.email || '',
      connected: Boolean(active && appliedDomain === active.domain && fingerprint === active.fingerprint),
      expiresAt: active?.expiresAt || '', autoRenew: Boolean(active),
      publicIp: state.publicIp, operation: state.operation, renewal: state.renewal };
  }

  return {
    status,
    async configure(body) { await request('POST', validateDomainSettings(body)); return status(); },
    async attach(tlsServer) {
      server = tlsServer;
      // Startup always has a usable fallback certificate; the helper is optional.
      let startupError;
      for (let attempt = 0; attempt < 5; attempt++) {
        try { await status(); startupError = undefined; break; }
        catch (error) {
          startupError = error;
          if (error.code !== 'domain_unavailable') break;
          if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
      if (startupError) console.error('[nait-awg]', startupError.code);
      const timer = setInterval(() => status().catch(error => console.error('[nait-awg]', error.code)), 60000);
      timer.unref();
      server.once('close', () => clearInterval(timer));
    }
  };
}

module.exports = { createDomainService };
