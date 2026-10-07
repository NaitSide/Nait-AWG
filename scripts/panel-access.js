#!/usr/bin/env node
'use strict';
const net = require('node:net');

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

if (require.main === module) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === 'port' && args.length === 1) process.stdout.write(String(normalizePanelPort(args[0])));
    else if (action === 'url' && args.length === 2) process.stdout.write(panelUrl(args[0], args[1]));
    else throw new Error('Использование: panel-access.js port PORT | url IPv4 PORT');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { normalizePanelPort, panelUrl };
