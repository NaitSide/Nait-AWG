'use strict';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function renderDomain(identity = {}) {
  return `<section class="card domain-card" id="domainCard">
    <div class="card-head"><div><h2>Доступ по домену</h2><p>Без предупреждений браузера о сертификате.</p></div><span class="tag" id="domainBadge">По IP</span></div>
    <form id="domainForm"><div class="domain-fields">
      <label class="field">Домен<input id="panelDomain" name="domain" type="text" placeholder="moy-site.ru" maxlength="253" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>
      <label class="field"><span>Email <small>(для регистрации в Let’s Encrypt)</small></span><input id="domainEmail" name="email" type="email" placeholder="you@example.com" maxlength="254" autocomplete="email" required></label>
      <button class="btn purple" id="domainSave" type="submit" disabled>Сохранить</button>
    </div></form>
    <div class="domain-bottom"><details class="domain-help"><summary><span class="domain-info" aria-hidden="true">i</span> Как подключить домен <span class="domain-expand">Развернуть</span><span class="domain-collapse">Свернуть</span></summary>
      <ol><li>В настройках DNS своего домена создайте A-запись с IP этого сервера: <strong>${esc(identity.endpointHost || 'смотрите в шапке настроек')}</strong>. Дождитесь обновления DNS. Если есть AAAA-запись, она тоже должна указывать на этот сервер.</li>
      <li>Разрешите входящие подключения к TCP-порту 80 в сетевом экране хостинга и сервера. На сервере он должен быть свободен: панель использует его только для проверки домена. Порт самой панели менять не нужно.</li>
      <li>Введите домен без https://, порта и пути, укажите email и нажмите «Сохранить». Сертификат Let’s Encrypt выпускается бесплатно и продлевается автоматически. Для продления сохраните DNS-запись и доступность порта 80.</li></ol>
      <p>Домен подключается только к веб-панели. Адрес VPN и выданные клиентам конфиги не меняются. Продолжая, вы принимаете <a href="https://letsencrypt.org/repository/" target="_blank" rel="noopener noreferrer">условия Let’s Encrypt</a>.</p>
    </details><div class="domain-result" id="domainResult" hidden><a id="domainOpen" class="domain-link" target="_blank" rel="noopener noreferrer">Открыть панель ↗</a><span id="domainExpiry"></span></div></div>
    <p class="domain-feedback" id="domainFeedback" role="status" aria-live="polite">Проверяем настройки…</p>
  </section>`;
}
module.exports = { renderDomain };
