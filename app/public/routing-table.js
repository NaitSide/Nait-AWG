'use strict';
(() => {
  const el=id=>document.getElementById(id),t=text=>window.NaitI18n?.t(text)||text;
  const node=(tag,className,text)=>{const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;};
  class RoutingTable {
    constructor(prefix,{request,onChange,onBusy}) {
      Object.assign(this,{prefix,request,onChange,onBusy,token:0,catalog:{services:[]},draft:{custom:[],resolved:{}}});
      this.body=el(prefix+'Services');this.mode=el(prefix+'Mode');this.refreshButton=el(prefix+'Refresh');
      this.mode.addEventListener('change',()=>{this.display();onChange();});
      this.body.addEventListener('change',()=>onChange());
      this.body.addEventListener('input',event=>{if(event.target.matches('[data-extra-ips]')){this.capture();this.updateAvailability();this.display();onChange();}else if(event.target.matches('[data-custom-name],[data-custom-ips]'))onChange();});
      el(prefix+'Add').addEventListener('click',()=>{
        this.capture();if(this.draft.custom.length>=30)return;
        const id='custom-'+crypto.randomUUID();this.draft.custom.push({id,name:'',ipv4:[],enabled:true});
        this.render();onChange();this.body.querySelector('[data-row="'+id+'"] [data-custom-name]').focus();
      });
      this.body.addEventListener('click',event=>{
        const add=event.target.closest('[data-add-extra]'),clear=event.target.closest('[data-clear-extra]');
        if(add){const field=add.parentElement.querySelector('[data-extra-editor]');field.hidden=false;field.querySelector('textarea').focus();return;}
        if(clear){const editor=clear.closest('[data-extra-editor]');editor.querySelector('textarea').value='';editor.hidden=true;this.capture();this.updateAvailability();this.display();onChange();return;}
        const button=event.target.closest('[data-remove-route]');if(!button)return;
        this.capture();this.draft.custom=this.draft.custom.filter(row=>row.id!==button.dataset.removeRoute);this.render();onChange();
      });
      this.refreshButton.addEventListener('click',()=>this.refresh());
    }
    fill(value,catalog) {
      this.token++;this.onBusy(false);this.refreshButton.disabled=false;this.catalog=catalog||{services:[]};
      this.draft=structuredClone({mode:value?.mode||'all',services:value?.services||[],custom:value?.custom||[],resolved:value?.resolved||{},extras:value?.extras||{},bypassLocal:value?.bypassLocal||false});
      this.mode.value=this.draft.mode;el(this.prefix+'DnsStatus').textContent='';this.render();
      window.NaitDropdowns?.sync(this.mode);
    }
    cancelPending() {this.token++;this.onBusy(false);this.refreshButton.disabled=false;}
    capture() {
      this.draft.mode=this.mode.value;
      this.draft.services=[...this.body.querySelectorAll('[data-service]:checked')].map(input=>input.dataset.service);
      this.draft.extras=Object.fromEntries([...this.body.querySelectorAll('[data-extra-ips]')].map(input=>[input.dataset.extraIps,input.value.trim().split(/[\s,;]+/).filter(Boolean)]).filter(([,ips])=>ips.length));
      this.draft.bypassLocal=Boolean(this.body.querySelector('[data-local]')?.checked);
      this.draft.custom=[...this.body.querySelectorAll('[data-custom-row]')].map(row=>({id:row.dataset.row,
        name:row.querySelector('[data-custom-name]').value.trim(),enabled:row.querySelector('input[type=checkbox]').checked,
        ipv4:row.querySelector('[data-custom-ips]').value.trim().split(/[\s,;]+/).filter(Boolean)}));
      return this.draft;
    }
    read() {
      const value=this.capture();
      if(value.custom.some(row=>!row.name||!row.ipv4.length))throw Error(t('Укажите название и хотя бы один IPv4-адрес или подсеть для каждой своей строки.'));
      if(value.mode==='selected'&&!value.services.length&&!value.custom.some(row=>row.enabled))throw Error(t('Выберите хотя бы один доступный сервис.'));
      return structuredClone(value);
    }
    checkbox(name,checked,attribute,value='') {
      const input=node('input');input.type='checkbox';input.checked=checked;input.dataset[attribute]=value;
      input.setAttribute('aria-label',name);return input;
    }
    addresses(cell,addresses,serviceId) {
      if(!addresses.length && !serviceId) {cell.append(node('span','route-empty','Адресов пока нет'));return;}
      const summaryText=addresses.slice(0,2).join(', ');
      if(addresses.length<=2 && !serviceId) {const text=node('span','route-ip',summaryText);text.dataset.noI18n='';cell.append(text);return;}
      const details=node('details','route-addresses'),summary=node('summary'),text=node('span','route-ip',summaryText);
      text.dataset.noI18n='';summary.append(text,node('span','route-count',addresses.length>2?'+'+(addresses.length-2):'+'));if(!addresses.length)text.textContent=t('Адресов пока нет');
      const list=node('div','route-ip route-address-list',addresses.join('\n'));list.dataset.noI18n='';details.append(summary,list);
      if(serviceId){
        const add=node('button','route-add',t('＋ Добавить IP'));add.type='button';add.dataset.addExtra=serviceId;
        const editor=node('div','route-extra-editor');editor.dataset.extraEditor='';editor.hidden=!this.draft.extras[serviceId]?.length;
        const label=node('label','field',t('Добавлено вручную')),input=node('textarea','route-ips-input');
        input.dataset.extraIps=serviceId;input.dataset.noI18n='';input.value=(this.draft.extras[serviceId]||[]).join(', ');input.rows=2;input.maxLength=8192;input.spellcheck=false;
        input.placeholder='1.2.3.4, 5.6.7.0/24';input.setAttribute('aria-label',t('Дополнительные IPv4-адреса и подсети'));label.append(input);
        const clear=node('button','route-add',t('Удалить ручные адреса'));clear.type='button';clear.dataset.clearExtra=serviceId;editor.append(label,clear);details.append(add,editor);
      }
      cell.append(details);
    }
    render() {
      this.body.replaceChildren();
      for(const service of this.catalog.services) {
        const resolved=this.draft.resolved[service.id],available=service.available||Boolean(resolved?.ipv4.length)||Boolean(this.draft.extras[service.id]?.length);
        const row=node('tr',available?'':'route-unavailable'),check=node('td'),name=node('td'),addresses=node('td');
        const input=this.checkbox(service.name.ru,this.draft.services.includes(service.id),'service',service.id);
        input.dataset.available=String(available);input.dataset.baseAvailable=String(service.available||Boolean(resolved?.ipv4.length));check.append(input);
        const title=node('strong','route-service-name',service.name.ru);title.title=service.description.ru;name.append(title);
        const labels={telegram:'Сети Telegram',youtube:'Сети Google',instagram:'Сети Meta',whatsapp:'Сети Meta',facebook:'Сети Meta'};
        const description=node('small','route-description',!available?'Обновите IP через DNS':!service.available?(resolved?.ipv4.length?'DNS-адреса':'Добавлено вручную'):labels[service.id]);
        name.append(description);this.addresses(addresses,[...new Set([...(resolved?.ipv4||[]),...service.ipv4])],service.id);
        if(resolved) {
          const date=new Date(resolved.updatedAt).toLocaleString(window.NaitI18n?.locale||'ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
          const meta=node('small','route-source','DNS · '+date+' · '+resolved.sources.join(', '));meta.dataset.noI18n='';addresses.append(meta);
        }
        row.append(check,name,addresses);this.body.append(row);
      }
      for(const custom of this.draft.custom) {
        const row=node('tr','route-custom'),check=node('td'),name=node('td'),addresses=node('td');
        row.dataset.row=custom.id;row.dataset.customRow='';check.append(this.checkbox(t('Направлять через VPN'),custom.enabled,'customEnabled'));
        const input=node('input','route-name-input');input.dataset.customName='';input.value=custom.name;input.maxLength=80;
        input.placeholder=t('Название сервиса');input.setAttribute('aria-label',t('Название своего сервиса'));
        const remove=node('button','route-remove','×');remove.type='button';remove.dataset.removeRoute=custom.id;
        remove.setAttribute('aria-label',t('Удалить свою строку'));remove.title=t('Удалить свою строку');
        const nameWrap=node('div','route-custom-name');nameWrap.append(input,remove);name.append(nameWrap);
        const textarea=node('textarea','route-ips-input');textarea.dataset.customIps='';textarea.value=custom.ipv4.join(', ');
        textarea.rows=2;textarea.maxLength=8192;textarea.spellcheck=false;textarea.placeholder='8.8.8.8, 8.8.4.0/24';textarea.setAttribute('aria-label',t('Свои IPv4-адреса и подсети'));
        addresses.append(textarea);row.append(check,name,addresses);this.body.append(row);
      }
      const local=node('tr','route-local'),check=node('td'),name=node('td'),addresses=node('td');
      check.append(this.checkbox(t('Оставлять локальные сети напрямую'),this.draft.bypassLocal,'local'));
      name.append(node('strong','route-service-name','Локальные сети'),node('small','route-description','Напрямую, без VPN'));
      this.addresses(addresses,['192.168.0.0/16','10.0.0.0/8','172.16.0.0/12']);
      addresses.append(node('small','route-description','В полном режиме также исключаются локальные IPv6-сети.'));
      local.append(check,name,addresses);this.body.append(local);
      el(this.prefix+'Add').disabled=this.draft.custom.length>=30;this.display();
    }
    updateAvailability(){for(const input of this.body.querySelectorAll('[data-service]'))input.dataset.available=String(input.dataset.baseAvailable==='true'||Boolean(this.draft.extras[input.dataset.service]?.length));}
    display() {
      const all=this.mode.value==='all';
      el(this.prefix+'Warning').hidden=all;
      for(const input of this.body.querySelectorAll('[data-service]'))input.disabled=all||input.dataset.available!=='true';
      for(const input of this.body.querySelectorAll('[data-custom-enabled]'))input.disabled=all;
      el(this.prefix+'ModeHelp').textContent=t(all?'Все внешние адреса идут через VPN. Локальные сети можно оставить напрямую.':'Отметьте сервисы, которые должны работать через VPN.');
      this.body.closest('table').classList.toggle('route-full-mode',all);
    }
    async refresh() {
      const token=++this.token,feedback=el(this.prefix+'DnsStatus');this.refreshButton.disabled=true;this.onBusy(true);this.onChange();
      feedback.textContent=t('Запрашиваем адреса через Cloudflare и Google DNS…');
      try {
        const result=await this.request('/api/client-policies/resolve',{services:this.catalog.services.map(service=>service.id)});
        if(token!==this.token)return;
        this.capture();
        const next=structuredClone(this.draft.resolved);
        for(const [id,entry] of Object.entries(result.resolved)) {
          const previous=this.draft.resolved[id];
          const ipv4=result.partial.includes(id)&&previous?[...new Set([...previous.ipv4,...entry.ipv4])]:entry.ipv4;
          if(ipv4.length>256)throw Error(t('Слишком много DNS-адресов для одного сервиса. Предыдущий список сохранён.'));
          next[id]={...entry,ipv4,sources:result.partial.includes(id)&&previous?[...new Set([...previous.sources,...entry.sources])].sort():entry.sources};
        }
        this.draft.resolved=next;
        this.render();this.onChange();
        feedback.textContent=t(result.failed.length||result.partial.length
          ?'Часть DNS-запросов не выполнена. Доступные адреса добавлены; прежние списки сохранены.'
          :'IP-адреса обновлены. Сохраните настройки и скачайте конфиги заново.');
      } catch(error) {if(token===this.token)feedback.textContent=error.message;}
      finally {if(token===this.token){this.refreshButton.disabled=false;this.onBusy(false);}}
    }
  }
  window.NaitRoutingTable=RoutingTable;
})();
