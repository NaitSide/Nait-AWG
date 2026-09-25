'use strict';

const crypto = require('crypto');

function safeCompare(value, expected) {
  const valueBuffer = Buffer.from(String(value || ''), 'utf8');
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf8');

  if (!valueBuffer.length || valueBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(valueBuffer, expectedBuffer);
}

function extractBearerToken(headerValue) {
  const match = String(headerValue || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireReceiverAuth(req, res, next) {
  const expectedToken = String(process.env.RECEIVER_API_KEY || '').trim();

  const receivedToken = extractBearerToken(req.get('authorization'));

  if (!expectedToken || expectedToken === 'change-me' || !safeCompare(receivedToken, expectedToken)) {
    return res.status(401).json({
      error: 'Unauthorized'
    });
  }

  return next();
}

module.exports = {
  requireReceiverAuth
};
