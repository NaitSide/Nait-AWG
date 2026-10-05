'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { render, writeState, assertRoutes } = require('../scripts/fresh-awg-config');
const { parseAwgClientInterfaceParameters } = require('../vendor/receiver/src/services/awgService');
const { validate } = require('../vendor/receiver/src/services/obfuscationRules');
const root = path.join(__dirname, '..');
const bootstrap = fs.readFileSync(path.join(root, 'scripts/install-fresh-awg.sh'), 'utf8');
const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
const freshKey = () => crypto.randomBytes(32).toString('base64');

test('fresh AWG 3.1 profile exports to Receiver and remains editable, without initial peers', () => {
  for (let i = 0; i < 100; i++) {
    const config = render(freshKey(), freshKey(), 55424);
    const params = parseAwgClientInterfaceParameters(config);
    const checked = validate(params);
    assert.equal(new Set(['S1','S2','S3','S4'].map(k => checked[k])).size, 1);
    assert.equal(checked.RandomTrailers, 'on');
    assert.match(config, /^Jc = 0$/m);
    assert.ok(Number(checked.Jc) >= 4 && Number(checked.Jc) <= 12);
    assert.doesNotMatch(config, /\[Peer\]/);
    assert.match(config, /^# I1 = /m);
    assert.match(config, /^Address = 10\.8\.1\.0\/24$/m);
  }
});
test('fresh configuration rejects malformed keys and out-of-range or injected ports', () => {
  for (const port of [0, 1023, 65536, '55424\nPostUp = bad', '00444']) assert.throws(() => render(freshKey(), freshKey(), port));
  for (const key of ['', Buffer.alloc(32).toString('base64'), 'secret\n[Peer]']) assert.throws(() => render(key, freshKey(), 55424));
});
test('state creation is exclusive and contains private files, never overwritten by a retry', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-fresh-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = path.join(directory, 'state');
  writeState(state, freshKey(), freshKey(), freshKey(), 55424);
  const before = fs.readFileSync(path.join(state, 'awg0.conf'), 'utf8');
  assert.equal(fs.readFileSync(path.join(state, 'clientsTable'), 'utf8'), '[]\n');
  assert.throws(() => writeState(state, freshKey(), freshKey(), freshKey(), 55424));
  assert.equal(fs.readFileSync(path.join(state, 'awg0.conf'), 'utf8'), before);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(state).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(state, 'awg0.conf')).mode & 0o777, 0o600);
  }
});
test('subnet guard detects narrower, equal and broader route overlaps, but ignores defaults', () => {
  assert.doesNotThrow(() => assertRoutes([{dst:'default'}, {dst:'172.17.0.0/16'}, {dst:'10.8.2.1'}]));
  for (const dst of ['10.0.0.0/8','10.8.0.0/16','10.8.1.0/24','10.8.1.128/25','10.8.1.55']) assert.throws(() => assertRoutes([{dst}]));
  for (const dst of ['invalid','999.1.1.1/24','10.8.1.0/33']) assert.throws(() => assertRoutes([{dst}]));
  assert.throws(() => assertRoutes(null));
});
test('bootstrap pins official image and keeps keys private; existing panel paths do not call bootstrap', () => {
  assert.match(bootstrap, /IMAGE=amneziavpn\/amneziawg-go@sha256:[a-f0-9]{64}/);
  assert.match(bootstrap, /--network none --entrypoint awg/);
  assert.match(bootstrap, /--sysctl net.ipv4.ip_forward=1/);
  assert.match(bootstrap, /--restart always/);
  assert.doesNotMatch(bootstrap, /rm -rf|docker (rm|stop|restart)|authorized_keys/);
  assert.match(installer, /if \[\[ "\$\{1:-\}" == full \]\]; then\n  collect_install_options/);
  assert.match(installer, /официальный образ AmneziaWG 3\.1/);
  assert.match(installer, /тот же VPN-движок, что и при/);
  assert.match(installer, /flock -n 9/);
});

