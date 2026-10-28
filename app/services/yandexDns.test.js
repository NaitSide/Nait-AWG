'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {queryYandexA}=require('./yandexDns');
test('Yandex uses fixed basic IPv4 resolvers and cancels a running query on abort',async()=>{
 let servers,name,reject,cancelled=0;
 const controller=new AbortController(),resolver={setServers:value=>{servers=value;},resolve4:domain=>{name=domain;return new Promise((_,fail)=>{reject=fail;});},cancel:()=>{cancelled++;reject(Object.assign(Error('cancelled'),{code:'ECANCELLED'}));}};
 const task=queryYandexA('gosuslugi.ru',controller.signal,{resolverFactory:()=>resolver});controller.abort();
 await assert.rejects(task,{code:'ECANCELLED'});assert.deepEqual(servers,['77.88.8.8','77.88.8.1']);assert.equal(name,'gosuslugi.ru');assert.equal(cancelled,1);
 await assert.rejects(queryYandexA('gosuslugi.ru',controller.signal,{resolverFactory:()=>({...resolver,resolve4:()=>{throw Error('must not run');}})}),{name:'AbortError'});
});
test('Yandex alone can refresh public A records, and a later full outage cannot erase stored snapshots',async()=>{
 const {createRoutingDnsService}=require('./routingDnsService'),{freezeRouting,storedRouting}=require('./routingService');
 const r=await createRoutingDnsService({fetch:async()=>{throw Error('HTTPS outage');},resolveYandex:async()=>['213.59.253.7','213.59.253.7','10.0.0.1','::1']}).refresh({services:['gosuslugi']});
 assert.deepEqual(r.resolved.gosuslugi.ipv4,['213.59.253.7/32']);assert.deepEqual(r.resolved.gosuslugi.sources,['Yandex']);assert.deepEqual(r.partial,['gosuslugi']);
 const p=freezeRouting({mode:'excluded',services:['gosuslugi'],resolved:r.resolved});assert.deepEqual(storedRouting(p),p);
 const offline=createRoutingDnsService({fetch:async()=>{throw Error('offline');},resolveYandex:async()=>{throw Error('offline');}});
 await assert.rejects(offline.refresh({services:['gosuslugi']}),{code:'routing_dns_unavailable'});assert.deepEqual(p.resolved.gosuslugi.ipv4,['213.59.253.7/32']);
});
