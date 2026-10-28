'use strict';
const {Resolver}=require('node:dns').promises;
async function queryYandexA(domain,signal,{resolverFactory=()=>new Resolver({timeout:2000,tries:1})}={}){
 const resolver=resolverFactory();resolver.setServers(['77.88.8.8','77.88.8.1']);
 const cancel=()=>resolver.cancel();
 if(signal.aborted)throw signal.reason;
 signal.addEventListener('abort',cancel,{once:true});
 try{return await resolver.resolve4(domain);}finally{signal.removeEventListener('abort',cancel);}
}
module.exports={queryYandexA};
