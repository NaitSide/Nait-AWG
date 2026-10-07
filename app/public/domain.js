'use strict';
(() => {
  const form = document.getElementById('domainForm');
  if (!form) return;
  const domain = document.getElementById('panelDomain');
  const email = document.getElementById('domainEmail');
  const save = document.getElementById('domainSave');
  const feedback = document.getElementById('domainFeedback');
  let busy = false, dirty = false, timer, polling = false;
  const phases = { checking: 'Проверяем домен…', issuing: 'Получаем сертификат…', applying: 'Подключаем сертификат…', renewing: 'Проверяем продление сертификата…' };
  form.addEventListener('input', () => { dirty = true; });
  function render(state) {
    busy = Boolean(phases[state.operation?.phase]);
    save.disabled = busy || !state.available;
    domain.disabled = email.disabled = busy;
    if (!dirty && !busy) { domain.value = state.domain || ''; email.value = state.email || ''; }
    const result = document.getElementById('domainResult');
    result.hidden = !state.connected;
    if (state.connected) {
      const url = new URL(window.location.href);
      url.protocol = 'https:'; url.hostname = state.domain; url.pathname = '/'; url.search = ''; url.hash = '';
      const link = document.getElementById('domainOpen');
      link.href = url.href; link.title = url.href;
      document.getElementById('domainExpiry').textContent = `До ${new Date(state.expiresAt).toLocaleDateString('ru-RU')} · Продление автоматически`;
    }
    feedback.classList.remove('error', 'success');
    if (state.operation?.phase === 'error' || state.renewal?.error) {
      feedback.textContent = state.operation?.phase === 'error' ? state.operation.message : `Не удалось продлить сертификат: ${state.renewal.error}`;
      feedback.classList.add('error');
    } else if (busy) feedback.textContent = phases[state.operation.phase];
    else if (state.operation?.phase === 'done' && !state.connected) feedback.textContent = 'Подключаем сертификат к панели…';
    else if (state.connected) { feedback.textContent = 'Домен подключён. Откройте панель по новому адресу.'; feedback.classList.add('success'); }
    else feedback.textContent = 'Необязательно: доступ по IP уже работает.';
    clearTimeout(timer);
    timer = setTimeout(refresh, busy || (state.operation?.phase === 'done' && !state.connected) ? 2000 : 60000);
  }
  async function request(body) {
    const response = await fetch('/api/domain', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    if (response.status === 401) { window.location.assign('/'); throw new Error('Войдите в панель.'); }
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.message || 'Не удалось проверить домен.'), { status: response.status });
    return data;
  }
  async function refresh() {
    if (polling) return;
    polling = true;
    try { render(await request()); }
    catch (error) {
      feedback.textContent = error.message;
      feedback.classList.add('error');
      if (!busy) save.disabled = true;
      clearTimeout(timer); timer = setTimeout(refresh, 10000);
    } finally { polling = false; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    const body = { domain: domain.value.trim(), email: email.value.trim() };
    busy = true; save.disabled = true; domain.disabled = email.disabled = true;
    feedback.classList.remove('error', 'success'); feedback.textContent = 'Проверяем домен…';
    clearTimeout(timer);
    try { dirty = true; render(await request(body)); }
    catch (error) {
      feedback.textContent = error.message; feedback.classList.add('error');
      busy = false; domain.disabled = email.disabled = false; save.disabled = false;
      timer = setTimeout(refresh, 10000);
    }
  });
  refresh();
})();
