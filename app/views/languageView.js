'use strict';
function renderLanguageSwitch() {
  return '<div class="locale-switch" role="group" aria-label="Язык интерфейса"><button type="button" data-language="ru" aria-label="Русский" aria-pressed="false" lang="ru">RU</button><button type="button" data-language="en" aria-label="English" aria-pressed="false" lang="en">EN</button></div>';
}
module.exports={renderLanguageSwitch};
