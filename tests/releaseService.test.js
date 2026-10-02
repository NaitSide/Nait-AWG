'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  API_URL,
  NAIT_PACKAGE_API_URL,
  normalizeRelease,
  normalizeNaitAwgVersion,
  getLatestAwgToolsRelease,
  getLatestNaitAwgVersion,
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

test('normalizes the Nait-AWG version published on main', () => {
  const result = normalizeNaitAwgVersion({
    name: 'package.json',
    html_url: 'https://github.com/NaitSide/Nait-AWG/blob/main/package.json',
    content: Buffer.from(JSON.stringify({ name: 'nait-awg', version: '0.1.0' })).toString('base64')
  });
  assert.equal(result.component, 'nait-awg');
  assert.equal(result.version, '0.1.0');
  assert.equal(result.tagName, 'v0.1.0');
  assert.equal(result.repositoryUrl, 'https://github.com/NaitSide/Nait-AWG');
});

test('rejects an invalid Nait-AWG package payload', () => {
  assert.throws(() => normalizeNaitAwgVersion({
    name: 'package.json',
    html_url: 'https://example.com/package.json',
    content: Buffer.from(JSON.stringify({ name: 'something-else', version: 'latest' })).toString('base64')
  }), /payload is incomplete/);
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

test('caches the Nait-AWG version check for ten minutes', async () => {
  clearReleaseCache();
  let calls = 0;
  const request = async url => {
    calls += 1;
    assert.equal(url, NAIT_PACKAGE_API_URL);
    return {
      name: 'package.json',
      html_url: 'https://github.com/NaitSide/Nait-AWG/blob/main/package.json',
      content: Buffer.from(JSON.stringify({ name: 'nait-awg', version: '0.1.0' })).toString('base64')
    };
  };
  const first = await getLatestNaitAwgVersion({ now: 2_000_000, request });
  const second = await getLatestNaitAwgVersion({ now: 2_000_001, request });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  clearReleaseCache();
});
