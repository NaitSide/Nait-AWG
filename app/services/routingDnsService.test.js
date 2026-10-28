'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createRoutingDnsService:makeRoutingDnsService}=require('./routingDnsService');
const createRoutingDnsService=options=>makeRoutingDnsService({resolveYandex:async()=>{throw Error('Synthetic Yandex outage');},...options});
const answer=(records,status=0)=>new Response(JSON.stringify({Status:status,Answer:records.map(data=>({type:1,data}))}));
test('DNS refresh uses both fixed HTTPS providers, deduplicates public A records and caches a preview',async()=>{
  const calls=[];
  const resolver=createRoutingDnsService({resolveYandex:async()=>['8.8.8.8'],fetch:async(url,options)=>{
    calls.push({url,options});return answer(['8.8.8.8','8.8.8.8','192.168.1.1','127.0.0.1','203.0.113.1','::1']);
  }});
  const result=await resolver.refresh({services:['youtube']});
  assert.deepEqual(result.resolved.youtube.ipv4,['8.8.8.8/32']);
  assert.deepEqual(result.resolved.youtube.sources,['Cloudflare','Google','Yandex']);assert.deepEqual(result.failed,[]);
  assert.equal(calls.length,8);assert(calls.every(call=>call.url.protocol==='https:'&&call.options.redirect==='error'));
  assert(calls.every(call=>['dns.google','cloudflare-dns.com'].includes(call.url.hostname)));
  result.resolved.youtube.ipv4=[];
  assert.deepEqual((await resolver.refresh({services:['youtube']})).resolved.youtube.ipv4,['8.8.8.8/32']);assert.equal(calls.length,8);
  await assert.rejects(resolver.refresh({services:['http://127.0.0.1/']}),{code:'invalid_dns_selection'});
});
test('partial provider failures retain usable addresses and report missing services without manufacturing ranges',async()=>{
  const resolver=createRoutingDnsService({fetch:async url=>{
    if(url.hostname==='dns.google'||url.searchParams.get('name').includes('youtube')||url.searchParams.get('name').includes('ytimg')||url.searchParams.get('name').includes('googlevideo'))throw Error('Synthetic outage');
    return answer(['1.1.1.1']);
  }});
  const result=await resolver.refresh({services:['telegram','youtube']});
  assert.deepEqual(result.resolved.telegram.ipv4,['1.1.1.1/32']);assert.deepEqual(result.partial,['telegram']);assert.deepEqual(result.failed,['youtube']);
});
test('NXDOMAIN, oversized responses and private-only DNS answers cannot replace saved routes',async()=>{
  for(const fetch of [async()=>answer([],3),async()=>new Response('x'.repeat(70000)),async()=>answer(['10.0.0.1'])]) {
    await assert.rejects(createRoutingDnsService({fetch}).refresh({services:['telegram']}),{code:'routing_dns_unavailable'});
  }
});
test('concurrent refreshes are coalesced and different concurrent selections are bounded',async()=>{
  let release,calls=0;const wait=new Promise(resolve=>{release=resolve;});
  const resolver=createRoutingDnsService({fetch:async()=>{calls++;await wait;return answer(['1.1.1.1']);}});
  const first=resolver.refresh({services:['telegram']}),second=resolver.refresh({services:['telegram']});
  await assert.rejects(resolver.refresh({services:['youtube']}),{code:'routing_dns_busy'});release();
  assert.deepEqual(await first,await second);assert.equal(calls,6);
});

test('WhatsApp and TikTok refresh independently and survive saved routing/export without selecting unrelated services',async()=>{
  const {catalog,freezeRouting,storedRouting,routesFor}=require('./routingService');
  const {domains}=require('./routingDnsService');
  assert.deepEqual(Object.keys(domains).sort(),catalog.services.map(s=>s.id).sort());
  const calls=[];
  const resolver=createRoutingDnsService({resolveYandex:async name=>[name.includes('whatsapp')?'1.1.1.1':'9.9.9.9'],fetch:async url=>{
    const name=url.searchParams.get('name');calls.push(name);
    return answer([name.includes('whatsapp')?'1.1.1.1':'9.9.9.9']);
  }});
  const result=await resolver.refresh({services:['whatsapp','tiktok']});
  assert.deepEqual(result.failed,[]);assert.deepEqual(result.partial,[]);
  assert.deepEqual(result.resolved.whatsapp.ipv4,['1.1.1.1/32']);
  assert.deepEqual(result.resolved.tiktok.ipv4,['9.9.9.9/32']);
  assert(calls.includes('web.whatsapp.com'));assert(calls.includes('mmg.whatsapp.net'));
  assert(calls.includes('www.tiktok.com'));assert(calls.includes('v16-webapp-prime.tiktok.com'));
  const policy=freezeRouting({mode:'selected',services:['whatsapp','tiktok'],resolved:result.resolved});
  assert.deepEqual(storedRouting(policy),policy);
  assert.deepEqual(policy.services,['tiktok','whatsapp']);
  const exported=routesFor(policy,'8.8.8.8');
  assert(exported.includes('1.1.1.1/32'));assert(exported.includes('9.9.9.9/32'));
  assert(!exported.includes('0.0.0.0/0'));
});

test('new messenger and social profiles keep DNS snapshots separate and deduplicate shared Meta routes',async()=>{
  const {catalog,freezeRouting,storedRouting,routesFor}=require('./routingService');
  const {domains}=require('./routingDnsService');
  const ids=['discord','signal','viber','facebook','twitter'];
  const addresses=Object.fromEntries(ids.map((id,i)=>[id,'9.9.9.'+(10+i)]));
  const resolver=createRoutingDnsService({resolveYandex:async name=>[addresses[ids.find(id=>domains[id].includes(name))]],fetch:async url=>{
    const id=ids.find(id=>domains[id].includes(url.searchParams.get('name')));
    assert(id);return answer([addresses[id]]);
  }});
  const result=await resolver.refresh({services:ids});
  assert.deepEqual(result.failed,[]);assert.deepEqual(result.partial,[]);
  for(const id of ids){
    assert.deepEqual(result.resolved[id].ipv4,[addresses[id]+'/32']);
    const policy=freezeRouting({mode:'selected',services:[id],resolved:{[id]:result.resolved[id]}});
    assert.deepEqual(policy.services,[id]);assert.deepEqual(storedRouting(policy),policy);
    const routes=routesFor(policy,'1.1.1.1');assert(routes.includes(addresses[id]+'/32'));
    for(const other of ids.filter(other=>other!==id))assert(!routes.includes(addresses[other]+'/32'));
  }
  const meta=freezeRouting({mode:'selected',services:['instagram','whatsapp','facebook']});
  assert.deepEqual(meta.ipv4,catalog.services.find(s=>s.id==='instagram').ipv4);
  assert.deepEqual(storedRouting(meta),meta);
});
