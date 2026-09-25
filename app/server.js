'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const express = require('express');
const path = require('path');
const { createHttpError, createSoloService } = require('./services/soloService');
const { renderPanel: renderSoloPanel } = require('./views/panelView');

const app = express();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8443);
const tlsKeyPath = String(process.env.TLS_KEY_PATH || '').trim();
const tlsCertPath = String(process.env.TLS_CERT_PATH || '').trim();
const tlsEnabled = Boolean(tlsKeyPath || tlsCertPath);
const cookieSecure = tlsEnabled || String(process.env.COOKIE_SECURE || '').trim().toLowerCase() !== 'false';
const sessionSecret = Buffer.from(String(process.env.SOLO_SESSION_SECRET || ''), 'base64');
const sessionTtlSeconds = Number(process.env.SOLO_SESSION_TTL_SECONDS || 12 * 60 * 60);
const adminLogin = String(process.env.SOLO_ADMIN_LOGIN || 'NaitSide').trim();
const adminPassword = String(process.env.SOLO_ADMIN_PASSWORD || '');
const solo = createSoloService();

if (sessionSecret.length < 32) throw new Error('SOLO_SESSION_SECRET must contain at least 32 random bytes encoded as base64');
if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds < 3600 || sessionTtlSeconds > 90 * 24 * 60 * 60) throw new Error('SOLO_SESSION_TTL_SECONDS must be between 3600 and 7776000');
if (adminPassword.length < 12) throw new Error('SOLO_ADMIN_PASSWORD must contain at least 12 characters');
if (tlsEnabled && (!tlsKeyPath || !tlsCertPath)) throw new Error('TLS_KEY_PATH and TLS_CERT_PATH must be set together');

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
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
  const token = readCookies(req.headers.cookie).solo_session;
  const [expiresAt, nonce, signature] = String(token || '').split('.');
  if (!expiresAt || !nonce || !signature || Number(expiresAt) < Date.now()) return false;
  const expected = sign(`${expiresAt}.${nonce}`);
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
  console.error('[nait-awg-solo]', error.code || 'internal_error', error.message);
  res.status(status).json({ code: error.code || 'internal_error', message: status < 500 ? error.message : 'Внутренняя ошибка панели.' });
}

function credentialsMatch(body) {
  const receivedLogin = Buffer.from(String(body?.login || ''));
  const expectedLogin = Buffer.from(adminLogin);
  const receivedPassword = Buffer.from(String(body?.password || ''));
  const expectedPassword = Buffer.from(adminPassword);
  return receivedLogin.length === expectedLogin.length
    && receivedPassword.length === expectedPassword.length
    && crypto.timingSafeEqual(receivedLogin, expectedLogin)
    && crypto.timingSafeEqual(receivedPassword, expectedPassword);
}

