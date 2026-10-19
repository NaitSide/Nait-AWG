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
  await h.service.setObfuscation({parameters:{...parameters,S1:'24',S2:'24',S3:'24',S4:'24'},confirmed:true,expectedRevision:state.revision});
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
