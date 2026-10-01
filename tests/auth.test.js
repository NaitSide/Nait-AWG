'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

test('admin password change stores a hash and invalidates previous sessions', async (t) => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-auth-'));
  const authPath = path.join(dataDirectory, 'admin-auth.json');
  process.env.NAIT_AWG_SESSION_SECRET = crypto.randomBytes(32).toString('base64');
  process.env.NAIT_AWG_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.NAIT_AWG_ADMIN_LOGIN = 'admin';
  process.env.NAIT_AWG_ADMIN_PASSWORD = 'InitialPass123!';
  process.env.NAIT_AWG_DATA_PATH = path.join(dataDirectory, 'clients.db');
  process.env.NAIT_AWG_AUTH_PATH = authPath;
  process.env.COOKIE_SECURE = 'false';

  const app = require('../app/server');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (process.platform !== 'win32') fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const login = (password) => fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password })
  });

  const loginResponse = await login('InitialPass123!');
  assert.equal(loginResponse.status, 200);
  const sessionCookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];

  const weakPasswordResponse = await fetch(`${origin}/api/admin/password`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie, Origin: origin },
    body: JSON.stringify({
      currentPassword: 'InitialPass123!',
      newPassword: 'aaaaaaaaaaaa',
      repeatPassword: 'aaaaaaaaaaaa'
    })
  });
  assert.equal(weakPasswordResponse.status, 400);
  assert.equal((await weakPasswordResponse.json()).code, 'invalid_new_password');

  const changeResponse = await fetch(`${origin}/api/admin/password`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie, Origin: origin },
    body: JSON.stringify({
      currentPassword: 'InitialPass123!',
      newPassword: 'NewPassword456!',
      repeatPassword: 'NewPassword456!'
    })
  });
  assert.equal(changeResponse.status, 200);
  assert.deepEqual(await changeResponse.json(), { status: 'ok', reauthRequired: true });

  const stored = fs.readFileSync(authPath, 'utf8');
  assert.match(stored, /"passwordHash": "scrypt\$/);
  assert.doesNotMatch(stored, /NewPassword456!/);
  assert.equal((await fetch(`${origin}/api/status`, { headers: { Cookie: sessionCookie } })).status, 401);
  assert.equal((await login('InitialPass123!')).status, 401);
  assert.equal((await login('NewPassword456!')).status, 200);
});
