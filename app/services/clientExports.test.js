'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {inflateSync} = require('node:zlib');
const {DatabaseSync} = require('node:sqlite');
const {createAwgService} = require('./awgService');
const {parseClientConfig} = require('./clientConfigService');
const {createAmneziaGuest, encodeAmneziaGuest, buildAmneziaVpn} = require('./clientExportService');
const {PARAMETER_NAMES: names, protocolVersion, clientSettings, saveProfile, readProfile, rewriteProfile} = require('./clientProfileService');
const obfuscationRules = require('./obfuscationRules');
const fixtures = path.join(__dirname, 'fixtures/official-5.0.3.0');
const official = JSON.parse(fs.readFileSync(path.join(fixtures,'awg31.guest.json')));
const officialConf = fs.readFileSync(path.join(fixtures,'awg31.conf.txt'),'utf8');
const oldGuest = JSON.parse(fs.readFileSync(path.join(fixtures,'legacy-010.guest.json')));
const native = parseClientConfig(officialConf,names);
const parameters = Object.fromEntries(names.filter(name => native.client[name] !== undefined).map(name => [name,native.client[name]]));
const fingerprint = key => crypto.createHash('sha256').update(key).digest('hex').slice(0,12);
const key = number => Buffer.alloc(32,number).toString('base64');
const {generateSignature} = require('./signatureService');
const {freezeRouting} = require('./routingService');
function unpack(vpn) {
  const packed=Buffer.from(vpn.slice(6),'base64url');
  const plain=inflateSync(packed.subarray(4));
  assert.equal(packed.readUInt32BE(0),plain.length);
  return JSON.parse(plain);
}
function semantic(guest) {
  const result=structuredClone(guest);
  const awg=result.containers[0].awg;
  awg.last_config=typeof awg.last_config==='string'?JSON.parse(awg.last_config):awg.last_config;
  const resolved=awg.last_config.config.replaceAll('$PRIMARY_DNS',result.dns1||'1.1.1.1').replaceAll('$SECONDARY_DNS',result.dns2||'1.0.0.1');
  const parsed=parseClientConfig(resolved,names);
  awg.last_config.config={Interface:{...parsed.client},Peer:{...parsed.server}};
  return result;
}
function material(parsed=native) { return {privateKey:parsed.client.PrivateKey,publicKey:parsed.publicKey,presharedKey:parsed.server.PresharedKey}; }
function encrypt(text) {
  const iv=Buffer.alloc(12,4); const cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(key(5),'base64'),iv);
  const data=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),data].map(value=>value.toString('base64')).join('.');
}
function harness(overrides={}, initial=[]) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nait-awg-export-test-'));
  const dataPath=path.join(directory,'clients.db');
  const env={NAIT_AWG_DATA_KEY:key(5),NAIT_AWG_DATA_PATH:dataPath,PUBLIC_ENDPOINT_HOST:'203.0.113.10',AWG_CONTAINER_NAME:'amnezia-awg2',...overrides};
  let inventory=structuredClone(initial);
  const mutations=[];
  let profile={status:'ok',serverPublicKey:native.server.PublicKey,listenPort:55424,interfaceAddress:'10.42.7.1/24',tunnelSubnet:'10.42.7.0/24',clientInterfaceParameters:parameters};
  let config=`[Interface]\nPrivateKey = ${key(9)}\nAddress = 10.42.7.1/24\nListenPort = 55424\n`+inventory.map(peer=>`\n[Peer]\nPublicKey = ${peer.publicKey}\nPresharedKey = ${peer.psk}\nAllowedIPs = ${peer.allowedIps[0]}\n`).join('');
  const dependencies={
    generateKeyMaterial:async()=>material(),readAwgConfig:async()=>config,readPublishedVpnPort:async()=>55424,
    receiver:async(route,options={})=>{
      const body=options.body?JSON.parse(options.body):null;
      if(route==='/awg/profile')return profile;
      if(route==='/awg/peers'&&!body)return {status:'ok',peers:inventory};
      if(route==='/awg/peers'&&body){
        mutations.push(body);inventory.push({publicKey:body.publicKey,allowedIps:[body.allowedIp],transferRx:0,transferTx:0});
        config+=`\n[Peer]\nPublicKey = ${body.publicKey}\nPresharedKey = ${body.presharedKey}\nAllowedIPs = ${body.allowedIp}\n`;
        return {status:'ok'};
      }
      if(route==='/awg/obfuscation'&&!body){const revision=obfuscationRules.revision(profile.clientInterfaceParameters);return {parameters:profile.clientInterfaceParameters,revision,valuesRevision:revision,peersCount:inventory.length};}
      if(route==='/awg/obfuscation'&&body){profile={...profile,clientInterfaceParameters:body.parameters};return {status:'ok',backupId:'test-backup'};}
      if(route==='/awg/restore'){
        mutations.push(body);config=body.config;
        inventory=config.split('[Peer]').slice(1).map(block=>({
          publicKey:/PublicKey = (.+)/.exec(block)[1],allowedIps:[/AllowedIPs = (.+)/.exec(block)?.[1]].filter(Boolean),transferRx:0,transferTx:0
        }));
        return {status:'ok'};
      }
      if(route==='/awg/gates/read'){
        const peer=inventory.find(peer=>peer.publicKey===body.publicKey);
        return {status:'ok',readQuality:'complete',writerStatus:'idle',nodeIncarnation:'test-node',classification:'OPEN',
          publicKeyFingerprint:fingerprint(peer.publicKey),persistentAllowedIps:peer.allowedIps,runtimeAllowedIps:peer.allowedIps};
      }
      throw Error('Unexpected test route '+route);
    }
  };
  return {service:createAwgService(env,dependencies),dataPath,env,dependencies,mutations,
    setProfile:value=>{profile=value;},setConfig:value=>{config=value;}};
}

