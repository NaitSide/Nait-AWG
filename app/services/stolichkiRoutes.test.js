'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {catalog,freezeRouting,storedRouting,routesFor,cidr}=require('./routingService');
const {domains}=require('./routingDnsService');
test('Stolichki capture addresses bypass VPN with narrow host routes and survive storage',()=>{
 const p=freezeRouting({mode:'excluded',services:['stolichki']});assert.deepEqual(storedRouting(p),p);
 const text=routesFor(p,'1.1.1.1','203.0.113.10:51820');
 const contains=ip=>{const n=ip.split('.').reduce((n,v)=>n*256+Number(v),0);return text.split(', ').some(r=>{const b=cidr(r);return n>=b.start&&n<=b.end;});};
 for(const ip of ["109.238.88.146","91.231.235.125","185.31.113.61","84.201.151.229","45.12.229.27"])assert(!contains(ip),ip);
 for(const ip of ['185.31.113.60','91.231.235.124','8.8.8.8','142.250.102.95','9.9.9.9'])assert(contains(ip),ip);
 assert(catalog.services.find(s=>s.id==='stolichki').ipv4.every(s=>s.endsWith('/32')));
 assert(domains.stolichki.includes('cdn.stolichki.ru'));assert(domains.stolichki.includes('smartcaptcha.yandexcloud.net'));
 assert(!domains.stolichki.includes('sync.browser.yandex.net'));assert(!domains.stolichki.includes('fonts.googleapis.com'));
});
