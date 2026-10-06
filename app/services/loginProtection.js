'use strict';

const net = require('node:net');

// The installer exposes HTTPS directly. Never trust caller-supplied forwarding headers.
function connectionAddress(req) {
  let address = String(req.socket?.remoteAddress || 'unknown').toLowerCase();
  if (address.startsWith('::ffff:') && net.isIP(address.slice(7)) === 4) address = address.slice(7);
  if (net.isIP(address) === 6) address = new URL(`http://[${address.split('%')[0]}]/`).hostname;
  return address;
}

function createLoginLimiter({ now = Date.now, windowMs = 600000, maxAttempts = 10,
  globalWindowMs = 60000, globalMaxAttempts = 100, maxEntries = 4096 } = {}) {
  for (const value of [windowMs, maxAttempts, globalWindowMs, globalMaxAttempts, maxEntries]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid login limiter settings');
  }
  const addresses = new Map();
  let global = { expiresAt: 0, attempts: 0 };
  const retry = (expiry, time) => Math.max(1, Math.ceil((expiry - time) / 1000));
  return {
    take(address) {
      const time = now();
      if (global.expiresAt <= time) global = { expiresAt: time + globalWindowMs, attempts: 0 };
      let state = addresses.get(address);
      if (state && state.expiresAt <= time) { addresses.delete(address); state = undefined; }
      // Rejected requests never renew the window: the operator can always retry after it expires.
      const blockedUntil = Math.max(global.attempts >= globalMaxAttempts ? global.expiresAt : 0,
        state?.attempts >= maxAttempts ? state.expiresAt : 0);
      if (blockedUntil) return { allowed: false, retryAfter: retry(blockedUntil, time) };
      if (!state) {
        for (const [key, entry] of addresses) if (entry.expiresAt <= time) addresses.delete(key);
        if (addresses.size >= maxEntries) {
          return { allowed: false, retryAfter: retry(Math.min(...Array.from(addresses.values(), entry => entry.expiresAt)), time) };
        }
        state = { expiresAt: time + windowMs, attempts: 0 };
        addresses.set(address, state);
      }
      state.attempts += 1;
      global.attempts += 1;
      return { allowed: true };
    }
  };
}

module.exports = { createLoginLimiter, connectionAddress };
