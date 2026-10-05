'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { parseClientConfig } = require('../app/services/clientConfigService');

test('authenticated downloads select conf or vpn without changing stored client data', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-export-api-'));
  const dataKey = crypto.randomBytes(32);
  Object.assign(process.env, { NAIT_AWG_SESSION_SECRET:crypto.randomBytes(32).toString('base64'),
    NAIT_AWG_DATA_KEY:dataKey.toString('base64'), NAIT_AWG_ADMIN_LOGIN:'admin', NAIT_AWG_ADMIN_PASSWORD:'TestPassword123!',
    NAIT_AWG_DATA_PATH:path.join(directory,'clients.db'), COOKIE_SECURE:'false' });
  const server = require('../app/server').listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const privateKey = crypto.randomBytes(32).toString('base64');
  const native = `[Interface]\nPrivateKey = ${privateKey}\nAddress = 10.8.1.2/32\nHeaderProtectionKey = 12345\n\n[Peer]\nPublicKey = ${crypto.randomBytes(32).toString('base64')}\nEndpoint = 203.0.113.42:40000\nAllowedIPs = 0.0.0.0/0\n`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const bytes = Buffer.concat([cipher.update(native,'utf8'),cipher.final()]);
  const encrypted = [iv,cipher.getAuthTag(),bytes].map(b=>b.toString('base64')).join('.');
  const db = new DatabaseSync(process.env.NAIT_AWG_DATA_PATH);
  db.prepare("INSERT INTO clients (client_id,label,receiver_label,public_key_fingerprint,address,encrypted_config,status,created_at) VALUES (?,?,?,?,?,?,'active',?)")
    .run('test-client','Клиент','Client-test','aabbccddeeff','10.8.1.2/32',encrypted,new Date().toISOString());
  t.after(() => db.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const endpoint = origin + '/api/peers/aabbccddeeff/config';
  assert.equal((await fetch(endpoint+'?format=amneziavpn')).status,401);
  const login = await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({login:'admin',password:'TestPassword123!'})});
  const headers = {Cookie:login.headers.get('set-cookie').split(';',1)[0]};
  const conf = await fetch(endpoint,{headers});
  assert.equal(conf.status,200); assert.equal(await conf.text(),native);
  assert.match(conf.headers.get('content-disposition'), /Client-test\.conf/);
  assert.equal(conf.headers.get('cache-control'),'no-store');
  const vpn = await fetch(endpoint+'?format=amneziavpn',{headers});
  assert.equal(vpn.status,200); assert.match(vpn.headers.get('content-disposition'),/Client-test\.vpn/);
  assert.equal(vpn.headers.get('cache-control'),'no-store');
  assert.equal(parseClientConfig(await vpn.text(),['HeaderProtectionKey']).config,native);
  const bad = await fetch(endpoint+'?format=other',{headers});
  assert.equal(bad.status,400); assert.equal((await bad.json()).code,'unsupported_client_format');
  assert.equal((await fetch(origin+'/api/peers/000000000000/config?format=amneziavpn',{headers})).status,404);
  const qrEndpoint=origin+'/api/peers/aabbccddeeff/qr';
  assert.equal((await fetch(qrEndpoint+'?format=amneziavpn')).status,401);
  const qr=await fetch(qrEndpoint+'?format=amneziavpn',{headers});
  assert.equal(qr.status,200);assert.equal(qr.headers.get('cache-control'),'no-store');
  const series=await qr.json();assert.ok(series.frames.length>=1);assert.equal(series.format,'amneziavpn');
  assert.ok(series.frames.every(frame=>frame.startsWith('data:image/svg+xml;base64,')));
  const nativeQr=await fetch(qrEndpoint,{headers});assert.equal(nativeQr.status,200);assert.equal(nativeQr.headers.get('cache-control'),'no-store');assert.match(await nativeQr.text(),/<svg/);
  assert.equal((await fetch(qrEndpoint+'?format=other',{headers})).status,400);
  assert.equal((await fetch(origin+'/api/peers/000000000000/qr?format=amneziavpn',{headers})).status,404);
  assert.equal(db.prepare('SELECT encrypted_config FROM clients WHERE client_id=?').get('test-client').encrypted_config,encrypted);
});
