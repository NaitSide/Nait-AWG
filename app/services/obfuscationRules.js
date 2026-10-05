'use strict';

// AWG 3.1 editor rules. Primary references:
// https://github.com/amnezia-vpn/amneziawg-go#configuration
// https://github.com/amnezia-vpn/amneziawg-linux-kernel-module#configuration
const crypto = require('node:crypto');
const groups = [
  { id: 'base', title: 'Базовые параметры · AWG 1.0', names: ['Jc','Jmin','Jmax','S1','S2','H1','H2','H3','H4'] },
  { id: 'v2', title: 'Дополнения · AWG 2.0', names: ['S3','S4'] },
  { id: 'v3', title: 'Защита и таймеры · AWG 3.0', names: ['HeaderProtectionKey','ContentPaddingAddition','RekeyAfterTime','RekeyTimeout','RejectAfterTime','KeepaliveTimeout','MaxHandshakeAttempts'] },
  { id: 'v31', title: 'Дополнения · AWG 3.1', names: ['RandomTrailers','DisableCookies'] },
  { id: 'cps', title: 'Сигнатурные пакеты · AWG 1.5+', names: ['I1','I2','I3','I4','I5'] }
];
const names = groups.flatMap(group => group.names);
const optional = new Set(['ContentPaddingAddition','I1','I2','I3','I4','I5']);
const shared = new Set(['S1','S2','S3','S4','H1','H2','H3','H4','HeaderProtectionKey']);
const hints = {
  Jc: ['Число дополнительных пакетов перед рукопожатием.', 'Рекомендация разработчиков: 4–12. В редакторе: 0–128. Может отличаться у клиентов.'],
  Jmin: ['Минимальный размер дополнительных пакетов, в байтах.', 'Не больше Jmax. Рекомендуемый исходный ориентир: 8 байт.'],
  Jmax: ['Максимальный размер дополнительных пакетов, в байтах.', 'Исходный ориентир: 80 байт. Редактор ограничивает размер 1280 байт.'],
  S1: ['Дополнение начального пакета рукопожатия.', 'С ключом защиты: не менее 12 байт. Без RandomTrailers ориентир: 15–150 байт.'],
  S2: ['Дополнение ответного пакета рукопожатия.', 'Не менее 12 байт при защите заголовков. Совпадает с клиентом.'],
  S3: ['Дополнение ответа cookie. Добавлено в AWG 2.0.', 'Не менее 12 байт при защите заголовков. Совпадает с клиентом.'],
  S4: ['Дополнение пакетов данных. Добавлено в AWG 2.0.', 'Не менее 12 байт при защите заголовков. Увеличение добавляет накладные расходы.'],
  HeaderProtectionKey: ['Общий ключ защиты заголовков, не приватный ключ VPN-клиента.', '32 случайных байта в Base64. Требует S1–S4 ≥ 12. Генератор создаёт новый ключ.'],
  ContentPaddingAddition: ['Диапазон дополнительного заполнения пакетов данных.', 'Число или диапазон, например 10-100. Это не универсальная рекомендация для любой сети.'],
  RekeyAfterTime: ['Время до планового обновления ключей, в секундах.', 'Число или диапазон. Должно быть меньше RejectAfterTime. Лучше сохранить рабочие значения.'],
  RekeyTimeout: ['Интервал повторной попытки рукопожатия, в секундах.', 'Число или диапазон. Лучше сохранить рабочие значения.'],
  RejectAfterTime: ['Предельное время использования ключей, в секундах.', 'Число или диапазон. Должно быть больше RekeyAfterTime.'],
  KeepaliveTimeout: ['Таймер проверки активности соединения, в секундах.', 'Это не PersistentKeepalive клиента. Лучше сохранить рабочий диапазон.'],
  MaxHandshakeAttempts: ['Максимальное число попыток рукопожатия.', 'Положительное число или диапазон. Лучше сохранить рабочие значения.'],
  RandomTrailers: ['Случайное заполнение до MTU. Добавлено в AWG 3.1.', 'on/off. Редактор требует одинаковые S1–S4 при включении. Может увеличивать расход трафика.'],
  DisableCookies: ['Отключает отправку ответов cookie. Добавлено в AWG 3.1.', 'on/off. Лучше сохранить рабочее значение; меняет защиту от лишних рукопожатий.']
};
for (let i=1;i<=4;i++) hints['H'+i] = ['Диапазон идентификатора типа пакета '+i+'. Диапазоны доступны с AWG 2.0.', 'Число или диапазон 0–4294967295. H1–H4 не должны пересекаться.'];
for (let i=1;i<=5;i++) hints['I'+i] = ['Сигнатурный пакет перед рукопожатием. Это клиентская настройка, не обязательная серверная.', 'Необязательно. Теги <b 0x…>, <r N>, <rd N>, <rc N>, <t>. Генератор не меняет эти строки.'];

