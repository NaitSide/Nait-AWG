'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { renderPanel } = require('../app/views/panelView');
test('QR and download dialogs have compact application tabs, copy actions and safe app links', () => {
  const html = renderPanel({ peers:[], profile:{} });
  for (const kind of ['qr','download']) {
    for (const format of ['awg','vpn']) assert.match(html,new RegExp(`data-share-modal="${kind}" data-share-format="${format}"`));
  }
  assert.match(html,/id="clientDownloadModal"/);
  assert.match(html,/<button class="btn purple" id="copyQr"[^>]*disabled>Скопировать QR/);
  assert.ok(html.indexOf('id="copyQr"') < html.indexOf('id="downloadQr"'));
  assert.match(html,/id="qrMultipartHint" hidden/);
  assert.match(html,/QR переключается автоматически/);
  assert.match(html,/дождитесь, пока приложение считает оба кадра/);
  assert.match(html,/target="_blank" rel="noopener noreferrer"/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length);
});
test('VPN QR is deferred explicitly and native QR copy uses a PNG ClipboardItem', () => {
  const js = fs.readFileSync(require.resolve('../app/public/panel.js'),'utf8');
  assert.match(js,/QR для AmneziaVPN пока не включён/);
  assert.match(js,/new ClipboardItem\(\{ 'image\/png': png \}\)/);
  assert.match(js,/requestId !== qrRequestId/);
  assert.match(js,/\?format=amneziavpn/);
});
test('share feedback always reserves two text lines without resizing either dialog', () => {
  const css = fs.readFileSync(require.resolve('../app/public/panel.css'),'utf8');
  assert.match(css,/\.share-instructions \.share-status\{[^}]*line-height:1\.6;block-size:3\.2em;overflow:auto/);
  assert.doesNotMatch(css,/\.share-status:empty\{[^}]*display:none/);
});
