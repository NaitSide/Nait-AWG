'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

test('client config upload requires login and same origin, with a bounded dedicated JSON parser', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-config-api-'));
  process.env.NAIT_AWG_SESSION_SECRET = crypto.randomBytes(32).toString('base64');
  process.env.NAIT_AWG_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.NAIT_AWG_ADMIN_LOGIN = 'admin';
  process.env.NAIT_AWG_ADMIN_PASSWORD = 'TestPassword123!';
  process.env.NAIT_AWG_DATA_PATH = path.join(directory, 'clients.db');
  process.env.COOKIE_SECURE = 'false';
  const server = require('../app/server').listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const target = `${origin}/api/peers/aabbccddeeff/config/import`;
  const body = JSON.stringify({ config: 'x'.repeat(60000) });
  const anonymous = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(anonymous.status, 401);
  const login = await fetch(`${origin}/api/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'admin', password: 'TestPassword123!' }) });
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const wrongOrigin = await fetch(target, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://other.example' }, body });
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await wrongOrigin.json()).code, 'invalid_origin');
  const malformed = await fetch(target, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin }, body });
  assert.equal(malformed.status, 400); // reaches config validation, not the generic 32 KB parser
  assert.equal((await malformed.json()).code, 'invalid_client_config');
  const tooLargeConfig = await fetch(target, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ config: 'x'.repeat(65537) }) });
  assert.equal(tooLargeConfig.status, 400);
  assert.equal((await tooLargeConfig.json()).code, 'invalid_client_config');
  const tooLargeBody = await fetch(target, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ config: 'x'.repeat(524289) }) });
  assert.equal(tooLargeBody.status, 413);
  assert.equal((await tooLargeBody.json()).code, 'client_config_too_large');
  const brokenJson = await fetch(target, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: '{"config":"sensitive-client-data"' });
  assert.equal(brokenJson.status, 400);
  const safeError = await brokenJson.text();
  assert.match(safeError, /invalid_client_config_json/);
  assert.doesNotMatch(safeError, /sensitive-client-data/);
});
