'use strict';
const QRCode = require('qrcode');

// Official Qt wire format: qint16 magic, quint8 count/index, QByteArray length+bytes.
// https://github.com/amnezia-vpn/amnezia-client/blob/dev/client/core/utils/qrCodeUtils.cpp
const CHUNK_BYTES = 850;
function encodeAmneziaChunks(data) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > CHUNK_BYTES * 255) {
    throw Object.assign(new Error('Конфиг слишком велик для составного QR-кода.'), {status:400,code:'client_qr_too_large'});
  }
  const count = Math.ceil(data.length / CHUNK_BYTES);
  return Array.from({length:count}, (_, index) => {
    const bytes=data.subarray(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES);
    const header=Buffer.alloc(8);
    header.writeInt16BE(1984,0);header.writeUInt8(count,2);header.writeUInt8(index,3);header.writeUInt32BE(bytes.length,4);
    return Buffer.concat([header,bytes]).toString('base64url');
  });
}
async function buildAmneziaQrSeries(vpn) {
  if (typeof vpn !== 'string' || !/^vpn:\/\/[A-Za-z0-9_-]+$/.test(vpn)) {
    throw Object.assign(new Error('Некорректный гостевой конфиг AmneziaVPN.'), {status:400,code:'invalid_client_export'});
  }
  const chunks=encodeAmneziaChunks(Buffer.from(vpn.slice(6),'base64url'));
  const frames=await Promise.all(chunks.map(async text => {
    const svg=await QRCode.toString(text,{type:'svg',width:512,margin:1,errorCorrectionLevel:'L'});
    return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
  }));
  return {format:'amneziavpn',intervalMs:1000,frames};
}
module.exports={encodeAmneziaChunks,buildAmneziaQrSeries};
