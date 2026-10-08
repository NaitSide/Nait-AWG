'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// This file belongs in app/views next to panelView.js.
const {renderPanel} = require('./panelView');
const publicDir = path.join(__dirname,'../public');
const script = fs.readFileSync(path.join(publicDir,'panel.js'),'utf8');

test('backdrops have no dismissal handlers; explicit controls and Escape still close dialogs', () => {
  const modal={id:'qrModal'},calls=[],listeners={};
  const button={addEventListener:(type,callback)=>listeners.click=callback,closest:()=>modal};
  const context=vm.createContext({document:{
    querySelectorAll:selector=>{assert.equal(selector,'[data-close-modal]');return [button];},
    querySelector:selector=>selector==='#qrModal.open'?modal:null,
    addEventListener:(type,callback)=>listeners[type]=callback
  },closeModal:dialog=>calls.push(dialog.id)});
  const start=script.indexOf("document.querySelectorAll('[data-close-modal]')");
  const end=script.indexOf("deleteForm.addEventListener('submit'",start);
  assert(start>=0&&end>start);
  vm.runInContext(script.slice(start,end),context);
  listeners.click();
  listeners.keydown({key:'Enter'});
  listeners.keydown({key:'Escape'});
  assert.deepEqual(calls,['qrModal','qrModal']);
});

test('hidden creation errors take no layout space', () => {
  const css=fs.readFileSync(path.join(publicDir,'panel.css'),'utf8');
  assert.match(css,/#createModal \.create-message\[hidden\]\{display:none\}/);
  assert.doesNotMatch(css,/#createModal[^\n]*\.create-message\[hidden\][^\n]*visibility:hidden/);
});

test('download dialog uses the configuration label, with an English translation', () => {
  const html=renderPanel({peers:[],profile:{},adminLogin:'admin'});
  assert.match(html,/<h2 id="clientDownloadTitle">Скачать конфиг<\/h2>/);
  assert.match(html,/<p class="create-message" id="createMessage" role="alert" hidden>/);
  const context=vm.createContext({window:{}});
  vm.runInContext(fs.readFileSync(path.join(publicDir,'i18n-catalog.js'),'utf8'),context);
  assert.equal(context.window.NaitTranslations.en['Скачать конфиг'],'Download configuration');
});

test('creation uses only the busy button, reports failures, and permits retry', async () => {
  const nodes=new Map();
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{value:'Audit',hidden:true,disabled:false,textContent:'',classList:{add(){},remove(){}}});
    return nodes.get(id);
  };
  let submit,resolve;
  const context=vm.createContext({
    document:{getElementById:node},
    createForm:{addEventListener:(type,callback)=>submit=callback},
    createSubmit:node('createSubmit'),createMessage:node('createMessage'),
    createModal:{classList:{add(){}}},
    fetch:()=>new Promise(r=>resolve=r)
  });
  const start=script.indexOf("createForm.addEventListener('submit'");
  const end=script.indexOf("document.getElementById('createdDone')",start);
  assert(start>=0&&end>start);
  vm.runInContext('let createBusy=false,createdPeer=null;\n'+script.slice(start,end),context);
  const pending=submit({preventDefault(){}});
  assert.equal(node('createMessage').hidden,true);
  assert.equal(node('createSubmit').disabled,true);
  assert.equal(node('createSubmit').textContent,'Создаём доступ...');
  assert.equal(node('clientLabel').disabled,true);
  resolve({ok:false,json:async()=>({message:'Synthetic error'})});await pending;
  assert.equal(node('createMessage').hidden,false);
  assert.equal(node('createMessage').textContent,'Synthetic error');
  assert.equal(node('createSubmit').disabled,false);
  assert.equal(node('clientLabel').disabled,false);
  const retry=submit({preventDefault(){}});
  assert.equal(node('createMessage').hidden,true);
  assert.equal(node('createMessage').textContent,'');
  resolve({ok:true,json:async()=>({id:'audit-peer',label:'Audit',address:'10.8.1.2/32'})});await retry;
  assert.equal(node('createSuccess').hidden,false);
  assert.equal(node('createMessage').hidden,true);
  assert.equal(node('createSubmit').disabled,false);
});
