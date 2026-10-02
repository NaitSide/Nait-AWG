'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPanel } = require('../app/views/panelView');

function render(telegram, note, overrides = {}) {
  return renderPanel({
    peers: [{ id: 'aabbccddeeff', publicKeyFingerprint: 'aabbccddeeff', label: 'Клиент',
      telegram, note, address: '10.8.1.2/32', state: 'inactive', transferRx: 0, transferTx: 0, ...overrides }],
    profile: { panelIdentity: { appVersion: '0.1.0', serverHostname: 'az-hel-01', endpointHost: '217.144.186.141' } }
  });
}

test('client subline shows Telegram and note instead of key fingerprint', () => {
  const html = render('@example', 'Тестовая заметка');
  assert.match(html, /class="gate-client-contact" >@example<\/span>/);
  assert.match(html, /class="gate-note-icon"[^>]*data-note="Тестовая заметка"/);
  assert.doesNotMatch(html, /class="gate-client-contact"[^>]*>aabbccddeeff<\/span>/);
});

test('settings header identifies the panel version and current server', () => {
  const html = render('', '');
  assert.match(html, /Веб-интерфейс AmneziaWG Self-hosted/);
  assert.match(html, /class="settings-project-link" href="https:\/\/github\.com\/NaitSide\/Nait-AWG"/);
  assert.match(html, /Nait-AWG · v0\.1\.0/);
  assert.match(html, /az-hel-01 · 217\.144\.186\.141/);
});

test('node status spans the settings column and exposes an on-demand official release check', () => {
  const html = render('', '');
  assert.match(html, /class="card node-status-card"/);
  assert.match(html, /Протокол на сервере/);
  assert.match(html, /href="https:\/\/github\.com\/amnezia-vpn\/amneziawg-tools"/);
  assert.match(html, /id="awgLatestRelease">Не проверялся/);
  assert.match(html, /id="checkAwgRelease"[^>]*>Чекнуть последнюю версию/);
  assert.match(html, /Версия протокола и релиз awg-tools — разные обозначения/);
});

test('client subline shows note alone when Telegram is empty', () => {
  const html = render('', 'Тестовая заметка');
  assert.match(html, /class="gate-client-contact" hidden><\/span><button class="gate-note-icon"[^>]*data-note="Тестовая заметка"/);
});

test('client subline is hidden when Telegram and note are empty', () => {
  const html = render('', '');
  assert.match(html, /class="gate-contact-line" hidden><span class="gate-client-contact" hidden><\/span>/);
});

test('gate control follows refresh and precedes delete', () => {
  const html = render('', '');
  const refresh = html.indexOf('aria-label="Обновить список"');
  const divider = html.indexOf('class="gate-actions-divider"');
  const power = html.indexOf('id="toggleAccess"');
  const deleteButton = html.indexOf('id="deletePeer"');
  assert.ok(refresh < divider && divider < power && power < deleteButton);
  assert.match(html, /id="toggleAccess"[^>]*disabled/);
});

test('gate confirmation uses an in-page dialog with client details', () => {
  const html = render('@example', 'Заметка');
  assert.match(html, /id="accessModal" aria-hidden="true"/);
  assert.match(html, /id="accessModalTitle">Отключить VPN-клиента\?/);
  assert.match(html, /id="accessName"/);
  assert.match(html, /id="accessTelegram"/);
  assert.match(html, /id="accessAddress"/);
  assert.match(html, /id="accessNote"/);
  assert.match(html, /id="accessError" role="alert" hidden/);
});

test('disabled status stays red while handshake indicator remains online', () => {
  const html = render('', '', { state: 'active', displayStatus: 'disabled' });
  assert.match(html, /data-status="disabled"/);
  assert.match(html, /class="pill gate-status-button off"[^>]*>Отключён<\/button>/);
  assert.match(html, /class="gate-runtime-indicator online"/);
  assert.match(html, /class="gate-runtime-ping"/);
});

test('never-connected status is grey and has its own filter', () => {
  const html = render('', '', { displayStatus: 'never' });
  assert.match(html, /class="pill gate-status-button"[^>]*>Не подключался<\/button>/);
  assert.match(html, /data-status-filter="never">Не подключались/);
  assert.match(html, /data-status-filter="disabled">Отключённые/);
});

test('client row exposes a provisional access state for the checking button', () => {
  const html = render('', '', { accessState: 'on' });
  assert.match(html, /data-access-state="on"/);
  assert.match(html, /panel\.js\?v=24/);
  assert.match(html, /admin-password-popover/);
  assert.match(html, /adminPasswordRequirement/);
  assert.match(html, /novalidate/);
});

test('status badge opens a traffic modal without changing grey status colors', () => {
  const html = render('', '', { displayStatus: 'inactive' });
  assert.match(html, /class="pill gate-status-button" type="button" title="Показать трафик клиента">Неактивен<\/button>/);
  assert.match(html, /id="usageModal" aria-hidden="true"/);
  assert.match(html, /Последние 12 месяцев/);
  assert.match(html, /id="usageMonths" role="group"/);
  assert.match(html, /id="usageMonthDetail" role="status"/);
});

test('backup card offers export and a guarded restore workflow', () => {
  const html = render('', '');
  assert.match(html, /Резервная копия пользователей и настроек/);
  assert.match(html, /id="openBackup"/);
  assert.match(html, /id="backupModal" aria-hidden="true"/);
  assert.match(html, /id="backupEncrypt" type="checkbox"/);
  assert.match(html, /id="backupPasswordFields" hidden/);
  assert.match(html, /id="backupPassword" type="password"/);
  assert.match(html, /id="backupPasswordConfirm" type="password"/);
  assert.match(html, /Без пароля файл будет содержать приватные ключи/);
  assert.match(html, /id="openRestore"/);
  assert.match(html, /id="restoreModal" aria-hidden="true"/);
  assert.match(html, /id="restoreFile" type="file"/);
  assert.match(html, /id="restoreConfirm" type="checkbox"/);
  assert.match(html, /id="restoreObfuscation" type="checkbox"/);
  assert.match(html, /id="restoreProgress"/);
  assert.match(html, /Endpoint из копии/);
  assert.match(html, /Endpoint этого сервера/);
  assert.match(html, /текущие данные будут заменены/);
  assert.match(html, /panel\.js\?v=24/);
  assert.match(html, /panel\.css\?v=26/);
});
