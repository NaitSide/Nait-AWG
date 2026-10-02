'use strict';

const https = require('https');

const API_URL = 'https://api.github.com/repos/amnezia-vpn/amneziawg-tools/releases/latest';
const REPOSITORY_URL = 'https://github.com/amnezia-vpn/amneziawg-tools';
const NAIT_PACKAGE_API_URL = 'https://api.github.com/repos/NaitSide/Nait-AWG/contents/package.json?ref=main';
const NAIT_REPOSITORY_URL = 'https://github.com/NaitSide/Nait-AWG';
const CACHE_TTL_MS = 10 * 60 * 1000;
let awgToolsCache = null;
let naitAwgCache = null;

function requestJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Nait-AWG release checker'
      }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 256 * 1024) request.destroy(new Error('GitHub response is too large'));
      });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`GitHub returned HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('GitHub returned invalid JSON')); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('GitHub request timed out')));
    request.on('error', reject);
  });
}

function normalizeRelease(payload) {
  const tagName = String(payload?.tag_name || '').trim();
  const releaseUrl = String(payload?.html_url || '').trim();
  const publishedAt = String(payload?.published_at || '').trim();
  if (!tagName || !/^https:\/\/github\.com\/amnezia-vpn\/amneziawg-tools\/releases\//.test(releaseUrl)) {
    throw new Error('GitHub release payload is incomplete');
  }
  return {
    component: 'amneziawg-tools',
    tagName,
    publishedAt: Number.isFinite(Date.parse(publishedAt)) ? new Date(publishedAt).toISOString() : '',
    releaseUrl,
    repositoryUrl: REPOSITORY_URL
  };
}

async function getLatestAwgToolsRelease(options = {}) {
  const now = Number(options.now || Date.now());
  if (awgToolsCache && now - awgToolsCache.checkedAt < CACHE_TTL_MS) return awgToolsCache.release;
  const payload = await (options.request || requestJson)(API_URL);
  const release = normalizeRelease(payload);
  awgToolsCache = { checkedAt: now, release };
  return release;
}

function normalizeNaitAwgVersion(payload) {
  const sourceUrl = String(payload?.html_url || '').trim();
  let packageJson;
  try {
    const content = Buffer.from(String(payload?.content || '').replace(/\s/g, ''), 'base64').toString('utf8');
    packageJson = JSON.parse(content);
  } catch {
    throw new Error('Nait-AWG package payload is incomplete');
  }
  const name = String(packageJson?.name || '').trim();
  const version = String(packageJson?.version || '').trim();
  if (payload?.name !== 'package.json'
    || sourceUrl !== 'https://github.com/NaitSide/Nait-AWG/blob/main/package.json'
    || name !== 'nait-awg'
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Nait-AWG package payload is incomplete');
  }
  return {
    component: 'nait-awg',
    version,
    tagName: `v${version}`,
    repositoryUrl: NAIT_REPOSITORY_URL
  };
}

async function getLatestNaitAwgVersion(options = {}) {
  const now = Number(options.now || Date.now());
  if (naitAwgCache && now - naitAwgCache.checkedAt < CACHE_TTL_MS) return naitAwgCache.version;
  const payload = await (options.request || requestJson)(NAIT_PACKAGE_API_URL);
  const version = normalizeNaitAwgVersion(payload);
  naitAwgCache = { checkedAt: now, version };
  return version;
}

function clearReleaseCache() {
  awgToolsCache = null;
  naitAwgCache = null;
}

module.exports = {
  API_URL,
  REPOSITORY_URL,
  NAIT_PACKAGE_API_URL,
  NAIT_REPOSITORY_URL,
  normalizeRelease,
  normalizeNaitAwgVersion,
  getLatestAwgToolsRelease,
  getLatestNaitAwgVersion,
  clearReleaseCache
};
