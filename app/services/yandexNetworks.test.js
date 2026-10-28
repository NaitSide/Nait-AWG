'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {catalog,cidr,freezeRouting,storedRouting,routesFor}=require('./routingService');
const official=require('../data/yandex-ipv4.json');
test('Yandex keeps its stable ID and covers every official IPv4 network in the exclusion export',()=>{
 const y=catalog.services.find(s=>s.id==='yandex');assert.equal(y.name.ru,'Сервисы Яндекса');assert.equal(official.ipv4.length,15);
 const networks=y.ipv4.map(cidr);for(const text of official.ipv4){const b=cidr(text);assert(networks.some(n=>n.start<=b.start&&n.end>=b.end),text);}
 const p=freezeRouting({mode:'excluded',services:['yandex']});assert.deepEqual(storedRouting(p),p);
 const allowed=routesFor(p,'1.1.1.1','203.0.113.10:51820').split(', ').map(cidr);
 for(const text of official.ipv4){const b=cidr(text);assert(!allowed.some(n=>n.start<=b.end&&b.start<=n.end),text);}
 assert(allowed.some(n=>{const v=0x08080808;return v>=n.start&&v<=n.end;}));assert(!y.ipv4.some(s=>s.includes(':')));
});