const bash = process.env.NAIT_AWG_TEST_BASH || (process.platform === 'win32' ? '' : 'bash');
const bashPath = process.platform === 'win32' && bash ? `export PATH='${path.dirname(bash).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase())}':"$PATH"\n` : '';
test('fresh install banner pauses for Enter before preparing the host; EOF cannot continue', {skip: !bash}, () => {
  const bannerStart = installer.indexOf("  note 'Установка AmneziaWG 3.1 + веб-интерфейс Nait-AWG'");
  const prepare = installer.indexOf('bash "$SOURCE_DIR/scripts/install-fresh-awg.sh" prepare', bannerStart);
  const banner = installer.slice(bannerStart, prepare);
  assert.ok(bannerStart > 0 && prepare > bannerStart);
  assert.match(banner, /============================================================/);
  assert.match(banner, /Нажмите Enter, чтобы продолжить/);
  assert.match(banner, /NAIT_AWG_ACCEPT_FRESH/);
  assert.doesNotMatch(banner, /Y\/n|\[Yy\]|read -n/);
  const readLine = banner.split('\n').find(line => line.includes('read -r -p'));
  const script = `set -e\nfail(){ echo "$*" >&2; exit 1; }\n${readLine.replace('</dev/tty', '')}\nprintf 'continued'\n`;
  const enter = spawnSync(bash, ['-c', bashPath + script], {encoding:'utf8', input:'\n'});
  assert.equal(enter.status, 0, enter.stderr);
  assert.equal(enter.stdout, 'continued');
  const eof = spawnSync(bash, ['-c', bashPath + script], {encoding:'utf8', input:''});
  assert.notEqual(eof.status, 0);
  assert.equal(eof.stdout, '');
});
test('all installer shell scripts parse in Bash', {skip: !bash}, () => {
  for (const filename of ['install.sh', 'scripts/install-fresh-awg.sh','scripts/start-fresh-awg.sh']) {
    const result = spawnSync(bash, ['-n', path.join(root, filename).replace(/\\/g, '/')], {encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
});
test('fresh-host guard stops on stopped containers, unavailable Docker, existing state and failed port checks', {skip: !bash}, () => {
  const guard = bootstrap.match(/assert_fresh\(\) \{[\s\S]*?\n\}/)[0];
  const portCheck = bootstrap.match(/port_free\(\) \{[\s\S]*?\n\}/)[0];
  const run = (behavior, state = '/does-not-exist-nait-fresh-test') => spawnSync(bash, ['-c', bashPath + `set -e\nSTATE_DIR='${state}'\nfail(){ echo "$*" >&2; exit 1; }\nsystemctl(){ echo not-found; }\nss(){ :; }\nip(){ echo '1: lo: <LOOPBACK>'; }\ndocker(){ :; }\n${portCheck}\n${guard}\n${behavior}\nassert_fresh`], {encoding:'utf8'});
  assert.equal(run('').status, 0);
  let result = run('docker(){ if [[ "$1" == ps ]]; then echo stopped-container; fi; }');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /контейнеры/);
  result = run('docker(){ return 1; }');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /недоступен/);
  result = run('ss(){ return 1; }');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /проверить занятость/);
  result = run('systemctl(){ echo loaded; }');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /служба/);
  result = run('', '/tmp');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /существующая установка/);
});

