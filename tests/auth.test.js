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

  const browserLoginResponse = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'InitialPass123!' })
  });
  assert.equal(browserLoginResponse.status, 303);
  assert.equal(browserLoginResponse.headers.get('location'), '/panel');
  assert.match(browserLoginResponse.headers.get('set-cookie'), /^nait_awg_session=/);

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
  const newCookie=(await login('NewPassword456!')).headers.get('set-cookie').split(';',1)[0];
  const save=(body,requestOrigin=origin)=>fetch(origin+'/api/admin/credentials',{method:'PATCH',headers:{'Content-Type':'application/json',Cookie:newCookie,Origin:requestOrigin},body:JSON.stringify(body)});
  const onlyLogin={login:'Nikita.test',currentPassword:'NewPassword456!',newPassword:'',repeatPassword:''};
  assert.equal((await save(onlyLogin,'https://another.example')).status,403);
  assert.equal((await save({...onlyLogin,currentPassword:'incorrect'})).status,401);
  assert.equal((await save({...onlyLogin,login:'<script>'})).status,400);
  assert.equal((await save({...onlyLogin,newPassword:'bad',repeatPassword:'bad'})).status,400);
  assert.equal((await save(onlyLogin)).status,200);
  assert.equal((await fetch(origin+'/api/status',{headers:{Cookie:newCookie}})).status,401);
  assert.equal((await login('NewPassword456!')).status,401);
  const namedLogin=()=>fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:'Nikita.test',password:'NewPassword456!'})});
  assert.equal((await namedLogin()).status,200);
  assert.equal(JSON.parse(fs.readFileSync(authPath,'utf8')).login,'Nikita.test');
  // Restart reads the persisted login, not the original environment fallback.
  delete require.cache[require.resolve('../app/server')];
  const restarted=require('../app/server').listen(0,'127.0.0.1');
  await once(restarted,'listening');
  t.after(()=>new Promise(resolve=>restarted.close(resolve)));
  const restartLogin=await fetch(`http://127.0.0.1:${restarted.address().port}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:'Nikita.test',password:'NewPassword456!'})});
  assert.equal(restartLogin.status,200);
});