function invalid(message) { return Object.assign(new Error(message), {status:400,statusCode:400,code:'invalid_obfuscation'}); }
function range(text, name, max=65535) {
  const match=/^(\d+)(?:-(\d+))?$/.exec(text);
  const a=match?Number(match[1]):NaN, b=match?Number(match[2]??match[1]):NaN;
  if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||a>b||b>max) throw invalid(name+': некорректное число или диапазон.');
  return [a,b];
}
function validate(values) {
  if (!values || typeof values!=='object' || Array.isArray(values) || Object.keys(values).some(name=>!names.includes(name))) throw invalid('Неизвестные параметры обфускации.');
  const result={};
  for(const name of names) {
    const value=values[name];
    if(value!==undefined && typeof value!=='string' && typeof value!=='number') throw invalid(name+': некорректное значение.');
    const text=String(value??'').trim();
    if(!text && optional.has(name)) continue;
    if(!text || text.length>4096 || /[\r\n\0]/.test(text)) throw invalid(name+': укажите значение без переносов строки.');
    if(name==='HeaderProtectionKey') {
      if(!/^[A-Za-z0-9+/]{43}=$/.test(text)||Buffer.from(text,'base64').toString('base64')!==text||Buffer.from(text,'base64').every(byte=>byte===0)) throw invalid('HeaderProtectionKey: нужен ненулевой ключ из 32 байт в Base64.');
      result[name]=text;
    } else if(['RandomTrailers','DisableCookies'].includes(name)) {
      if(!/^(on|off|0|1)$/i.test(text)) throw invalid(name+': выберите on или off.');
      result[name]=/^(on|1)$/i.test(text)?'on':'off';
    } else if(/^I[1-5]$/.test(name)) {
      const tags=text.match(/<(?:b 0x(?:[\da-fA-F]{2})+|r \d+|rd \d+|rc \d+|t)>/g)||[];
      if(tags.join('')!==text.replace(/\s+(?=<)/g,'').trim()) throw invalid(name+': некорректная последовательность тегов.');
      let size=0;
      for(const tag of tags) size+=tag==='<t>'?4:tag.startsWith('<b ')?(tag.length-6)/2:Number(tag.match(/\d+/)[0]);
      if(size<1||size>1280) throw invalid(name+': суммарный размер пакета должен быть 1–1280 байт.');
      result[name]=tags.join('');
    } else if(/^(Jc|Jmin|Jmax|S[1-4])$/.test(name)) {
      const max=name==='Jc'?128:name==='S1'?1132:name==='S2'?1188:1280;
      if(!/^\d+$/.test(text)||Number(text)>max) throw invalid(name+': допустимы целые числа от 0 до '+max+'.');
      result[name]=String(Number(text));
    } else {
      const bounds=range(text,name,/^H/.test(name)?4294967295:65535);
      if(name!=='ContentPaddingAddition'&&!/^H/.test(name)&&bounds[0]<1) throw invalid(name+': таймер или число попыток должны быть положительными.');
      result[name]=bounds[0]===bounds[1]?String(bounds[0]):bounds.join('-');
    }
  }
  // Explicit zero clears a previous runtime value instead of relying on omission.
  if(result.ContentPaddingAddition===undefined)result.ContentPaddingAddition='0';
  if(Number(result.Jmin)>Number(result.Jmax)) throw invalid('Jmin не должен превышать Jmax.');
  if(['S1','S2','S3','S4'].some(name=>Number(result[name])<12)) throw invalid('С HeaderProtectionKey значения S1–S4 должны быть не меньше 12.');
  const headers=['H1','H2','H3','H4'].map(name=>range(result[name],name,4294967295));
  for(let i=0;i<4;i++) for(let j=i+1;j<4;j++) if(headers[i][0]<=headers[j][1]&&headers[j][0]<=headers[i][1]) throw invalid('Диапазоны H1–H4 не должны пересекаться.');
  const sizes=[148,92,64,32].map((base,i)=>base+Number(result['S'+(i+1)]));
  if(new Set(sizes).size!==4) throw invalid('S1–S4 создают одинаковые размеры разных типов пакетов.');
  if(result.RandomTrailers==='on' && new Set(['S1','S2','S3','S4'].map(name=>result[name])).size!==1) throw invalid('При RandomTrailers=on задайте одинаковые S1–S4.');
  if(range(result.RekeyAfterTime,'RekeyAfterTime')[1]>=range(result.RejectAfterTime,'RejectAfterTime')[0]) throw invalid('Весь диапазон RekeyAfterTime должен быть меньше RejectAfterTime.');
  return result;
}
function revision(values) {
  const canonical=name=>{
    const text=String(values[name]??(name==='ContentPaddingAddition'?'0':'')).trim();
    if(['RandomTrailers','DisableCookies'].includes(name))return /^(on|1)$/i.test(text)?'on':'off';
    if(/^\d+(?:-\d+)?$/.test(text)){const[a,b=a]=text.split('-').map(Number);return a===b?String(a):`${a}-${b}`;}
    return text;
  };
  return crypto.createHash('sha256').update(JSON.stringify(names.map(name=>[name,canonical(name)]))).digest('hex');
}
function generate(current) {
  const next={...current,Jc:String(crypto.randomInt(4,13)),Jmin:'8',Jmax:'80',HeaderProtectionKey:crypto.randomBytes(32).toString('base64')};
  const padding=crypto.randomInt(15,151);
  for(let i=1;i<=4;i++) {next['S'+i]=String(padding);next['H'+i]=String(i);}
  return validate(next);
}
function rewrite(config, values, client=false) {
  const lines=String(config).split(/\r?\n/), out=[];
  // Client junk defaults must not silently enable junk on the server itself.
  const serverJunk={};let sourceSection='';
  if(!client)for(const line of lines){
    const header=/^\s*\[([^\]]+)\]\s*$/.exec(line);if(header){sourceSection=header[1].toLowerCase();continue;}
    const pair=/^\s*(Jc|Jmin|Jmax)\s*=\s*(.*?)\s*$/.exec(line);
    if(sourceSection==='interface'&&pair)serverJunk[pair[1]]=pair[2];
  }
  let inside=false,seen=false,inserted=false;
  const newline=config.includes('\r\n')?'\r\n':'\n';
  function insert() {
    if(inserted) return;
    for(const name of names) if(values[name]!==undefined) {
      const comment=!client && /^I[1-5]$/.test(name);
      const value=!client&&/^J(c|min|max)$/.test(name)?(serverJunk[name]??'0'):values[name];
      out.push(`${comment?'# ':''}${name} = ${value}`);
    }
    // Preserve the distinction between server junk and client defaults.
    if(!client) for(const name of ['Jc','Jmin','Jmax']) out.push(`# Client${name} = ${values[name]}`);
    inserted=true;
  }
  for(const line of lines) {
    if(/^\s*\[.*\]\s*$/.test(line)) {
      if(inside) insert();
      inside=/^\s*\[Interface\]\s*$/i.test(line);
      if(inside && seen) throw invalid('Повторная секция Interface.');
      if(inside) seen=true;
    }
    const pair=/^\s*[#;]?\s*([A-Za-z0-9]+)\s*=/.exec(line);
    if(inside&&pair&&(names.includes(pair[1])||/^ClientJ(c|min|max)$/.test(pair[1]))) continue;
    out.push(line);
  }
  if(inside) insert();
  if(!seen) throw invalid('Отсутствует секция Interface.');
  return out.join(newline);
}
module.exports={groups,names,hints,shared,validate,revision,generate,rewrite};
