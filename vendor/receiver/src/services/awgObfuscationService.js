'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {withDirectoryLock}=require('../utils/lock');
const {runFile}=require('../utils/exec');
const {getAwgRuntimeConfig,getAwgStatus,getAwgPeers,parseAwgClientInterfaceParameters}=require('./awgService');
const {readConfig,writeConfigToContainer,getContainerConfigPath,parseAwgConfig}=require('./awgConfigService');
const {createConfigRestoreBackup}=require('./awgBackupService');
const rules=require('./obfuscationRules');

function fail(code,message,statusCode=409){return Object.assign(new Error(message),{code,statusCode,status:statusCode});}
function hash(text){return crypto.createHash('sha256').update(text).digest('hex');}
function activeValues(text){
  const values={};let section='';
  for(const line of text.split(/\r?\n/)) {
    const header=/^\s*\[([^\]]+)\]\s*$/.exec(line);if(header){section=header[1].toLowerCase();continue;}
    const pair=/^\s*([A-Za-z0-9]+)\s*=\s*(.*?)\s*$/.exec(line);
    if(section==='interface'&&pair&&rules.names.includes(pair[1])&&!/^I[1-5]$/.test(pair[1])) values[pair[1]]=pair[2];
  }return values;
}
function canonical(name,value){
  const text=String(value??'').trim();
  if(['RandomTrailers','DisableCookies'].includes(name))return /^(1|on|true)$/i.test(text)?'on':'off';
  if(/^\d+(?:-\d+)?$/.test(text)) {const [a,b=a]=text.split('-').map(Number);return a===b?String(a):`${a}-${b}`;}
  return text;
}
function verifyParameters(expected,runtime){
  const actual=activeValues(runtime);
  for(const [name,value] of Object.entries(expected)) {
    const missing=actual[name]===undefined;
    if(missing&&['0','off'].includes(canonical(name,value)))continue;
    if(missing||canonical(name,actual[name])!==canonical(name,value))throw fail('obfuscation_runtime_mismatch','Работающий AWG не подтвердил параметры обфускации.');
  }
}
function peerIdentity(inventory){
  if(inventory?.status!=='ok'||!Array.isArray(inventory.peers))throw fail('awg_unavailable','Список клиентов AWG недоступен.');
  return JSON.stringify(inventory.peers.map(peer=>[peer.publicKey,[...(peer.allowedIps||[])].sort()]).sort((a,b)=>a[0].localeCompare(b[0])));
}
function verifyInterfaceIdentity(expected,runtime){
  function identity(text){
    const values={};let section='';
    for(const line of text.split(/\r?\n/)){
      const header=/^\s*\[([^\]]+)\]\s*$/.exec(line);if(header){section=header[1].toLowerCase();continue;}
      const pair=/^\s*(PrivateKey|ListenPort|FwMark)\s*=\s*(.*?)\s*$/i.exec(line);
      if(section==='interface'&&pair)values[pair[1].toLowerCase()]=pair[2];
    }return values;
  }
  const expectedValues=identity(expected),actual=identity(runtime);
  for(const [name,value]of Object.entries(expectedValues)){
    const same=name==='privatekey'?actual[name]===value:Number(actual[name]??0)===Number(value);
    if(!same)throw fail('awg_config_drift','Файл и работающий AWG расходятся по настройкам интерфейса. Сначала проверьте сервер через SSH.');
  }
}
function createObfuscationService(dependencies={}) {
  const config=dependencies.config||getAwgRuntimeConfig();
  const read=dependencies.read||(()=>readConfig(config,'obfuscation-read'));
  const status=dependencies.status||getAwgStatus;
  const peers=dependencies.peers||getAwgPeers;
  const runtime=dependencies.runtime||(async()=> (await runFile('docker',['exec',config.containerName,'awg','showconf',config.interfaceName],{timeoutMs:30000,maxBuffer:2*1024*1024})).stdout);
  const write=dependencies.write||(text=>writeConfigToContainer(config,text,'obfuscation-write'));
  const backup=dependencies.backup||(()=>createConfigRestoreBackup(config,getContainerConfigPath(config)));
  const sync=dependencies.sync||(()=>runFile('docker',['exec',config.containerName,'bash','-c','awg syncconf "$1" <(awg-quick strip "$2")','bash',config.interfaceName,getContainerConfigPath(config)],{timeoutMs:30000}));
  const lock=dependencies.lock||(task=>withDirectoryLock(path.join(process.env.AWG_LOCK_DIR||'/opt/naitlab/nait_awg_node/receiver/locks','awg0.write.lock.d'),{timeoutMs:15000},task));
  const intentPath=path.join(process.env.AWG_GATE_STATE_DIR||'/opt/naitlab/nait_awg_node/receiver/state','obfuscation-intent.json');
  const journal=dependencies.journal||{
    read(){try{return JSON.parse(fs.readFileSync(intentPath,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw fail('obfuscation_recovery_failed','Журнал изменения AWG повреждён. Проверьте сервер через SSH.',503);}},
    save(value){
      fs.mkdirSync(path.dirname(intentPath),{recursive:true,mode:0o700});
      const temporary=intentPath+'.'+crypto.randomUUID()+'.tmp';
      try{
        const descriptor=fs.openSync(temporary,'wx',0o600);
        try{fs.writeFileSync(descriptor,JSON.stringify(value)+'\n');fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
        fs.renameSync(temporary,intentPath);
      }finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
    },
    clear(){fs.unlinkSync(intentPath);}
  };
  async function recoverUnlocked(){
    const intent=journal.read();if(!intent)return;
    if(intent.schemaVersion!==1||typeof intent.original!=='string'||typeof intent.next!=='string')throw fail('obfuscation_recovery_failed','Журнал изменения AWG повреждён. Требуется ручная проверка.',503);
    const observed=await read();
    if(observed!==intent.original&&observed!==intent.next)throw fail('obfuscation_recovery_failed','После прерванного сохранения конфигурация изменилась извне. Требуется ручная проверка.',503);
    if(observed===intent.next){
      try{
        const actual=await runtime();verifyInterfaceIdentity(intent.next,actual);verifyParameters(activeValues(intent.next),actual);
        if(peerIdentity(await peers())===intent.peers){journal.clear();return;}
      }catch{}
    }
    // Interrupted persistence/application is returned to the previous verified state.
    await write(intent.original);await sync();
    const actual=await runtime();verifyInterfaceIdentity(intent.original,actual);verifyParameters(activeValues(intent.original),actual);
    if(await read()!==intent.original||peerIdentity(await peers())!==intent.peers)throw fail('obfuscation_recovery_failed','Не удалось подтвердить откат прерванного сохранения. Проверьте AWG через SSH.',503);
    journal.clear();
  }
  async function stateUnlocked(){
    const text=await read(); const current=await status();
    if(current.status!=='ok'||!current.container?.running)throw fail('awg_unavailable','AWG недоступен.');
    const actual=await runtime();verifyInterfaceIdentity(text,actual);verifyParameters(activeValues(text),actual);
    if(peerIdentity({status:'ok',peers:parseAwgConfig(text).peers})!==peerIdentity(await peers()))throw fail('awg_config_drift','Список клиентов в файле и работающем AWG расходится. Сначала проверьте сервер через SSH.');
    const parameters=parseAwgClientInterfaceParameters(text);
    return {status:'ok',parameters,revision:hash(text),valuesRevision:rules.revision(parameters),peersCount:current.peersCount};
  }
  async function get(){return lock(async()=>{await recoverUnlocked();return stateUnlocked();});}
  async function set(input){
    if(!dependencies.writeEnabled&&String(process.env.AWG_WRITE_ENABLED).toLowerCase()!=='true')throw fail('write_disabled','Изменение AWG отключено.',403);
    const parameters=rules.validate(input?.parameters);
    if(!/^[a-f0-9]{64}$/.test(String(input?.expectedRevision||'')))throw fail('invalid_obfuscation_revision','Необходимо заново проверить текущие параметры.',400);
    return lock(async()=>{
      await recoverUnlocked();
      const before=await stateUnlocked();
      if(before.revision!==input.expectedRevision)throw fail('obfuscation_changed','Конфигурация изменилась. Заново откройте редактор.');
      if(before.valuesRevision===rules.revision(parameters))return {...before,unchanged:true};
      const original=await read();
      if(hash(original)!==before.revision)throw fail('obfuscation_changed','Конфигурация изменилась во время проверки.');
      const next=rules.rewrite(original,parameters);
      const originalPeers=peerIdentity(await peers());
      const saved=await backup();
      let writeAttempted=false;
      try{
        // Check again after backup; do not overwrite an external writer's change.
        if(hash(await read())!==before.revision)throw fail('obfuscation_changed','Конфигурация изменилась во время резервирования.');
        journal.save({schemaVersion:1,original,next,peers:originalPeers,backupId:saved.backupId});
        writeAttempted=true;
        await write(next);await sync();
        const actual=await runtime();verifyInterfaceIdentity(next,actual);verifyParameters(activeValues(next),actual);
        if(await read()!==next||peerIdentity(await peers())!==originalPeers)throw fail('obfuscation_verify_failed','Не удалось подтвердить сохранность клиентов и параметров.');
        const result=await stateUnlocked();
        journal.clear();
        return {...result,backupId:saved.backupId};
      }catch(error){
        if(writeAttempted){
          try{
            // Roll back only our own revision. An unrelated external change needs manual review.
            const observed=await read();
            if(observed!==next&&observed!==original)throw new Error('external change');
            await write(original);await sync();
            const actual=await runtime();verifyInterfaceIdentity(original,actual);verifyParameters(activeValues(original),actual);
            if(await read()!==original||peerIdentity(await peers())!==originalPeers)throw new Error('rollback verification');
            journal.clear();
          }catch{throw fail('obfuscation_rollback_failed','Автоматический откат не подтверждён. Проверьте AWG через SSH; резервная копия сохранена.',500);}
        }
        if(error.code&&error.statusCode)throw error;
        throw fail('obfuscation_apply_failed','Параметры не применены. Прежнее состояние восстановлено.',500);
      }
    });
  }
  return {get,set,hasPending:()=>Boolean(journal.read()),recover:()=>lock(recoverUnlocked)};
}
module.exports={createObfuscationService,verifyParameters,activeValues};
