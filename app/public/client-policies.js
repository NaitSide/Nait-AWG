'use strict';
(() => {
  const el = id => document.getElementById(id);
  const t = text => window.NaitI18n?.t(text) || text;
  let globalState = null, clientState = null, clientId = '', clientLoading = 0;
  const prepared = {}, generations = {}, dirty = new Set(), busy = new Set();
  const help = {
    current:'Сохраняет исходные значения до явного выбора и сохранения.',
    none:'Отключает только I1–I5. Защита заголовков и остальные механизмы сохраняются.',
    quic:'QUIC используется для веб-соединений, в том числе HTTP/3. Этот вариант имитирует признаки его начального пакета.',
    dns:'DNS используется для поиска IP-адресов по именам сайтов. Этот вариант добавляет пакет DNS-запроса.',
    custom:'Ручные пакеты I1–I5. Используйте поддерживаемые теги и размер до 1232 байт.'
  };
  async function request(url, body, method='POST') {
    let response;
    try {
      response = await fetch(url, body === undefined ? {cache:'no-store',signal:AbortSignal.timeout(30000)} : {
        method, headers:{'content-type':'application/json'}, body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    } catch {
      throw new Error(t('Не удалось связаться с панелью. Загрузите настройки заново.'));
    }
    const data = await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(data.message || t('Не удалось загрузить или сохранить настройки.'));
    return data;
  }
  const status = (prefix, message) => { el(prefix+'Status').textContent = message; };
  function controls(prefix, loading=false) {
    el(prefix+'Fields').disabled = loading;
    el(prefix+'Save').disabled = loading;
    const cancel = el(prefix+'Cancel'); if (cancel) cancel.disabled = loading;
  }
  function maskDisplay(prefix) {
    const profile = el(prefix+'Profile').value;
    el(prefix+'Help').textContent = help[profile];
    el(prefix+'Packets').hidden = profile !== 'custom';
  }
  function fillMask(prefix, value) {
    generations[prefix] = (generations[prefix] || 0) + 1;
    busy.delete(prefix);
    prepared[prefix] = value ? structuredClone(value) : null;
    el(prefix+'Profile').value = value?.profile || 'current';
    el(prefix+'Packets').querySelectorAll('[data-packet]').forEach(input=>{
      input.value = value?.packets?.[input.dataset.packet] || '';
    });
    maskDisplay(prefix);
  }
  function fillRoute(prefix, value) {
    el(prefix+'Mode').value = value?.mode || 'all';
    el(prefix+'Services').querySelectorAll('input').forEach(input=>{
      input.checked = (value?.services || []).includes(input.value);
    });
    routeDisplay(prefix);
  }
  function routeDisplay(prefix) {
    el(prefix+'Services').hidden = el(prefix+'Mode').value !== 'selected';
  }
  function readRoute(prefix) {
    const value = {mode:el(prefix+'Mode').value,services:Array.from(el(prefix+'Services').querySelectorAll('input:checked')).map(input=>input.value)};
    if (value.mode === 'selected' && !value.services.length) throw new Error(t('Выберите хотя бы один доступный сервис.'));
    return value;
  }
  function readMask(prefix) {
    const profile = el(prefix+'Profile').value;
    if (profile === 'current') throw new Error(t('Выберите способ маскировки или оставьте текущие параметры без сохранения.'));
    if (profile === 'custom') return {profile, packets:Object.fromEntries(Array.from(el(prefix+'Packets').querySelectorAll('[data-packet]'))
      .filter(input=>input.value.trim()).map(input=>[input.dataset.packet,input.value.trim()]))};
    if (prepared[prefix]?.profile !== profile) throw new Error(t('Дождитесь подготовки параметров.'));
    return prepared[prefix];
  }
  function mark(prefix) {
    dirty.add(prefix);
    status(prefix.startsWith('client') ? 'clientPolicy' : prefix, 'Есть несохранённые изменения.');
  }
  for (const prefix of ['mask','clientMask']) {
    el(prefix+'Profile').addEventListener('change',async()=>{
      const token = generations[prefix] = (generations[prefix] || 0) + 1, profile = el(prefix+'Profile').value;
      busy.delete(prefix);
      mark(prefix); maskDisplay(prefix);
      if (['current','custom'].includes(profile)) return;
      busy.add(prefix);
      status(prefix==='mask'?'mask':'clientPolicy','Готовим параметры…');
      try {
        const value = await request('/api/client-policies/generate',{profile});
        if (generations[prefix] !== token) return;
        prepared[prefix] = value;
        status(prefix==='mask'?'mask':'clientPolicy','Параметры подготовлены. Сохраните, чтобы применить их к выдаваемым конфигам.');
      } catch(error) { if (generations[prefix]===token) status(prefix==='mask'?'mask':'clientPolicy',error.message); }
      finally { if (generations[prefix]===token) busy.delete(prefix); }
    });
    el(prefix+'Packets').addEventListener('input',()=>mark(prefix));
  }
  for (const prefix of ['route','clientRoute']) {
    el(prefix+'Mode').addEventListener('change',()=>{mark(prefix);routeDisplay(prefix);});
    el(prefix+'Services').addEventListener('change',()=>mark(prefix));
  }
  function fillGlobal(type) {
    const prefix = type === 'obfuscation' ? 'mask' : 'route';
    if (prefix === 'mask') fillMask(prefix,globalState.obfuscation); else fillRoute(prefix,globalState.routing);
    dirty.delete(prefix); status(prefix,''); controls(prefix);
  }
  async function loadGlobals() {
    for (const prefix of ['mask','route']) {controls(prefix,true);status(prefix,'Загружаем настройки…');}
    try {
      globalState = await request('/api/client-policies');
      fillGlobal('obfuscation');fillGlobal('routing');
    } catch(error) {status('mask',error.message);status('route',error.message);}
  }
  for (const [prefix,form,type] of [['mask','maskForm','obfuscation'],['route','routeForm','routing']]) {
    el(prefix+'Cancel').addEventListener('click',()=>{if(globalState)fillGlobal(type);});
    el(prefix+'Reload').addEventListener('click',async()=>{
      if (busy.size) return;
      // Explicit reload discards only this form's draft; the other draft stays visible.
      controls(prefix,true);
      try {const next=await request('/api/client-policies');globalState=next;fillGlobal(type);}
      catch(error){status(prefix,error.message);controls(prefix,!globalState);}
    });
    el(form).addEventListener('submit',async event=>{
      event.preventDefault(); if (!globalState || busy.size) return;
      try {
        const value = type==='routing' ? readRoute(prefix) : readMask(prefix);
        busy.add(prefix);controls(prefix,true);
        const result = await request('/api/client-policies',{expectedRevision:globalState.revision,type,value});
        globalState.revision = result.revision;globalState[type] = value;
        dirty.delete(prefix);status(prefix,'Настройки сохранены. Скачайте конфиги или QR заново.');
      } catch(error) {status(prefix,error.message);}
      finally {busy.delete(prefix);controls(prefix);}
    });
  }
  for (const prefix of ['clientMask','clientRoute']) el(prefix+'Binding').addEventListener('change',()=>{
    el(prefix+'Override').hidden = el(prefix+'Binding').value !== 'override'; mark(prefix);
  });
  async function openClient(id) {
    const token = ++clientLoading;
    clientId=id;clientState=null;controls('clientPolicy',true);status('clientPolicy','Загружаем настройки…');
    showModal('clientPolicyModal');
    try {
      const state = await request('/api/peers/'+encodeURIComponent(id)+'/policies');
      if (token!==clientLoading) return;
      clientState = state;
      for (const [prefix,type] of [['clientMask','obfuscation'],['clientRoute','routing']]) {
        const choice = state.client[type];
        // An old profile has no policy until the first explicit save of a global setting.
        el(prefix+'Binding').value = choice?.mode || (state[type] ? 'inherit' : 'preserve');
        el(prefix+'Override').hidden = el(prefix+'Binding').value !== 'override';
        const value = choice?.value || state[type];
        if(type==='routing')fillRoute(prefix,value);else fillMask(prefix,value);
        dirty.delete(prefix);
      }
      controls('clientPolicy');status('clientPolicy','');
    } catch(error) {if(token===clientLoading)status('clientPolicy',error.message);}
  }
  el('openClientPolicies').addEventListener('click',()=>{
    if (editingRow) openClient(editingRow.dataset.peerId);
  });
  el('clientPolicyForm').addEventListener('submit',async event=>{
    event.preventDefault();if (!clientState || busy.size) return;
    try {
      const input={expectedRevision:clientState.revision};
      for (const [prefix,type] of [['clientMask','obfuscation'],['clientRoute','routing']]) {
        const mode = el(prefix+'Binding').value;
        input[type]={mode};
        if(mode==='override')input[type].value=type==='routing'?readRoute(prefix):readMask(prefix);
      }
      busy.add('clientPolicy');controls('clientPolicy',true);el('clientPolicyModal').dataset.busy='true';
      const result = await request('/api/peers/'+encodeURIComponent(clientId)+'/policies',input,'PUT');
      clientState.revision=result.revision;
      if(globalState)globalState.revision=result.revision;
      dirty.delete('clientMask');dirty.delete('clientRoute');status('clientPolicy','Настройки сохранены. Скачайте конфиги или QR заново.');
    } catch(error) {status('clientPolicy',error.message);}
    finally {busy.delete('clientPolicy');controls('clientPolicy');el('clientPolicyModal').dataset.busy='false';}
  });
  el('clientPolicyModal').querySelectorAll('[data-close-modal]').forEach(button=>button.addEventListener('click',()=>{
    if(busy.has('clientPolicy'))return;
    dirty.delete('clientMask');dirty.delete('clientRoute');clientLoading++;
  }));
  window.addEventListener('beforeunload',event=>{if(dirty.size){event.preventDefault();event.returnValue='';}});
  window.addEventListener('keydown',event=>{
    if(event.key==='Escape' && !el('clientPolicyModal').classList.contains('open')) {
      dirty.delete('clientMask');dirty.delete('clientRoute');clientLoading++;
    }
  });
  loadGlobals();
})();
