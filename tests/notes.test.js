'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createAwgService } = require('../app/services/awgService');

test('notes persist separately from VPN clients and accept existing peers', async () => {
  const publicKey = 'local-fixture-public-key';
  const fingerprint = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 12);
  const receiver = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', peers: [{ publicKey, allowedIps: ['10.8.1.2/32'] }] }));
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  try {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nait-awg-notes-test-'));
    const env = {
      RECEIVER_URL: `http://127.0.0.1:${receiver.address().port}`,
      NAIT_AWG_DATA_KEY: crypto.randomBytes(32).toString('base64'),
      NAIT_AWG_DATA_PATH: path.join(directory, 'clients.db')
    };
    const service = createAwgService(env);
    await assert.rejects(service.updatePeerNote('000000000000', 'Чужая заметка'), { code: 'peer_not_found' });
    await assert.rejects(service.updatePeerNote(fingerprint, 'x'.repeat(2001)), { code: 'invalid_note' });
    await assert.rejects(service.updatePeerMetadata(fingerprint, { note: '', telegram: 'x'.repeat(81) }), { code: 'invalid_telegram' });
    await assert.rejects(service.updatePeerMetadata('000000000000', { note: '', telegram: '@someone' }), { code: 'peer_not_found' });
    await service.updatePeerNote(fingerprint, 'Тестовая заметка');
    assert.equal((await service.listPeers())[0].note, 'Тестовая заметка');
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'peer-notes.json'), 'utf8')).notes[fingerprint], 'Тестовая заметка');
    assert.equal((await createAwgService(env).listPeers())[0].note, 'Тестовая заметка');
    await service.updatePeerMetadata(fingerprint, { note: 'Другая заметка', telegram: '@username' });
    assert.equal((await service.listPeers())[0].telegram, '@username');
    assert.deepEqual((await createAwgService(env).listPeers())[0].telegram, '@username');
    await service.updatePeerNote(fingerprint, '');
    assert.equal((await service.listPeers())[0].note, '');
    assert.equal((await service.listPeers())[0].telegram, '@username');
    await service.updatePeerMetadata(fingerprint, { note: '', telegram: '' });
    assert.equal((await service.listPeers())[0].telegram, '');
    const metadataPath = path.join(directory, 'peer-notes.json');
    fs.writeFileSync(metadataPath, JSON.stringify({ version: 1, notes: { [fingerprint]: 'Старая заметка' } }));
    const legacyService = createAwgService(env);
    assert.equal((await legacyService.listPeers())[0].note, 'Старая заметка');
    assert.equal((await legacyService.listPeers())[0].telegram, '');
    await legacyService.updatePeerMetadata(fingerprint, { note: 'Старая заметка', telegram: '@new_user' });
    assert.equal(JSON.parse(fs.readFileSync(metadataPath, 'utf8')).notes[fingerprint], 'Старая заметка');
  } finally {
    await new Promise(resolve => receiver.close(resolve));
  }
});
