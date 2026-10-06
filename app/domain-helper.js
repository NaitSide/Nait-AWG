'use strict';

// Root-only certificate broker. The panel can request one validated domain,
// never supply commands, filesystem paths, certbot options or arbitrary hooks.
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns').promises;
const os = require('node:os');
const fs = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { domainError, validateDomainSettings, validateCertificate } = require('./services/domainRules');

function createBroker({ root = '/var/lib/nait-awg-domain', publicIp, gid, runner = run,
  resolver = dns, checkPort = portAvailable, clock = Date.now } = {}) {
  let active = null;
  let operation = { phase: 'idle' };
  let renewal = { lastCheckedAt: '', error: '' };
  let busy = false;
  let lastAttempt = 0;
  let job;
  const configRoot = path.join(root, 'acme');
  const stateFile = path.join(root, 'state.json');
  const common = ['--config-dir', configRoot, '--work-dir', path.join(root, 'work'),
    '--logs-dir', path.join(root, 'logs'), '--non-interactive',
    '--server', 'https://acme-v02.api.letsencrypt.org/directory'];

  async function atomicJson(file, data) {
    const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async function save() { await atomicJson(stateFile, { schemaVersion: 1, active, renewal }); }
  function status() { return { active, operation, renewal, publicIp }; }

  async function initialize() {
    await fs.mkdir(root, { recursive: true, mode: 0o750 });
    try {
      const stored = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (stored.schemaVersion !== 1) throw new Error('invalid domain state');
      if (stored.active) {
        const normalized = validateDomainSettings(stored.active);
        if (normalized.domain !== stored.active.domain || !/^[a-f0-9]{32}$/.test(stored.active.revision)
          || !Number.isSafeInteger(stored.active.generation) || stored.active.generation < 1
          || stored.active.certName !== certName(normalized.domain)) throw new Error('invalid domain state');
        active = stored.active;
      }
      renewal = stored.renewal || renewal;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async function preflight(domain) {
    operation = { phase: 'checking', domain };
    let addresses;
    try { addresses = await resolver.resolve4(domain); }
    catch { throw domainError('domain_dns', 'Не найдена A-запись домена. Направьте её на IP этого сервера и дождитесь обновления DNS.'); }
    if (!net.isIPv4(publicIp) || !addresses.length || addresses.some(ip => ip !== publicIp)) {
      throw domainError('domain_dns_mismatch', 'A-запись домена указывает не на этот сервер. Исправьте её и дождитесь обновления DNS.');
    }
    // A stale AAAA record can make the CA contact a different server.
    let ipv6 = [];
    try { ipv6 = await resolver.resolve6(domain); }
    catch (error) { if (!['ENODATA', 'ENOTFOUND'].includes(error.code)) throw domainError('domain_dns', 'Не удалось проверить AAAA-запись. Повторите позже.'); }
    const localV6 = Object.values(os.networkInterfaces()).flat().filter(item => item?.family === 'IPv6').map(item => item.address);
    if (ipv6.some(ip => !localV6.includes(ip))) {
      throw domainError('domain_ipv6', 'AAAA-запись направляет домен на другой IPv6-адрес. Исправьте или удалите её.');
    }
    await checkPort();
  }

  async function publish(settings) {
    const live = path.join(configRoot, 'live', settings.certName);
    const [key, cert] = await Promise.all(['privkey.pem', 'fullchain.pem'].map(file => fs.readFile(path.join(live, file))));
    const checked = validateCertificate(key, cert, settings.domain, clock());
    if (active?.domain === settings.domain && active?.fingerprint === checked.fingerprint) {
      const next = { ...active, email: settings.email };
      await atomicJson(stateFile, { schemaVersion: 1, active: next, renewal });
      active = next;
      return;
    }
    const revision = crypto.randomBytes(16).toString('hex');
    const directory = path.join(root, 'certificates', revision);
    await fs.mkdir(directory, { recursive: true, mode: 0o750 });
    await fs.chown(directory, 0, gid);
    for (const [name, data] of [['key.pem', key], ['cert.pem', cert]]) {
      const file = path.join(directory, name);
      await fs.writeFile(file, data, { mode: 0o640, flag: 'wx' });
      await fs.chown(file, 0, gid);
    }
    // Publish the pointer last. Incomplete candidate files cannot replace active TLS.
    const next = { ...settings, revision, generation: (active?.generation || 0) + 1, ...checked };
    await atomicJson(stateFile, { schemaVersion: 1, active: next, renewal });
    active = next;
  }

  function certbotError(error) {
    const output = `${error.stderr || ''}\n${error.stdout || ''}`;
    if (/address already in use|could not bind|cannot bind/i.test(output)) return 'Порт 80 занят другой программой. Текущий доступ сохранён.';
    if (/unauthorized|timeout|timed out|connection refused|invalid response/i.test(output)) return 'Не удалось подтвердить домен. Проверьте DNS и доступность TCP-порта 80 из интернета.';
    if (/rateLimited|too many|rate limit/i.test(output)) return 'Достигнут лимит выпуска Let’s Encrypt. Повторите позже; текущий доступ сохранён.';
    return 'Не удалось получить сертификат. Текущий доступ сохранён. Подробности доступны в журнале службы сертификатов.';
  }

  function configure(body) {
    const settings = validateDomainSettings(body);
    if (busy) throw domainError('domain_busy', 'Операция с сертификатом уже выполняется.', 409);
    if (lastAttempt && clock() - lastAttempt < 30000) throw domainError('domain_wait', 'Подождите 30 секунд перед повторной попыткой.', 429);
    busy = true;
    lastAttempt = clock();
    operation = { phase: 'checking', domain: settings.domain };
    job = (async () => {
      try {
        await preflight(settings.domain);
        operation = { phase: 'issuing', domain: settings.domain };
        const name = certName(settings.domain);
        await runner('/usr/bin/certbot', ['certonly', '--standalone', '--preferred-challenges', 'http',
          '--cert-name', name, '-d', settings.domain, '--email', settings.email,
          '--agree-tos', '--keep-until-expiring', ...common], { timeout: 180000, maxBuffer: 1024 * 1024 });
        operation = { phase: 'applying', domain: settings.domain };
        const previousRenewal = renewal;
        renewal = { lastCheckedAt: new Date(clock()).toISOString(), error: '' };
        try { await publish({ ...settings, certName: name }); }
        catch (error) { renewal = previousRenewal; throw error; }
        operation = { phase: 'done', domain: settings.domain };
      } catch (error) {
        const message = error.code && error.status ? error.message : certbotError(error);
        operation = { phase: 'error', domain: settings.domain, message };
        console.error('[nait-awg-domain]', error.code || 'certificate_failed');
        if (error.stderr) console.error(String(error.stderr).slice(-3000));
      } finally { busy = false; }
    })();
    return status();
  }

  async function renew() {
    if (!active || busy) return;
    busy = true;
    const previousOperation = operation;
    try {
      await preflight(active.domain);
      operation = { phase: 'renewing', domain: active.domain };
      await runner('/usr/bin/certbot', ['renew', '--cert-name', active.certName, '--standalone',
        '--no-random-sleep-on-renew', '--no-directory-hooks', ...common],
      { timeout: 180000, maxBuffer: 1024 * 1024 });
      renewal = { lastCheckedAt: new Date(clock()).toISOString(), error: '' };
      await publish(active);
      operation = previousOperation;
    } catch (error) {
      renewal = { lastCheckedAt: new Date(clock()).toISOString(), error: error.status ? error.message : certbotError(error) };
      await save().catch(() => console.error('[nait-awg-domain] cannot_save_renewal_status'));
      operation = previousOperation;
      console.error('[nait-awg-domain] renewal_failed');
    } finally { busy = false; }
  }
  return { initialize, status, configure, renew, wait: () => job };
}

function certName(domain) { return 'nait-awg-' + crypto.createHash('sha256').update(domain).digest('hex').slice(0, 16); }
function portAvailable() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(domainError('domain_port_busy', 'TCP-порт 80 занят другой программой. Освободите его; автоматически останавливать программы мы не будем.')));
    probe.listen(80, '0.0.0.0', () => probe.close(resolve));
  });
}

