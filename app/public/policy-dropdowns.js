'use strict';
(() => {
  if(!HTMLElement.prototype.showPopover)return;
  const entries=new Map();
  function close(entry,focus=false) {
    entry.root.classList.remove('open');entry.button.setAttribute('aria-expanded','false');
    if(entry.list.matches(':popover-open'))entry.list.hidePopover();
    if(focus)entry.button.focus({preventScroll:true});
  }
  function sync(select) {
    const entry=entries.get(select);if(!entry)return;
    entry.label.textContent=select.selectedOptions[0]?.textContent || '';
    [...entry.list.children].forEach((option,index)=>{
      const selected=select.options[index].selected;
      option.textContent=select.options[index].textContent;option.disabled=select.options[index].disabled;
      option.classList.toggle('selected',selected);option.setAttribute('aria-selected',String(selected));
    });
  }
  function open(entry,direction=0) {
    if(entry.select.matches(':disabled'))return;
    for(const other of entries.values())if(other!==entry)close(other);
    sync(entry.select);entry.root.classList.add('open');entry.button.setAttribute('aria-expanded','true');
    const rect=entry.button.getBoundingClientRect(),below=innerHeight-rect.bottom-12,above=rect.top-12;
    entry.anchor={top:rect.top,left:rect.left};
    const down=below>=Math.min(220,entry.list.children.length*40+12)||below>=above;
    Object.assign(entry.list.style,{width:rect.width+'px',left:Math.max(6,Math.min(rect.left,innerWidth-rect.width-6))+'px',
      maxHeight:Math.max(80,Math.min(260,down?below:above))+'px',
      top:down?rect.bottom+6+'px':'auto',bottom:down?'auto':innerHeight-rect.top+6+'px'});
    entry.list.showPopover();
    const items=[...entry.list.children].filter(item=>!item.disabled);
    (direction<0?items.at(-1):items.find(item=>item.classList.contains('selected'))||items[0])?.focus({preventScroll:true});
  }
  for(const select of document.querySelectorAll('select[data-policy-select]')) {
    const root=document.createElement('div');root.className='cdrop policy-dropdown';
    const button=document.createElement('button');button.type='button';button.className='cdrop-btn';
    button.id=select.id+'Button';button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
    const label=document.createElement('span');label.className='cdrop-label';label.id=select.id+'Value';
    button.setAttribute('aria-labelledby',select.id+'Label '+label.id);
    const arrow=document.createElement('span');arrow.className='cdrop-arrow';arrow.textContent='▾';arrow.setAttribute('aria-hidden','true');
    button.append(label,arrow);
    const list=document.createElement('div');list.className='cdrop-list';list.id=select.id+'Options';
    list.setAttribute('popover','manual');list.setAttribute('role','listbox');list.setAttribute('aria-labelledby',select.id+'Label');
    button.setAttribute('aria-controls',list.id);
    const entry={select,root,button,label,list};entries.set(select,entry);
    for(const option of select.options) {
      const item=document.createElement('button');item.type='button';item.className='cdrop-item';item.setAttribute('role','option');item.tabIndex=-1;
      item.addEventListener('click',()=>{
        select.value=option.value;sync(select);close(entry,true);select.dispatchEvent(new Event('change',{bubbles:true}));
      });list.append(item);
    }
    root.append(button,list);select.after(root);select.hidden=true;sync(select);
    button.addEventListener('click',()=>entry.root.classList.contains('open')?close(entry):open(entry));
    button.addEventListener('keydown',event=>{
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();open(entry,event.key==='ArrowUp'||event.key==='End'?-1:1);}
    });
    list.addEventListener('keydown',event=>{
      const items=[...list.children].filter(item=>!item.disabled),index=items.indexOf(document.activeElement);
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(entry,true);}
      else if(event.key==='Tab')close(entry);
      else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
        items[next]?.focus({preventScroll:true});items[next]?.scrollIntoView({block:'nearest'});
      }
    });
    select.addEventListener('change',()=>sync(select));
  }
  document.addEventListener('click',event=>{for(const entry of entries.values())if(!entry.root.contains(event.target))close(entry);});
  window.addEventListener('keydown',event=>{if(event.key==='Escape')for(const entry of entries.values())if(entry.root.classList.contains('open')){event.stopImmediatePropagation();close(entry,true);}});
  window.addEventListener('resize',()=>{for(const entry of entries.values())close(entry);});
  document.addEventListener('scroll',event=>{
    for(const entry of entries.values())if(entry.root.classList.contains('open')&&!entry.list.contains(event.target)) {
      const rect=entry.button.getBoundingClientRect();
      if(Math.abs(rect.top-entry.anchor.top)>1||Math.abs(rect.left-entry.anchor.left)>1)close(entry);
    }
  },true);
  window.NaitDropdowns={sync};
})();
