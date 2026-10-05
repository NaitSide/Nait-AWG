'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {encodeAmneziaChunks,buildAmneziaQrSeries}=require('../app/services/clientQrService');
const {buildAmneziaVpn}=require('../app/services/clientExportService');
const {parseClientConfig}=require('../app/services/clientConfigService');
test('QR chunks reproduce Qt QDataStream framing with 850-byte parts and zero-based indices',()=>{
  assert.equal(Buffer.from(encodeAmneziaChunks(Buffer.from('abc'))[0],'base64url').toString('hex'),'07c0010000000003616263');
  for(const size of [1,849,850,851,1700,1701,850*255]){
    const bytes=crypto.randomBytes(size),chunks=encodeAmneziaChunks(bytes),count=Math.ceil(size/850);
    assert.equal(chunks.length,count);
    const decoded=chunks.map((text,index)=>{
      assert.match(text,/^[A-Za-z0-9_-]+$/);
      const chunk=Buffer.from(text,'base64url');
      assert.equal(chunk.readInt16BE(0),1984);assert.equal(chunk[2],count);assert.equal(chunk[3],index);
      assert.equal(chunk.readUInt32BE(4),chunk.length-8);assert.ok(chunk.length<=858);
      return chunk.subarray(8);
    });
    assert.deepEqual(Buffer.concat(decoded),bytes);
  }
  for(const data of [Buffer.alloc(0),Buffer.alloc(850*255+1),'invalid'])assert.throws(()=>encodeAmneziaChunks(data),{code:'client_qr_too_large'});
});
test('series carries the exact guest export and retains native keys after reassembly',async()=>{
  const key=crypto.randomBytes(32).toString('base64');
  const config=`[Interface]\nPrivateKey = ${key}\nAddress = 10.8.1.2/32\n\n[Peer]\nPublicKey = ${crypto.randomBytes(32).toString('base64')}\nEndpoint = 203.0.113.42:40000\nAllowedIPs = 0.0.0.0/0\n`;
  const vpn=buildAmneziaVpn(config,'Test',[]),bytes=Buffer.from(vpn.slice(6),'base64url');
  const parts=encodeAmneziaChunks(bytes).map(text=>Buffer.from(text,'base64url').subarray(8));
  assert.equal(parseClientConfig('vpn://'+Buffer.concat(parts).toString('base64url'),[]).config,config);
  const series=await buildAmneziaQrSeries(vpn);
  assert.equal(series.intervalMs,1000);assert.equal(series.frames.length,parts.length);
  for(const frame of series.frames){assert.match(frame,/^data:image\/svg\+xml;base64,/);assert.match(Buffer.from(frame.split(',')[1],'base64').toString(),/<svg[^>]*width="512" height="512"/);}
  await assert.rejects(buildAmneziaQrSeries('invalid'),{code:'invalid_client_export'});
});
