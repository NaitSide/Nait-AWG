'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
const loginPage = fs.readFileSync(path.join(root, 'app', 'public', 'index.html'), 'utf8');

test('installer exposes install, future full install and update modes', () => {
  assert.match(installer, /1\) Установить только веб-панель Nait-AWG/);
  assert.match(installer, /2\) Установить AmneziaWG 3\.1 \+ веб-панель Nait-AWG — \(в разработке\)/);
  assert.match(installer, /3\) Обновить веб-интерфейс Nait-AWG/);
  assert.match(installer, /1\|install\) requested_action=install/);
  assert.match(installer, /3\|update\) requested_action=update/);
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
  assert.match(loginPage, /id="current-password" name="password"[^>]+autocomplete="current-password"/);
  assert.match(loginPage, /loginForm\.requestSubmit\(\)/);
  assert.match(loginPage, /login-validation-popover/);
});
