const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPublicIpv4, isPublicIpv4 } = require('../scripts/detect-public-ipv4');

test('accepts a public IPv4 and rejects local or reserved addresses', () => {
  assert.equal(isPublicIpv4('217.144.186.141'), true);
  for (const address of ['10.8.1.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.1.1', '100.64.1.1', '203.0.113.1', '999.1.1.1']) {
    assert.equal(isPublicIpv4(address), false, address);
  }
});

test('prefers the route source, then SSH server address', () => {
  assert.equal(detectPublicIpv4({ route: '1.1.1.1 via 1.2.3.4 dev eth0 src 217.144.186.141 uid 0', sshConnection: '2.2.2.2 1234 3.3.3.3 2121' }), '217.144.186.141');
  assert.equal(detectPublicIpv4({ route: '1.1.1.1 dev eth0 src 10.0.0.2', sshConnection: '2.2.2.2 1234 217.144.186.141 2121' }), '217.144.186.141');
  assert.equal(detectPublicIpv4({ route: '1.1.1.1 dev eth0 src 10.0.0.2', sshConnection: '2.2.2.2 1234 10.0.0.2 2121' }), '');
});
