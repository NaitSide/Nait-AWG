'use strict';
(() => {
  const form = document.getElementById('domainForm');
  if (!form) return;
  const domain = document.getElementById('panelDomain');
  const email = document.getElementById('domainEmail');
  const save = document.getElementById('domainSave');
  const feedback = document.getElementById('domainFeedback');
  const feedbackText = document.getElementById('domainFeedbackText');
  const link = document.getElementById('domainOpen');
  const result = document.getElementById('domainResult');
  let busy = false, dirty = false, timer, polling = false;
  const phases = { checking: 'Проверяем домен…', issuing: 'Получаем сертификат…', applying: 'Подключаем сертификат…', renewing: 'Проверяем продление сертификата…' };
  form.addEventListener('input', () => { dirty = true; });
  function setFeedback(message, kind = '') {
    feedback.classList.remove('error', 'success');
    if (kind) feedback.classList.add(kind);
    feedbackText.textContent = message;
    link.hidden = true;
    result.hidden = true;
  }
  function render(state) {
    busy = Boolean(phases[state.operation?.phase]);
    save.disabled = busy || !state.available;
    domain.disabled = email.disabled = busy;
    if (!dirty && !busy) { domain.value = state.domain || ''; email.value = state.email || ''; }
    if (state.connected) {
      const url = new URL(window.location.href);
      url.protocol = 'https:'; url.hostname = state.domain; url.pathname = '/'; url.search = ''; url.hash = '';
      link.href = url.href; link.title = url.href; link.textContent = `${url.href} ↗`;
      const expires = new Date(state.expiresAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
      document.getElementById('domainExpiry').textContent = `Сертификат годен до ${expires} · Продлевается автоматически`;
    }
    if (state.operation?.phase === 'error' || state.renewal?.error) {
      setFeedback(state.operation?.phase === 'error' ? state.operation.message : `Не удалось продлить сертификат: ${state.renewal.error}`, 'error');
    } else if (busy) setFeedback(phases[state.operation.phase]);
    else if (state.operation?.phase === 'done' && !state.connected) setFeedback('Подключаем сертификат к панели…');
    else if (state.connected) { setFeedback('Домен подключён', 'success'); result.hidden = false; link.hidden = false; }
    else setFeedback('Необязательно: доступ по IP уже работает.');
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
      setFeedback(error.message, 'error');
      if (!busy) save.disabled = true;
      clearTimeout(timer); timer = setTimeout(refresh, 10000);
    } finally { polling = false; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    const body = { domain: domain.value.trim(), email: email.value.trim() };
    busy = true; save.disabled = true; domain.disabled = email.disabled = true;
    setFeedback('Проверяем домен…');
    clearTimeout(timer);
    try { dirty = true; render(await request(body)); }
    catch (error) {
      setFeedback(error.message, 'error');
      busy = false; domain.disabled = email.disabled = false; save.disabled = false;
      timer = setTimeout(refresh, 10000);
    }
  });
  refresh();
})();
