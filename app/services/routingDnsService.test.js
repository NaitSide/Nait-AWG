'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createRoutingDnsService}=require('./routingDnsService');
const answer=(records,status=0)=>new Response(JSON.stringify({Status:status,Answer:records.map(data=>({type:1,data}))}));
test('DNS refresh uses both fixed HTTPS providers, deduplicates public A records and caches a preview',async()=>{
  const calls=[];
  const resolver=createRoutingDnsService({fetch:async(url,options)=>{
    calls.push({url,options});return answer(['8.8.8.8','8.8.8.8','192.168.1.1','127.0.0.1','203.0.113.1','::1']);
  }});
  const result=await resolver.refresh({services:['youtube']});
  assert.deepEqual(result.resolved.youtube.ipv4,['8.8.8.8/32']);
  assert.deepEqual(result.resolved.youtube.sources,['Cloudflare','Google']);assert.deepEqual(result.failed,[]);
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
