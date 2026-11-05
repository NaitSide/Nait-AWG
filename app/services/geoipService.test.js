'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createGeoipService}=require('./geoipService');
const rules=require('./geoipRules');
const {geoipFixture}=require('./fixtures/geoip');
const {freezeRouting,routesFor,storedRouting,cidr,publicRouting}=require('./routingService');
const {emptyState,migratePolicies,validateState}=require('./clientPolicyService');
const fixture=geoipFixture();
const parsed=()=>rules.parseDownload(Buffer.from(fixture.body),fixture.checksums,Date.parse('2026-11-05T13:00:00Z'));
const covers=(routes,address)=>{const n=address.split('.').reduce((n,x)=>n*256+Number(x),0);return routes.split(', ').map(cidr).some(b=>b.start<=n&&n<=b.end);};
test('verified GeoIP augments only excluded IPv4 and snapshots survive policy validation and backup migration',()=>{
  const snapshot=parsed(),value={mode:'excluded',services:[],bypassLocal:true,geoip:{enabled:true,hash:snapshot.hash},custom:[{id:'custom-extra',name:'Foreign host',enabled:true,ipv4:['9.9.9.9']}]};
  const frozen=freezeRouting(value,snapshot),routes=routesFor(frozen,'1.1.1.1','203.0.113.1:51820');
  assert(!covers(routes,'45.0.0.1'));assert(covers(routes,'45.0.4.1'));assert(covers(routes,'8.8.8.8'));
  assert(!covers(routes,'9.9.9.9'));assert(!covers(routes,'192.168.1.1'));assert(!covers(routes,'203.0.113.1'));assert(!routes.includes(':'));
  assert.deepEqual(storedRouting(JSON.parse(JSON.stringify(frozen))),frozen);
  const state={...emptyState(),routing:frozen,clients:{aaaaaaaaaaaa:{routing:{mode:'override',value:frozen}}}};
  const restored=migratePolicies(JSON.parse(JSON.stringify(state)),emptyState(),[{oldFingerprint:'aaaaaaaaaaaa',fingerprint:'bbbbbbbbbbbb'}],false);
  assert.equal(routesFor(restored.routing,'1.1.1.1','203.0.113.1:51820'),routes);
  assert.equal(restored.clients.bbbbbbbbbbbb.routing.value.geoip.hash,snapshot.hash);
  assert.equal(publicRouting(frozen).geoip.ipv4,undefined);
  const bad=structuredClone(state);bad.routing.geoip.ipv4[0]='8.8.8.0/24';assert.throws(()=>validateState(bad));
  assert.throws(()=>freezeRouting({...value,mode:'selected',services:['telegram']},snapshot),{code:'invalid_geoip_mode'});
  const disabled=freezeRouting({...value,geoip:{enabled:false}});
  assert(covers(routesFor(disabled,'1.1.1.1','203.0.113.1:51820'),'45.0.0.1'));
});
test('GeoIP keeps existing DNS overlap rejection',()=>{
  const snapshot=parsed(),frozen=freezeRouting({mode:'excluded',services:[],geoip:{enabled:true,hash:snapshot.hash}},snapshot);
  assert.throws(()=>routesFor(frozen,'45.0.0.1','203.0.113.1:51820'),{code:'excluded_dns_overlap'});
});
test('corrupt, private, non-canonical and correctly formatted truncated downloads are rejected',()=>{
  assert.throws(()=>rules.parseDownload(Buffer.from(fixture.body.slice(0,-1)),fixture.checksums,Date.now()));
  assert.throws(()=>rules.parseDownload(Buffer.from(fixture.body),'0'.repeat(32)+'  ru-aggregated.zone\n',Date.now()));
  for(const token of ['10.0.0.0/8','45.0.0.1/22','0.0.0.0/0','::/0','garbage']){
    const body=fixture.body.replace('45.0.0.0/22',token);
    const checksum=crypto.createHash('md5').update(body).digest('hex')+'  ru-aggregated.zone';
    assert.throws(()=>rules.parseDownload(Buffer.from(body),checksum,Date.now()));
  }
  const partial=fixture.body.split('\n').slice(0,2000).join('\n')+'\n';
  assert.throws(()=>rules.parseDownload(Buffer.from(partial),fixture.checksums,Date.now()));
  // Even a self-consistent replacement is rejected when coverage drops sharply.
  const dropped=fixture.body.split('\n').slice(0,5000).join('\n')+'\n';
  const checksum=crypto.createHash('md5').update(dropped).digest('hex')+'  ru-aggregated.zone';
  assert.throws(()=>rules.parseDownload(Buffer.from(dropped),checksum,Date.now(),parsed()),{code:'geoip_unexpected_change'});
});
test('refresh is bounded, coalesced, persistent and leaves last-good disk and memory intact on failure',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nait-geoip-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filePath=path.join(dir,'geoip.json');let now=Date.parse('2026-11-05T13:00:00Z'),mode='ok',calls=0;
  const fetch=async(url,options)=>{
    calls++;assert.equal(options.redirect,'error');assert(options.signal);assert([rules.SOURCE,rules.CHECKSUM_SOURCE].includes(url));
    if(mode==='http')return new Response('unavailable',{status:503});
    if(mode==='huge')return new Response('x',{headers:{'content-length':String(1024*1024)}});
    if(mode==='partial')return new Response(url===rules.SOURCE?fixture.body.slice(0,fixture.body.length/2):fixture.checksums);
    return new Response(url===rules.SOURCE?fixture.body:fixture.checksums);
  };
  const service=createGeoipService({filePath,fetch,now:()=>now});
  const a=service.refresh(),b=service.refresh();assert.equal(a,b);const meta=await a;assert.equal(calls,2);
  const original=fs.readFileSync(filePath);assert.equal(meta.count,8192);assert.equal(meta.ipv4,undefined);
  assert.equal(createGeoipService({filePath}).status().hash,meta.hash);
  const copy=service.snapshot(meta.hash);copy.ipv4[0]='8.8.8.0/24';assert.notEqual(service.snapshot(meta.hash).ipv4[0],copy.ipv4[0]);
  assert.throws(()=>service.refresh(),{code:'geoip_rate_limited'});
  for(const failureMode of ['http','huge','partial']){
    now+=61000;mode=failureMode;await assert.rejects(service.refresh());
    assert.equal(service.status().hash,meta.hash);assert.deepEqual(fs.readFileSync(filePath),original);
  }
  fs.writeFileSync(filePath,'broken');assert.equal(createGeoipService({filePath}).status(),null);
});
test('country-sized export limits still reject oversized files and decompression bombs',()=>{
  const {parseClientConfig}=require('./clientConfigService'),{PARAMETER_NAMES}=require('./clientProfileService');
  const {MAX_CONFIG_BYTES,MAX_GUEST_BYTES}=require('./clientConfigLimits');
  assert.throws(()=>parseClientConfig('x'.repeat(MAX_CONFIG_BYTES+1),PARAMETER_NAMES),{code:'invalid_client_config'});
  const header=Buffer.alloc(4);header.writeUInt32BE(MAX_GUEST_BYTES+1);
  const compressed=require('node:zlib').deflateSync(Buffer.alloc(MAX_GUEST_BYTES+1,32));
  assert.throws(()=>parseClientConfig('vpn://'+Buffer.concat([header,compressed]).toString('base64url'),PARAMETER_NAMES),{code:'invalid_client_export'});
  header.writeUInt32BE(16); // A forged small header must not bypass the inflater's own output bound.
  assert.throws(()=>parseClientConfig('vpn://'+Buffer.concat([header,compressed]).toString('base64url'),PARAMETER_NAMES),{code:'invalid_client_export'});
});
