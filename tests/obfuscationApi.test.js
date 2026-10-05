'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const http=require('node:http');const crypto=require('node:crypto');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {once}=require('node:events');const {DatabaseSync}=require('node:sqlite');
const rules=require('../app/services/obfuscationRules');
test('obfuscation API requires authorization, origin, confirmation and updates encrypted exports without replacing keys',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nait-obf-api-'));
  let parameters=rules.validate({Jc:'4',Jmin:'8',Jmax:'80',S1:'20',S2:'20',S3:'20',S4:'20',H1:'1',H2:'2',H3:'3',H4:'4',HeaderProtectionKey:Buffer.alloc(32,7).toString('base64'),RekeyAfterTime:'100-120',RekeyTimeout:'3-7',RejectAfterTime:'150-180',KeepaliveTimeout:'5-15',MaxHandshakeAttempts:'15-20',RandomTrailers:'on',DisableCookies:'on'});
  let revision='a'.repeat(64),writes=0;
  const receiver=http.createServer((req,res)=>{
    const respond=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    if(req.method==='GET'&&req.url==='/awg/obfuscation')return respond({status:'ok',parameters,revision,valuesRevision:rules.revision(parameters),peersCount:1});
    if(req.method==='POST'&&req.url==='/awg/obfuscation'){
      let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
        const input=JSON.parse(body);assert.equal(input.expectedRevision,revision);parameters=input.parameters;revision='b'.repeat(64);writes++;
        respond({status:'ok',backupId:'fixture-backup'});
      });return;
    }
    res.statusCode=404;respond({message:'fixture unavailable'});
  }).listen(0,'127.0.0.1');await once(receiver,'listening');
  process.env.RECEIVER_URL=`http://127.0.0.1:${receiver.address().port}`;
  process.env.NAIT_AWG_SESSION_SECRET=crypto.randomBytes(32).toString('base64');
  const dataKey=crypto.randomBytes(32);process.env.NAIT_AWG_DATA_KEY=dataKey.toString('base64');
  process.env.NAIT_AWG_ADMIN_LOGIN='admin';process.env.NAIT_AWG_ADMIN_PASSWORD='InitialPass123!';process.env.COOKIE_SECURE='false';
  process.env.NAIT_AWG_DATA_PATH=path.join(directory,'clients.db');process.env.NAIT_AWG_AUTH_PATH=path.join(directory,'admin-auth.json');
  const app=require('../app/server');const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const native=rules.rewrite(`[Interface]\nPrivateKey = ${Buffer.alloc(32,3).toString('base64')}\nAddress = 10.8.1.2/32\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = ${Buffer.alloc(32,4).toString('base64')}\nPresharedKey = ${Buffer.alloc(32,5).toString('base64')}\nEndpoint = example.test:9000\nAllowedIPs = 0.0.0.0/0\n`,parameters,true);
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',dataKey,iv);
  const ciphertext=Buffer.concat([cipher.update(native,'utf8'),cipher.final()]);
  const encrypted=[iv,cipher.getAuthTag(),ciphertext].map(value=>value.toString('base64')).join('.');
  const db=new DatabaseSync(process.env.NAIT_AWG_DATA_PATH);
  db.prepare("INSERT INTO clients (client_id,label,receiver_label,public_key_fingerprint,address,encrypted_config,status,created_at) VALUES ('one','One','One','aabbccddeeff','10.8.1.2/32',?,'active',?)").run(encrypted,new Date().toISOString());
  t.after(async()=>{db.close();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>receiver.close(resolve))]);if(process.platform!=='win32')fs.rmSync(directory,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin+'/api/obfuscation')).status,401);
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:'admin',password:'InitialPass123!'})});
  const cookie=login.headers.get('set-cookie').split(';',1)[0];
  const post=(route,body,requestOrigin=origin)=>fetch(origin+'/api/obfuscation/'+route,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:requestOrigin},body:JSON.stringify(body)});
  const draft={parameters:{...parameters,S1:'25',S2:'25',S3:'25',S4:'25'},expectedRevision:revision};
  assert.equal((await post('inspect',draft,'https://another.example')).status,403);
  const preview=await (await post('inspect',draft)).json();assert.equal(preview.sharedChanged,true);assert.equal(preview.savedConfigs,1);
  assert.equal((await post('apply',draft)).status,400);assert.equal(writes,0);
  assert.equal((await post('apply',{...draft,parameters:{...parameters,S1:'0'},confirmed:true})).status,400);assert.equal(writes,0);
  const applied=await post('apply',{...draft,confirmed:true});assert.equal(applied.status,200);assert.equal((await applied.json()).updatedConfigs,1);assert.equal(writes,1);
  const exported=await fetch(origin+'/api/peers/aabbccddeeff/config',{headers:{Cookie:cookie}});assert.equal(exported.status,200);
  const after=await exported.text();assert.match(after,/^S1 = 25$/m);
  assert.equal(after.split('[Peer]')[1],native.split('[Peer]')[1]);
  assert.match(after,new RegExp('PrivateKey = '+Buffer.alloc(32,3).toString('base64')));
  const stored=db.prepare('SELECT encrypted_config FROM clients').get().encrypted_config;
  assert.doesNotMatch(stored,/PrivateKey|S1 = 25/);assert.notEqual(stored,encrypted);
  assert.equal(fs.existsSync(path.join(directory,'obfuscation-pending.json')),false);
  for(const resource of ['favicon.ico','favicon.svg','apple-touch-icon.png','site.webmanifest']){
    const response=await fetch(origin+'/favicon/'+resource);assert.equal(response.status,200);assert.doesNotMatch(response.headers.get('content-type'),/text\/html/);
  }
});
