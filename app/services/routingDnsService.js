'use strict';
const {queryYandexA}=require('./yandexDns');
const {catalog, publicAddress, union} = require('./routingService');
// A bounded list of public service names. No user-provided URLs, DNS servers or domains are fetched.
const domains = Object.freeze({
  "telegram": [
    "telegram.org",
    "web.telegram.org",
    "t.me"
  ],
  "youtube": [
    "www.youtube.com",
    "youtubei.googleapis.com",
    "i.ytimg.com",
    "redirector.googlevideo.com"
  ],
  "instagram": [
    "www.instagram.com",
    "i.instagram.com",
    "graph.instagram.com"
  ],
  "openai": [
    "chatgpt.com",
    "auth.openai.com",
    "api.openai.com",
    "cdn.oaistatic.com"
  ],
  "anthropic": [
    "claude.ai",
    "api.anthropic.com"
  ],
  "whatsapp": [
    "www.whatsapp.com",
    "web.whatsapp.com",
    "g.whatsapp.net",
    "mmg.whatsapp.net",
    "pps.whatsapp.net"
  ],
  "tiktok": [
    "www.tiktok.com",
    "m.tiktok.com",
    "api16-normal-c-useast1a.tiktokv.com",
    "api16-normal-c-alisg.tiktokv.com",
    "v16-webapp-prime.tiktok.com",
    "p16-sign-va.tiktokcdn.com",
    "p16-sign-sg.tiktokcdn.com"
  ],
  "discord": [
    "discord.com",
    "gateway.discord.gg",
    "cdn.discordapp.com",
    "media.discordapp.net",
    "discord.gg",
    "discordapp.com",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
    "latency.discord.media"
  ],
  "signal": [
    "chat.signal.org",
    "storage.signal.org",
    "cdn.signal.org",
    "cdn2.signal.org",
    "cdn3.signal.org",
    "cdsi.signal.org",
    "svr2.signal.org",
    "contentproxy.signal.org",
    "sfu.voip.signal.org",
    "signal.org",
    "signal.group",
    "signal.me"
  ],
  "viber": [
    "www.viber.com",
    "secure.viber.com",
    "account.viber.com",
    "media.viber.com",
    "pg.cdn.viber.com",
    "share.viber.com",
    "share.cdn.viber.com",
    "content.cdn.viber.com",
    "aloha.viber.com",
    "ptt.viber.com",
    "stickers-search.viber.com"
  ],
  "facebook": [
    "www.facebook.com",
    "m.facebook.com",
    "graph.facebook.com",
    "static.xx.fbcdn.net",
    "scontent.xx.fbcdn.net",
    "connect.facebook.net",
    "www.messenger.com",
    "edge-mqtt.facebook.com"
  ],
  "twitter": [
    "x.com",
    "www.x.com",
    "api.x.com",
    "twitter.com",
    "api.twitter.com",
    "t.co",
    "abs.twimg.com",
    "pbs.twimg.com",
    "video.twimg.com"
  ],
  "max": [
    "max.ru",
    "web.max.ru",
    "api-tg.oneme.ru",
    "api.sferum.ru",
    "api2.oneme.ru",
    "download.max.ru",
    "go.max.ru",
    "help.max.ru",
    "legal.max.ru",
    "sferum.ru",
    "st.max.ru",
    "tamtam.chat",
    "web.sferum.ru",
    "www.max.ru"
  ],
  "vk": [
    "vk.com",
    "api.vk.com",
    "login.vk.com",
    "vk.ru",
    "id.vk.com",
    "ads.vk.com",
    "api.vk.ru",
    "apisdk.live.vkvideo.ru",
    "id.vk.ru",
    "im.vk.com",
    "limits.vk.com",
    "live.vkvideo.ru",
    "m.vk.com",
    "m.vk.ru",
    "m.vkvideo.ru",
    "maps.vk.com",
    "music.vk.com",
    "music.vk.ru",
    "oauth.vk.com",
    "persiq.vk.com",
    "pp.userapi.com",
    "pubsub.live.vkvideo.ru",
    "queuev4.vk.com",
    "st.vk.com",
    "stat.vk.com",
    "static.vk.ru",
    "stats.vk-portal.net",
    "sun9-72.userapi.com",
    "tracker-api.vk-analytics.ru",
    "ts.tracker-api.vk-analytics.ru",
    "userapi.com",
    "vk-portal.net",
    "vk.cc",
    "vk.link",
    "vk.me",
    "vkforms.ru",
    "vkmessenger.app",
    "vkmessenger.com",
    "vkplay.ru",
    "vkuser.net"
  ],
  "mail": [
    "mail.ru",
    "e.mail.ru",
    "auth.mail.ru",
    "id.mail.ru",
    "account.mail.ru",
    "ad.mail.ru",
    "clientapi.mail.ru",
    "fsa.mail.ru",
    "go.imgsmail.ru",
    "go.mail.ru",
    "imgsmail.ru",
    "my.mail.ru",
    "o2.mail.ru",
    "oauth.mail.ru",
    "r.mradx.net",
    "sdk.mail.ru",
    "suggests.go.mail.ru",
    "touch.mail.ru",
    "trk.mail.ru",
    "tv.mail.ru",
    "www.mail.ru"
  ],
  "ok": [
    "ok.ru",
    "connect.ok.ru",
    "api.ok.ru",
    "api.mycdn.me",
    "api2.ok.ru",
    "i.okcdn.ru",
    "m.ok.ru",
    "mobile.ok.ru",
    "mycdn.me",
    "odnoklassniki.ru",
    "okcdn.ru",
    "st.mycdn.me",
    "st.okcdn.ru",
    "tv.ok.ru",
    "uvapi.okcdn.ru",
    "www.ok.ru"
  ],
  "dzen": [
    "dzen.ru",
    "sso.dzen.ru"
  ],
  "rutube": [
    "rutube.ru",
    "static.rutube.ru"
  ],
  "yandex": [
    "yandex.ru",
    "ya.ru",
    "passport.yandex.ru",
    "api-maps.yandex.ru",
    "yastatic.net",
    "taxi.yandex.ru",
    "geocode-maps.yandex.ru",
    "suggest-maps.yandex.ru",
    "static-maps.yandex.ru",
    "maps.yandex.ru",
    "internet.yandex.ru",
    "ipv4-internet.yandex.net",
    "core-renderer-tiles.maps.yandex.net",
    "man.proxy.mob.maps.yandex.net",
    "mobile-maps-common.s3.yandex.net",
    "mobmaps-proxy-api-ext-bb.maps.yandex.net",
    "proxy.mob.maps.yandex.net",
    "proxy.mob.virtual.maps.yandex.net",
    "uz.mob.maps.yandex.net"
  ],
  "gosuslugi": [
    "af.gosuslugi.ru",
    "auto.gosuslugi.ru",
    "bot.gosuslugi.ru",
    "commission.gosuslugi.ru",
    "cras.gosuslugi.ru",
    "do.gosuslugi.ru",
    "dom.gosuslugi.ru",
    "download.gosuslugi.ru",
    "elections.gosuslugi.ru",
    "eln.gosuslugi.ru",
    "epgu.gosuslugi.ru",
    "esia.gosuslugi.ru",
    "goskey.gosuslugi.ru",
    "gosuslugi.ru",
    "gu-st.ru",
    "knd.gosuslugi.ru",
    "lk.gosuslugi.ru",
    "map.gosuslugi.ru",
    "max.gosuslugi.ru",
    "oplata.gosuslugi.ru",
    "pay.gosuslugi.ru",
    "payment.gosuslugi.ru",
    "pos.gosuslugi.ru",
    "roles.gosuslugi.ru",
    "sign-sdk.gosuslugi.ru",
    "www.gosuslugi.ru",
    "www2.gosuslugi.ru",
    "goskey.ru",
    "host1.goskey.ru",
    "host2.goskey.ru"
  ],
  "ozon": [
    "www.ozon.ru",
    "api.ozon.ru",
    "ir.ozone.ru"
  ],
  "wildberries": [
    "api-ios.wildberries.ru",
    "apps-config.wildberries.ru",
    "banners-bt.wildberries.ru",
    "basket-01.wbbasket.ru",
    "cart-storage-api.wildberries.ru",
    "cdn.wbbasket.ru",
    "chances.wildberries.ru",
    "data-checker.wildberries.ru",
    "delivery-bt.wildberries.ru",
    "deliveryprice.wildberries.ru",
    "home-service.wildberries.ru",
    "installments-aggregator-bt.wildberries.ru",
    "installments.wildberries.ru",
    "journal-bt.wildberries.ru",
    "locator.wildberries.ru",
    "marketing-info.wildberries.ru",
    "marketplace-sentry.wb.ru",
    "mkk.wildberries.ru",
    "napi.wildberries.ru",
    "paywb.com",
    "points-bt.wildberries.ru",
    "points.wb.ru",
    "specials.wildberries.ru",
    "splitter.wb.ru",
    "sso.wb.ru",
    "static-basket-01.wb.ru",
    "static-basket-01.wbbasket.ru",
    "static-basket-03.wbbasket.ru",
    "ug-bt.wildberries.ru",
    "ui-bt.wildberries.ru",
    "user-features.wb.ru",
    "user-vector-info.wb.ru",
    "wb-balance.wildberries.ru",
    "wb-wallet.wildberries.ru",
    "wbx-bell-pushtokens.wildberries.ru",
    "wbx-bell-v3.wildberries.ru",
    "wbxoofex.wildberries.ru",
    "wildberries.ru",
    "www.wildberries.ru",
    "xapi.wildberries.ru"
  ],
  "avito": [
    "www.avito.ru",
    "m.avito.ru",
    "www.avito.st"
  ],
  "sbp": [
    "nspk.ru",
    "privetmir.ru",
    "qr.nspk.ru",
    "sbp.nspk.ru",
    "sub.nspk.ru",
    "web.qr.nspk.ru",
    "www.nspk.ru",
    "www.privetmir.ru",
    "ift.platiecom.ru",
    "platiecom.ru",
    "platiqr.ru",
    "safepayonline.ru",
    "www.platiqr.ru"
  ],
  "cupis-wallet": [
    "1cupis.ru",
    "wallet.1cupis.ru",
    "chat.1cupis.ru"
  ],
  "stolichki": [
    "app.neo-pharm.ru",
    "f.stolichki.ru",
    "stolichki.ru",
    "www.stolichki.ru",
    "api.stolichki.ru",
    "api2.stolichki.ru",
    "cdn.stolichki.ru",
    "smartcaptcha.yandexcloud.net",
    "prisma-test.d-services.ru",
    "api.privet.d-services.ru",
    "ws.privet.d-services.ru"
  ],
  "banks": [
    "3dsec.sberbank.ru",
    "api.spasibosb.ru",
    "cdn-app.sberdevices.ru",
    "cdn.sberbank.ru",
    "cdn.sberdevices.ru",
    "cfg1.online.sberbank.ru",
    "cfg2.online.sberbank.ru",
    "cfg3.online.sberbank.ru",
    "api-common-gw.t-bank-app.ru",
    "api-common-gw.tbank.ru",
    "api-invest-gw.t-bank-app.ru",
    "api-payments-p.t-bank-app.ru",
    "api.t-bank-app.ru",
    "api.tbank.ru",
    "api.tinkoff.ru",
    "as.t-bank-app.ru",
    "android-mb.vtb.ru",
    "async-online4.vtb.ru",
    "chat1.vtb.ru",
    "h.vtb.ru",
    "headless-cms.vtb.ru",
    "kdelu.vtb.ru",
    "online.vtb.ru",
    "prod-digr-mtls.vtb.ru",
    "alfa-mobile.alfabank.ru",
    "alfa.me",
    "alfabank.com",
    "alfabank.gcdn.co",
    "alfabank.ru",
    "anketa.alfabank.ru",
    "click.alfabank.ru",
    "fevent.alfabank.ru"
  ]
});
const providers = [{name:'Cloudflare',url:'https://cloudflare-dns.com/dns-query'},
  {name:'Google',url:'https://dns.google/resolve'},{name:'Yandex'}];
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
function createRoutingDnsService({fetch:fetcher=globalThis.fetch,now=()=>Date.now(),resolveYandex=queryYandexA}={}) {
  const cache=new Map();
  let pending=null;
  async function resolve(ids) {
    const deadline=AbortSignal.timeout(20000);
    const results=Object.fromEntries(ids.map(id=>[id,{ipv4:[],sources:[],failedQueries:0}]));
    const tasks=ids.flatMap(id=>domains[id].flatMap(domain=>providers.map(provider=>({id,domain,provider}))));
    let index=0;
    await Promise.all(Array.from({length:Math.min(8,tasks.length)},async()=>{
      while(index<tasks.length) {
        const {id,domain,provider}=tasks[index++],entry=results[id];
        try {
          let data;
          if(provider.name==='Yandex'){
            const ips=await resolveYandex(domain,AbortSignal.any([deadline,AbortSignal.timeout(4000)]));
            data={Status:0,Answer:ips.map(data=>({type:1,data}))};
          }else{
          const url=new URL(provider.url);url.searchParams.set('name',domain);url.searchParams.set('type','A');
          if(provider.name==='Google')url.searchParams.set('edns_client_subnet','0.0.0.0/0');
          const response=await fetcher(url,{headers:{accept:'application/dns-json'},redirect:'error',signal:AbortSignal.any([deadline,AbortSignal.timeout(4000)])});
          data=await jsonResponse(response);
          }
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
