'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPanel } = require('../app/views/panelView');

function render(telegram, note, overrides = {}, profileOverrides = {}) {
  return renderPanel({
    peers: [{ id: 'aabbccddeeff', publicKeyFingerprint: 'aabbccddeeff', label: 'Клиент',
      telegram, note, address: '10.8.1.2/32', state: 'inactive', transferRx: 0, transferTx: 0, ...overrides }],
    profile: { status: 'ok', container: { running: true }, peersCount: 39, protocolVersion: '3.1', listenPort: 39428,
      panelIdentity: { appVersion: '0.1.0', serverHostname: 'az-hel-01', endpointHost: '217.144.186.141' }, ...profileOverrides }
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
  assert.match(html, /<h2>Статус<\/h2><p>39 клиентов<\/p>/);
  assert.match(html, /Версия протокола <b>AmneziaWG 3\.1<\/b>/);
  assert.match(html, /Endpoint <b>217\.144\.186\.141:39428<\/b>/);
  assert.match(html, /Состояние AWG <b class="node-runtime-state ok">/);
  assert.match(html, /<h3>Проверка версий<\/h3>/);
  assert.match(html, />Работает<\/b>/);
  assert.doesNotMatch(html, />Interface /);
  assert.doesNotMatch(html, />Listen port /);
  assert.match(html, /На этом сервере/);
  assert.match(html, /На GitHub/);
  assert.match(html, /<strong role="rowheader">awg-tools<\/strong><span role="cell">AWG 3\.1<\/span>/);
  assert.match(html, /<strong role="rowheader">Nait-AWG<\/strong><span role="cell">v0\.1\.0<\/span>/);
  assert.match(html, /id="awgLatestRelease"[^>]*>Не проверено/);
  assert.match(html, /id="naitLatestVersion"[^>]*>Не проверено/);
  assert.match(html, /id="checkVersions"[^>]*>Проверить/);
  assert.match(html, /id="versionCheckStatus"[^>]*hidden/);
  assert.doesNotMatch(html, /awg-tools на GitHub/);
  assert.doesNotMatch(html, /Опубликован/);
});

test('node status explains what to check when the AWG container does not answer', () => {
  const html = render('', '', {}, { status: 'unavailable', container: { running: false }, peersCount: null,
    protocolVersion: '', listenPort: null });
  assert.match(html, /Количество клиентов недоступно/);
  assert.match(html, /AWG недоступен/);
  assert.match(html, /Состояние AWG <b class="node-runtime-state error">/);
  assert.match(html, />Не отвечает<\/b>/);
  assert.match(html, /Проверьте, что Docker запущен, а контейнер AWG находится в состоянии Up/);
});

test('node status distinguishes a running container with an unreadable profile', () => {
  const html = render('', '', {}, { status: 'error', container: { running: true }, protocolVersion: '' });
  assert.match(html, />Ошибка конфигурации<\/b>/);
  assert.match(html, /Контейнер запущен, но панель не смогла прочитать профиль AmneziaWG/);
});

test('node status explains Receiver and peer inventory failures separately', () => {
  const receiverHtml = render('', '', {}, { status: 'unavailable', container: { running: false },
    error: 'receiver_unavailable', protocolVersion: '' });
  assert.match(receiverHtml, /контейнер Nait-AWG Receiver/);
  const peersHtml = render('', '', {}, { status: 'error', container: { running: true },
    error: 'awg_peer_inventory_unavailable' });
  assert.match(peersHtml, />Ошибка чтения<\/b>/);
  assert.match(peersHtml, /не смогла получить список клиентов/);
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
  assert.match(html, /panel\.js\?v=34/);
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

test('missing configs have a separate explanation button without replacing traffic status', () => {
  const html = render('', '', { hasConfig: false, displayStatus: 'inactive' });
  assert.match(html, /gate-status-button[^>]*title="Показать трафик клиента">Неактивен/);
  assert.match(html, /class="gate-config-info"[^>]*aria-label="Почему недоступны конфиг и QR-код"><svg[^>]*width="18" height="18"[^>]*stroke-width="1\.333333"/);
  assert.match(html, /id="clientConfigModal"/);
  assert.match(html, /<circle cx="12" cy="12" r="10" stroke-width="1\.066667"\/>/);
  assert.match(html, /<line x1="12" x2="12" y1="8" y2="12"\/>/);
  assert.match(html, /Действующее VPN-подключение сохраняется/);
  assert.doesNotMatch(html, /Загрузить конфиг|Посмотреть трафик|id="clientConfigHelp"|id="clientConfigText"/);
  assert.match(html, /id="openClientConfigImport"[^>]*>Импортировать \.conf/);
  assert.match(html, /id="clientConfigForm" hidden/);
  assert.match(html, /id="clientConfigFile" type="file" accept="\.conf,\.vpn" required/);
  assert.doesNotMatch(render('', '', { hasConfig: true }), /class="gate-config-info"/);
});

test('backup card offers export and a guarded restore workflow', () => {
  const html = render('', '');
  assert.match(html, /Резервная копия пользователей и настроек/);
  assert.doesNotMatch(html, /импорт \/ экспорт/);
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
  assert.match(html, /panel\.js\?v=34/);
  assert.match(html, /panel\.css\?v=39/);
});