async function setGlobal(service,type,value) {
  const current=await service.getClientPolicies();
  return service.setClientPolicies({expectedRevision:current.revision,type,value});
}
async function setPersonal(service,id,values) {
  const current=await service.getClientPolicies(id);
  return service.setClientPolicies({expectedRevision:current.revision,...values},id);
}
test('client policies preserve ciphertext, key material and server peers across restart and all export representations',async()=>{
  const h=harness(),peer=await h.service.createPeer({label:'Policy test'});
  const db=new DatabaseSync(h.dataPath),before=db.prepare('SELECT encrypted_config FROM clients').get().encrypted_config;
  const original=parseClientConfig((await h.service.getClientExport(peer.id)).config,names);
  await setGlobal(h.service,'routing',{mode:'selected',services:['telegram']});
  await setGlobal(h.service,'obfuscation',generateSignature('dns'));
  assert.equal(db.prepare('SELECT encrypted_config FROM clients').get().encrypted_config,before);db.close();
  const service=createAwgService(h.env,h.dependencies);
  const conf=(await service.getClientExport(peer.id)).config;
  const vpn=(await service.getClientExport(peer.id,'amneziavpn')).config;
  assert.equal(vpn,(await service.getClientExport(peer.id,'amneziavpn')).config);
  const a=parseClientConfig(conf,names),b=parseClientConfig(vpn,names);
  assert.deepEqual(a.client,b.client);assert.deepEqual(a.server,b.server);
  for(const name of ['PrivateKey','Address','HeaderProtectionKey','S1','H1'])assert.equal(a.client[name],original.client[name]);
  for(const name of ['PublicKey','PresharedKey','Endpoint','PersistentKeepalive'])assert.equal(a.server[name],original.server[name]);
  assert(!a.server.AllowedIPs.includes('0.0.0.0/0'));assert(a.server.AllowedIPs.includes('1.1.1.1/32'));
  const awg=unpack(vpn).containers[0].awg,last=JSON.parse(awg.last_config);
  assert.equal(awg.I1,a.client.I1);assert.equal(last.I1,a.client.I1);
  assert.deepEqual(last.allowed_ips,a.server.AllowedIPs.split(', '));
  assert.equal(h.mutations.length,1);assert.equal(h.mutations[0].allowedIp,peer.address);
  assert.match(await service.getQr(peer.id),/^<svg/);
  const {encodeAmneziaChunks}=require('./clientQrService');
  const packed=Buffer.from(vpn.slice(6),'base64url');
  const frames=encodeAmneziaChunks(packed);
  const decoded=Buffer.concat(frames.map(frame=>Buffer.from(frame,'base64url').subarray(8)));
  assert.deepEqual(decoded,packed);
  assert((await service.getQr(peer.id,'amneziavpn')).frames.length===frames.length);
});
test('table routes and DNS snapshots survive restart, agree in native and VPN exports, and support personal local bypass',async()=>{
  const h=harness(),peer=await h.service.createPeer({label:'Table routes'});
  const value={mode:'selected',services:['openai'],bypassLocal:true,
    resolved:{openai:{ipv4:['9.9.9.9/32'],updatedAt:'2026-10-20T12:00:00Z',sources:['Google','Cloudflare']}},
    custom:[{id:'custom-desk',name:'Custom network',enabled:true,ipv4:['8.8.4.4','192.168.1.0/24']}]};
  await setGlobal(h.service,'routing',value);
  const service=createAwgService(h.env,h.dependencies),saved=(await service.getClientPolicies()).routing;
  assert.deepEqual(saved.resolved.openai.ipv4,['9.9.9.9/32']);assert.equal(saved.custom[0].name,'Custom network');
  const conf=parseClientConfig((await service.getClientExport(peer.id)).config,names);
  const vpn=parseClientConfig((await service.getClientExport(peer.id,'amneziavpn')).config,names);
  assert.deepEqual(conf.server,vpn.server);assert(conf.server.AllowedIPs.includes('8.8.4.4/32'));
  assert(conf.server.AllowedIPs.includes('9.9.9.9/32'));assert(!conf.server.AllowedIPs.includes('192.168.1.0/24'));
  await setPersonal(service,peer.id,{routing:{mode:'override',value:{mode:'all',services:[],bypassLocal:true}}});
  const fullNative=parseClientConfig((await service.getClientExport(peer.id)).config,names);
  const fullVpn=parseClientConfig((await service.getClientExport(peer.id,'amneziavpn')).config,names);
  assert.equal(fullNative.server.AllowedIPs,fullVpn.server.AllowedIPs);assert(!fullNative.server.AllowedIPs.includes('0.0.0.0/0'));
  assert(fullNative.server.AllowedIPs.includes(':'));assert.equal(fullNative.server.Endpoint,conf.server.Endpoint);
  const backup=await service.createBackup(),target=harness();
  await target.service.restoreBackup(backup,null,{restoreObfuscation:false});
  const restored=await target.service.getClientPolicies(peer.id);
  assert.deepEqual(restored.routing.resolved,saved.resolved);assert.deepEqual(restored.routing.custom,saved.custom);
  assert.equal(restored.client.routing.value.bypassLocal,true);
});

