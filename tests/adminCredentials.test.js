'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const { generatePassword, inspectInstallation, resetCredentials } = require('../scripts/admin-credentials');
const installer = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
const options = { parseEnv: dotenv.parse };

function fixture(t, withAuth = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-credentials-')));
  fs.mkdirSync(path.join(root, 'data'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', 'server.js'), '// fixture\n');
  const authPath = path.join(root, 'data', 'admin-auth.json');
  const envPath = path.join(root, '.env');
  const oldSecret = crypto.randomBytes(32).toString('base64');
  const dataKey = crypto.randomBytes(32).toString('base64');
  const text = `# Keep all VPN and encryption settings intact\nPORT=23670\nPUBLIC_ENDPOINT_HOST=203.0.113.42\nNAIT_AWG_ADMIN_LOGIN=owner\nNAIT_AWG_ADMIN_PASSWORD='OldInstall123!'\nexport NAIT_AWG_ADMIN_PASSWORD='Duplicate123!'\nNAIT_AWG_SESSION_SECRET=${oldSecret}\nNAIT_AWG_DATA_KEY=${dataKey}\nNAIT_AWG_DATA_PATH='${path.join(root, 'data', 'clients.db')}'\nNAIT_AWG_AUTH_PATH='${authPath}'\nRECEIVER_API_KEY=unchanged-receiver-key\nAWG_CONTAINER_NAME=amnezia-awg2\nCOOKIE_SECURE=false\nTLS_KEY_PATH=\nTLS_CERT_PATH=\n`;
  fs.writeFileSync(envPath, text, { mode: 0o640 });
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync('ChangedBeforeReset123!', salt, 64);
  const oldAuth = JSON.stringify({ schemaVersion: 1, sessionVersion: 5,
    passwordHash: `scrypt$${salt.toString('base64url')}$${digest.toString('base64url')}` });
  if (withAuth) fs.writeFileSync(authPath, oldAuth, { mode: 0o600 });
  t.after(() => { if (process.platform !== 'win32') fs.rmSync(root, { recursive: true, force: true }); });
  return { root, envPath, authPath, text, oldSecret, dataKey, oldAuth };
}

test('generated passwords have exactly 12 readable characters and all four required classes', () => {
  const samples = new Set();
  for (let index = 0; index < 1000; index++) {
    const password = generatePassword();
    assert.equal(password.length, 12);
    assert.match(password, /^[A-Za-z2-9@#%*_!+-]{12}$/);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[a-z]/);
    assert.match(password, /[2-9]/);
    assert.match(password, /[@#%*_!+-]/);
    assert.doesNotMatch(password, /[01IOl]/);
    samples.add(password);
  }
  assert.equal(samples.size, 1000);
});

test('reset replaces install and changed passwords, rotates sessions and preserves unrelated settings and file ownership', (t) => {
  const data = fixture(t);
  const metadata = fs.statSync(data.envPath);
  fs.writeFileSync(path.join(data.root, 'data', 'clients.db'), 'untouched encrypted client data');
  const result = resetCredentials(data.root, options);
  const env = dotenv.parse(fs.readFileSync(data.envPath));
  assert.equal(env.NAIT_AWG_ADMIN_LOGIN, 'admin');
  assert.equal(env.NAIT_AWG_ADMIN_PASSWORD, result.password);
  assert.equal(result.password.length, 12);
  assert.notEqual(env.NAIT_AWG_SESSION_SECRET, data.oldSecret);
  assert.equal(Buffer.from(env.NAIT_AWG_SESSION_SECRET, 'base64').length, 32);
  const original = dotenv.parse(data.text);
  for (const key of Object.keys(original).filter(key => !['NAIT_AWG_ADMIN_LOGIN', 'NAIT_AWG_ADMIN_PASSWORD', 'NAIT_AWG_SESSION_SECRET'].includes(key))) {
    assert.equal(env[key], original[key]);
  }
  const newText = fs.readFileSync(data.envPath, 'utf8');
  assert.equal((newText.match(/^NAIT_AWG_ADMIN_PASSWORD=/gm) || []).length, 1);
  assert.doesNotMatch(newText, /OldInstall123|Duplicate123/);
  assert.match(newText, /# Keep all VPN/);
  const authText = fs.readFileSync(data.authPath, 'utf8');
  assert.ok(!authText.includes(result.password));
  const auth = JSON.parse(authText);
  assert.equal(auth.schemaVersion, 1);
  const [kind, salt, digest] = auth.passwordHash.split('$');
  assert.equal(kind, 'scrypt');
  assert.equal(crypto.scryptSync(result.password, Buffer.from(salt, 'base64url'), 64).toString('base64url'), digest);
  assert.equal(fs.readFileSync(path.join(data.root, 'data', 'clients.db'), 'utf8'), 'untouched encrypted client data');
  assert.equal(result.endpoint, '203.0.113.42');
  assert.equal(result.port, 23670);
  if (process.platform !== 'win32') {
    const current = fs.statSync(data.envPath);
    assert.equal(current.mode & 0o777, metadata.mode & 0o777);
    assert.equal(current.uid, metadata.uid);
    assert.equal(current.gid, metadata.gid);
    assert.equal(fs.statSync(data.authPath).mode & 0o777, 0o600);
  }
});

test('reset handles both initial installations without auth state and a corrupt saved auth file', (t) => {
  const data = fixture(t, false);
  const first = resetCredentials(data.root, options);
  assert.ok(fs.existsSync(data.authPath));
  fs.writeFileSync(data.authPath, 'corrupted auth state');
  const second = resetCredentials(data.root, options);
  assert.notEqual(first.password, second.password);
  assert.equal(JSON.parse(fs.readFileSync(data.authPath)).schemaVersion, 1);
});

test('missing installations and auth paths outside panel data are rejected before modifying credentials', (t) => {
  const data = fixture(t);
  assert.throws(() => inspectInstallation(path.join(data.root, 'missing'), options));
  for (const target of [path.join(data.root, '..', 'outside-auth.json'), path.join(data.root, 'data', 'clients.db'),
    path.join(data.root, 'data', 'client-notes.json'), path.join(data.root, 'data', 'clients.db-wal')]) {
    const unsafeText = data.text.replace(/^NAIT_AWG_AUTH_PATH=.*$/m, `NAIT_AWG_AUTH_PATH='${target}'`);
    fs.writeFileSync(data.envPath, unsafeText);
    assert.throws(() => resetCredentials(data.root, options));
    assert.equal(fs.readFileSync(data.envPath, 'utf8'), unsafeText);
    assert.equal(fs.readFileSync(data.authPath, 'utf8'), data.oldAuth);
  }
});

test('old credentials and old cookies fail after reset, and generated admin credentials survive application restart', async (t) => {
  const data = fixture(t);
  Object.assign(process.env, dotenv.parse(data.text));
  const serverPath = require.resolve('../app/server');
  let server = require(serverPath).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  let origin = `http://127.0.0.1:${server.address().port}`;
  const login = (username, password) => fetch(`${origin}/api/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: username, password }) });
  const oldLogin = await login('owner', 'ChangedBeforeReset123!');
  assert.equal(oldLogin.status, 200);
  const cookie = oldLogin.headers.get('set-cookie').split(';', 1)[0];
  await new Promise(resolve => server.close(resolve));
  const before = crypto.createHash('sha256').update(fs.readFileSync(path.join(data.root, 'data', 'clients.db'))).digest('hex');
  const result = resetCredentials(data.root, options);
  Object.assign(process.env, dotenv.parse(fs.readFileSync(data.envPath)));
  delete require.cache[serverPath];
  server = require(serverPath).listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/api/status`, { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await login('owner', 'ChangedBeforeReset123!')).status, 401);
  assert.equal((await login('admin', 'OldInstall123!')).status, 401);
  assert.equal((await login('admin', result.password)).status, 200);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(data.root, 'data', 'clients.db'))).digest('hex'), before);
});

const bash = process.env.NAIT_AWG_TEST_BASH || (process.platform === 'win32' ? '' : 'bash');
const bashPath = process.platform === 'win32' && bash
  ? `export PATH='${path.dirname(bash).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase())}':"$PATH"\n` : '';
test('failed reset restores both previous files and restarts only the panel', { skip: !bash }, (t) => {
  const data = fixture(t);
  const backup = path.join(data.root, '.auth-reset.test');
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(backup, 'panel.env'), data.text);
  fs.writeFileSync(path.join(backup, 'admin-auth'), data.oldAuth);
  fs.writeFileSync(data.envPath, 'new failed reset');
  fs.writeFileSync(data.authPath, 'new failed reset');
  const toShell = filename => filename.replace(/\\/g, '/');
  const rollback = installer.match(/rollback_reset\(\) \{[\s\S]*?\n\}/)[0];
  const script = `set -e\nINSTALL_DIR='${toShell(data.root)}'\nPANEL_UNIT=nait-awg-selfhost.service\nreset_backup='${toShell(backup)}'\nreset_auth_path='${toShell(data.authPath)}'\nreset_stopped=true\nreset_committed=false\nreset_snapshot_ready=true\nreset_had_auth=true\nnote() { :; }\nsystemctl() { printf '%s\\n' "$*"; }\n${rollback}\nrollback_reset\n`;
  const result = spawnSync(bash, ['-c', bashPath + script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'restart nait-awg-selfhost.service');
  assert.equal(fs.readFileSync(data.envPath, 'utf8'), data.text);
  assert.equal(fs.readFileSync(data.authPath, 'utf8'), data.oldAuth);
});

test('an interrupted backup never deletes the old auth state during rollback', { skip: !bash }, (t) => {
  const data = fixture(t);
  const rollback = installer.match(/rollback_reset\(\) \{[\s\S]*?\n\}/)[0];
  const script = `set -e\nreset_stopped=true\nreset_committed=false\nreset_snapshot_ready=false\nPANEL_UNIT=nait-awg-selfhost.service\nnote() { :; }\nsystemctl() { printf '%s\\n' "$*"; }\n${rollback}\nrollback_reset\n`;
  const result = spawnSync(bash, ['-c', bashPath + script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'restart nait-awg-selfhost.service');
  assert.equal(fs.readFileSync(data.authPath, 'utf8'), data.oldAuth);
});

test('rollback of an initial password removes only newly created auth state and restores the env', { skip: !bash }, (t) => {
  const data = fixture(t, false);
  const backup = path.join(data.root, '.auth-reset.test');
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(backup, 'panel.env'), data.text);
  fs.writeFileSync(data.envPath, 'new failed reset');
  fs.writeFileSync(data.authPath, 'new hash from failed reset');
  const toShell = filename => filename.replace(/\\/g, '/');
  const rollback = installer.match(/rollback_reset\(\) \{[\s\S]*?\n\}/)[0];
  const script = `set -e\nINSTALL_DIR='${toShell(data.root)}'\nPANEL_UNIT=nait-awg-selfhost.service\nreset_backup='${toShell(backup)}'\nreset_auth_path='${toShell(data.authPath)}'\nreset_stopped=true\nreset_committed=false\nreset_snapshot_ready=true\nreset_had_auth=false\nnote() { :; }\nsystemctl() { :; }\n${rollback}\nrollback_reset\n`;
  const result = spawnSync(bash, ['-c', bashPath + script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(data.envPath, 'utf8'), data.text);
  assert.equal(fs.existsSync(data.authPath), false);
});
