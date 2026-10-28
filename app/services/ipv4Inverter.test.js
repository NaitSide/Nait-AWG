'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {invertIPv4,collapseIPv4,range}=require('./ipv4Inverter');
test('inversion matches PowerShell boundary examples and canonicalizes host bits',()=>{
 assert.deepEqual(invertIPv4([]),['0.0.0.0/0']);assert.deepEqual(invertIPv4(['0.0.0.0/0']),[]);
 assert.deepEqual(invertIPv4(['0.0.0.0/1']),['128.0.0.0/1']);assert.deepEqual(invertIPv4(['128.0.0.0/1']),['0.0.0.0/1']);
 assert.equal(invertIPv4(['0.0.0.0','255.255.255.255']).length,62);
 assert.deepEqual(invertIPv4(['192.168.1.15/24','192.168.1.0/25']),invertIPv4(['192.168.1.0/24']));
 assert.deepEqual(collapseIPv4(['10.0.0.0/25','10.0.0.128/25','10.0.0.20']),['10.0.0.0/24']);
 for(const v of ['::1','1.2.3.4/33','1.2.3','1.2.3.4/','1.2.3.4/1/2','1.2.3.4\nBad=1',null])assert.throws(()=>invertIPv4([v]));
});
test('randomized partitions exactly cover IPv4 once, with no excluded addresses or mergeable sibling routes',()=>{
 let seed=619;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 for(let i=0;i<150;i++){
  const tokens=Array.from({length:1+rand()%25},()=>{const n=rand();return [(n>>>24),(n>>>16)&255,(n>>>8)&255,n&255].join('.')+'/'+(8+rand()%25);});
  const excluded=collapseIPv4(tokens).map(range),allowed=invertIPv4(tokens),blocks=allowed.map(range);
  const partition=[...excluded.map(b=>({...b,type:'excluded'})),...blocks.map(b=>({...b,type:'allowed'}))].sort((a,b)=>a.start-b.start);
  let cursor=0;for(const b of partition){assert.equal(b.start,cursor);cursor=b.end+1;}assert.equal(cursor,2**32);
  assert.deepEqual(collapseIPv4(allowed),allowed);
 }
});
