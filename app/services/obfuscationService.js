'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const rules=require('./obfuscationRules');
function failure(code,message,status=409){return Object.assign(new Error(message),{status,code});}
function createObfuscationService({receiver,directory,clients,encrypt,decrypt,updateConfigs}){
  const journalPath=path.join(directory,'obfuscation-pending.json');
  function saveJournal(journal){
    const temporary=journalPath+'.'+crypto.randomUUID()+'.tmp';
    try {
      const descriptor=fs.openSync(temporary,'wx',0o600);
      try{fs.writeFileSync(descriptor,JSON.stringify({schemaVersion:1,payload:encrypt(JSON.stringify(journal))})+'\n');fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
      fs.renameSync(temporary,journalPath);
    }finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
  }
  function journal(){
    try{const data=JSON.parse(fs.readFileSync(journalPath,'utf8'));if(data.schemaVersion!==1)throw new Error();return JSON.parse(decrypt(data.payload));}
    catch(error){if(error.code==='ENOENT')return null;throw failure('obfuscation_pending_invalid','Не удалось прочитать журнал изменения обфускации. Проверьте сервер.',503);}
  }
  async function current(){return receiver('/awg/obfuscation');}
  async function recover(){
    const pending=journal();if(!pending)return;
    let observed;
    try{observed=await current();}catch{throw failure('obfuscation_pending','Изменение обфускации ещё не подтверждено. Проверьте соединение и повторите. Не раздавайте старые конфиги.',503);}
    if(observed.valuesRevision===pending.after)updateConfigs(pending.updates);
    else if(observed.valuesRevision!==pending.before)throw failure('obfuscation_pending_conflict','Параметры изменились вне панели. Требуется ручная проверка журнала обфускации.',503);
    fs.unlinkSync(journalPath);
  }
  async function inspect(input){
    const parameters=rules.validate(input?.parameters);
    const state=await current();
    if(input.expectedRevision&&input.expectedRevision!==state.revision)throw failure('obfuscation_changed','Параметры изменились. Выключите и заново включите Edit mode.');
    const changed=rules.names.filter(name=>String(parameters[name]??'')!==String(state.parameters[name]??''));
    const stored=clients();
    return {state,parameters,changed,sharedChanged:changed.some(name=>rules.shared.has(name)),savedConfigs:stored.length};
  }
  async function apply(input){
    if(input?.confirmed!==true)throw failure('obfuscation_not_confirmed','Подтвердите последствия изменения параметров.',400);
    if(!/^[a-f0-9]{64}$/.test(String(input?.expectedRevision||'')))throw failure('invalid_obfuscation_revision','Сначала проверьте параметры перед сохранением.',400);
    const preview=await inspect(input);
    if(!preview.changed.length)return {status:'ok',unchanged:true,updatedConfigs:0};
    const updates=clients().map(client=>({fingerprint:client.publicKeyFingerprint,encryptedConfig:encrypt(rules.rewrite(decrypt(client.encryptedConfig),preview.parameters,true))}));
    saveJournal({before:preview.state.valuesRevision,after:rules.revision(preview.parameters),updates});
    let result;
    try{result=await receiver('/awg/obfuscation',{method:'POST',timeoutMs:120000,headers:{'content-type':'application/json','x-request-id':crypto.randomUUID()},body:JSON.stringify({parameters:preview.parameters,expectedRevision:preview.state.revision})});}
    catch(error){
      // A disconnected request can still have succeeded; reconcile against verified runtime.
      await recover();
      const observed=await current();
      if(observed.valuesRevision!==rules.revision(preview.parameters))throw error;
      return {status:'ok',updatedConfigs:updates.length,recovered:true};
    }
    // Durable journal survives a crash between server application and the SQLite commit.
    await recover();
    return {status:'ok',updatedConfigs:updates.length,backupId:result.backupId};
  }
  return {current,recover,inspect,apply};
}
module.exports={createObfuscationService};
