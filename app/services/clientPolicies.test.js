'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {initialKeys, generateSignature, validatePackets} = require('./signatureService');
const {catalog, validateCatalog, routesFor, freezeRouting, union} = require('./routingService');
const {effectiveProfile, emptyState, validateState} = require('./clientPolicyService');
const {PARAMETER_NAMES} = require('./clientProfileService');
const {parseClientConfig} = require('./clientConfigService');
const fs = require('node:fs');
const path = require('node:path');
const native = fs.readFileSync(path.join(__dirname,'fixtures/official-5.0.3.0/awg31.conf.txt'),'utf8');

test('QUIC Initial key derivation matches the independent RFC 9001 A.1 vector',()=>{
  const keys=initialKeys(Buffer.from('8394c8f03e515708','hex'));
  assert.equal(keys.key.toString('hex'),'1f369613dd76d5467730efcbe3b1a22d');
  assert.equal(keys.iv.toString('hex'),'fa044b2f42a3fd3b46fb255c');
  assert.equal(keys.hp.toString('hex'),'9f50449e04a0e810283a1e9933adedd2');
});
test('generated QUIC Initial authenticates and contains a CRYPTO ClientHello in 1200 bytes',()=>{
  const packet=Buffer.from(generateSignature('quic').packets.I1.slice(5,-1),'hex');
  assert.equal(packet.length,1200);assert.equal(packet.readUInt32BE(1),1);
  const keys=initialKeys(packet.subarray(6,14));
  const pnOffset=26,header=Buffer.from(packet.subarray(0,30));
  const cipher=crypto.createCipheriv('aes-128-ecb',keys.hp,null);cipher.setAutoPadding(false);
  const mask=cipher.update(packet.subarray(pnOffset+4,pnOffset+20));
  header[0]^=mask[0]&15;
  for(let i=0;i<4;i++)header[pnOffset+i]^=mask[i+1];
  assert.equal(header[0],0xc3);assert.equal(header.readUInt32BE(pnOffset),0);
  const decipher=crypto.createDecipheriv('aes-128-gcm',keys.key,keys.iv);
  decipher.setAAD(header);decipher.setAuthTag(packet.subarray(-16));
  const plain=Buffer.concat([decipher.update(packet.subarray(30,-16)),decipher.final()]);
  assert.equal(plain[0],6);assert.equal(plain[1],0);assert.equal(plain[4],1);
  assert.equal(plain.readUInt16BE(8),0x0303);
  assert(plain.includes(Buffer.from('example.com')));
});
test('DNS is a complete reserved-domain A query and generation is stable only after saving',()=>{
  const first=generateSignature('dns');
  const bytes=Buffer.from(first.packets.I1.slice(5,-1),'hex');
  assert.equal(bytes.readUInt16BE(2),0x0100);assert.equal(bytes.readUInt16BE(4),1);
  assert.equal(bytes.subarray(12).toString('hex'),'076578616d706c6503636f6d0000010001');
  const state={...emptyState(),obfuscation:first};
  assert.equal(effectiveProfile(native,state,'test').config,effectiveProfile(native,state,'test').config);
});
test('unsupported tags, unsafe lengths, repeated timestamps and control characters fail',()=>{
  for(const text of ['<c>','<r 1001>','<r 0>','<r 99999999999999>','<t><t>','<r 1000><r 233>','<b 0x0>','<r 10>\nPostUp = bad']){
    assert.throws(()=>validatePackets({I1:text}),{code:'invalid_signature'});
  }
  assert.deepEqual(validatePackets({I1:'<r 1000><r 232>'}),{I1:'<r 1000><r 232>'});
});
test('catalog validates bounded public networks and selective routing never becomes default',()=>{
  for(const bad of ['0.0.0.0/0','::/0','10.0.0.0/8','127.0.0.0/8','8.8.8.1/24','8.8.8.0/33','224.0.0.0/3']){
    const candidate=structuredClone(catalog);candidate.services[0].ipv4=[bad];
    assert.throws(()=>validateCatalog(candidate));
  }
  const before=JSON.stringify(catalog);
  assert.throws(()=>routesFor({mode:'selected',services:[]},'1.1.1.1'));
  assert.throws(()=>routesFor({mode:'selected',services:['openai']},'1.1.1.1'));
  assert.throws(()=>routesFor({mode:'selected',services:['telegram']},'2606:4700:4700::1111'),{code:'split_dns_ipv4_required'});
  const routes=routesFor(freezeRouting({mode:'selected',services:['telegram','youtube']}),'1.1.1.1, 10.42.7.1');
  assert(routes.includes('10.42.7.1/32'));assert(routes.includes('1.1.1.1/32'));
  assert(!routes.includes('0.0.0.0/0'));assert(!routes.includes(':'));
  assert.equal(JSON.stringify(catalog),before);
  assert.deepEqual(union(['8.8.8.0/24','8.8.8.8/32','8.8.8.0/24']),['8.8.8.0/24']);
});
test('stored snapshots retain their exact networks independently of later catalog changes',()=>{
  const state={...emptyState(),routing:freezeRouting({mode:'selected',services:['telegram']})};
  state.routing.ipv4=['91.108.4.0/24'];
  const restored=validateState(state);
  const exported=effectiveProfile(native,restored,'test');
  const parsed=parseClientConfig(exported.config,PARAMETER_NAMES);
  assert(parsed.server.AllowedIPs.includes('91.108.4.0/24'));
  assert(!parsed.server.AllowedIPs.includes('149.154.160.0/20'));
});
test('selective profiles reject endpoint routing loops and unresolved endpoint names before saving',()=>{
  const state={...emptyState(),routing:freezeRouting({mode:'selected',services:['youtube']})};
  const replaceEndpoint=value=>native.replace(/^Endpoint\s*=.*$/m,'Endpoint = '+value);
  assert.throws(()=>effectiveProfile(replaceEndpoint('8.8.8.8:51820'),state,'test'),{code:'split_endpoint_overlap'});
  assert.throws(()=>effectiveProfile(replaceEndpoint('vpn.example.com:51820'),state,'test'),{code:'split_endpoint_ipv4_required'});
  assert.doesNotThrow(()=>effectiveProfile(native,state,'test'));
});
test('an invalid catalog update preserves the last good local copy byte for byte',()=>{
  const os=require('node:os'),{installCatalog}=require('../../scripts/update-service-catalog');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nait-catalog-'));
  const candidate=path.join(dir,'candidate.json'),destination=path.join(dir,'catalog.json');
  const previous=JSON.stringify(catalog);fs.writeFileSync(destination,previous);
  const bad=structuredClone(catalog);bad.services[0].ipv4=['0.0.0.0/0'];fs.writeFileSync(candidate,JSON.stringify(bad));
  assert.throws(()=>installCatalog(candidate,destination));assert.equal(fs.readFileSync(destination,'utf8'),previous);
  fs.writeFileSync(candidate,previous);installCatalog(candidate,destination);
  assert.deepEqual(JSON.parse(fs.readFileSync(destination,'utf8')),catalog);
  fs.rmSync(dir,{recursive:true,force:true});
});
