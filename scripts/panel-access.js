#!/usr/bin/env node
'use strict';
const { installerText } = require('./installer-i18n');
const net = require('node:net');
const fs = require('node:fs/promises');
const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');
const { validateDomainSettings } = require('../app/services/domainRules');

function normalizePanelPort(value) {
  const text = String(value ?? '');
  const port = Number(text);
  if (!/^\d{1,5}$/.test(text) || (port !== 443 && (port < 1024 || port > 65535)) || port === 42842) {
    throw new Error('Выберите 443 или порт от 1024 до 65535, кроме внутреннего порта 42842.');
  }
  return port;
}

function panelUrl(host, value) {
  if (net.isIP(host) !== 4) throw new Error('Нужен IPv4 сервера.');
  const port = normalizePanelPort(value);
  return `https://${host}${port === 443 ? '' : `:${port}`}/`;
}

async function installedPanelUrl(host, value, {
  stateFile = '/var/lib/nait-awg-domain/state.json', connect = tls.connect
} = {}) {
  const fallback = panelUrl(host, value);
  const port = normalizePanelPort(value);
  try {
    const stored = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (stored.schemaVersion !== 1 || !stored.active) return fallback;
    const { domain } = validateDomainSettings(stored.active);
    if (domain !== stored.active.domain || typeof stored.active.fingerprint !== 'string') return fallback;
    // Read-only local check: use the domain only when the restarted panel
    // actually serves its saved, unexpired certificate. No DNS/ACME request.
    const applied = await new Promise(resolve => {
      let socket;
      const finish = matched => { clearTimeout(timer); socket?.destroy(); resolve(matched); };
      const timer = setTimeout(() => finish(false), 2000);
      try {
        socket = connect({ host: '127.0.0.1', port, servername: domain, rejectUnauthorized: false });
        socket.once('secureConnect', () => {
          try {
            const cert = new X509Certificate(socket.getPeerCertificate().raw);
            const now = Date.now();
            finish(cert.fingerprint256 === stored.active.fingerprint
              && Boolean(cert.checkHost(domain, { subject: 'never' }))
              && Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) > now);
          } catch { finish(false); }
        });
        socket.once('error', () => finish(false));
        socket.once('close', () => finish(false));
      } catch { finish(false); }
    });
    if (applied) return `https://${domain}${port === 443 ? '' : `:${port}`}/`;
  } catch { /* Missing or unusable domain state must not break an update. */ }
  return fallback;
}

async function main() {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === 'port' && args.length === 1) process.stdout.write(String(normalizePanelPort(args[0])));
    else if (action === 'url' && args.length === 2) process.stdout.write(panelUrl(args[0], args[1]));
    else if (action === 'installed-url' && args.length === 2) process.stdout.write(await installedPanelUrl(args[0], args[1]));
    else throw new Error('Использование: panel-access.js port PORT | url IPv4 PORT | installed-url IPv4 PORT');
  } catch (error) {
    const messages = {
      'Выберите 443 или порт от 1024 до 65535, кроме внутреннего порта 42842.': 'Choose 443 or a port from 1024 to 65535, excluding internal port 42842.',
      'Нужен IPv4 сервера.': 'Server IPv4 is required.',
      'Использование: panel-access.js port PORT | url IPv4 PORT | installed-url IPv4 PORT': 'Usage: panel-access.js port PORT | url IPv4 PORT | installed-url IPv4 PORT'
    };
    console.error(installerText(error.message, messages[error.message] || error.message));
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { normalizePanelPort, panelUrl, installedPanelUrl };
