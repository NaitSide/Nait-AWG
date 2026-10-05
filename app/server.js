'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const express = require('express');
const path = require('path');
const { version: appVersion } = require('../package.json');
const { createHttpError, createAwgService } = require('./services/awgService');
const { getLatestAwgToolsRelease, getLatestNaitAwgVersion } = require('./services/releaseService');
const { renderPanel: renderAwgPanel } = require('./views/panelView');

const app = express();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8443);
const tlsKeyPath = String(process.env.TLS_KEY_PATH || '').trim();
const tlsCertPath = String(process.env.TLS_CERT_PATH || '').trim();
const tlsEnabled = Boolean(tlsKeyPath || tlsCertPath);
const cookieSecure = tlsEnabled || String(process.env.COOKIE_SECURE || '').trim().toLowerCase() !== 'false';
const sessionSecret = Buffer.from(String(process.env.NAIT_AWG_SESSION_SECRET || ''), 'base64');
const sessionTtlSeconds = Number(process.env.NAIT_AWG_SESSION_TTL_SECONDS || 12 * 60 * 60);
const adminLogin = String(process.env.NAIT_AWG_ADMIN_LOGIN || 'admin').trim();
const adminPassword = String(process.env.NAIT_AWG_ADMIN_PASSWORD || '');
const serverHostname = os.hostname();
const publicEndpointHost = String(process.env.PUBLIC_ENDPOINT_HOST || '').trim();
const panelDataPath = String(process.env.NAIT_AWG_DATA_PATH || path.join(__dirname, '..', 'data', 'clients.db')).trim();
const adminAuthPath = String(process.env.NAIT_AWG_AUTH_PATH || path.join(path.dirname(panelDataPath), 'admin-auth.json')).trim();
const panelService = createAwgService();

if (sessionSecret.length < 32) throw new Error('NAIT_AWG_SESSION_SECRET must contain at least 32 random bytes encoded as base64');
if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds < 3600 || sessionTtlSeconds > 90 * 24 * 60 * 60) throw new Error('NAIT_AWG_SESSION_TTL_SECONDS must be between 3600 and 7776000');
if (adminPassword.length < 12) throw new Error('NAIT_AWG_ADMIN_PASSWORD must contain at least 12 characters');
if (tlsEnabled && (!tlsKeyPath || !tlsCertPath)) throw new Error('TLS_KEY_PATH and TLS_CERT_PATH must be set together');

function loadAdminAuthState() {
  try {
    const stored = JSON.parse(fs.readFileSync(adminAuthPath, 'utf8'));
    if (stored.schemaVersion !== 1 || typeof stored.passwordHash !== 'string' || !Number.isSafeInteger(stored.sessionVersion) || stored.sessionVersion < 0) {
      throw new Error('invalid admin auth state');
    }
    if (stored.login !== undefined && !/^[a-zA-Z0-9_.-]{1,64}$/.test(stored.login)) throw new Error('invalid admin login');
    return { login: stored.login || adminLogin, passwordHash: stored.passwordHash, sessionVersion: stored.sessionVersion };
  } catch (error) {
    if (error.code === 'ENOENT') return { login: adminLogin, passwordHash: '', sessionVersion: 0 };
    throw new Error(`Cannot read Nait-AWG admin auth state: ${error.message}`);
  }
}

let adminAuthState = loadAdminAuthState();

