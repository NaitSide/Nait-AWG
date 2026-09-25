'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requireReceiverAuth } = require('./auth');

function invoke(authHeader, expectedKey) {
  const previous = process.env.RECEIVER_API_KEY;
  if (expectedKey === undefined) delete process.env.RECEIVER_API_KEY;
  else process.env.RECEIVER_API_KEY = expectedKey;
  let nextCalled = false;
  let status;
  const response = { status(code) { status = code; return this; }, json() { return this; } };
  try {
    requireReceiverAuth({ get: () => authHeader }, response, () => { nextCalled = true; });
    return { nextCalled, status };
  } finally {
    if (previous === undefined) delete process.env.RECEIVER_API_KEY;
    else process.env.RECEIVER_API_KEY = previous;
  }
}

test('Receiver denies missing or placeholder API key', () => {
  assert.deepEqual(invoke('', undefined), { nextCalled: false, status: 401 });
  assert.deepEqual(invoke('Bearer change-me', 'change-me'), { nextCalled: false, status: 401 });
});

test('Receiver accepts only the configured bearer token', () => {
  assert.deepEqual(invoke('Bearer wrong', 'test-secret'), { nextCalled: false, status: 401 });
  assert.deepEqual(invoke('Bearer test-secret', 'test-secret'), { nextCalled: true, status: undefined });
});
