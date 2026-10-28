'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {freezeRouting,storedRouting,routesFor,cidr,catalog}=require('./routingService');
const contains=(text,address)=>{const n=address.split('.').reduce((n,v)=>n*256+Number(v),0);return text.split(', ').some(s=>{if(s==='0.0.0.0/0')return true;const b=cidr(s);return n>=b.start&&n<=b.end;});};
test('excluded snapshot survives storage, removes LAN and endpoint, and never emits IPv6',()=>{
 const p=freezeRouting({mode:'excluded',services:['sbp'],extras:{sbp:['91.231.236.245','151.236.81.37']},bypassLocal:true,
  choices:{selected:{services:['telegram'],custom:[]},excluded:{services:['sbp'],custom:[]}}});
 assert.deepEqual(storedRouting(p),p);const routes=routesFor(p,'1.1.1.1','203.0.113.10:51820');
 for(const ip of ['91.231.236.245','151.236.81.37','203.0.113.10','192.168.1.1','10.0.1.1'])assert(!contains(routes,ip),ip);
 for(const ip of ['91.231.236.244','8.8.8.8','1.1.1.1','203.0.113.11'])assert(contains(routes,ip),ip);
 assert(!routes.includes(':'));assert(!p.ipv4.includes('1.1.1.1/32'));
 assert.throws(()=>routesFor(p,'1.1.1.1','vpn.example:51820'),{code:'split_endpoint_ipv4_required'});
 assert.throws(()=>routesFor(p,'91.231.236.245','203.0.113.10:51820'),{code:'excluded_dns_overlap'});
});
test('empty exclusions retain full IPv4 except endpoint, inactive choices cannot become routes',()=>{
 const p=freezeRouting({mode:'excluded',services:[],choices:{selected:{services:['youtube'],custom:[]}}});
 assert.deepEqual(storedRouting(p),p);const routes=routesFor(p,'1.1.1.1','203.0.113.10:51820');assert(contains(routes,'8.8.8.8'));assert(!contains(routes,'203.0.113.10'));
 for(const choices of [{oops:{}},{excluded:{services:['unknown'],custom:[]}},{excluded:{services:[],custom:['custom-absent']}}])assert.throws(()=>freezeRouting({...p,choices}));
 assert.equal(catalog.services.filter(s=>s.id==='sbp').length,1);assert(!catalog.services.some(s=>/gazprom|sovcom/i.test(s.id)));
});
