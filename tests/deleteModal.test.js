'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { renderPanel } = require('../app/views/panelView');

function fixture(fetchImpl = async () => ({ ok: true })) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const attrs = new Map(), classes = new Set();
      elements.set(id, { handlers: {}, disabled: false, hidden: false, textContent: '',
        addEventListener(name, handler) { this.handlers[name] = handler; },
        setAttribute(name, value) { attrs.set(name, value); }, getAttribute(name) { return attrs.get(name); },
        focus() {}, classList: { add: name => classes.add(name), remove: name => classes.delete(name),
          toggle(name, value) { value ? classes.add(name) : classes.delete(name); }, contains: name => classes.has(name) } });
    }
    return elements.get(id);
  }
  const requests = [], redirects = [];
  const row = { dataset: { canDelete: 'true', peerId: 'abcdef012345', label: 'Old client', address: '10.8.1.2/32', telegram: '@old', note: 'original' } };
  const context = vm.createContext({ document: { getElementById: element }, selectedRow: row,
    deletingRow: null, deleteBusy: false, deleteForm: element('deleteForm'),
    showModal: id => element(id).classList.add('open'),
    fetch: async (url, options) => { requests.push({ url, options }); return fetchImpl(url, options); },
    window: { location: { assign: url => redirects.push(url) } } });
  const source = fs.readFileSync(path.join(__dirname, '../app/public/panel.js'), 'utf8');
  const start = source.indexOf("deleteForm.addEventListener('submit'");
  const end = source.indexOf("powerButton.addEventListener('click'", start);
  vm.runInContext(source.slice(start, end), context);
  return { context, element, requests, redirects,
    open() { element('deleteForm').handlers.submit({ preventDefault() {} }); },
    toggle() { element('deleteConsent').handlers.click(); },
    confirm() { return element('deleteConfirm').handlers.click(); } };
}

test('delete uses a project modal with confirmation switch instead of browser confirm', () => {
  const html = renderPanel({ peers: [], profile: {} });
  assert.match(html, /id="deleteModal" aria-hidden="true"/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="deleteModalTitle"/);
  assert.match(html, /id="deleteConsent" type="button" aria-pressed="false"/);
  assert.match(html, /id="deleteConfirm" type="button" disabled/);
  assert.match(html, /id="deleteError" role="alert" hidden/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../app/public/panel.js'), 'utf8'), /\bconfirm\(/);
});
test('opening or clicking an unconfirmed dialog never deletes a client', async () => {
  const item = fixture(); item.open();
  assert.equal(item.element('deleteName').textContent, 'Old client');
  assert.equal(item.element('deleteConfirm').disabled, true);
  await item.confirm(); assert.equal(item.requests.length, 0);
  item.toggle(); item.toggle(); await item.confirm();
  assert.equal(item.requests.length, 0);
});
test('confirmation deletes the captured client, not a newly selected row', async () => {
  const item = fixture(); item.open(); item.toggle();
  item.context.selectedRow = { dataset: { peerId: 'different' } };
  await item.confirm();
  assert.equal(item.requests[0].url, '/api/peers/abcdef012345');
  assert.equal(item.requests[0].options.method, 'DELETE');
  assert.deepEqual(item.redirects, ['/panel']);
});
test('busy deletion blocks double clicks', async () => {
  let finish;
  const item = fixture(() => new Promise(resolve => { finish = resolve; }));
  item.open(); item.toggle();
  const pending = item.confirm(); await item.confirm();
  assert.equal(item.requests.length, 1);
  assert.equal(item.element('deleteConsent').disabled, true);
  finish({ ok: true }); await pending;
});
test('failure is shown in the modal and requires fresh confirmation', async () => {
  const item = fixture(async () => ({ ok: false, json: async () => ({ message: 'Deletion rejected' }) }));
  item.open(); item.toggle(); await item.confirm();
  assert.equal(item.element('deleteError').hidden, false);
  assert.equal(item.element('deleteError').textContent, 'Deletion rejected');
  assert.equal(item.element('deleteConfirm').disabled, true);
  assert.equal(item.context.deleteBusy, false);
  assert.equal(item.element('deleteConsent').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(item.redirects, []);
});
