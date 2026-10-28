'use strict';
const net=require('node:net');
const MAX=2**32-1;
function bad(){return Object.assign(new Error('Некорректные IPv4-исключения.'),{status:400,code:'invalid_ipv4_exclusions'});}
function address(n){return [24,16,8,0].map(shift=>Math.floor(n/2**shift)%256).join('.');}
function range(token){
 if(typeof token!=='string')throw bad();
 const [host,prefixText,extra]=token.trim().split('/');
 if(net.isIP(host)!==4||extra!==undefined||(prefixText!==undefined&&!/^\d{1,2}$/.test(prefixText)))throw bad();
 const prefix=prefixText===undefined?32:Number(prefixText);if(prefix<0||prefix>32)throw bad();
 const n=host.split('.').reduce((n,v)=>n*256+Number(v),0),size=2**(32-prefix),start=Math.floor(n/size)*size;
 return {start,end:start+size-1};
}
function merge(tokens){
 if(!Array.isArray(tokens)||tokens.length>16384)throw bad();
 const sorted=tokens.map(range).sort((a,b)=>a.start-b.start||a.end-b.end),out=[];
 for(const block of sorted){const last=out.at(-1);if(last&&block.start<=last.end+1)last.end=Math.max(last.end,block.end);else out.push({...block});}
 return out;
}
function cidrs(start,end){
 const result=[];
 while(start<=end){let size=1,bits=0;while(size<2**32&&start%(size*2)===0&&start+size*2-1<=end){size*=2;bits++;}
  result.push(address(start)+'/'+(32-bits));start+=size;}
 return result;
}
function collapseIPv4(tokens){return merge(tokens).flatMap(b=>cidrs(b.start,b.end));}
function invertIPv4(tokens){
 let cursor=0;const out=[];
 for(const excluded of merge(tokens)){if(excluded.start>cursor)out.push(...cidrs(cursor,excluded.start-1));cursor=excluded.end+1;}
 if(cursor<=MAX)out.push(...cidrs(cursor,MAX));return out;
}
module.exports={invertIPv4,collapseIPv4,range};
