'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
const loginPage = fs.readFileSync(path.join(root, 'app', 'public', 'index.html'), 'utf8');

test('installer exposes install, future full install, update and credential reset modes', () => {
  assert.match(installer, /1\) Установить только веб-панель Nait-AWG/);
  assert.match(installer, /2\) Установить AmneziaWG 3\.1 \+ веб-панель Nait-AWG — \(в разработке\)/);
  assert.match(installer, /3\) Обновить веб-интерфейс Nait-AWG/);
  assert.match(installer, /4\) Сбросить логин и пароль/);
  assert.match(installer, /1\|install\) requested_action=install/);
  assert.match(installer, /3\|update\) requested_action=update/);
  assert.match(installer, /4\|reset-auth\) requested_action=reset-auth/);
});

test('reset bypasses AWG preflight and dependency installation, and credentials appear only after panel readiness', () => {
  const resetStart = installer.indexOf('if [[ "${1:-}" == reset-auth ]]; then');
  const resetEnd = installer.indexOf('[[ -r /etc/os-release ]]', resetStart);
  const reset = installer.slice(resetStart, resetEnd);
  assert.ok(resetStart > 0 && resetEnd > resetStart);
  assert.match(reset, /Установленная веб-панель Nait-AWG не найдена/);
  assert.match(reset, /admin-credentials\.js" inspect/);
  assert.match(reset, /admin-credentials\.js" reset/);
  assert.match(reset, /systemctl stop "\$PANEL_UNIT"/);
  assert.doesNotMatch(reset, /docker|RECEIVER_UNIT|selfhost-preflight|npm|useradd/);
  assert.ok(reset.indexOf('[[ "$panel_ready" == true ]]') < reset.indexOf('note "Пароль: $admin_password"'));
  assert.match(installer, /admin-credentials\.js" generate/);
  assert.doesNotMatch(installer, /read -r -s -p 'Пароль администратора|Повторите пароль:|admin_password="\$\{NAIT_AWG_ADMIN_PASSWORD/);
  assert.match(installer, /Сохраните пароль и не забудьте сменить его в настройках/);
});

test('update swaps application files without replacing persistent data', () => {
  const items = installer.match(/update_candidates=\(([^)]+)\)/)?.[1] || '';
  assert.match(items, /app/);
  assert.match(items, /node_modules/);
  assert.doesNotMatch(items, /\.env|data|tls|receiver\/state/);
  assert.match(installer, /rollback_update/);
  assert.match(installer, /Пользователи, пароль, порт и настройки сохранены/);
});

test('browser login uses password-manager semantics and Enter submission', () => {
  assert.match(loginPage, /<form id="loginForm" action="\/login" method="post" autocomplete="on">/);
  assert.match(loginPage, /name="username"[^>]+autocomplete="username"/);
  assert.doesNotMatch(loginPage, /name="username"[^>]+value="admin"/);
  assert.match(loginPage, /id="current-password" name="password"[^>]+autocomplete="current-password"/);
  assert.match(loginPage, /loginForm\.requestSubmit\(\)/);
  assert.match(loginPage, /login-validation-popover/);
});
