'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {catalog,freezeRouting,storedRouting,routesFor,cidr}=require('./routingService');
const {domains}=require('./routingDnsService');
const observed=["185.138.253.1","185.138.253.20","185.138.254.101","185.138.254.68","185.138.255.1","185.138.255.20","185.62.201.65","185.62.202.12","185.62.202.2","185.62.202.4","185.62.202.8","185.62.202.9","213.184.155.142","213.184.155.145","213.184.155.33","213.184.155.47","213.184.155.74","213.184.155.75","213.184.157.16","213.184.157.7","213.184.159.0","85.198.77.14","85.198.77.15","85.198.77.2","85.198.77.24","85.198.77.26","85.198.77.48","85.198.77.99","85.198.78.11","85.198.79.101","85.198.79.102","85.198.79.2","85.198.79.24","85.198.79.26","85.198.79.73","85.198.79.92","85.198.79.99","90.156.247.12"];
test('Wildberries capture routes bypass VPN without excluding unrelated neighbours',()=>{
 const policy=freezeRouting({mode:'excluded',services:['wildberries']});
 assert.deepEqual(storedRouting(policy),policy);
 const ranges=routesFor(policy,'1.1.1.1','203.0.113.10:51820').split(', ').map(cidr);
 const viaVpn=ip=>{const n=ip.split('.').reduce((n,v)=>n*256+Number(v),0);return ranges.some(r=>n>=r.start&&n<=r.end);};
 for(const ip of observed)assert(!viaVpn(ip),ip);
 for(const ip of ['185.62.202.10','90.156.247.11','8.8.8.8'])assert(viaVpn(ip),ip);
 const service=catalog.services.find(s=>s.id==='wildberries');
 assert(service.available);assert.equal(service.ipv4.length,38);assert.equal(new Set(service.ipv4).size,38);
 assert(service.ipv4.every(ip=>ip.endsWith('/32')));
 for(const domain of ["api-ios.wildberries.ru","apps-config.wildberries.ru","banners-bt.wildberries.ru","cart-storage-api.wildberries.ru","cdn.wbbasket.ru","chances.wildberries.ru","data-checker.wildberries.ru","delivery-bt.wildberries.ru","deliveryprice.wildberries.ru","home-service.wildberries.ru","installments-aggregator-bt.wildberries.ru","installments.wildberries.ru","journal-bt.wildberries.ru","locator.wildberries.ru","marketing-info.wildberries.ru","marketplace-sentry.wb.ru","mkk.wildberries.ru","napi.wildberries.ru","paywb.com","points-bt.wildberries.ru","points.wb.ru","specials.wildberries.ru","splitter.wb.ru","sso.wb.ru","static-basket-01.wb.ru","static-basket-01.wbbasket.ru","static-basket-03.wbbasket.ru","ug-bt.wildberries.ru","ui-bt.wildberries.ru","user-features.wb.ru","user-vector-info.wb.ru","wb-balance.wildberries.ru","wb-wallet.wildberries.ru","wbx-bell-pushtokens.wildberries.ru","wbx-bell-v3.wildberries.ru","wbxoofex.wildberries.ru","wildberries.ru","xapi.wildberries.ru"])assert(domains.wildberries.includes(domain),domain);
 assert.equal(new Set(domains.wildberries).size,domains.wildberries.length);
 assert(!domains.wildberries.includes('imap.gmail.com'));
});
