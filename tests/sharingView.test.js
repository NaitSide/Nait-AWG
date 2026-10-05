'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { renderPanel } = require('../app/views/panelView');
test('QR and download dialogs have compact application tabs without instructions or app links', () => {
  const html = renderPanel({ peers:[], profile:{} });
  for (const kind of ['qr','download']) {
    for (const format of ['awg','vpn']) assert.match(html,new RegExp(`data-share-modal="${kind}" data-share-format="${format}"`));
  }
  assert.match(html,/id="clientDownloadModal"/);
  assert.match(html,/<button class="btn purple" id="copyQr"[^>]*disabled>Скопировать QR/);
  assert.ok(html.indexOf('id="copyQr"') < html.indexOf('id="downloadQr"'));
  assert.match(html,/id="qrMultipartHint" role="status"/);
  for(const id of ['qrCopyInstruction','qrAppLink','qrInstruction','clientDownloadCopyInstruction','clientDownloadAppLink','clientDownloadInstruction','qrUseFile'])assert.ok(!html.includes('id="'+id+'"'));
  assert.match(html,/data-client-config-import="\.vpn"/);
  assert.match(html,/data-client-config-import="\.conf"/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length);
});
test('VPN QR animates on screen only and native QR copy uses a PNG ClipboardItem', () => {
  const js = fs.readFileSync(require.resolve('../app/public/panel.js'),'utf8');
  assert.doesNotMatch(js,/QR для AmneziaVPN пока не включён/);
  assert.match(js,/setInterval/);assert.match(js,/stopQrAnimation\(\)/);
  assert.match(js,/new ClipboardItem\(\{ 'image\/png': png \}\)/);
  assert.match(js,/requestId !== qrRequestId/);
  assert.match(js,/\?format=amneziavpn/);
});
test('QR feedback and hidden VPN actions reserve stable space', () => {
  const css = fs.readFileSync(require.resolve('../app/public/panel.css'),'utf8');
  assert.match(css,/\.qr-share-status\{[^}]*line-height:1\.6;block-size:3\.2em;overflow:auto/);
  assert.match(css,/#qrActions\{min-height:71px/);
  assert.doesNotMatch(css,/\.share-status:empty\{[^}]*display:none/);
});
