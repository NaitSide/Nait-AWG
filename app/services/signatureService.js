'use strict';
const crypto = require('node:crypto');
const PACKET_NAMES = ['I1', 'I2', 'I3', 'I4', 'I5'];
function invalid() {
  return Object.assign(new Error('Некорректные сигнатурные пакеты: проверьте теги и размер.'), {status: 400, code: 'invalid_signature'});
}
// Conservative subset shared by the original AWG runtimes. No third-party tags.
function validatePackets(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)
      || Object.keys(values).some(name => !PACKET_NAMES.includes(name))) throw invalid();
  const result = {};
  for (const name of PACKET_NAMES) {
    if (values[name] === undefined || values[name] === '') continue;
    if (typeof values[name] !== 'string' || values[name].length > 4096) throw invalid();
    const text = values[name].trim();
    const tags = text.match(/<(?:b 0x(?:[\da-fA-F]{2})+|r \d+|rd \d+|rc \d+|t)>/g) || [];
    if (tags.join('') !== text || tags.filter(tag => tag === '<t>').length > 1) throw invalid();
    let size = 0;
    for (const tag of tags) {
      if (tag === '<t>') size += 4;
      else if (tag.startsWith('<b ')) size += (tag.length - 6) / 2;
      else {
        const length = Number(tag.match(/\d+/)[0]);
        if (!Number.isInteger(length) || length < 1 || length > 1000) throw invalid();
        size += length;
      }
    }
    // UDP payload fits the IPv6 minimum link MTU (1280 - IPv6/UDP headers).
    if (size < 1 || size > 1232) throw invalid();
    result[name] = text;
  }
  return result;
}
const uint16 = value => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; };
const vector = bytes => Buffer.concat([uint16(bytes.length), bytes]);
const extension = (type, bytes) => Buffer.concat([uint16(type), vector(bytes)]);
function expand(secret, label, length) {
  const name = Buffer.from('tls13 ' + label);
  const info = Buffer.concat([uint16(length), Buffer.from([name.length]), name, Buffer.from([0])]);
  return crypto.createHmac('sha256', secret).update(info).update(Buffer.from([1])).digest().subarray(0, length);
}
function initialKeys(dcid) {
  // RFC 9001 sections 5.2, 5.4. Independent implementation; packet number = 0.
  const secret = crypto.createHmac('sha256', Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex')).update(dcid).digest();
  const client = expand(secret, 'client in', 32);
  return {key: expand(client, 'quic key', 16), iv: expand(client, 'quic iv', 12), hp: expand(client, 'quic hp', 16)};
}
function quicInitial() {
  const dcid = crypto.randomBytes(8), scid = crypto.randomBytes(8);
  const {publicKey} = crypto.generateKeyPairSync('x25519');
  const keyShare = publicKey.export({format: 'der', type: 'spki'}).subarray(-32);
  const serverName = Buffer.from('example.com');
  const transport = Buffer.concat([Buffer.from([0x0f, 8]), scid, Buffer.from([3, 2, 0x44, 0xb0])]);
  const extensions = Buffer.concat([
    extension(0, vector(Buffer.concat([Buffer.from([0]), vector(serverName)]))),
    extension(10, vector(uint16(29))), extension(13, vector(Buffer.from('08040403', 'hex'))),
    extension(16, vector(Buffer.from([2, 0x68, 0x33]))),
    extension(43, Buffer.from([2, 3, 4])),
    extension(51, vector(Buffer.concat([uint16(29), vector(keyShare)]))), extension(57, transport)
  ]);
  const hello = Buffer.concat([Buffer.from([3, 3]), crypto.randomBytes(32), Buffer.from([0]),
    vector(Buffer.from('13011302', 'hex')), Buffer.from([1, 0]), vector(extensions)]);
  const handshakeHeader = Buffer.alloc(4); handshakeHeader[0] = 1; handshakeHeader.writeUIntBE(hello.length, 1, 3);
  const handshake = Buffer.concat([handshakeHeader, hello]);
  const varint = value => uint16(0x4000 | value);
  const cryptoFrame = Buffer.concat([Buffer.from([6, 0]), varint(handshake.length), handshake]);
  const prefix = Buffer.concat([Buffer.from('c30000000108', 'hex'), dcid, Buffer.from([8]), scid, Buffer.from([0])]);
  const payloadLength = 1200 - prefix.length - 2 - 4 - 16;
  const header = Buffer.concat([prefix, varint(4 + payloadLength + 16), Buffer.alloc(4)]);
  const plaintext = Buffer.alloc(payloadLength); cryptoFrame.copy(plaintext);
  const keys = initialKeys(dcid);
  const cipher = crypto.createCipheriv('aes-128-gcm', keys.key, keys.iv); cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const packet = Buffer.concat([header, ciphertext]);
  const pnOffset = prefix.length + 2;
  const protect = crypto.createCipheriv('aes-128-ecb', keys.hp, null); protect.setAutoPadding(false);
  const mask = protect.update(packet.subarray(pnOffset + 4, pnOffset + 20));
  packet[0] ^= mask[0] & 0x0f;
  for (let i = 0; i < 4; i++) packet[pnOffset + i] ^= mask[i + 1];
  return packet;
}
function generateSignature(profile) {
  let packets;
  if (profile === 'none') packets = {};
  else if (profile === 'dns') {
    // RFC 1035 query for reserved example.com, random transaction ID. No network.
    const query = Buffer.concat([crypto.randomBytes(2), Buffer.from('01000001000000000000076578616d706c6503636f6d0000010001', 'hex')]);
    packets = {I1: '<b 0x' + query.toString('hex') + '>'};
  } else if (profile === 'quic') packets = {I1: '<b 0x' + quicInitial().toString('hex') + '>'};
  else throw Object.assign(invalid(), {code: 'unsupported_signature_profile'});
  return {profile, packets: validatePackets(packets)};
}
module.exports = {PACKET_NAMES, validatePackets, generateSignature, initialKeys};
