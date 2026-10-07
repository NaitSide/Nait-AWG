#!/usr/bin/env node
'use strict';
const { installerText } = require('./installer-i18n');

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const net = require('node:net');
const { normalizePanelPort } = require('./panel-access');

const PASSWORD_GROUPS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '@#%*_!+-'];
const PASSWORD_ALPHABET = PASSWORD_GROUPS.join('');

function generatePassword() {
  // Uniform cryptographic sampling; reject passwords missing a required class.
  while (true) {
    const password = Array.from({ length: 12 }, () => PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)]).join('');
    if (PASSWORD_GROUPS.every(group => [...password].some(character => group.includes(character)))) return password;
  }
}

function regularFile(filename, optional = false) {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Ожидался обычный файл установленной панели.');
    return stat;
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}

function inspectInstallation(directory, options = {}) {
  const root = path.resolve(directory);
  if (fs.realpathSync(root) !== root) throw new Error('Каталог панели не должен быть символической ссылкой.');
  const envPath = path.join(root, '.env');
  const envStat = regularFile(envPath);
  regularFile(path.join(root, 'app', 'server.js'));
  const text = fs.readFileSync(envPath, 'utf8');
  const parseEnv = options.parseEnv || createRequire(path.join(root, 'app', 'server.js'))('dotenv').parse;
  const env = parseEnv(text);
  const dataDirectory = path.join(root, 'data');
  if (!fs.lstatSync(dataDirectory).isDirectory() || fs.realpathSync(dataDirectory) !== dataDirectory) {
    throw new Error('Каталог данных панели повреждён или является символической ссылкой.');
  }
  const authPath = path.resolve(env.NAIT_AWG_AUTH_PATH || path.join(path.dirname(env.NAIT_AWG_DATA_PATH || path.join(dataDirectory, 'clients.db')), 'admin-auth.json'));
  if (/[\u0000-\u001f\u007f]/.test(authPath) || authPath !== path.join(dataDirectory, 'admin-auth.json')
      || authPath === path.resolve(env.NAIT_AWG_DATA_PATH || path.join(dataDirectory, 'clients.db'))) {
    throw new Error('Нестандартный путь авторизации. Автоматический сброс разрешён только для data/admin-auth.json установленной панели.');
  }
  const authStat = regularFile(authPath, true);
  let port;
  try { port = normalizePanelPort(env.PORT); } catch { /* Report the same safe installation error below. */ }
  if (net.isIP(env.PUBLIC_ENDPOINT_HOST || '') !== 4 || port === undefined) {
    throw new Error('Не удалось прочитать адрес и порт установленной панели.');
  }
  return { root, envPath, envStat, text, env, authPath, authStat, endpoint: env.PUBLIC_ENDPOINT_HOST, port };
}

function replaceEnv(text, values) {
  const remaining = new Set(Object.keys(values));
  const result = [];
  for (const line of text.split(/\r?\n/)) {
    const key = /^\s*(?:export\s+)?([A-Z_]+)\s*=/.exec(line)?.[1];
    if (!Object.hasOwn(values, key)) { result.push(line); continue; }
    if (remaining.delete(key)) result.push(`${key}='${values[key]}'`);
  }
  for (const key of remaining) result.push(`${key}='${values[key]}'`);
  return result.join('\n').replace(/\n*$/, '\n');
}

function atomicWrite(filename, content, metadata) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    if (process.platform !== 'win32') {
      fs.fchownSync(descriptor, metadata.uid, metadata.gid);
      fs.fchmodSync(descriptor, metadata.mode & 0o777);
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filename);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function resetCredentials(directory, options = {}) {
  const installation = inspectInstallation(directory, options);
  const password = generatePassword();
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, 64);
  const auth = { schemaVersion: 1, passwordHash: `scrypt$${salt.toString('base64url')}$${digest.toString('base64url')}`,
    sessionVersion: 0, updatedAt: new Date().toISOString() };
  const nextEnv = replaceEnv(installation.text, { NAIT_AWG_ADMIN_LOGIN: 'admin', NAIT_AWG_ADMIN_PASSWORD: password,
    NAIT_AWG_SESSION_SECRET: crypto.randomBytes(32).toString('base64') });
  // The installer stops the panel and keeps a rollback copy of both files.
  // The new session secret invalidates every old cookie, even after corrupted auth state.
  const dataStat = fs.statSync(path.join(installation.root, 'data'));
  const authMetadata = installation.authStat || { uid: dataStat.uid, gid: dataStat.gid, mode: 0o600 };
  atomicWrite(installation.authPath, `${JSON.stringify(auth, null, 2)}\n`, { ...authMetadata, mode: 0o600 });
  atomicWrite(installation.envPath, nextEnv, installation.envStat);
  return { password, endpoint: installation.endpoint, port: installation.port };
}

if (require.main === module) {
  try {
    const [action, directory] = process.argv.slice(2);
    if (action === 'generate' && !directory) process.stdout.write(generatePassword());
    else if (action === 'inspect' && directory) {
      const installation = inspectInstallation(directory);
      process.stdout.write(`${installation.endpoint}\t${installation.port}\t${installation.authPath}\n`);
    } else if (action === 'reset' && directory) process.stdout.write(resetCredentials(directory).password);
    else throw new Error('Использование: admin-credentials.js generate | inspect DIR | reset DIR');
  } catch (error) {
    // No passwords, environment content or parser errors are included in diagnostics.
    console.error(installerText('Не удалось подготовить реквизиты панели:', 'Could not prepare panel credentials:'), error.code || installerText('проверьте файлы установленной панели', 'check the installed panel files'));
    process.exitCode = 1;
  }
}

module.exports = { generatePassword, inspectInstallation, replaceEnv, resetCredentials };
