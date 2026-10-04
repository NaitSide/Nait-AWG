'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, hidden:false, disabled:false, textContent:'', attrs:{}, dataset:{}, listeners:{}, style:{},
      classList:{toggle(){}}, addEventListener(type, callback){ this.listeners[type]=callback; },
      setAttribute(name,value){this.attrs[name]=value;}, removeAttribute(name){delete this.attrs[name]; if(name==='src') this.src=undefined;},
      remove(){}, select(){} });
    return nodes.get(id);
  }
  const requests = [];
  const revoked = [];
  const opens = [];
  const document = { getElementById:node,querySelectorAll:()=>[],body:{appendChild(){}},createElement:()=>node('copyTextarea'),execCommand:()=>true };
  const context = vm.createContext({document, configButton:node('downloadConfig'), navigator:{}, URL:{
    createObjectURL:()=>`blob:qr-${requests.length}`,revokeObjectURL:url=>revoked.push(url)},
    fetch:url=>new Promise(resolve=>requests.push({url,resolve})),
    showModal:id=>opens.push(id),closeModal:()=>{}, selectedRow:{dataset:{peerId:'one',label:'One',hasConfig:'true'}},createdPeer:null});
  const js = fs.readFileSync(require.resolve('../app/public/panel.js'),'utf8');
  const source = js.slice(js.indexOf('const clientFormats = {'),js.indexOf("document.querySelectorAll('[data-close-modal]')"));
  vm.runInContext('let qrRequestId = 0; let qrObjectUrl = null;\n'+source,context);
  const run = code=>vm.runInContext(code,context);
  return {node,requests,revoked,opens,run,context};
}
test('switching to VPN while native QR loads cancels stale image and keeps QR actions disabled', async () => {
  const f = fixture();
  const pending = f.run("openQr({id:'one',label:'One',qrUrl:'/one/qr'})");
  await f.run("selectQrFormat('vpn')");
  f.requests[0].resolve({ok:true,blob:async()=>({})});
  await pending;
  assert.equal(f.node('qrImage').src,undefined);
  assert.equal(f.node('qrImage').hidden,true);
  assert.equal(f.node('copyQr').disabled,true);
  assert.equal(f.node('downloadQr').attrs['aria-disabled'],'true');
  assert.equal(f.node('qrMultipartHint').hidden,false);
  assert.equal(f.node('qrActions').hidden,true);
  assert.equal(f.requests.length,1); // no fake AmneziaVPN QR request
});
test('loaded native QR enables both actions and revokes its object URL when leaving the tab', async () => {
  const f = fixture();
  const pending = f.run("openQr({id:'one',label:'One',qrUrl:'/one/qr'})");
  f.requests[0].resolve({ok:true,blob:async()=>({})}); await pending;
  assert.equal(f.node('copyQr').disabled,true);
  f.node('qrImage').onload();
  assert.equal(f.node('qrActions').hidden,false);
  assert.equal(f.node('copyQr').disabled,false);
  assert.equal(f.node('downloadQr').href,'blob:qr-1');
  await f.run("selectQrFormat('vpn')");
  assert.deepEqual(f.revoked,['blob:qr-1']);
  assert.equal(f.node('downloadQr').attrs['aria-disabled'],'true');
  assert.equal(f.node('qrActions').hidden,true);
  const reopened = f.run("selectQrFormat('awg')");
  assert.equal(f.node('qrActions').hidden,false);
  f.requests[1].resolve({ok:true,blob:async()=>({})}); await reopened;
});
test('download dialog captures selected client identity and resets the application on reopening', () => {
  const f = fixture();
  f.node('downloadConfig').listeners.click({preventDefault(){}});
  f.run("selectedRow = {dataset:{peerId:'two',label:'Two',hasConfig:'true'}}; selectDownloadFormat('vpn')");
  assert.equal(f.node('clientDownloadName').textContent,'One');
  assert.equal(f.node('clientDownloadFile').href,'/api/peers/one/config?format=amneziavpn');
  f.node('downloadConfig').listeners.click({preventDefault(){}});
  assert.equal(f.node('clientDownloadName').textContent,'Two');
  assert.equal(f.node('clientDownloadFile').href,'/api/peers/two/config');
  assert.deepEqual(f.opens,['clientDownloadModal','clientDownloadModal']);
});
test('missing configs cannot open download and instruction text has a plain HTTP copy fallback', async () => {
  const f = fixture();
  f.run("selectedRow.dataset.hasConfig = 'false'");
  f.node('downloadConfig').listeners.click({preventDefault(){}});
  assert.equal(f.opens.length,0);
  await f.node('qrCopyInstruction').listeners.click();
  assert.match(f.node('copyTextarea').value,/AmneziaWG\nУстановите/);
  assert.match(f.node('copyTextarea').value,/https:\/\/docs.amnezia.org/);
  assert.equal(f.node('qrShareStatus').textContent,'Инструкция скопирована.');
});
