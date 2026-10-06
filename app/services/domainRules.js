'use strict';

const { domainToASCII } = require('node:url');
const { X509Certificate } = require('node:crypto');
const tls = require('node:tls');

function domainError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function validateDomainSettings(body) {
  if (!body || typeof body.domain !== 'string' || typeof body.email !== 'string') {
    throw domainError('domain_fields', 'Укажите домен и email.');
  }
  const raw = body.domain.trim().toLowerCase();
  const domain = /^[\p{L}\p{N}.-]+$/u.test(raw) ? domainToASCII(raw) : '';
  if (!domain || domain.length > 253 || !domain.includes('.') || /[^a-z0-9.-]/.test(domain)
    || !/^[a-z][a-z0-9-]*$/.test(domain.split('.').at(-1))
    || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw domainError('invalid_domain', 'Введите доменное имя без https://, порта и пути. Например, moy-site.ru.');
  }
  const email = body.email.trim();
  if (email.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(email)) {
    throw domainError('invalid_email', 'Укажите корректный email для регистрации сертификата.');
  }
  return { domain, email };
}

function validateCertificate(key, cert, domain, now = Date.now()) {
  // Building a TLS context also checks that the private key matches the certificate.
  tls.createSecureContext({ key, cert, minVersion: 'TLSv1.2' });
  const leaf = new X509Certificate(cert);
  if (!leaf.checkHost(domain, { subject: 'never' }) || Date.parse(leaf.validFrom) > now
    || Date.parse(leaf.validTo) <= now) {
    throw domainError('invalid_certificate', 'Новый сертификат не прошёл проверку. Прежний доступ сохранён.', 502);
  }
  return { fingerprint: leaf.fingerprint256, expiresAt: new Date(leaf.validTo).toISOString() };
}

module.exports = { domainError, validateDomainSettings, validateCertificate };