function issueSession(res) {
  const expiresAt = String(Date.now() + sessionTtlSeconds * 1000);
  const nonce = crypto.randomBytes(18).toString('base64url');
  const token = `${expiresAt}.${nonce}.${sign(`${expiresAt}.${nonce}`)}`;
  res.setHeader('Set-Cookie', `solo_session=${token}; HttpOnly; ${cookieSecure ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=${sessionTtlSeconds}`);
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
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nait AWG Solo</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600&display=swap" rel="stylesheet"><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-width:320px;color:#e6edf3;background:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px),#0d0b14;background-size:48px 48px;font:14px Montserrat,system-ui,sans-serif}main{width:min(1100px,calc(100% - 32px));margin:42px auto}.panel{overflow:hidden;margin:18px 0;border:1px solid rgba(255,255,255,.1);border-radius:16px;background:linear-gradient(145deg,rgba(28,30,39,.96),rgba(17,15,24,.98))}header{display:flex;justify-content:space-between;gap:20px;align-items:center;padding:22px;border-bottom:1px solid rgba(255,255,255,.08)}h1,h2{margin:0}p,.muted,small{color:#8b949e}small{display:block;margin-top:5px;font-size:11px}.new-peer{display:flex;gap:10px;align-items:end;padding:18px}.new-peer label{display:grid;gap:7px;flex:1;color:#aeb4bd;font-size:12px}input{height:42px;padding:0 12px;border:1px solid rgba(255,255,255,.12);border-radius:9px;background:#0d0b14;color:#e6edf3;font:inherit}.button{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:8px 12px;border:1px solid #4d836f;border-radius:9px;background:#259b76;color:#f3fffb;font:600 12px Montserrat,sans-serif;text-decoration:none;cursor:pointer}.button.danger{border-color:#854656;background:#4a2430}table{width:100%;border-collapse:collapse}th,td{padding:14px 18px;text-align:left;border-top:1px solid rgba(255,255,255,.08)}th{color:#8b949e;font-size:11px}.controls{display:flex;flex-wrap:wrap;gap:7px}.controls form{margin:0}.notice{margin:18px 0;padding:12px 15px;border:1px solid #367b67;border-radius:10px;background:#173c34;color:#9ee8d3}@media(max-width:700px){main{width:min(100% - 20px,1100px);margin:18px auto}header,.new-peer{align-items:stretch;flex-direction:column}.controls{min-width:210px}table{min-width:700px}.panel{overflow:auto}}</style></head><body><main><header><div><h1>Nait AWG Solo</h1><p>Frankfurt · ${escapeHtml(profile.interface || 'awg0')} · ${peers.length} peer</p></div><form method="post" action="/logout"><button class="button danger" type="submit">Выйти</button></form></header>${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}<section class="panel"><header><div><h2>Доступы</h2><p>Solo управляет только peer, созданными этой панелью.</p></div></header><form class="new-peer" method="post" action="/panel/peers"><label>Имя нового клиента<input name="label" maxlength="80" required placeholder="например, iPhone-Nikita"></label><button class="button" type="submit">Выдать доступ</button></form><table><thead><tr><th>КЛИЕНТ</th><th>АДРЕС</th><th>СТАТУС</th><th>ДЕЙСТВИЯ</th></tr></thead><tbody>${rows}</tbody></table></section></main></body></html>`;
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

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'nait-awg-solo', timestamp: new Date().toISOString() }));
app.post('/api/login', (req, res) => {
  console.info('[nait-awg-solo] login attempt');
  if (!credentialsMatch(req.body)) {
    console.info('[nait-awg-solo] login rejected');
    return res.status(401).json({ code: 'invalid_credentials', message: 'Неверные данные.' });
  }
  issueSession(res);
  res.setHeader('Connection', 'close');
  console.info('[nait-awg-solo] login accepted');
  return res.json({ status: 'ok' });
});
app.post('/login', (req, res) => {
  if (!credentialsMatch(req.body)) return res.redirect(303, '/?error=1');
  issueSession(res);
  return res.redirect(303, '/panel');
});
app.post('/api/logout', (_req, res) => { res.setHeader('Set-Cookie', `solo_session=; HttpOnly; ${cookieSecure ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=0`); res.status(204).end(); });
app.post('/logout', (_req, res) => { res.setHeader('Set-Cookie', `solo_session=; HttpOnly; ${cookieSecure ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=0`); res.redirect(303, '/'); });
app.get('/api/session', (req, res) => res.json({ authenticated: isAuthenticated(req) }));
app.get('/api/status', requireAuth, async (_req, res) => { try { res.json(await solo.receiver('/awg/profile')); } catch (error) { sendError(res, error); } });
app.post('/api/backup', requireAuth, async (req, res) => {
  const origin = req.get('origin');
  const expectedOrigin = `${tlsEnabled ? 'https' : 'http'}://${req.get('host')}`;
  if (origin && origin !== expectedOrigin) return res.status(403).json({ code: 'invalid_origin', message: 'Недопустимый источник запроса.' });
  try {
    const backup = await solo.createBackup(req.body?.passphrase);
    const stamp = backup.createdAt.replace(/[:.]/g, '-');
    res.attachment(`nait-awg-backup-${stamp}-${backup.encryption ? 'encrypted' : 'plain'}.json`);
    return res.type('application/json').send(JSON.stringify(backup, null, 2) + '\n');
  } catch (error) { return sendError(res, error); }
});
app.get('/api/peers', requireAuth, async (_req, res) => { try { res.json(await solo.listPeers()); } catch (error) { sendError(res, error); } });
app.post('/api/peers', requireAuth, async (req, res) => { try { res.status(201).json(await solo.createPeer(req.body)); } catch (error) { sendError(res, error); } });
app.get('/api/peers/:fingerprint/access', requireAuth, async (req, res) => { try { res.json(await solo.readPeerAccess(req.params.fingerprint)); } catch (error) { sendError(res, error); } });
app.get('/api/peers/:fingerprint/usage', requireAuth, async (req, res) => { try { res.json(await solo.getUsage(req.params.fingerprint)); } catch (error) { sendError(res, error); } });
app.post('/api/peers/:fingerprint/access', requireAuth, async (req, res) => { try { res.json(await solo.setPeerAccess(req.params.fingerprint, req.body?.enabled)); } catch (error) { sendError(res, error); } });
app.get('/api/peers/:fingerprint/config', requireAuth, async (req, res) => { try { const { client, config } = await solo.getConfig(req.params.fingerprint); res.type('text/plain').attachment(`${client.receiverLabel}.conf`).send(config); } catch (error) { sendError(res, error); } });
app.get('/api/peers/:fingerprint/qr', requireAuth, async (req, res) => { try { res.type('image/svg+xml').send(await solo.getQr(req.params.fingerprint)); } catch (error) { sendError(res, error); } });
app.put('/api/peers/:fingerprint/note', requireAuth, async (req, res) => { try { res.json(await solo.updatePeerNote(req.params.fingerprint, req.body?.note)); } catch (error) { sendError(res, error); } });
app.put('/api/peers/:fingerprint/metadata', requireAuth, async (req, res) => { try { res.json(await solo.updatePeerMetadata(req.params.fingerprint, req.body)); } catch (error) { sendError(res, error); } });
app.delete('/api/peers/:fingerprint', requireAuth, async (req, res) => { try { await solo.deletePeer(req.params.fingerprint); res.status(204).end(); } catch (error) { sendError(res, error); } });
app.get('/panel', requirePageAuth, async (req, res) => { try { const [peers, profile] = await Promise.all([solo.listPeers(), solo.receiver('/awg/profile')]); const selectedId = String(req.query.selected || ''); const notice = req.query.created ? `Доступ «${String(req.query.created)}» создан. Выберите строку для QR или скачивания.` : ''; res.type('html').send(renderSoloPanel({ peers, profile, selectedId, notice })); } catch (error) { sendError(res, error); } });
app.post('/panel/peers', requirePageAuth, async (req, res) => { try { const peer = await solo.createPeer(req.body); res.redirect(303, `/panel?selected=${encodeURIComponent(peer.id)}&created=${encodeURIComponent(peer.label)}`); } catch (error) { sendError(res, error); } });
app.post('/panel/peers/:fingerprint/delete', requirePageAuth, async (req, res) => { try { await solo.deletePeer(req.params.fingerprint); res.redirect(303, '/panel'); } catch (error) { sendError(res, error); } });
app.get('/', (req, res, next) => { if (isAuthenticated(req)) return res.redirect(303, '/panel'); return next(); });
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.use((_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  const server = tlsEnabled
    ? https.createServer({ key: fs.readFileSync(tlsKeyPath), cert: fs.readFileSync(tlsCertPath) }, app)
    : app;
  server.listen(port, host, () => {
    console.log(`Nait AWG Solo listening on ${tlsEnabled ? 'https' : 'http'}://${host}:${port}`);
    solo.startUsageTracking();
  });
}

module.exports = app;
