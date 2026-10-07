'use strict';
const { infoIcon } = require('./infoIcon');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function renderDomain(identity = {}) {
  return `<section class="card domain-card" id="domainCard">
    <div class="card-head"><div><h2>Доступ по домену</h2><p>Без предупреждений браузера о сертификате.</p></div><span class="tag" id="domainBadge">По IP</span></div>
    <form id="domainForm"><div class="domain-fields">
      <label class="field">Домен<input id="panelDomain" name="domain" type="text" placeholder="moy-site.ru" maxlength="253" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>
      <label class="field"><span>Email <small>(для регистрации в Let’s Encrypt)</small></span><input id="domainEmail" name="email" type="email" placeholder="you@example.com" maxlength="254" autocomplete="email" required></label>
      <button class="btn purple" id="domainSave" type="submit" disabled>Сохранить</button>
    </div></form>
    <div class="domain-bottom"><details class="domain-help"><summary><span class="domain-info" aria-hidden="true">${infoIcon}</span> Как подключить домен <span class="domain-expand">Развернуть</span><span class="domain-collapse">Свернуть</span></summary>
      <ol class="domain-steps">
        <li><strong>У провайдера домена откройте настройки DNS.</strong><ul><li>Добавьте или измените A-запись: IP этого сервера — <strong>${esc(identity.endpointHost || 'смотрите в шапке настроек')}</strong>.</li></ul></li>
        <li><strong>Дождитесь обновления DNS.</strong><ul><li>Проверьте на <a href="https://dnschecker.org/" target="_blank" rel="noopener noreferrer">DNSChecker ↗</a>: введите домен, выберите A и сравните IP.</li></ul></li>
        <li><strong>Введите домен и email, нажмите «Сохранить».</strong><ul><li>Домен — без http://, https://, порта и пути.</li></ul></li>
      </ol>
      <p class="domain-help-note">Порт 80 должен быть открыт у хостинга и на сервере, и не занят другой программой.</p>
      <p class="domain-help-note">Продление автоматическое. VPN не меняется. Сохраняя, вы принимаете <a href="https://letsencrypt.org/repository/" target="_blank" rel="noopener noreferrer">условия Let’s Encrypt</a>.</p>
    </details><div class="domain-result" id="domainResult" hidden><a id="domainOpen" class="domain-link" target="_blank" rel="noopener noreferrer">Открыть панель ↗</a><span id="domainExpiry"></span></div></div>
    <p class="domain-feedback" id="domainFeedback" role="status" aria-live="polite">Проверяем настройки…</p>
  </section>`;
}
module.exports = { renderDomain };
