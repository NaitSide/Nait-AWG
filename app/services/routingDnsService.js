'use strict';
const {catalog, publicAddress, union} = require('./routingService');
// A bounded list of public service names. No user-provided URLs, DNS servers or domains are fetched.
const domains = Object.freeze({
  telegram:['telegram.org','web.telegram.org','t.me'],
  youtube:['www.youtube.com','youtubei.googleapis.com','i.ytimg.com','redirector.googlevideo.com'],
  instagram:['www.instagram.com','i.instagram.com','graph.instagram.com'],
  openai:['chatgpt.com','auth.openai.com','api.openai.com','cdn.oaistatic.com'],
  anthropic:['claude.ai','api.anthropic.com']
});
const providers = [{name:'Cloudflare',url:'https://cloudflare-dns.com/dns-query'},
  {name:'Google',url:'https://dns.google/resolve'}];
function failure(code,message,status=400) {return Object.assign(new Error(message),{code,status});}
async function jsonResponse(response) {
  if(!response.ok) throw Error('DNS HTTP error');
  let size=0;const chunks=[];
  for await(const chunk of response.body) {
    size+=chunk.length;
    if(size>65536)throw Error('DNS response is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function createRoutingDnsService({fetch:fetcher=globalThis.fetch,now=()=>Date.now()}={}) {
  const cache=new Map();
  let pending=null;
  async function resolve(ids) {
    const results=Object.fromEntries(ids.map(id=>[id,{ipv4:[],sources:[],failedQueries:0}]));
    const tasks=ids.flatMap(id=>domains[id].flatMap(domain=>providers.map(provider=>({id,domain,provider}))));
    let index=0;
    await Promise.all(Array.from({length:Math.min(8,tasks.length)},async()=>{
      while(index<tasks.length) {
        const {id,domain,provider}=tasks[index++],entry=results[id];
        try {
          const url=new URL(provider.url);url.searchParams.set('name',domain);url.searchParams.set('type','A');
          if(provider.name==='Google')url.searchParams.set('edns_client_subnet','0.0.0.0/0');
          const response=await fetcher(url,{headers:{accept:'application/dns-json'},redirect:'error',signal:AbortSignal.timeout(4000)});
          const data=await jsonResponse(response);
          if(data.Status!==0 || data.TC===true || !Array.isArray(data.Answer) || data.Answer.length>256)throw Error('DNS has no usable answer');
          const addresses=data.Answer.filter(record=>record.type===1&&publicAddress(record.data)).map(record=>record.data+'/32');
          if(!addresses.length)throw Error('DNS has no public IPv4');
          entry.ipv4.push(...addresses);entry.sources.push(provider.name);
        } catch {entry.failedQueries++;}
      }
    }));
    const resolved={},failed=[],partial=[];
    for(const [id,entry] of Object.entries(results)) {
      if(!entry.ipv4.length) {failed.push(id);continue;}
      const ipv4=union(entry.ipv4);
      if(ipv4.length>256) {failed.push(id);continue;}
      resolved[id]={ipv4,updatedAt:new Date(now()).toISOString(),sources:[...new Set(entry.sources)].sort()};
      if(entry.failedQueries)partial.push(id);
    }
    if(!Object.keys(resolved).length)throw failure('routing_dns_unavailable','DNS-серверы не вернули адреса. Предыдущие списки сохранены.',502);
    return {resolved,failed,partial};
  }
  return {async refresh(input) {
    const ids=input?.services;
    if(!Array.isArray(ids)||!ids.length||ids.length>catalog.services.length||new Set(ids).size!==ids.length
        ||ids.some(id=>typeof id!=='string'||!Object.hasOwn(domains,id)))throw failure('invalid_dns_selection','Выберите сервисы из списка.');
    const key=[...ids].sort().join(',');
    const saved=cache.get(key);if(saved&&now()-saved.at<60000)return structuredClone(saved.value);
    if(pending) {
      if(pending.key===key)return structuredClone(await pending.promise);
      throw failure('routing_dns_busy','Обновление адресов уже выполняется. Дождитесь результата.',429);
    }
    pending={key,promise:resolve(ids)};
    try {const value=await pending.promise;cache.set(key,{at:now(),value});return structuredClone(value);}
    finally {pending=null;}
  }};
}
module.exports={createRoutingDnsService,domains};
