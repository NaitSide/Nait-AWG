'use strict';

const https = require('https');

const API_URL = 'https://api.github.com/repos/amnezia-vpn/amneziawg-tools/releases/latest';
const REPOSITORY_URL = 'https://github.com/amnezia-vpn/amneziawg-tools';
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = null;

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
  if (cache && now - cache.checkedAt < CACHE_TTL_MS) return cache.release;
  const payload = await (options.request || requestJson)(API_URL);
  const release = normalizeRelease(payload);
  cache = { checkedAt: now, release };
  return release;
}

function clearReleaseCache() {
  cache = null;
}

module.exports = { API_URL, REPOSITORY_URL, normalizeRelease, getLatestAwgToolsRelease, clearReleaseCache };