test('empty, unavailable and stale policy saves fail without mutations or revision changes',async()=>{
  const h=harness(),peer=await h.service.createPeer({label:'Test'});
  const before=await h.service.getClientPolicies();
  for(const services of [[],['openai'],['unknown'],['anthropic']])await assert.rejects(setGlobal(h.service,'routing',{mode:'selected',services}));
  await assert.rejects(h.service.setClientPolicies({expectedRevision:99,type:'routing',value:{mode:'all',services:[]}}),{code:'client_policy_changed'});
  await assert.rejects(setPersonal(h.service,peer.id,{routing:null}),{code:'invalid_client_policy'});
  assert.equal((await h.service.getClientPolicies()).revision,before.revision);assert.equal(h.mutations.length,1);
});
test('personal packets and routes survive general masking, shared obfuscation and return to inheritance',async()=>{
  const h=harness(),peer=await h.service.createPeer({label:'Personal'});
  const personal=generateSignature('dns');
  await setPersonal(h.service,peer.id,{routing:{mode:'override',value:{mode:'selected',services:['telegram']}},obfuscation:{mode:'override',value:personal}});
  await setGlobal(h.service,'routing',{mode:'all',services:[]});
  await setGlobal(h.service,'obfuscation',generateSignature('none'));
  const state=await h.service.getObfuscation();
  await h.service.setObfuscation({parameters:{...state.parameters,S1:'24',S2:'24',S3:'24',S4:'24'},confirmed:true,expectedRevision:state.revision});
  let parsed=parseClientConfig((await h.service.getClientExport(peer.id,'amneziavpn')).config,names);
  assert.equal(parsed.client.I1,personal.packets.I1);assert.equal(parsed.client.S1,'24');
  assert(!parsed.server.AllowedIPs.includes('0.0.0.0/0'));
  await setPersonal(h.service,peer.id,{routing:{mode:'inherit'},obfuscation:{mode:'inherit'}});
  const exported=(await h.service.getClientExport(peer.id,'amneziavpn')).config;
  parsed=parseClientConfig(exported,names);
  assert.equal(parsed.server.AllowedIPs,'0.0.0.0/0, ::/0');assert.equal(parsed.client.I1,undefined);
  assert(parsed.client.HeaderProtectionKey);
  const awg=unpack(exported).containers[0].awg;
  for(const name of ['I1','I2','I3','I4','I5']){assert.equal(awg[name],'');assert.equal(JSON.parse(awg.last_config)[name],undefined);}
});
test('import explicitly preserves source policies by default and can adopt general settings',async()=>{
  for(const choice of ['preserve','inherit']){
    const parsed=parseClientConfig(officialConf,names),id=fingerprint(parsed.publicKey);
    const h=harness({},[{publicKey:parsed.publicKey,psk:parsed.server.PresharedKey,allowedIps:[parsed.client.Address]}]);
    await setGlobal(h.service,'obfuscation',generateSignature('none'));
    await setGlobal(h.service,'routing',{mode:'selected',services:['telegram']});
    await h.service.importClientConfig(id,{config:officialConf,...(choice==='inherit'?{policyMode:choice}:{})});
    const result=parseClientConfig((await h.service.getClientExport(id)).config,names);
    assert.equal(result.server.AllowedIPs,choice==='preserve'?parsed.server.AllowedIPs:require('./routingService').routesFor(freezeRouting({mode:'selected',services:['telegram']}),parsed.client.DNS));
    assert.equal(result.client.PrivateKey,parsed.client.PrivateKey);
  }
});
test('policy snapshots migrate to fresh fingerprints and require explicit source-mask restoration',async()=>{
  const source=harness(),peer=await source.service.createPeer({label:'Move'});
  const personal=generateSignature('dns');
  await setPersonal(source.service,peer.id,{routing:{mode:'override',value:{mode:'selected',services:['telegram']}},obfuscation:{mode:'override',value:personal}});
  const backup=await source.service.createBackup();
  for(const restoreObfuscation of [false,true]){
    const target=harness();
    const pair=crypto.generateKeyPairSync('x25519');
    const fresh={privateKey:pair.privateKey.export({format:'der',type:'pkcs8'}).subarray(-32).toString('base64'),
      publicKey:pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64'),presharedKey:key(23)};
    const service=createAwgService(target.env,{...target.dependencies,generateKeyMaterial:async()=>fresh});
    // The source harness's server text has no AWG fields: add a real interface for opt-in restore.
    if(restoreObfuscation) backup.payload.awg.config=backup.payload.awg.config.replace('\n[Peer]', '\n'+Object.entries(parameters).map(([k,v])=>`${k} = ${v}`).join('\n')+'\n[Peer]');
    await service.restoreBackup(backup,null,{restoreObfuscation});
    const id=fingerprint(fresh.publicKey),state=await service.getClientPolicies(id);
    assert.equal(state.client.routing.mode,'override');
    assert.equal(state.client.obfuscation?.value?.packets.I1,restoreObfuscation?personal.packets.I1:undefined);
    const parsed=parseClientConfig((await service.getClientExport(id)).config,names);
    assert(!parsed.server.AllowedIPs.includes('0.0.0.0/0'));assert.equal(parsed.client.PrivateKey,fresh.privateKey);
  }
});
test('large selective profiles reject native QR clearly and retain full multipart exports',async()=>{
  const h=harness(),peer=await h.service.createPeer({label:'Large'});
  await setGlobal(h.service,'routing',{mode:'selected',services:['youtube','instagram','telegram']});
  await setGlobal(h.service,'obfuscation',generateSignature('quic'));
  const config=(await h.service.getClientExport(peer.id)).config;
  await assert.rejects(h.service.getQr(peer.id),{code:'client_qr_too_large'});
  const series=await h.service.getQr(peer.id,'amneziavpn');assert(series.frames.length>1);
  const vpn=(await h.service.getClientExport(peer.id,'amneziavpn')).config;
  assert.equal(parseClientConfig(vpn,names).server.AllowedIPs,parseClientConfig(config,names).server.AllowedIPs);
});
test('old snapshots without a policy table restore with destination defaults',async()=>{
  const source=harness();await source.service.createPeer({label:'Old backup'});
  const db=new DatabaseSync(source.dataPath);db.exec('DROP TABLE client_policies');db.close();
  const backup=await source.service.createBackup();
  const target=harness();await target.service.restoreBackup(backup);
  const state=await target.service.getClientPolicies();assert.equal(state.routing,null);assert.equal(state.obfuscation,null);
  assert.equal((await target.service.listPeers()).length,1);
});
test('a lost shared-obfuscation response reconciles policy and ciphertext from one durable journal',async()=>{
  const h=harness(),peer=await h.service.createPeer({label:'Journal'});
  const service=createAwgService(h.env,{...h.dependencies,receiver:async(route,options)=>{
    const result=await h.dependencies.receiver(route,options);
    if(route==='/awg/obfuscation'&&options?.method==='POST')throw Error('Synthetic lost response');
    return result;
  }});
  const state=await service.getObfuscation(),packets=generateSignature('dns').packets;
  await service.setObfuscation({parameters:{...parameters,...packets},expectedRevision:state.revision,confirmed:true});
  const restarted=createAwgService(h.env,h.dependencies);
  const effective=parseClientConfig((await restarted.getClientExport(peer.id)).config,names);
  assert.equal(effective.client.I1,packets.I1);
  assert.equal((await restarted.getClientPolicies()).obfuscation.packets.I1,packets.I1);
  assert.equal(fs.existsSync(path.join(path.dirname(h.dataPath),'obfuscation-pending.json')),false);
});

test('official 3.1 guest fields and types match after decoding, including DNS placeholders',()=>{
  const parsed=parseClientConfig(encodeAmneziaGuest(official),names);
  const generated=createAmneziaGuest(parsed.config,official.description,names,{mtu:'1376',subnetAddress:'10.42.7.0'});
  assert.deepEqual(semantic(generated),semantic(official));
  const last=JSON.parse(generated.containers[0].awg.last_config);
  assert.match(last.config,/DNS = \$PRIMARY_DNS, \$SECONDARY_DNS/);
  assert.doesNotMatch(last.config,/^MTU\s*=/m);
  assert.equal(typeof last.port,'number'); assert.equal(typeof generated.containers[0].awg.port,'string');
});

test('new native export matches independently sourced official .conf fields and values',async()=>{
  const {service,mutations}=harness({CLIENT_DNS:'8.8.8.8, 1.0.0.1'});
  const created=await service.createPeer({label:'Android TV'});
  const exported=await service.getClientExport(created.id);
  const parsed=parseClientConfig(exported.config,names);
  assert.deepEqual({...parsed.client},{...native.client,Address:'10.42.7.2/32'});
  assert.deepEqual({...parsed.server},{...native.server});
  assert.equal(mutations.length,1); assert.equal(mutations[0].persistentKeepalive,0);
  const vpn=unpack((await service.getClientExport(created.id,'amneziavpn')).config);
  assert.equal(vpn.description,'Android TV'); assert.equal(vpn.containers[0].awg.subnet_address,'10.42.7.0');
  assert.equal(JSON.parse(vpn.containers[0].awg.last_config).mtu,'1376');
});

test('official desktop and mobile MTU policies, explicit overrides and custom DNS are separate from server data',()=>{
  assert.deepEqual(clientSettings({},parameters),{dns:'1.1.1.1, 1.0.0.1',allowedIps:'0.0.0.0/0, ::/0',keepalive:'25-35',mtu:'1376'});
  assert.equal(clientSettings({CLIENT_EXPORT_PLATFORM:'mobile'},parameters).mtu,'1280');
  const settings=clientSettings({CLIENT_MTU:'1420',CLIENT_DNS:'9.9.9.9, 149.112.112.112',CLIENT_PERSISTENT_KEEPALIVE:'20-40'},parameters);
  assert.equal(settings.mtu,'1420');assert.equal(settings.keepalive,'20-40');assert.equal(settings.dns,'9.9.9.9, 149.112.112.112');
  assert.equal(clientSettings({CLIENT_PERSISTENT_KEEPALIVE:'0'},parameters).keepalive,'0');
});

test('AWG 1.x, 1.5, 2 and 3.1 select only applicable version and keepalive fields',()=>{
  const base={Jc:'5',Jmin:'10',Jmax:'50',S1:'1',S2:'2',H1:'1',H2:'2',H3:'3',H4:'4'};
  for(const [params,version,keepalive] of [[base,'','25'],[{...base,I1:'<b 0x01>'},'1.5','25'],[{...base,S3:'0',S4:'0'},'2','25'],[{...base,H1:'1-2'},'2','25'],[{...base,RekeyTimeout:'3-7'},'3.1','25-35']]){
    assert.equal(protocolVersion(params),version);assert.equal(clientSettings({},params).keepalive,keepalive);
  }
  assert.equal(protocolVersion({...base,RandomTrailers:'off',DisableCookies:'off'}),'');
});

test('earlier AWG exports do not gain 3.1 settings, and legacy container identity is respected',async()=>{
  for(const [extra,version] of [[{},undefined],[{I1:'<b 0x01>'},'1.5'],[{S3:'0',S4:'0'},'2']]){
    const params={Jc:'5',Jmin:'10',Jmax:'50',S1:'1',S2:'2',H1:'1',H2:'2',H3:'3',H4:'4',...extra};
    const h=harness({AWG_CONTAINER_NAME:'amnezia-awg'});
    h.setProfile({status:'ok',serverPublicKey:native.server.PublicKey,listenPort:55424,interfaceAddress:'10.42.7.1/24',tunnelSubnet:'10.42.7.0/24',clientInterfaceParameters:params});
    const created=await h.service.createPeer({label:'Earlier AWG'});
    const guest=unpack((await h.service.getClientExport(created.id,'amneziavpn')).config);
    assert.equal(guest.defaultContainer,'amnezia-awg');assert.equal(guest.containers[0].awg.protocol_version,version);
    const last=JSON.parse(guest.containers[0].awg.last_config);
    assert.equal(last.persistent_keep_alive,'25');assert.equal(last.HeaderProtectionKey,undefined);
    assert.equal(last.RandomTrailers,undefined);
  }
});

test('disabled 3.1 toggles are omitted from native text but retained in server metadata',async()=>{
  const h=harness();h.setProfile({status:'ok',serverPublicKey:native.server.PublicKey,listenPort:55424,
    interfaceAddress:'10.42.7.1/24',tunnelSubnet:'10.42.7.0/24',clientInterfaceParameters:{...parameters,RandomTrailers:'off',DisableCookies:'off'}});
  const created=await h.service.createPeer({label:'Toggle test'});
  const exported=await h.service.getClientExport(created.id);
  assert.doesNotMatch(exported.config,/RandomTrailers|DisableCookies/);
  const awg=unpack((await h.service.getClientExport(created.id,'amneziavpn')).config).containers[0].awg;
  assert.equal(awg.RandomTrailers,'off');assert.equal(awg.DisableCookies,'off');
  assert.equal(JSON.parse(awg.last_config).RandomTrailers,undefined);
});

test('invalid policy and keepalive ranges fail before creating any server peer',async()=>{
  for(const settings of [{CLIENT_MTU:'bad'},{CLIENT_EXPORT_PLATFORM:'unknown'},{CLIENT_PERSISTENT_KEEPALIVE:'35-25'},{CLIENT_PERSISTENT_KEEPALIVE:'65536'},{CLIENT_DNS:'1.1.1.1\nPrivateKey = bad'}]){
    const {service,mutations}=harness(settings);
    await assert.rejects(service.createPeer({label:'Test'}),{code:'invalid_client_export_settings'});
    assert.equal(mutations.length,0);
  }
  assert.throws(()=>clientSettings({CLIENT_PERSISTENT_KEEPALIVE:'25-35'},{S3:'0'}));
});

test('guest import preserves original MTU, empty fields, DNS representation and object last_config',()=>{
  for(const mtu of ['1280','1420']){
    const guest=structuredClone(official);const last=JSON.parse(guest.containers[0].awg.last_config);
    last.mtu=mtu;guest.containers[0].awg.last_config=last;
    const parsed=parseClientConfig(encodeAmneziaGuest(guest),names);
    const saved=readProfile(saveProfile(parsed.config,parsed.guest));
    assert.deepEqual(semantic(unpack(encodeAmneziaGuest(saved.guest))),semantic(guest));
    assert.equal(saved.guest.containers[0].awg.I2,'');
    assert.doesNotMatch(saved.config,/^MTU\s*=/m);
  }
});

test('import and re-export through SQLite retain the official guest profile after restarting the service',async()=>{
  const parsed=parseClientConfig(encodeAmneziaGuest(official),names);
  const peer={publicKey:parsed.publicKey,psk:parsed.server.PresharedKey,allowedIps:[parsed.client.Address],clientName:'iPhone'};
  const h=harness({},[peer]);const id=fingerprint(peer.publicKey);
  await h.service.importClientConfig(id,{config:encodeAmneziaGuest(official)});
  const db=new DatabaseSync(h.dataPath); const before=db.prepare('SELECT encrypted_config FROM clients').get().encrypted_config;db.close();
  const restarted=createAwgService(h.env,h.dependencies);
  const guest=unpack((await restarted.getClientExport(id,'amneziavpn')).config);
  const expected=structuredClone(official);expected.description='iPhone';
  assert.deepEqual(semantic(guest),semantic(expected));
  const nativeExport=await restarted.getClientExport(id);
  assert.equal(nativeExport.config,parsed.config);
  const after=new DatabaseSync(h.dataPath);assert.equal(after.prepare('SELECT encrypted_config FROM clients').get().encrypted_config,before);after.close();
  assert.equal(h.mutations.length,0);
});

test('native import preserves explicit MTU and keepalive when generating a guest',async()=>{
  const config=officialConf.replace('DNS =','MTU = 1412\nDNS =').replace('25-35','31-39');
  const parsed=parseClientConfig(config,names);
  const h=harness({},[{publicKey:parsed.publicKey,psk:parsed.server.PresharedKey,allowedIps:[parsed.client.Address],clientName:'PC'}]);
  const id=fingerprint(parsed.publicKey);await h.service.importClientConfig(id,{config});
  const guest=unpack((await h.service.getClientExport(id,'amneziavpn')).config);
  const last=JSON.parse(guest.containers[0].awg.last_config);
  assert.equal(last.mtu,'1412');assert.equal(last.persistent_keep_alive,'31-39');assert.match(last.config,/MTU = 1412/);
  assert.equal((await h.service.getClientExport(id)).config,parsed.config);
});

test('older stored profiles retain exact native bytes, guest semantics and encrypted database values',async()=>{
  const config=JSON.parse(oldGuest.containers[0].awg.last_config).config;
  const parsed=parseClientConfig(config,names);const id=fingerprint(parsed.publicKey);
  const h=harness({CLIENT_DNS:'9.9.9.9',CLIENT_EXPORT_PLATFORM:'mobile'});
  const cipher=encrypt(config);const db=new DatabaseSync(h.dataPath);
  db.prepare(`INSERT INTO clients (client_id,label,receiver_label,public_key_fingerprint,address,encrypted_config,status,created_at)
    VALUES (?,?,?,?,?,?,'active',?)`).run('old-client',oldGuest.description,'Old-client',id,parsed.client.Address,cipher,'2026-01-01T00:00:00Z');
  const service=createAwgService(h.env,h.dependencies);
  assert.equal((await service.getClientExport(id)).config,config);
  const guest=unpack((await service.getClientExport(id,'amneziavpn')).config);
  assert.deepEqual(semantic(guest),semantic(oldGuest));
  assert.equal(db.prepare('SELECT encrypted_config FROM clients').get().encrypted_config,cipher);db.close();
  assert.equal(h.mutations.length,0);
});

test('legacy export retains explicitly empty AWG and DNS slots as 0.1.0 did',()=>{
  const config=officialConf.replace('DNS = 8.8.8.8, 1.0.0.1','DNS = 8.8.8.8, , 9.9.9.9').replace('I1 =','I2 =\nI1 =');
  const guest=unpack(buildAmneziaVpn(config,'Legacy',names,{legacy:true}));
  assert.equal(guest.dns2,'');assert.equal(guest.containers[0].awg.I2,'');
  assert.equal(JSON.parse(guest.containers[0].awg.last_config).I2,'');
});

test('explicit obfuscation editing keeps DNS, MTU and connection identity while syncing both guest layers',()=>{
  const parsed=parseClientConfig(encodeAmneziaGuest(official),names);
  const updated={...parameters,S1:'24',S2:'24',S3:'24',S4:'24',I2:'<b 0x0102>'};
  const saved=readProfile(rewriteProfile(saveProfile(parsed.config,parsed.guest),updated));
  const awg=saved.guest.containers[0].awg,last=JSON.parse(awg.last_config);
  assert.equal(last.mtu,'1376');assert.equal(last.client_priv_key,parsed.client.PrivateKey);
  assert.equal(last.client_ip,JSON.parse(official.containers[0].awg.last_config).client_ip);
  assert.equal(awg.subnet_address,'10.42.7.0');assert.equal(saved.guest.dns1,official.dns1);
  assert.match(last.config,/DNS = \$PRIMARY_DNS, \$SECONDARY_DNS/);
  assert.equal(awg.I2,updated.I2);assert.equal(last.I2,updated.I2);
  assert.equal(parseClientConfig(saved.config,names).client.S1,'24');
  assert.doesNotThrow(()=>parseClientConfig(encodeAmneziaGuest(saved.guest),names));
});

test('obfuscation apply and journal reconciliation work with encrypted structured profiles',async()=>{
  const h=harness();const created=await h.service.createPeer({label:'TV'});
  const before=unpack((await h.service.getClientExport(created.id,'amneziavpn')).config);
  const state=await h.service.getObfuscation();
  await h.service.setObfuscation({parameters:{...state.parameters,S1:'24',S2:'24',S3:'24',S4:'24'},confirmed:true,expectedRevision:state.revision});
  const guest=unpack((await h.service.getClientExport(created.id,'amneziavpn')).config);
  const parsed=parseClientConfig(encodeAmneziaGuest(guest),names);
  assert.equal(parsed.client.S1,'24');
  const last=JSON.parse(guest.containers[0].awg.last_config),old=JSON.parse(before.containers[0].awg.last_config);
  assert.equal(last.mtu,old.mtu);assert.equal(last.client_priv_key,old.client_priv_key);
  assert.equal(fs.existsSync(path.join(path.dirname(h.dataPath),'obfuscation-pending.json')),false);
});

test('changing export preferences leaves previously created profiles and ciphertext unchanged',async()=>{
  const h=harness();const created=await h.service.createPeer({label:'Saved phone'});
  const before=await h.service.getClientExport(created.id,'amneziavpn');
  const db=new DatabaseSync(h.dataPath);const cipher=db.prepare('SELECT encrypted_config FROM clients').get().encrypted_config;
  const restarted=createAwgService({...h.env,CLIENT_DNS:'8.8.8.8',CLIENT_EXPORT_PLATFORM:'mobile',CLIENT_PERSISTENT_KEEPALIVE:'0'},h.dependencies);
  assert.equal((await restarted.getClientExport(created.id,'amneziavpn')).config,before.config);
  assert.equal(db.prepare('SELECT encrypted_config FROM clients').get().encrypted_config,cipher);db.close();
});

test('backup and intentional migration support structured profiles and use target export settings',async()=>{
  const source=harness();await source.service.createPeer({label:'Restored phone'});
  const backup=await source.service.createBackup();
  const target=harness({CLIENT_EXPORT_PLATFORM:'mobile',CLIENT_DNS:'9.9.9.9, 149.112.112.112'});
  const imported=parseClientConfig(encodeAmneziaGuest(official),names);
  const destination=createAwgService(target.env,{...target.dependencies,generateKeyMaterial:async()=>material(imported)});
  const inspected=await destination.inspectBackup(backup);
  assert.equal(inspected.clientsCount,1);
  await destination.restoreBackup(backup);
  const guest=unpack((await destination.getClientExport(fingerprint(imported.publicKey),'amneziavpn')).config);
  assert.equal(guest.description,'Restored phone');assert.equal(guest.dns1,'9.9.9.9');
  assert.equal(JSON.parse(guest.containers[0].awg.last_config).mtu,'1280');
});

test('inconsistent duplicate keys, addresses, ports, keepalive and unsupported credentials are rejected',()=>{
  for(const mutate of [
    g=>{g.password='do-not-export';},g=>{g.containers[0].awg.ssh='do-not-export';},
    g=>{g.hostName='203.0.113.99';},g=>{g.containers[0].awg.port='12345';},
    g=>{const l=JSON.parse(g.containers[0].awg.last_config);l.client_priv_key=key(8);g.containers[0].awg.last_config=JSON.stringify(l);},
    g=>{const l=JSON.parse(g.containers[0].awg.last_config);l.persistent_keep_alive='25';g.containers[0].awg.last_config=JSON.stringify(l);},
    g=>{const l=JSON.parse(g.containers[0].awg.last_config);l.allowed_ips=['10.0.0.0/8'];g.containers[0].awg.last_config=JSON.stringify(l);},
    g=>{const l=JSON.parse(g.containers[0].awg.last_config);l.mtu=1376;g.containers[0].awg.last_config=JSON.stringify(l);}
  ]){const guest=structuredClone(official);mutate(guest);assert.throws(()=>parseClientConfig(encodeAmneziaGuest(guest),names));}
});

test('missing optional metadata remains absent through import; absent and empty are not merged',()=>{
  const guest=structuredClone(official);const awg=guest.containers[0].awg,last=JSON.parse(awg.last_config);
  delete awg.I2;delete last.mtu;awg.last_config=JSON.stringify(last);
  const parsed=parseClientConfig(encodeAmneziaGuest(guest),names);
  const saved=readProfile(saveProfile(parsed.config,parsed.guest));
  assert.equal(Object.hasOwn(saved.guest.containers[0].awg,'I2'),false);
  assert.equal(Object.hasOwn(JSON.parse(saved.guest.containers[0].awg.last_config),'mtu'),false);
});

test('migration rolls back when source routes cannot use the destination DNS',async()=>{
  const source=harness();await source.service.createPeer({label:'Source'});
  await setGlobal(source.service,'routing',{mode:'selected',services:['telegram']});
  const backup=await source.service.createBackup();
  const target=harness({CLIENT_DNS:'2606:4700:4700::1111'});
  await assert.rejects(target.service.restoreBackup(backup),{code:'restore_panel_failed'});
  assert.equal((await target.service.listPeers()).length,0);
  assert.equal((await target.service.getClientPolicies()).routing,null);
  assert.equal(target.mutations.length,2);
});


test('advanced editor shows saved general packets and keeps preset identity during shared edits',async()=>{
  const h=harness(),peer=await h.service.createPeer({label:'Editor test'});
  for (const profile of ['dns','quic','none']) {
    const mask=generateSignature(profile);
    await setGlobal(h.service,'obfuscation',mask);
    const state=await h.service.getObfuscation();
    for (const name of ['I1','I2','I3','I4','I5']) assert.equal(state.parameters[name],mask.packets[name] || '');
    const parsed=parseClientConfig((await h.service.getClientExport(peer.id)).config,names);
    assert.equal(parsed.client.I1 || '',state.parameters.I1);
    const unchanged=await h.service.inspectObfuscation({parameters:state.parameters,expectedRevision:state.revision});
    assert.deepEqual(unchanged.changed,[]);
    await h.service.setObfuscation({parameters:{...state.parameters,Jc:state.parameters.Jc==='4'?'5':'4'},expectedRevision:state.revision,confirmed:true});
    assert.equal((await h.service.getClientPolicies()).obfuscation.profile,profile);
  }
});

test('advanced editor rejects a stale general profile and manual packets become the general custom profile',async()=>{
  const h=harness();await h.service.createPeer({label:'Stale editor test'});
  await setGlobal(h.service,'obfuscation',generateSignature('dns'));
  const stale=await h.service.getObfuscation();
  await setGlobal(h.service,'obfuscation',generateSignature('quic'));
  for (const method of ['inspectObfuscation','setObfuscation']) {
    await assert.rejects(h.service[method]({parameters:stale.parameters,expectedRevision:stale.revision,confirmed:true}),{code:'obfuscation_changed'});
  }
  const state=await h.service.getObfuscation();
  const next={...state.parameters,I1:'<r 40>',I2:'<r 20>'};
  await h.service.setObfuscation({parameters:next,expectedRevision:state.revision,confirmed:true});
  const saved=(await h.service.getClientPolicies()).obfuscation;
  assert.equal(saved.profile,'custom');assert.deepEqual(saved.packets,{I1:'<r 40>',I2:'<r 20>'});
});
