'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  API_URL,
  normalizeRelease,
  getLatestAwgToolsRelease,
  clearReleaseCache
} = require('../app/services/releaseService');

test('normalizes an official amneziawg-tools release', () => {
  const result = normalizeRelease({
    tag_name: 'v3.1.20260812',
    html_url: 'https://github.com/amnezia-vpn/amneziawg-tools/releases/tag/v3.1.20260812',
    published_at: '2026-08-12T10:20:30Z'
  });
  assert.equal(result.component, 'amneziawg-tools');
  assert.equal(result.tagName, 'v3.1.20260812');
  assert.equal(result.publishedAt, '2026-08-12T10:20:30.000Z');
});

test('rejects a release URL outside the official repository', () => {
  assert.throws(() => normalizeRelease({
    tag_name: 'v1.0.0',
    html_url: 'https://example.com/releases/v1.0.0'
  }), /payload is incomplete/);
});

test('caches the latest release check for ten minutes', async () => {
  clearReleaseCache();
  let calls = 0;
  const request = async url => {
    calls += 1;
    assert.equal(url, API_URL);
    return {
      tag_name: 'v3.1.20260812',
      html_url: 'https://github.com/amnezia-vpn/amneziawg-tools/releases/tag/v3.1.20260812',
      published_at: '2026-08-12T10:20:30Z'
    };
  };
  const first = await getLatestAwgToolsRelease({ now: 1_000_000, request });
  const second = await getLatestAwgToolsRelease({ now: 1_000_001, request });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  clearReleaseCache();
});