async function start() {
  if (process.getuid?.() !== 0) throw new Error('Certificate helper must run as root');
  const { stdout } = await run('/usr/bin/id', ['-g', 'nait-awg']);
  const gid = Number(stdout.trim());
  if (!Number.isSafeInteger(gid) || gid < 1) throw new Error('Invalid panel group');
  const broker = createBroker({ publicIp: process.env.PUBLIC_ENDPOINT_HOST || '', gid });
  await broker.initialize();
  const socket = '/run/nait-awg-domain/helper.sock';
  await fs.unlink(socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const server = http.createServer(async (req, res) => {
    const respond = (code, payload) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.url !== '/domain') return respond(404, {});
    if (req.method === 'GET') return respond(200, broker.status());
    if (req.method !== 'POST') return respond(405, {});
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 4096) throw domainError('domain_request_large', 'Запрос слишком большой.', 413);
      }
      return respond(202, broker.configure(JSON.parse(body)));
    } catch (error) { return respond(error.status || 400, { code: error.code || 'invalid_request', message: error.status ? error.message : 'Некорректный запрос.' }); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await fs.chown(socket, 0, gid);
  await fs.chmod(socket, 0o660);
  setTimeout(() => broker.renew(), 30000).unref();
  setInterval(() => broker.renew(), 12 * 60 * 60 * 1000).unref();
}

if (require.main === module) start().catch(error => { console.error('[nait-awg-domain]', error.message); process.exit(1); });
module.exports = { createBroker, certName };
