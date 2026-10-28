'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net');
const {freezeRouting,storedRouting,routesFor,cidr}=require('./routingService');
const custom={id:'custom-test',name:'My service',enabled:true,ipv4:['8.8.8.8','192.168.1.0/24']};
const contains=(routes,address)=>{const number=address.split('.').reduce((n,v)=>n*256+Number(v),0);return routes.split(', ').filter(route=>!route.includes(':')).some(route=>{const block=cidr(route);return number>=block.start&&number<=block.end;});};
test('custom-only selections canonicalize IPv4 hosts, retain unchecked rows and survive stored-state validation',()=>{
  const policy=freezeRouting({mode:'selected',services:[],custom:[custom,{...custom,id:'custom-disabled',enabled:false,ipv4:['9.9.9.9']}],bypassLocal:false});
  assert.deepEqual(policy.ipv4,['8.8.8.8/32','192.168.1.0/24']);assert.deepEqual(storedRouting(policy),policy);
  const exported=routesFor(policy,'1.1.1.1');assert(contains(exported,'192.168.1.3'));assert(!contains(exported,'9.9.9.9'));
});
test('local bypass removes private routes even when a custom row contains them, while public DNS remains tunneled',()=>{
  const policy=freezeRouting({mode:'selected',services:[],custom:[custom],bypassLocal:true});
  const routes=routesFor(policy,'1.1.1.1, 192.168.1.1');
  assert(contains(routes,'8.8.8.8'));assert(contains(routes,'1.1.1.1'));assert(!contains(routes,'192.168.1.1'));
});
test('full VPN with local bypass covers external IPv4 and IPv6, excludes LANs and avoids an endpoint route loop',()=>{
  const policy=freezeRouting({mode:'all',services:[],bypassLocal:true});
  const routes=routesFor(policy,'1.1.1.1','203.0.113.10:51820');
  for(const address of ['8.8.8.8','1.1.1.1','203.0.113.11','192.169.0.1'])assert(contains(routes,address),address);
  for(const address of ['10.0.1.1','172.16.2.1','172.31.255.255','192.168.1.1','203.0.113.10'])assert(!contains(routes,address),address);
  const v6=routes.split(', ').filter(route=>route.includes(':'));
  assert(v6.length);assert(v6.every(route=>net.isIP(route.split('/')[0])===6));assert(!v6.includes('::/0'));
  const number6=text=>{const [head,tail]=text.split('::'),left=head?head.split(':'):[],right=tail?tail.split(':'):[];
    return [...left,...Array(text.includes('::')?8-left.length-right.length:0).fill('0'),...right].reduce((n,part)=>(n<<16n)+BigInt('0x'+part),0n);};
  const covers6=text=>v6.some(route=>{const [base,prefix]=route.split('/'),shift=128n-BigInt(prefix);return number6(text)>>shift===number6(base)>>shift;});
  for(const address of ['2606:4700:4700::1111','2001:4860:4860::8888','fe7f::1','fec0::1'])assert(covers6(address),address);
  for(const address of ['fc00::1','fdff:ffff::1','fe80::1','febf:ffff::1'])assert(!covers6(address),address);
  assert.throws(()=>routesFor(policy,'1.1.1.1','vpn.example.com:51820'),{code:'split_endpoint_ipv4_required'});
  assert.equal(routesFor(freezeRouting({mode:'all',services:[]}),'1.1.1.1'),'0.0.0.0/0, ::/0');
});
test('DNS snapshots enable a DNS-only service and preserve its exact addresses after storage',()=>{
  const policy=freezeRouting({mode:'selected',services:['openai'],resolved:{openai:{ipv4:['1.1.1.1/32'],updatedAt:'2026-10-20T00:00:00Z',sources:['Google']}}});
  assert.deepEqual(storedRouting(policy).ipv4,['1.1.1.1/32']);
  assert.throws(()=>freezeRouting({...policy,resolved:{openai:{...policy.resolved.openai,ipv4:['10.0.0.1/32']}}}));
});
test('invalid custom rows cannot become default routes or inject config directives',()=>{
  for(const patch of [{ipv4:['0.0.0.0/0']},{ipv4:['8.8.8.1/24']},{ipv4:['::/0']},{ipv4:['1.1.1.1\nPostUp=bad']},{name:''},{name:'bad\nname'}]) {
    assert.throws(()=>freezeRouting({mode:'selected',services:[],custom:[{...custom,...patch}]}));
  }
});

test('per-service manual routes enable DNS-only services and remain isolated across storage and selection',()=>{
 const value={mode:'selected',services:['openai'],extras:{openai:['9.9.9.9','9.9.9.9/32','10.1.0.0/16'],anthropic:['8.8.4.4']},bypassLocal:true};
 const saved=freezeRouting(value);assert.deepEqual(saved.ipv4,['9.9.9.9/32','10.1.0.0/16']);assert.deepEqual(storedRouting(saved),saved);
 const routes=routesFor(saved,'1.1.1.1');assert(contains(routes,'9.9.9.9'));assert(!contains(routes,'8.8.4.4'));assert(!contains(routes,'10.1.0.1'));
 for(const extras of [{unknown:['8.8.8.8']},{openai:['0.0.0.0/0']},{openai:['8.8.8.1/24']},{openai:['::1']},{openai:['1.1.1.1\nBad=1']}])assert.throws(()=>freezeRouting({...value,extras}));
});