app.disable('x-powered-by');
const standardJsonParser = express.json({ limit: '32kb' });
const restoreJsonParser = express.json({ limit: '40mb' });
const clientConfigJsonParser = express.json({ limit: '512kb' });
function parseClientConfigJson(req, res, next) {
  clientConfigJsonParser(req, res, error => {
    if (!error) return next();
    // Do not log or echo malformed JSON containing client private keys.
    const tooLarge = error.type === 'entity.too.large';
    return res.status(tooLarge ? 413 : 400).json({ code: tooLarge ? 'client_config_too_large' : 'invalid_client_config_json',
      message: tooLarge ? 'Файл подключения слишком большой.' : 'Некорректный формат запроса загрузки конфига.' });
  });
}
app.use((req, res, next) => {
  if (req.path === '/api/restore/inspect' || req.path === '/api/restore') return next();
  if (req.method === 'POST' && /^\/api\/peers\/[^/]+\/config\/import$/.test(req.path)) return next();
  return standardJsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

function stringsMatch(received, expected) {
  const receivedBuffer = Buffer.from(String(received ?? ''));
  const expectedBuffer = Buffer.from(String(expected ?? ''));
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

function passwordMatches(password) {
  if (!adminAuthState.passwordHash) return stringsMatch(password, adminPassword);
  const [algorithm, encodedSalt, encodedDigest] = adminAuthState.passwordHash.split('$');
  if (algorithm !== 'scrypt' || !encodedSalt || !encodedDigest) return false;
  try {
    const salt = Buffer.from(encodedSalt, 'base64url');
    const expected = Buffer.from(encodedDigest, 'base64url');
    const received = crypto.scryptSync(String(password || ''), salt, expected.length);
    return expected.length > 0 && crypto.timingSafeEqual(received, expected);
  } catch {
    return false;
  }
}

async function saveAdminCredentials(login, password) {
  const nextState = {
    schemaVersion: 1,
    login,
    passwordHash: createPasswordHash(password),
    sessionVersion: adminAuthState.sessionVersion + 1,
    updatedAt: new Date().toISOString()
  };
  const directory = path.dirname(adminAuthPath);
  const temporaryPath = `${adminAuthPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.promises.mkdir(directory, { recursive: true });
  try {
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temporaryPath, adminAuthPath);
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => {});
  }
  adminAuthState = { login, passwordHash: nextState.passwordHash, sessionVersion: nextState.sessionVersion };
}

function readCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    try { cookies[decodeURIComponent(part.slice(0, separator).trim())] = decodeURIComponent(part.slice(separator + 1).trim()); } catch {}
  }
  return cookies;
}

function isAuthenticated(req) {
  const token = readCookies(req.headers.cookie).nait_awg_session;
  const [expiresAt, sessionVersion, nonce, signature] = String(token || '').split('.');
  if (!expiresAt || !sessionVersion || !nonce || !signature || Number(expiresAt) < Date.now()) return false;
  if (Number(sessionVersion) !== adminAuthState.sessionVersion) return false;
  const expected = sign(`${expiresAt}.${sessionVersion}.${nonce}`);
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ code: 'unauthorized', message: 'Войдите в панель.' });
}

function requirePageAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.redirect(303, '/');
}

function sendError(res, error) {
  const status = error.status || 500;
  console.error('[nait-awg]', error.code || 'internal_error', error.message);
  const safeOperationalMessage=['obfuscation_pending','obfuscation_pending_invalid','obfuscation_pending_conflict','obfuscation_rollback_failed','obfuscation_apply_failed'].includes(error.code);
  res.status(status).json({ code: error.code || 'internal_error', message: status < 500 || safeOperationalMessage ? error.message : 'Внутренняя ошибка панели.' });
}

function credentialsMatch(body) {
  return stringsMatch(body?.username ?? body?.login, adminAuthState.login) && passwordMatches(body?.password);
}

function issueSession(res) {
  const expiresAt = String(Date.now() + sessionTtlSeconds * 1000);
  const nonce = crypto.randomBytes(18).toString('base64url');
  const payload = `${expiresAt}.${adminAuthState.sessionVersion}.${nonce}`;
  const token = `${payload}.${sign(payload)}`;
  res.setHeader('Set-Cookie', `nait_awg_session=${token}; HttpOnly; ${cookieSecure ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=${sessionTtlSeconds}`);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function renderPanel(peers, profile, notice = '') {
  const rows = peers.map((peer) => {
    const controls = peer.hasConfig
      ? `<a class="button" href="/api/peers/${encodeURIComponent(peer.id)}/config">Скачать конфиг</a><a class="button" target="_blank" rel="noopener" href="/api/peers/${encodeURIComponent(peer.id)}/qr">QR</a>`
      : '<span class="muted">Конфиг не сохранён</span>';
    const remove = peer.canDelete
      ? `<form method="post" action="/panel/peers/${encodeURIComponent(peer.id)}/delete"><button class="button danger" type="submit">Удалить</button></form>`
      : '<span class="muted">Существующий peer</span>';
    return `<tr><td><strong>${escapeHtml(peer.label)}</strong><small>${escapeHtml(peer.publicKeyFingerprint)}</small></td><td>${escapeHtml(peer.address)}</td><td>${escapeHtml(peer.state === 'active' ? 'Активен' : 'Неактивен')}</td><td class="controls">${controls}${remove}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nait-AWG</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600&display=swap" rel="stylesheet"><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-width:320px;color:#e6edf3;background:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px),#0d0b14;background-size:48px 48px;font:14px Montserrat,system-ui,sans-serif}main{width:min(1100px,calc(100% - 32px));margin:42px auto}.panel{overflow:hidden;margin:18px 0;border:1px solid rgba(255,255,255,.1);border-radius:16px;background:linear-gradient(145deg,rgba(28,30,39,.96),rgba(17,15,24,.98))}header{display:flex;justify-content:space-between;gap:20px;align-items:center;padding:22px;border-bottom:1px solid rgba(255,255,255,.08)}h1,h2{margin:0}p,.muted,small{color:#8b949e}small{display:block;margin-top:5px;font-size:11px}.new-peer{display:flex;gap:10px;align-items:end;padding:18px}.new-peer label{display:grid;gap:7px;flex:1;color:#aeb4bd;font-size:12px}input{height:42px;padding:0 12px;border:1px solid rgba(255,255,255,.12);border-radius:9px;background:#0d0b14;color:#e6edf3;font:inherit}.button{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:8px 12px;border:1px solid #4d836f;border-radius:9px;background:#259b76;color:#f3fffb;font:600 12px Montserrat,sans-serif;text-decoration:none;cursor:pointer}.button.danger{border-color:#854656;background:#4a2430}table{width:100%;border-collapse:collapse}th,td{padding:14px 18px;text-align:left;border-top:1px solid rgba(255,255,255,.08)}th{color:#8b949e;font-size:11px}.controls{display:flex;flex-wrap:wrap;gap:7px}.controls form{margin:0}.notice{margin:18px 0;padding:12px 15px;border:1px solid #367b67;border-radius:10px;background:#173c34;color:#9ee8d3}@media(max-width:700px){main{width:min(100% - 20px,1100px);margin:18px auto}header,.new-peer{align-items:stretch;flex-direction:column}.controls{min-width:210px}table{min-width:700px}.panel{overflow:auto}}</style></head><body><main><header><div><h1>Nait-AWG</h1><p>Frankfurt · ${escapeHtml(profile.interface || 'awg0')} · ${peers.length} peer</p></div><form method="post" action="/logout"><button class="button danger" type="submit">Выйти</button></form></header>${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}<section class="panel"><header><div><h2>Доступы</h2><p>Nait-AWG управляет только peer, созданными этой панелью.</p></div></header><form class="new-peer" method="post" action="/panel/peers"><label>Имя нового клиента<input name="label" maxlength="80" required placeholder="например, iPhone-Nikita"></label><button class="button" type="submit">Выдать доступ</button></form><table><thead><tr><th>КЛИЕНТ</th><th>АДРЕС</th><th>СТАТУС</th><th>ДЕЙСТВИЯ</th></tr></thead><tbody>${rows}</tbody></table></section></main></body></html>`;
}

function initials(label) {
  return String(label || '—').split(/[\s_.-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase().slice(0, 2) || '—';
}

function formatBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Number(value || 0);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(amount >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function activityHtml(peer) {
  if (!peer.latestHandshakeAt) return '<span class="activity-empty">Нет handshake</span>';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(peer.latestHandshakeAt).getTime()) / 1000));
  const age = seconds < 60 ? 'только что' : seconds < 3600 ? `${Math.floor(seconds / 60)} мин назад` : `${Math.floor(seconds / 3600)} ч назад`;
  return `<div class="traffic"><span>↓ <b>${formatBytes(peer.transferRx)}</b></span><span>↑ <b>${formatBytes(peer.transferTx)}</b></span></div><small>${age}</small>`;
}

function renderPanelV2(peers, profile, options = {}) {
  const selected = options.selected;
  const topActions = selected?.hasConfig
    ? `<a class="toolbar-icon" title="Показать QR" target="_blank" rel="noopener" href="/api/peers/${encodeURIComponent(selected.id)}/qr">⌗</a><a class="toolbar-icon" title="Скачать конфиг" href="/api/peers/${encodeURIComponent(selected.id)}/config">⇩</a>`
    : '<span class="toolbar-icon disabled">⌗</span><span class="toolbar-icon disabled">⇩</span>';
  const deleteAction = selected?.canDelete
    ? `<form method="post" action="/panel/peers/${encodeURIComponent(selected.id)}/delete"><button class="toolbar-icon danger" title="Удалить peer" type="submit">⌫</button></form>`
    : '<span class="toolbar-icon danger disabled">⌫</span>';
  const rows = peers.map((peer) => {
    const isSelected = selected?.id === peer.id;
    const live = peer.state === 'active';
    const status = live ? 'Активен' : 'Неактивен';
    const selectUrl = `/panel?selected=${encodeURIComponent(peer.id)}`;
    return `<tr class="${isSelected ? 'selected' : ''} selectable" role="link" tabindex="0" onclick="window.location.href='${selectUrl}'" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.location.href='${selectUrl}'}"><td><span class="user-cell"><span class="avatar">${escapeHtml(initials(peer.label))}<i class="${live ? 'live' : ''}"></i></span><span><b>${escapeHtml(peer.label)}</b><small>${escapeHtml(peer.publicKeyFingerprint)}</small></span></span></td><td>${activityHtml(peer)}</td><td>${escapeHtml(peer.address)}</td><td>${peer.hasConfig ? '<span class="config-state">Есть</span>' : '<span class="muted">—</span>'}</td><td><span class="pill ${live ? 'live' : ''}">${status}</span></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">Клиенты не найдены.</td></tr>';
  const filter = options.filter || 'all';
  const query = escapeHtml(options.query || '');
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'nait-awg', timestamp: new Date().toISOString() }));
app.post('/api/login', (req, res) => {
  console.info('[nait-awg] login attempt');
  if (!credentialsMatch(req.body)) {
    console.info('[nait-awg] login rejected');
    return res.status(401).json({ code: 'invalid_credentials', message: 'Неверные данные.' });
  }
  issueSession(res);
  res.setHeader('Connection', 'close');
  console.info('[nait-awg] login accepted');
  return res.json({ status: 'ok' });
});
app.post('/login', (req, res) => {
  if (!credentialsMatch(req.body)) return res.redirect(303, '/?error=1');
  issueSession(res);
  return res.redirect(303, '/panel');
});
app.post('/api/logout', (_req, res) => { res.setHeader('Set-Cookie', `nait_awg_session=; HttpOnly; ${cookieSecure ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=0`); res.status(204).end(); });
app.post('/logout', (_req, res) => { res.setHeader('Set-Cookie', `nait_awg_session=; HttpOnly; ${cookieSecure ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=0`); res.redirect(303, '/'); });
app.get('/api/session', (req, res) => res.json({ authenticated: isAuthenticated(req) }));
let adminCredentialsBusy = false;
app.patch(['/api/admin/credentials', '/api/admin/password'], requireAuth, async (req, res) => {
  const origin = req.get('origin');
  const expectedOrigin = `${tlsEnabled ? 'https' : 'http'}://${req.get('host')}`;
  if (origin && origin !== expectedOrigin) return res.status(403).json({ code: 'invalid_origin', message: 'Недопустимый источник запроса.' });
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  const repeatPassword = String(req.body?.repeatPassword || '');
  const login = req.path === '/api/admin/password' ? adminAuthState.login : String(req.body?.login || '').trim();
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(login)) return res.status(400).json({ code: 'invalid_admin_login', message: 'Логин: от 1 до 64 символов, латинские буквы, цифры, точка, дефис или подчёркивание.' });
  if (adminCredentialsBusy) return res.status(409).json({ code: 'credentials_busy', message: 'Реквизиты уже сохраняются. Повторите вход.' });
  if (!passwordMatches(currentPassword)) return res.status(401).json({ code: 'invalid_current_password', message: 'Текущий пароль указан неверно.' });
  const passwordIsStrong = newPassword.length >= 12
    && newPassword.length <= 256
    && /^[a-zA-Z0-9@#%^*_.!+\-]+$/.test(newPassword)
    && /[a-z]/.test(newPassword)
    && /[A-Z]/.test(newPassword)
    && /[0-9]/.test(newPassword)
    && /[@#%^*_.!+\-]/.test(newPassword);
  const changePassword = req.path === '/api/admin/password' || Boolean(newPassword || repeatPassword);
  if (changePassword && !passwordIsStrong) {
    return res.status(400).json({ code: 'invalid_new_password', message: 'Пароль слишком простой. Используйте от 12 до 256 символов: минимум одну заглавную и одну строчную латинскую букву, одну цифру и один специальный символ @#%^*_.!+-.' });
  }
  if (newPassword !== repeatPassword) return res.status(400).json({ code: 'password_mismatch', message: 'Новые пароли не совпадают.' });
  if (changePassword && passwordMatches(newPassword)) return res.status(400).json({ code: 'password_unchanged', message: 'Новый пароль совпадает с текущим.' });
  if (!changePassword && login === adminAuthState.login) return res.status(400).json({ code: 'credentials_unchanged', message: 'Логин и пароль не изменены.' });
  adminCredentialsBusy = true;
  try {
    await saveAdminCredentials(login, changePassword ? newPassword : currentPassword);
    res.setHeader('Set-Cookie', `nait_awg_session=; HttpOnly; ${cookieSecure ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=0`);
    return res.json({ status: 'ok', reauthRequired: true });
  } catch (error) {
    return sendError(res, error);
  } finally {
    adminCredentialsBusy = false;
  }
});
app.get('/api/status', requireAuth, async (_req, res) => { try { res.json(await panelService.receiver('/awg/profile')); } catch (error) { sendError(res, error); } });
function requireSameOrigin(req,res,next){
  const origin=req.get('origin');
  if(origin&&origin!==`${tlsEnabled?'https':'http'}://${req.get('host')}`)return res.status(403).json({code:'invalid_origin',message:'Недопустимый источник запроса.'});
  next();
}
app.get('/api/obfuscation',requireAuth,async(_req,res)=>{try{res.json(await panelService.getObfuscation());}catch(error){sendError(res,error);}});
for(const [route,method] of [['generate','generateObfuscation'],['inspect','inspectObfuscation'],['apply','setObfuscation']]){
  app.post('/api/obfuscation/'+route,requireAuth,requireSameOrigin,async(req,res)=>{
    try{res.json(await panelService[method](req.body));}catch(error){sendError(res,error);}
  });
}
app.get('/api/awg/releases/latest', requireAuth, async (_req, res) => {
  try { return res.json(await getLatestAwgToolsRelease()); }
  catch (error) {
    console.error('[nait-awg] awg_release_check_failed', error.message);
    return res.status(502).json({ code: 'awg_release_check_failed', message: 'Не удалось проверить GitHub. Попробуйте позже.' });
  }
});
app.get('/api/versions/latest', requireAuth, async (_req, res) => {
  const [awgToolsResult, naitAwgResult] = await Promise.allSettled([
    getLatestAwgToolsRelease(),
    getLatestNaitAwgVersion()
  ]);
  const payload = {
    awgTools: awgToolsResult.status === 'fulfilled' ? awgToolsResult.value : null,
    naitAwg: naitAwgResult.status === 'fulfilled' ? naitAwgResult.value : null
  };
  if (!payload.awgTools) console.error('[nait-awg] awg_release_check_failed', awgToolsResult.reason?.message || 'Unknown error');
  if (!payload.naitAwg) console.error('[nait-awg] nait_awg_version_check_failed', naitAwgResult.reason?.message || 'Unknown error');
  if (!payload.awgTools && !payload.naitAwg) {
    return res.status(502).json({ code: 'version_check_failed', message: 'Не удалось проверить GitHub. Попробуйте позже.' });
  }
  return res.json(payload);
});
app.post('/api/backup', requireAuth, async (req, res) => {
  const origin = req.get('origin');
  const expectedOrigin = `${tlsEnabled ? 'https' : 'http'}://${req.get('host')}`;
  if (origin && origin !== expectedOrigin) return res.status(403).json({ code: 'invalid_origin', message: 'Недопустимый источник запроса.' });
  try {
    const backup = await panelService.createBackup(req.body?.passphrase);
    const stamp = backup.createdAt.replace(/[:.]/g, '-');
    res.attachment(`nait-awg-backup-${stamp}-${backup.encryption ? 'encrypted' : 'plain'}.json`);
    return res.type('application/json').send(JSON.stringify(backup, null, 2) + '\n');
  } catch (error) { return sendError(res, error); }
});
app.post('/api/restore/inspect', requireAuth, restoreJsonParser, async (req, res) => {
  const origin = req.get('origin');
  const expectedOrigin = `${tlsEnabled ? 'https' : 'http'}://${req.get('host')}`;
  if (origin && origin !== expectedOrigin) return res.status(403).json({ code: 'invalid_origin', message: 'Недопустимый источник запроса.' });
  try { return res.json(await panelService.inspectBackup(req.body?.backup, req.body?.passphrase)); }
  catch (error) { return sendError(res, error); }
});
app.post('/api/restore', requireAuth, restoreJsonParser, async (req, res) => {
  const origin = req.get('origin');
  const expectedOrigin = `${tlsEnabled ? 'https' : 'http'}://${req.get('host')}`;
  if (origin && origin !== expectedOrigin) return res.status(403).json({ code: 'invalid_origin', message: 'Недопустимый источник запроса.' });
  if (req.body?.confirmed !== true) return res.status(400).json({ code: 'restore_not_confirmed', message: 'Подтвердите замену текущих данных.' });
  if (req.body?.restoreObfuscation !== undefined && typeof req.body.restoreObfuscation !== 'boolean') {
    return res.status(400).json({ code: 'invalid_restore_option', message: 'Некорректный выбор параметров обфускации.' });
  }
  try { return res.json(await panelService.restoreBackup(req.body?.backup, req.body?.passphrase,
    { restoreObfuscation: req.body?.restoreObfuscation === true })); }
  catch (error) { return sendError(res, error); }
});
app.get('/api/peers', requireAuth, async (_req, res) => { try { res.json(await panelService.listPeers()); } catch (error) { sendError(res, error); } });
app.post('/api/peers', requireAuth, async (req, res) => { try { res.status(201).json(await panelService.createPeer(req.body)); } catch (error) { sendError(res, error); } });
app.get('/api/peers/:fingerprint/access', requireAuth, async (req, res) => { try { res.json(await panelService.readPeerAccess(req.params.fingerprint)); } catch (error) { sendError(res, error); } });
app.get('/api/peers/:fingerprint/usage', requireAuth, async (req, res) => { try { res.json(await panelService.getUsage(req.params.fingerprint)); } catch (error) { sendError(res, error); } });
app.post('/api/peers/:fingerprint/access', requireAuth, async (req, res) => { try { res.json(await panelService.setPeerAccess(req.params.fingerprint, req.body?.enabled)); } catch (error) { sendError(res, error); } });
app.get('/api/peers/:fingerprint/config', requireAuth, async (req, res) => { try { const { client, config, extension } = await panelService.getClientExport(req.params.fingerprint, req.query.format); res.set('Cache-Control', 'no-store').type('text/plain').attachment(`${client.receiverLabel}.${extension}`).send(config); } catch (error) { sendError(res, error); } });
app.get('/api/peers/:fingerprint/qr', requireAuth, async (req, res) => { try { res.type('image/svg+xml').send(await panelService.getQr(req.params.fingerprint)); } catch (error) { sendError(res, error); } });
app.post('/api/peers/:fingerprint/config/import', requireAuth, parseClientConfigJson, async (req, res) => {
  const origin = req.get('origin');
  if (origin && origin !== `${tlsEnabled ? 'https' : 'http'}://${req.get('host')}`) {
    return res.status(403).json({ code: 'invalid_origin', message: 'Недопустимый источник запроса.' });
  }
  try { res.json(await panelService.importClientConfig(req.params.fingerprint, req.body)); }
  catch (error) { sendError(res, error); }
});
app.put('/api/peers/:fingerprint/note', requireAuth, async (req, res) => { try { res.json(await panelService.updatePeerNote(req.params.fingerprint, req.body?.note)); } catch (error) { sendError(res, error); } });
app.put('/api/peers/:fingerprint/metadata', requireAuth, async (req, res) => { try { res.json(await panelService.updatePeerMetadata(req.params.fingerprint, req.body)); } catch (error) { sendError(res, error); } });
app.delete('/api/peers/:fingerprint', requireAuth, async (req, res) => { try { await panelService.deletePeer(req.params.fingerprint); res.status(204).end(); } catch (error) { sendError(res, error); } });
app.get('/panel', requirePageAuth, async (req, res) => {
  try {
    let profile;
    try {
      profile = await panelService.receiver('/awg/profile');
    } catch (error) {
      console.error('[nait-awg] awg_profile_unavailable', error.message);
      profile = { status: 'unavailable', container: { running: false }, peersCount: null,
        listenPort: null, protocolVersion: '', error: 'receiver_unavailable' };
    }
    let peers = [];
    if (profile.status === 'ok') {
      try { peers = await panelService.listPeers(); }
      catch (error) {
        console.error('[nait-awg] awg_peer_inventory_unavailable', error.message);
        profile = { ...profile, status: 'error', error: 'awg_peer_inventory_unavailable' };
      }
    }
    const selectedId = String(req.query.selected || '');
    const notice = req.query.created ? `Доступ «${String(req.query.created)}» создан. Выберите строку для QR или скачивания.`
      : req.query.restored ? 'Резервная копия успешно восстановлена.' : '';
    return res.type('html').send(renderAwgPanel({ peers,
      profile: { ...profile, panelIdentity: { appVersion, serverHostname, endpointHost: publicEndpointHost } },
      selectedId, notice, adminLogin: adminAuthState.login }));
  } catch (error) { return sendError(res, error); }
});
app.post('/panel/peers', requirePageAuth, async (req, res) => { try { const peer = await panelService.createPeer(req.body); res.redirect(303, `/panel?selected=${encodeURIComponent(peer.id)}&created=${encodeURIComponent(peer.label)}`); } catch (error) { sendError(res, error); } });
app.post('/panel/peers/:fingerprint/delete', requirePageAuth, async (req, res) => { try { await panelService.deletePeer(req.params.fingerprint); res.redirect(303, '/panel'); } catch (error) { sendError(res, error); } });
app.get('/', (req, res, next) => { if (isAuthenticated(req)) return res.redirect(303, '/panel'); return next(); });
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.use((_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  const server = tlsEnabled
    ? https.createServer({ key: fs.readFileSync(tlsKeyPath), cert: fs.readFileSync(tlsCertPath) }, app)
    : app;
  server.listen(port, host, () => {
    console.log(`Nait-AWG listening on ${tlsEnabled ? 'https' : 'http'}://${host}:${port}`);
    panelService.startUsageTracking();
  });
}

module.exports = app;
