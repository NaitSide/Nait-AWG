'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const rules=require('../app/services/obfuscationRules');
const {createObfuscationService}=require('../app/services/obfuscationService');
const {renderPanel}=require('../app/views/panelView');
const valid={Jc:'4',Jmin:'8',Jmax:'80',S1:'20',S2:'20',S3:'20',S4:'20',H1:'1',H2:'2',H3:'3',H4:'4',HeaderProtectionKey:Buffer.alloc(32,7).toString('base64'),RekeyAfterTime:'100-120',RekeyTimeout:'3-7',RejectAfterTime:'150-180',KeepaliveTimeout:'5-15',MaxHandshakeAttempts:'15-20',RandomTrailers:'on',DisableCookies:'on'};
test('obfuscation rules reject injection, invalid combinations and malformed signatures',()=>{
  assert.deepEqual(rules.validate(valid),{...valid,ContentPaddingAddition:'0'});
  for(const changed of [{S1:'11'},{H1:'2-10'},{Jmin:'90'},{S3:'21'},{RekeyAfterTime:'151-190'},{HeaderProtectionKey:Buffer.alloc(32).toString('base64')},{Jmax:'80\nPostUp=bad'},{I1:'<r 999999>'},{I1:'invalid'},{Unknown:'value'}])assert.throws(()=>rules.validate({...valid,...changed}),{code:'invalid_obfuscation'});
  assert.equal(rules.validate({...valid,I1:'<b 0x0102><r 12><t>'}).I1,'<b 0x0102><r 12><t>');
});
test('random generation is valid and preserves timers and custom client signatures',()=>{
  for(let i=0;i<30;i++) {
    const generated=rules.generate({...valid,I1:'<r 32>'});
    assert.deepEqual(rules.validate(generated),generated);
    assert.equal(generated.RekeyAfterTime,valid.RekeyAfterTime);
    assert.equal(generated.I1,'<r 32>');
    assert.notEqual(generated.HeaderProtectionKey,valid.HeaderProtectionKey);
  }
});
test('rewrite changes only obfuscation while keeping peer keys, addresses and access state',()=>{
  const source='[Interface]\nPrivateKey = client-secret\nAddress = 10.8.1.2/32\n# ClientJc = 9\nJc = 0\nS1 = 12\n\n[Peer]\nPublicKey = server-key\nPresharedKey = psk\nEndpoint = example.test:9000\nAllowedIPs = 0.0.0.0/0\n';
  const rewritten=rules.rewrite(source,valid,true);
  assert.equal(rewritten.split('[Peer]')[1],source.split('[Peer]')[1]);
  assert.match(rewritten,/PrivateKey = client-secret/);
  assert.match(rewritten,/Address = 10.8.1.2\/32/);
  assert.doesNotMatch(rewritten,/# ClientJc/);
  assert.equal((rewritten.match(/^Jc = /gm)||[]).length,1);
  const server=rules.rewrite(source,valid);
  assert.match(server,/^Jc = 0$/m);
  assert.match(server,/^# ClientJc = 4$/m);
});
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nait-obf-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let state={parameters:valid,revision:'a'.repeat(64),valuesRevision:rules.revision(valid)};
  let mode='normal',updates=[];
  const receiver=async(route,options)=>{
    if(mode==='offline')throw new Error('disconnected');
    if(!options)return state;
    const body=JSON.parse(options.body);
    if(mode==='rollback')throw new Error('reverted');
    state={parameters:body.parameters,revision:'b'.repeat(64),valuesRevision:rules.revision(body.parameters)};
    if(mode==='lost-reply')throw new Error('disconnected after apply');
    if(mode==='pending'){mode='offline';throw new Error('disconnected after apply');}
    return state;
  };
  const source='[Interface]\nPrivateKey = SECRET\nAddress = 10.8.1.2/32\n\n[Peer]\nPublicKey = SERVER\n';
  const dependencies={receiver,directory,clients:()=>[{publicKeyFingerprint:'abc',encryptedConfig:source}],encrypt:text=>Buffer.from(text).toString('base64'),decrypt:text=>text.includes('[Interface]')?text:Buffer.from(text,'base64').toString(),updateConfigs:value=>{updates=value;}};
  return {service:createObfuscationService(dependencies),dependencies,directory,setMode:value=>{mode=value;},getUpdates:()=>updates,input:{parameters:{...valid,Jc:'5'},expectedRevision:'a'.repeat(64),confirmed:true}};
}
test('client configs reconcile an applied request whose response was lost',async t=>{
  const f=fixture(t);f.setMode('lost-reply');
  const result=await f.service.apply(f.input);
  assert.equal(result.recovered,true);
  assert.equal(f.getUpdates().length,1);
  assert.match(Buffer.from(f.getUpdates()[0].encryptedConfig,'base64').toString(),/Jc = 5/);
  assert.equal(fs.existsSync(path.join(f.directory,'obfuscation-pending.json')),false);
});
test('unconfirmed operation keeps a durable journal and recovers after restart',async t=>{
  const f=fixture(t);f.setMode('pending');
  await assert.rejects(f.service.apply(f.input),{code:'obfuscation_pending'});
  assert.equal(f.getUpdates().length,0);
  const journal=fs.readFileSync(path.join(f.directory,'obfuscation-pending.json'),'utf8');
  assert.doesNotMatch(journal,/SECRET|HeaderProtectionKey/);
  f.setMode('normal');
  await createObfuscationService(f.dependencies).recover();
  assert.equal(f.getUpdates().length,1);
});
test('server rollback never rewrites client configs and stale forms cannot apply',async t=>{
  const f=fixture(t);f.setMode('rollback');
  await assert.rejects(f.service.apply(f.input));
  assert.equal(f.getUpdates().length,0);
  await assert.rejects(f.service.apply({...f.input,expectedRevision:'c'.repeat(64)}),{code:'obfuscation_changed'});
  await assert.rejects(f.service.apply({...f.input,confirmed:false}),{code:'obfuscation_not_confirmed'});
});
test('settings have grouped hints, guarded editing and the shared favicon set',()=>{
  const html=renderPanel({peers:[],profile:{status:'ok',protocolVersion:'3.1',clientInterfaceParameters:valid}});
  for(const group of rules.groups)assert.ok(html.includes(group.title));
  assert.match(html,/id="obfuscationToggle"/);assert.match(html,/data-obfuscation-help/);
  const infoIcons=[...html.matchAll(/class="obfuscation-info"[^>]*>(.*?)<\/button>/g)].map(match=>match[1]);
  assert.equal(infoIcons.length,rules.names.length);
  assert.equal(new Set(infoIcons).size,1);
  assert.match(infoIcons[0],/width="18" height="18"/);
  assert.match(infoIcons[0],/stroke-width="1\.333333"/);
  assert.match(infoIcons[0],/<circle cx="12" cy="12" r="10" stroke-width="1\.066667"\/>/);
  assert.match(infoIcons[0],/y1="12" y2="16"/);
  assert.match(infoIcons[0],/y1="8" y2="8"/);
  assert.match(html,/id="obfuscationConfirmConsent"/);
  assert.match(html,/id="adminAccessLogin"[^>]*disabled/);
  assert.match(html,/id="adminPasswordSubmit"[^>]*>Сохранить/);
  for(const resource of ['favicon.ico','favicon.svg','apple-touch-icon.png','site.webmanifest'])assert.ok(html.includes('/favicon/'+resource));
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../app/public/favicon/site.webmanifest')));
  assert.equal(manifest.name,'Nait-AWG');
  for(const icon of manifest.icons)assert.equal(fs.existsSync(path.join(__dirname,'../app/public',icon.src)),true);
  assert.equal(fs.readFileSync(path.join(__dirname,'../vendor/receiver/src/services/obfuscationRules.js'),'utf8'),fs.readFileSync(path.join(__dirname,'../app/services/obfuscationRules.js'),'utf8'));
});
