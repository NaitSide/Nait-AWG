'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { renderPanel } = require('../app/views/panelView');
const css = fs.readFileSync(require.resolve('../app/public/panel.css'), 'utf8');

test('status column fits the longest badge and info action with balanced edge spacing', () => {
  const html = renderPanel({ peers: [], profile: {} });
  assert.match(html, /<colgroup><col style="width:37%"><col style="width:24%"><col style="width:auto"><col style="width:176px"><\/colgroup>/);
  assert.match(css, /\.gate-status-cell\{[^}]*justify-content:flex-start;gap:7px/);
  assert.match(css, /#accessView \.table-wrap th:last-child,#accessView \.table-wrap td:last-child\{padding-right:7px\}/);
  // Keep genuine narrow-screen scrolling; do not conceal clipped actions.
  assert.match(css, /\.table-wrap\{overflow-x:auto\}/);
});

test('unavailable QR has a neutral cursor without changing the access-check progress cursor', () => {
  const html = renderPanel({ peers: [], profile: {} });
  assert.match(html, /id="showQr"[^>]*disabled/);
  assert.match(css, /#showQr:disabled\{cursor:default\}/);
  assert.match(css, /\.gate-power-button\.checking:disabled\{[^}]*cursor:progress/);
});
