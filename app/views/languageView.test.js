'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {renderLanguageSwitch} = require('./languageView');
const {renderPanel} = require('./panelView');

test('language choice is available on login only, not in the main panel', () => {
  const login = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(login, /class="login-header-row"/);
  assert.match(login, /data-language="ru"/);
  assert.match(login, /data-language="en"/);
  const panel = renderPanel({peers: [], profile: {}});
  assert.doesNotMatch(panel, /data-language=/);
  assert.match(panel, /action="\/logout"/);
  assert.match(panel, /src="\/i18n\.js\?v=1"/);
});

function browserLanguage({locale = 'ru-RU', saved, blocked = false} = {}) {
  const context = vm.createContext({
    window: {}, navigator: {languages: [locale]},
    localStorage: {getItem() { if (blocked) throw new Error('disabled'); return saved; }, setItem() { if (blocked) throw new Error('disabled'); }},
    document: {documentElement: {}, readyState: 'loading', addEventListener() {}, querySelector() {return null;}, querySelectorAll() {return [];}, body: null},
    CustomEvent: class {},
  });
  context.window.dispatchEvent = () => {};
  for (const name of ['i18n-catalog.js', 'i18n.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8'), context);
  }
  return context.window;
}

test('first language follows browser; valid manual choice overrides it', () => {
  assert.equal(browserLanguage().NaitI18n.language, 'ru');
  assert.equal(browserLanguage({locale: 'en-GB'}).NaitI18n.language, 'en');
  assert.equal(browserLanguage({locale: 'de-DE'}).NaitI18n.language, 'en');
  assert.equal(browserLanguage({locale: 'ru-RU', saved: 'en'}).NaitI18n.language, 'en');
  assert.equal(browserLanguage({locale: 'en-US', saved: 'ru'}).NaitI18n.language, 'ru');
  assert.equal(browserLanguage({saved: 'invalid'}).NaitI18n.language, 'ru');
});

test('language switch works even with browser storage disabled', () => {
  const {NaitI18n} = browserLanguage({blocked: true});
  NaitI18n.setLanguage('en');
  assert.equal(NaitI18n.language, 'en');
  assert.equal(NaitI18n.locale, 'en-US');
  NaitI18n.setLanguage('invalid');
  assert.equal(NaitI18n.language, 'en');
});

test('catalog preserves Russian sources and interpolation placeholders', () => {
  const {NaitTranslations} = browserLanguage();
  for (const [source, translated] of Object.entries(NaitTranslations.en)) {
    assert.equal(NaitTranslations.ru[source], source);
    assert.equal((source.match(/\{\{value\}\}/g) || []).length, (translated.match(/\{\{value\}\}/g) || []).length, source);
    assert.doesNotMatch(translated, /[А-Яа-яЁё]/, source);
  }
});

test('dynamic UI messages translate without interpreting client names', () => {
  const {NaitI18n} = browserLanguage({locale: 'en-US'});
  assert.equal(NaitI18n.t('Выбран: Настройки'), 'Selected: Настройки');
  assert.equal(NaitI18n.t('1 клиент'), '1 client');
  assert.equal(NaitI18n.t('2 клиента'), '2 clients');
  assert.equal(NaitI18n.t('39 клиентов'), '39 clients');
  assert.equal(NaitI18n.t('Неизвестное сообщение клиента'), 'Неизвестное сообщение клиента');
  assert.equal(NaitI18n.t('Слишком много попыток входа. Повторите через 42 сек.'), 'Too many sign-in attempts. Try again in 42 seconds.');
  assert.equal(NaitI18n.t('H1: некорректное число или диапазон.'), 'H1: invalid number or range.');
  assert.match(NaitI18n.t('Кадр 2 из 3\nQR переключается автоматически.\nДождитесь, пока сканер AmneziaVPN считает все части.'), /^Frame 2 of 3\n/);
  assert.match(NaitI18n.t('Не удалось продлить сертификат: Не удалось подтвердить домен. Проверьте DNS и доступность TCP-порта 80 из интернета.'), /^Certificate renewal failed: [^А-Яа-яЁё]+$/);
});

test('language control has explicit buttons and accessible names', () => {
  const html = renderLanguageSwitch();
  assert.match(html, /type="button" data-language="ru"/);
  assert.match(html, /type="button" data-language="en"/);
  assert.match(html, /aria-label="Русский"/);
  assert.match(html, /aria-label="English"/);
  assert.match(html, /aria-pressed="false"/);
  assert.doesNotMatch(html, /<select|<img/);
});
