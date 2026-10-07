'use strict';
(() => {
  const storageKey = 'nait-awg-language';
  const catalog = window.NaitTranslations;
  if (!catalog) return;
  const valid = value => value === 'ru' || value === 'en';
  let saved;
  try { saved = localStorage.getItem(storageKey); } catch { /* Storage may be disabled. */ }
  const preferred = (navigator.languages?.[0] || navigator.language || 'ru').toLowerCase();
  let language = valid(saved) ? saved : preferred.startsWith('ru') ? 'ru' : 'en';
  document.documentElement.lang = language;
  const sources = new WeakMap();
  const attributeSources = new WeakMap();
  const attributes = ['title', 'aria-label', 'placeholder', 'alt'];
  // Never interpret a client's name, note, Telegram, config or input value as UI text.
  const userData = '[data-no-i18n],script,style,pre,code,#appShell,'
    + '.gate-client-name,.gate-client-contact,.thumb-initials,.gate-note-tooltip,.address-cell,.avatar,'
    + '#qrLabel,#clientDownloadName,#clientConfigName,#editName,#editAddress,'
    + '#deleteName,#deleteTelegram,#deleteAddress,#deleteNote,#accessName,#accessTelegram,#accessAddress,#accessNote,'
    + '#createdName,#createdAddress,#usageClient,#restoreEndpoint,#restoreTargetEndpoint';
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new Map(Object.entries(catalog.en));
  const reverse = new Map();
  for (const [ru, en] of exact) if (!reverse.has(en)) reverse.set(en, ru);
  const templates = [];
  const backwards = [];
  for (const [ru, en] of exact) {
    if (!ru.includes('{{value}}')) continue;
    // Count templates must not swallow arbitrary phrases ending in «клиента».
    const numeric = /^\{\{value\}\} (клиент(?:а|ов)?|сек назад|мин назад|ч назад|д назад)$/.test(ru);
    const compile = text => new RegExp('^' + text.split('{{value}}').map(escapeRegex).join(numeric ? '(\\d+)' : '([\\s\\S]+?)') + '$');
    templates.push({regex:compile(ru),output:en,source:ru});
    backwards.push({regex:compile(en),output:ru,source:en});
    // Some progress messages append a separate sentence to a parameterized prefix.
    if (ru.endsWith('.') && en.endsWith('.')) {
      templates.push({regex:new RegExp(compile(ru).source.slice(0,-1)),output:en,source:ru,prefix:true});
      backwards.push({regex:new RegExp(compile(en).source.slice(0,-1)),output:ru,source:en,prefix:true});
    }
  }
  templates.sort((a,b)=>b.source.length-a.source.length);
  backwards.sort((a,b)=>b.source.length-a.source.length);
  const prefixes = ['Выбран:', 'Скачать .', 'До начала помесячного учёта: ↓', 'получено', ', отправлено'];
  const sentences = [...exact].filter(([ru])=>ru.endsWith('.')&&!ru.includes('{{value}}')).sort((a,b)=>b[0].length-a[0].length);
  function translate(value, direction = 'en', depth = 0) {
    const raw = String(value ?? '');
    if (depth > 6) return raw;
    const text = raw.trim();
    const map = direction === 'en' ? exact : reverse;
    let result = map.get(text);
    if (result === undefined) {
      for (const template of direction === 'en' ? templates : backwards) {
        const match = template.regex.exec(text);
        if (!match) continue;
        let index = 1;
        result = template.output.replace(/\{\{value\}\}/g, () => {
          const captured = match[index++];
          return template.source.startsWith('Не удалось продлить сертификат:') || template.source.startsWith('Certificate renewal failed:')
            ? translate(captured,direction,depth+1) : captured;
        });
        if (template.prefix) result += translate(text.slice(match[0].length),direction,depth+1);
        break;
      }
    }
    if (result === undefined) {
      for (const ru of prefixes) {
        const from = direction === 'en' ? ru : exact.get(ru), to = direction === 'en' ? exact.get(ru) : ru;
        if (text.startsWith(from)) { result = to + text.slice(from.length); break; }
      }
    }
    if (result === undefined) {
      for (const [ru,en] of sentences) {
        const from=direction==='en'?ru:en, to=direction==='en'?en:ru;
        if (text.startsWith(from+' ')) { result=to+translate(text.slice(from.length),direction,depth+1);break; }
      }
    }
    if (result === undefined) return raw;
    return raw.slice(0,raw.indexOf(text)) + result + raw.slice(raw.indexOf(text)+text.length);
  }
  function translateText(node) {
    if (!node.parentElement || node.parentElement.closest(userData + ',textarea')) return;
    const previous = sources.get(node);
    const source = previous && node.data === previous.output ? previous.source : translate(node.data,'ru');
    const output = language === 'en' ? translate(source) : source;
    sources.set(node,{source,output});
    if (node.data !== output) node.data = output;
  }
  function translateAttributes(element) {
    if (element.closest(userData)) return;
    let records=attributeSources.get(element);
    if (!records) { records=new Map();attributeSources.set(element,records); }
    for (const name of attributes) {
      if (!element.hasAttribute(name)) continue;
      const current=element.getAttribute(name), previous=records.get(name);
      const source=previous&&current===previous.output?previous.source:translate(current,'ru');
      const output=language==='en'?translate(source):source;
      records.set(name,{source,output});
      if(current!==output)element.setAttribute(name,output);
    }
  }
  function apply(root=document.body) {
    if (!root) return;
    if (root.nodeType===Node.TEXT_NODE) {translateText(root);return;}
    if (root.nodeType!==Node.ELEMENT_NODE) return;
    translateAttributes(root);
    for (const element of root.querySelectorAll('[title],[aria-label],[placeholder],[alt]')) translateAttributes(element);
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    let node;while(node=walker.nextNode())translateText(node);
  }
  function controls() {
    document.documentElement.lang=language;
    const title = document.querySelector('title');
    if (title) apply(title);
    for(const button of document.querySelectorAll('[data-language]'))button.setAttribute('aria-pressed',String(button.dataset.language===language));
  }
  function setLanguage(next,persist=true) {
    if(!valid(next))return;
    language=next;
    if(persist)try{localStorage.setItem(storageKey,next);}catch{/* Still usable without persistence. */}
    controls();apply();
    window.dispatchEvent(new CustomEvent('nait:languagechange',{detail:{language}}));
  }
  window.NaitI18n=Object.freeze({get language(){return language;},get locale(){return language==='ru'?'ru-RU':'en-US';},
    t:value=>language==='en'?translate(value):translate(value,'ru'),setLanguage,apply});
  function start() {
    controls();apply();
    const observer=new MutationObserver(records=>{
      const roots=new Set();
      for(const record of records){
        if(record.type==='childList')for(const node of record.addedNodes)roots.add(node);
        else roots.add(record.target);
      }
      for(const root of roots)if(root.isConnected)apply(root);
    });
    observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:attributes});
    document.addEventListener('click',event=>{
      const button=event.target.closest('[data-language]');
      if(button){event.preventDefault();setLanguage(button.dataset.language);}
    });
    window.addEventListener('storage',event=>{if(event.key===storageKey&&valid(event.newValue))setLanguage(event.newValue,false);});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