test('bootstrap runs the real configuration writer against simulated Docker and fails closed without deleting state', {skip: !bash}, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-bootstrap-simulation-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const shell = text => text.replace(/\\/g, '/').replace(/'/g, "'\\''");
  const privateKey = freshKey(), publicKey = freshKey(), headerKey = freshKey();
  const nodeWrapper = path.join(directory, 'node-wrapper');
  fs.writeFileSync(nodeWrapper, `#!/usr/bin/env ${process.platform === 'win32' ? 'sh' : 'bash'}\nif [[ "$1" == */selfhost-preflight.js ]]; then [[ "\${SIM_FAIL:-}" != profile ]]; exit $?; fi\nexec '${shell(process.execPath)}' "$@"\n`, {mode:0o755});
  const body = bootstrap.slice(bootstrap.indexOf('node="${2:?'));
  const imageId = bootstrap.match(/readonly IMAGE_ID=(sha256:[a-f0-9]+)/)[1];
  const run = (name, failure = '') => {
    const state = path.join(directory, name);
    const trace = path.join(directory, name + '.trace');
    const code = bashPath + `set -Eeuo pipefail
SOURCE_DIR='${shell(root)}'
STATE_DIR='${shell(state)}'
CONTAINER=amnezia-awg2
IMAGE=official-pinned-image
IMAGE_ID='${imageId}'
TRACE='${shell(trace)}'
export SIM_FAIL='${failure}'
set -- install '${shell(nodeWrapper)}' 55424
fail(){ echo "$*" >&2; exit 1; }
note(){ echo "$*" >&2; }
assert_fresh(){ :; }
ss(){ [[ "$SIM_FAIL" != busy ]] || echo occupied; }
ip(){ echo '[{"dst":"default"}]'; }
sleep(){ :; }
ufw(){ return 1; }
install(){ if [[ "$1" == -d ]]; then :; else cp "$3" "$4"; fi; }
docker(){
  # Only commands are logged, never generated private material or stdin.
  printf '%s\\n' "$*" >> "$TRACE"
  case "$1" in
    pull) [[ "$SIM_FAIL" != pull ]];;
    image)
      if [[ "$*" == *Architecture* ]]; then echo amd64;
      elif [[ "$SIM_FAIL" == image ]]; then echo wrong-id;
      else echo '${imageId}'; fi;;
    ps) :;;
    inspect) echo true;;
    run)
      if [[ "$*" == *--version* ]]; then
        if [[ "$SIM_FAIL" == version ]]; then echo 'amneziawg-tools v2.0'; else echo 'amneziawg-tools v3.1.20260812'; fi
      elif [[ "$*" == *pubkey* ]]; then echo '${publicKey}';
      elif [[ "$*" == *genkey* ]]; then
        if [[ -f "$TRACE.key" ]]; then echo '${headerKey}'; else touch "$TRACE.key"; echo '${privateKey}'; fi
      else [[ "$SIM_FAIL" != create ]]; fi;;
    exec)
      if [[ "$*" == *'test -f'* ]]; then [[ "$SIM_FAIL" != readiness ]];
      elif [[ "$*" == *listen-port* ]]; then echo 55424;
      elif [[ "$*" == *public-key* ]]; then echo '${publicKey}';
      elif [[ "$*" == *'awg0 peers'* && "$SIM_FAIL" == peers ]]; then echo unexpected-peer;
      fi;;
  esac
}
${bootstrap.match(/port_free\(\) \{[\s\S]*?\n\}/)[0]}
${body}
`;
    const result = spawnSync(bash, ['-c', code], {encoding:'utf8', timeout:15000});
    const calls = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
    assert.doesNotMatch(calls, /(?:^|\n)(?:rm|stop|restart) /);
    assert.ok(!result.stdout.includes(privateKey) && !result.stderr.includes(privateKey));
    return {result, state, calls};
  };
  const success = run('success');
  assert.equal(success.result.status, 0, success.result.stderr);
  assert.match(fs.readFileSync(path.join(success.state, 'installed.env'), 'utf8'), /UDP_PORT=55424/);
  assert.match(success.calls, /--name amnezia-awg2/);
  for (const failure of ['busy','pull','image','version']) {
    const attempt = run(failure, failure);
    assert.notEqual(attempt.result.status, 0, failure);
    assert.equal(fs.existsSync(attempt.state), false, failure);
  }
  for (const failure of ['create','readiness','peers','profile']) {
    const attempt = run(failure, failure);
    assert.notEqual(attempt.result.status, 0, failure);
    assert.ok(fs.existsSync(path.join(attempt.state, 'awg0.conf')), failure);
    assert.equal(fs.existsSync(path.join(attempt.state, 'installed.env')), false, failure);
    assert.match(attempt.result.stderr, /Ключи и конфиг сохранены/, failure);
  }
});
