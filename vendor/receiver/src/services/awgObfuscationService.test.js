'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createObfuscationService,verifyParameters}=require('./awgObfuscationService');
const rules=require('./obfuscationRules');
const valid={Jc:'4',Jmin:'8',Jmax:'80',S1:'20',S2:'20',S3:'20',S4:'20',H1:'1',H2:'2',H3:'3',H4:'4',HeaderProtectionKey:Buffer.alloc(32,7).toString('base64'),RekeyAfterTime:'100-120',RekeyTimeout:'3-7',RejectAfterTime:'150-180',KeepaliveTimeout:'5-15',MaxHandshakeAttempts:'15-20',RandomTrailers:'on',DisableCookies:'on'};
function fixture(){
  let text=rules.rewrite('[Interface]\nPrivateKey = '+Buffer.alloc(32,2).toString('base64')+'\nAddress = 10.8.1.0/24\nListenPort = 9000\n\n[Peer]\nPublicKey = '+Buffer.alloc(32,3).toString('base64')+'\n# closed peer, no AllowedIPs\n',valid);
  const original=text;let mode='normal',writes=0,backups=0,syncs=0,intent=null,runtimeText=null,drift=false;
  const service=createObfuscationService({writeEnabled:true,config:{},lock:task=>task(),read:async()=>text,status:async()=>({status:'ok',container:{running:true},peersCount:1}),peers:async()=>({status:'ok',peers:[{publicKey:drift?'other-key':Buffer.alloc(32,3).toString('base64'),allowedIps:[]}]}),runtime:async()=>runtimeText||text,
    journal:{read:()=>intent,save:value=>{intent=value;},clear:()=>{intent=null;}},
    write:async next=>{text=next;writes++;},backup:async()=>{backups++;return {backupId:'test-backup'};},sync:async()=>{syncs++;if(mode==='fail'&&syncs===1)throw new Error('apply failed');runtimeText=null;}});
  function crash(kind){
    const next=rules.rewrite(original,{...valid,S1:'30',S2:'30',S3:'30',S4:'30'});
    intent={schemaVersion:1,original,next,peers:JSON.stringify([[Buffer.alloc(32,3).toString('base64'),[]]])};
    text=kind==='external'?next+'# external change\n':next;
    runtimeText=kind==='persisted-only'?original:null;
  }
  return {service,original,getText:()=>text,setMode:value=>{mode=value;},setDrift:()=>{drift=true;},setRuntime:value=>{runtimeText=value;},crash,counts:()=>({writes,backups,syncs})};
}
test('obfuscation write verifies runtime and preserves the exact peer section',async()=>{
  const f=fixture();const state=await f.service.get();
  const result=await f.service.set({parameters:{...valid,Jc:'5'},expectedRevision:state.revision});
  assert.equal(result.backupId,'test-backup');
  assert.equal(f.getText().split('[Peer]')[1],f.original.split('[Peer]')[1]);
  assert.equal(f.counts().writes,1);
});
test('failed runtime apply restores and verifies previous config',async()=>{
  const f=fixture();const state=await f.service.get();f.setMode('fail');
  await assert.rejects(f.service.set({parameters:{...valid,Jc:'5'},expectedRevision:state.revision}),{code:'obfuscation_apply_failed'});
  assert.equal(f.getText(),f.original);assert.equal(f.counts().writes,2);
});
test('stale revision and invalid input never write or reserve a backup',async()=>{
  const f=fixture();
  await assert.rejects(f.service.set({parameters:valid,expectedRevision:'c'.repeat(64)}),{code:'obfuscation_changed'});
  await assert.rejects(f.service.set({parameters:{...valid,S1:'0'},expectedRevision:'c'.repeat(64)}),{code:'invalid_obfuscation'});
  assert.equal(f.counts().writes,0);assert.equal(f.counts().backups,0);
});
test('parameter verification accepts canonical booleans but rejects an unsupported missing key',()=>{
  verifyParameters({RandomTrailers:'on'},'[Interface]\nRandomTrailers = 1\n');
  assert.throws(()=>verifyParameters({HeaderProtectionKey:valid.HeaderProtectionKey},'[Interface]\n'),{code:'obfuscation_runtime_mismatch'});
});
test('recovery preserves a verified completed write and rolls back a persisted-only write',async()=>{
  const completed=fixture();completed.crash('complete');await completed.service.recover();
  assert.match(completed.getText(),/^S1 = 30$/m);assert.equal(completed.counts().writes,0);
  const incomplete=fixture();incomplete.crash('persisted-only');await incomplete.service.recover();
  assert.equal(incomplete.getText(),incomplete.original);assert.equal(incomplete.service.hasPending(),false);
});
test('recovery never overwrites an external change after a crash',async()=>{
  const f=fixture();f.crash('external');const before=f.getText();
  await assert.rejects(f.service.recover(),{code:'obfuscation_recovery_failed'});
  assert.equal(f.getText(),before);assert.equal(f.counts().writes,0);
});
test('runtime identity or peer drift is rejected before writing or backing up',async()=>{
  for(const kind of ['peers','identity']){
    const f=fixture();const state=await f.service.get();
    if(kind==='peers')f.setDrift();else f.setRuntime(f.original.replace('ListenPort = 9000','ListenPort = 9001'));
    await assert.rejects(f.service.set({parameters:{...valid,Jc:'5'},expectedRevision:state.revision}),{code:'awg_config_drift'});
    assert.equal(f.counts().writes,0);assert.equal(f.counts().backups,0);
  }
});
