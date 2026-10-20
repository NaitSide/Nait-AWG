'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');

test('production policy APIs enforce authentication, origin checks, validation and stale revisions',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nait-policy-api-'));
  Object.assign(process.env,{
    NAIT_AWG_DATA_KEY:Buffer.alloc(32,71).toString('base64'),
    NAIT_AWG_SESSION_SECRET:Buffer.alloc(32,72).toString('base64'),
    NAIT_AWG_ADMIN_PASSWORD:'Synthetic-test-Password-123',
    NAIT_AWG_DATA_PATH:path.join(directory,'clients.db'),
    NAIT_AWG_AUTH_PATH:path.join(directory,'admin-auth.json'),
    COOKIE_SECURE:'false',RECEIVER_URL:'http://127.0.0.1:1',
    TLS_KEY_PATH:'',TLS_CERT_PATH:''
  });
  const app=require('../server');
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const base='http://127.0.0.1:'+server.address().port;
  const call=(route,method='GET',body,headers={})=>fetch(base+route,{
    method,headers:{'content-type':'application/json',...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  for(const [route,method] of [['/api/client-policies','GET'],['/api/client-policies','POST'],
    ['/api/client-policies/generate','POST'],['/api/client-policies/resolve','POST'],['/api/peers/012345abcdef/policies','GET'],['/api/peers/012345abcdef/policies','PUT']]){
    assert.equal((await call(route,method,method==='GET'?undefined:{})).status,401);
  }
  const login=await call('/api/login','POST',{username:'admin',password:process.env.NAIT_AWG_ADMIN_PASSWORD});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0],headers={cookie};
  assert.equal((await call('/api/client-policies/resolve','POST',{services:['youtube']},{...headers,origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await call('/api/client-policies/resolve','POST',{services:['https://untrusted.invalid']},headers)).status,400);
  const state=await (await call('/api/client-policies','GET',undefined,headers)).json();
  assert.equal(state.revision,0);
  const generate=await call('/api/client-policies/generate','POST',{profile:'dns'},headers);
  assert.equal(generate.status,200);assert((await generate.json()).packets.I1);
  const input={expectedRevision:0,type:'routing',value:{mode:'selected',services:['telegram']}};
  assert.equal((await call('/api/client-policies','POST',input,{...headers,origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await call('/api/client-policies','POST',{...input,value:{mode:'selected',services:[]}},headers)).status,400);
  assert.equal((await call('/api/client-policies','POST',input,headers)).status,200);
  assert.equal((await call('/api/client-policies','POST',input,headers)).status,409);
  assert.equal((await call('/api/peers/012345abcdef/policies','PUT',{expectedRevision:1},headers)).status,404);
  assert.equal((await call('/api/client-policies/generate','POST',{profile:'tls'},headers)).status,400);
});
