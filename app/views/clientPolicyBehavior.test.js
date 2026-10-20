'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/client-policies.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function ui(fetch) {
  const nodes=new Map();
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{value:'',disabled:false,hidden:false,textContent:'',listeners:{},
      addEventListener(type,handler){this.listeners[type]=handler;},
      querySelectorAll(selector){return selector==='[data-packet]'?this.packets || []:[];},
      classList:{contains:()=>false},dataset:{}});
    return nodes.get(id);
  };
  for(const prefix of ['mask','clientMask'])node(prefix+'Packets').packets=[1,2,3,4,5].map(n=>({dataset:{packet:'I'+n},value:''}));
  const events={};
  const context=vm.createContext({document:{getElementById:node},window:{addEventListener(type,handler){events[type]=handler;},dispatchEvent(event){events[event.type]?.(event);}},
    CustomEvent:class {constructor(type,options={}){this.type=type;this.detail=options.detail;}},
    fetch,structuredClone,AbortSignal,showModal(){}});
  vm.runInContext(source,context);
  return node;
}
const response=value=>({ok:true,json:async()=>value});
test('cancel invalidates an in-flight signature preview and preserves custom packet drafts',async()=>{
  let finish,mutations=0;
  const initial={revision:0,obfuscation:{profile:'custom',packets:{I1:'<r 50>'}},routing:null};
  const node=ui(async(url,options)=>{
    if(options?.method){mutations++;return new Promise(resolve=>{finish=resolve;});}
    return response(initial);
  });
  await tick();
  node('maskPackets').packets[0].value='<r 77>';
  node('maskProfile').value='dns';const pending=node('maskProfile').listeners.change();
  assert.equal(node('maskPackets').packets[0].value,'<r 77>');
  node('maskCancel').listeners.click();
  assert.equal(node('maskProfile').value,'custom');
  finish(response({profile:'dns',packets:{I1:'<b 0x0102>'}}));await pending;
  assert.equal(node('maskProfile').value,'custom');
  assert.equal(node('maskPackets').packets[0].value,'<r 50>');
  assert.equal(node('maskStatus').textContent,'');assert.equal(mutations,1);
});
test('load failure leaves forms disabled; refreshing the page loads saved settings',async()=>{
  let fail=true;
  const node=ui(async()=>{if(fail)throw Error('Synthetic disconnected server');return response({revision:0,obfuscation:null,routing:null});});
  await tick();
  assert.equal(node('routeFields').disabled,true);
  assert.match(node('routeStatus').textContent,/Не удалось связаться/);
  assert.match(node('routeStatus').textContent,/Обновите страницу/);
  fail=false;const refreshed=ui(async()=>response({revision:1,obfuscation:{profile:'quic',packets:{I1:'<r 20>'}},routing:null}));
  await tick();
  assert.equal(refreshed('routeFields').disabled,false);assert.equal(refreshed('routeStatus').textContent,'');
  assert.equal(refreshed('maskProfile').value,'quic');
});


test('cancel restores the last saved profile without a server request',async()=>{
  let reads=0;
  const node=ui(async()=>{reads++;return response({revision:1,obfuscation:{profile:'quic',packets:{I1:'<r 20>'}},routing:null});});
  await tick();
  node('maskProfile').value='custom';await node('maskProfile').listeners.change();
  node('maskCancel').listeners.click();
  assert.equal(node('maskProfile').value,'quic');assert.equal(reads,1);
});
