'use strict';
(() => {
  const card=document.getElementById('obfuscationCard');
  const form=document.getElementById('obfuscationForm');
  const toggle=document.getElementById('obfuscationToggle');
  const inputs=Array.from(form.querySelectorAll('input[name]'));
  const actions=card.querySelector('.obfuscation-actions');
  const status=document.getElementById('obfuscationStatus');
  const modal=document.getElementById('obfuscationModal');
  const errorBox=document.getElementById('obfuscationError');
  const consent=document.getElementById('obfuscationConfirmConsent');
  const apply=document.getElementById('obfuscationApply');
  let editing=false,busy=false,revision='',preview=null;
  const values=()=>Object.fromEntries(inputs.map(input=>[input.name,input.value]));
  const fill=parameters=>inputs.forEach(input=>{input.value=parameters[input.name]??'';});
  async function request(url,body){
    const response=await fetch(url,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload.message||'Не удалось проверить параметры.');
    return payload;
  }
  function controls(){
    toggle.disabled=busy;
    inputs.forEach(input=>{input.disabled=!editing||busy;});
    actions.hidden=!editing;
    for(const button of actions.querySelectorAll('button'))button.disabled=busy;
    apply.disabled=busy||!consent.checked;
    consent.disabled=busy;
    modal.dataset.busy=String(busy);
    card.classList.toggle('editing',editing);
    toggle.setAttribute('aria-pressed',String(editing));
    document.getElementById('obfuscationMode').textContent=editing?'Edit mode':'Read-only';
  }
  toggle.addEventListener('click',async()=>{
    if(busy)return;
    if(editing){editing=false;inputs.forEach(input=>{input.value=input.defaultValue;});status.textContent='';controls();return;}
    busy=true;status.textContent='Проверяем текущие параметры…';controls();
    try{
      const current=await request('/api/obfuscation');revision=current.revision;
      fill(current.parameters);inputs.forEach(input=>{input.defaultValue=input.value;});
      editing=true;status.textContent='';
    }catch(error){status.textContent=error.message;}
    finally{busy=false;controls();}
  });
  document.getElementById('obfuscationGenerate').addEventListener('click',async()=>{
    if(busy||!editing)return;
    busy=true;controls();
    try{fill(await request('/api/obfuscation/generate',{parameters:values()}));status.textContent='Случайные параметры подготовлены. На сервере ничего не изменилось. Таймеры и сигнатурные пакеты сохранены.';}
    catch(error){status.textContent=error.message;}
    finally{busy=false;controls();}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!editing)return;
    busy=true;controls();status.textContent='Проверяем значения и последствия…';
    try{
      preview=await request('/api/obfuscation/inspect',{parameters:values(),expectedRevision:revision});
      if(!preview.changed.length){status.textContent='Параметры не изменены.';return;}
      status.textContent='';consent.checked=false;errorBox.hidden=true;
      const impact=document.getElementById('obfuscationImpact');
      impact.textContent=`Изменятся: ${preview.changed.join(', ')}. Сохранённых конфигов для обновления: ${preview.savedConfigs}. Клиентов без исходного конфига: ${preview.missingConfigs}. `+(preview.sharedChanged?'Общие параметры изменены: старые клиентские файлы потребуется заменить.':'Общие параметры не изменены; совместимость старых конфигов по ним сохраняется.');
      showModal('obfuscationModal');
    }catch(error){status.textContent=error.message;}
    finally{busy=false;controls();}
  });
  consent.addEventListener('change',controls);
  apply.addEventListener('click',async()=>{
    if(busy||!consent.checked||!preview)return;
    busy=true;controls();apply.textContent='Применяем и проверяем…';errorBox.hidden=true;
    try{
      const result=await request('/api/obfuscation/apply',{parameters:preview.parameters,expectedRevision:preview.revision,confirmed:true});
      fill(preview.parameters);inputs.forEach(input=>{input.defaultValue=input.value;});editing=false;
      status.textContent=`Параметры сохранены. Обновлено конфигов в панели: ${result.updatedConfigs}. `+(preview.sharedChanged?'Скачайте и раздайте их заново.':'Общие параметры подключения не изменены.');
      busy=false;controls();closeModal(modal);
    }catch(error){errorBox.textContent=error.message;errorBox.hidden=false;}
    finally{busy=false;apply.textContent='Применить';controls();}
  });
  let activeHint=null;
  // Move the open hint out of clipped cards/main; z-index alone cannot escape overflow.
  function positionHint(){
    if(!activeHint)return;
    const {button,popover}=activeHint;
    const anchor=button.getBoundingClientRect();
    const margin=12,gap=8,width=document.documentElement.clientWidth,height=window.innerHeight;
    if(anchor.bottom<0||anchor.top>height||!button.getClientRects().length){hideHints();return;}
    popover.style.maxHeight=`${Math.max(40,height-2*margin)}px`;
    const size=popover.getBoundingClientRect();
    const left=Math.max(margin,Math.min(anchor.left,width-size.width-margin));
    const below=height-anchor.bottom-gap-margin,above=anchor.top-gap-margin;
    const useBelow=below>=size.height||below>=above;
    popover.style.maxHeight=`${Math.max(40,useBelow?below:above)}px`;
    const actual=popover.getBoundingClientRect();
    const top=useBelow?anchor.bottom+gap:anchor.top-gap-actual.height;
    popover.style.left=`${left}px`;
    popover.style.top=`${Math.max(margin,Math.min(top,height-actual.height-margin))}px`;
  }
  function hideHints(){
    if(!activeHint)return;
    const {button,popover,parent}=activeHint;
    button.setAttribute('aria-expanded','false');popover.hidden=true;
    popover.classList.remove('floating');popover.removeAttribute('style');parent.appendChild(popover);
    activeHint=null;
  }
  for(const button of card.querySelectorAll('[data-obfuscation-help]'))button.addEventListener('click',()=>{
    const open=button.getAttribute('aria-expanded')!=='true';hideHints();
    if(open){
      const popover=document.getElementById(button.getAttribute('aria-controls'));
      activeHint={button,popover,parent:popover.parentElement};
      document.body.appendChild(popover);popover.classList.add('floating');popover.hidden=false;
      button.setAttribute('aria-expanded','true');positionHint();
    }
  });
  document.addEventListener('click',event=>{if(!event.target.closest('.obfuscation-info,.obfuscation-popover'))hideHints();});
  document.addEventListener('scroll',positionHint,true);
  window.addEventListener('resize',positionHint);
  document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',hideHints));
  document.addEventListener('keydown',event=>{if(event.key==='Escape')hideHints();});
})();
