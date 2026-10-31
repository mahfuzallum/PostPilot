// Small vanilla JS: theme toggle, loading buttons, ripple (premium "touch animations"), copy buttons, tz preview.
(function(){
  const html=document.documentElement;
  document.addEventListener('click',e=>{
    const t=e.target.closest('[data-toggle-mode]'); if(t){const m=html.dataset.mode==='light'?'dark':'light';html.dataset.mode=m;localStorage.mode=m;fetch('/account/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:m})}).catch(()=>{});}
    const c=e.target.closest('[data-copy]'); if(c){const i=document.getElementById(c.dataset.copy);navigator.clipboard.writeText(i.value);c.textContent='✓ Copied';setTimeout(()=>c.textContent='Copy',1500);}
    const b=e.target.closest('[data-burger]'); if(b){const o=document.querySelector('.nav').classList.toggle('open');b.setAttribute('aria-expanded',o);b.textContent=o?'✕':'☰';}
    const btn=e.target.closest('.btn'); if(btn&&html.dataset.touch==='1'&&!matchMedia('(prefers-reduced-motion: reduce)').matches){const r=btn.getBoundingClientRect(),s=document.createElement('span'),d=Math.max(r.width,r.height);s.className='ripple';s.style.cssText=`width:${d}px;height:${d}px;left:${e.clientX-r.left-d/2}px;top:${e.clientY-r.top-d/2}px`;btn.appendChild(s);setTimeout(()=>s.remove(),600);}
  });
  document.addEventListener('submit',e=>{const b=e.target.querySelector('button[type=submit]:not([formnovalidate])');if(b&&!e.target.dataset.noload){setTimeout(()=>{b.classList.add('loading');b.disabled=true},0)}});
  // confirm dialogs (CSP-safe replacement for inline onsubmit)
  document.addEventListener('submit',e=>{const f=e.target;if(f.dataset.confirm&&!confirm(f.dataset.confirm)){e.preventDefault();e.stopImmediatePropagation();}},true);
  // time zone pickers: presets + searchable IANA list, auto-detected when nothing is saved
  const zones=(()=>{try{return Intl.supportedValuesOf('timeZone')}catch(e){return ['UTC','Asia/Dhaka','Asia/Kolkata','America/New_York','America/Chicago','America/Los_Angeles','Europe/London']}})();
  const detected=(()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){return 'UTC'}})();
  document.querySelectorAll('[data-tzp]').forEach(w=>{
    const sel=w.querySelector('select'),cus=w.querySelector('.tz-custom'),hid=w.querySelector('input[type=hidden]'),dl=w.querySelector('datalist');
    dl.innerHTML=zones.map(z=>`<option value="${z}">`).join('');
    const set=z=>{hid.value=z;w.dataset.value=z;w.dispatchEvent(new CustomEvent('tzchange',{bubbles:true,detail:z}));};
    const pick=z=>{if([...sel.options].some(o=>o.value===z)){sel.value=z;cus.hidden=true}else{sel.value='custom';cus.hidden=false;cus.value=z}set(z)};
    const note=w.parentElement.querySelector('.tz-auto'),overridden=localStorage.tzManual==='1';
    if(!w.dataset.cur||(!overridden&&w.dataset.save&&w.dataset.cur!==detected&&w.dataset.autosaved==='1')){pick(detected);w.dataset.auto='1';
      if(w.dataset.save)fetch('/account/tz',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tz:detected,auto:1})}).then(r=>r.ok&&window.ppToast&&window.ppToast('Time zone set to '+detected)).catch(()=>{});
    }else pick(w.dataset.cur);
    if(note)note.textContent=w.dataset.value===detected?'Detected: '+detected:'Detected: '+detected+' (using '+w.dataset.value+')';
    const manual=()=>{localStorage.tzManual='1';if(w.dataset.save)fetch('/account/tz',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tz:hid.value})}).catch(()=>{});if(note)note.textContent=hid.value===detected?'Detected: '+detected:'Detected: '+detected+' (using '+hid.value+')';};
    sel.addEventListener('change',()=>{if(sel.value==='custom'){cus.hidden=false;cus.focus();if(zones.includes(cus.value)){set(cus.value);manual()}}else{cus.hidden=true;set(sel.value);manual()}});
    cus.addEventListener('change',()=>{if(zones.includes(cus.value)){cus.setCustomValidity('');set(cus.value);manual()}else cus.setCustomValidity('Pick a time zone from the list')});
  });
  // instant appearance: theme / mode / font apply immediately and persist (localStorage + account)
  document.addEventListener('click',e=>{const t=e.target.closest('[data-appearance]');if(!t||t.disabled)return;const k=t.dataset.appearance,v=t.dataset.value;
    html.dataset[k]=v;localStorage[k]=v;document.querySelectorAll(`[data-appearance=${k}]`).forEach(x=>x.classList.toggle('on',x===t));
    fetch('/account/appearance',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({[k]:v})}).then(r=>r.json()).then(j=>window.ppToast&&window.ppToast(j.ok?'Appearance saved':(j.error||'Could not save'),j.ok?'ok':'err')).catch(()=>{});});
  window.ppToast=(msg,type='ok')=>{let t=document.getElementById('pp-toast');if(!t){t=document.createElement('div');t.id='pp-toast';t.setAttribute('role','status');document.body.appendChild(t)}t.className='toast '+type+' show';t.textContent=msg;clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('show'),2600)};
  const tf=document.querySelector('.alert.ok[data-toast]');if(tf){window.ppToast(tf.textContent);tf.remove();}
  if(!html.dataset.mode&&localStorage.mode) html.dataset.mode=localStorage.mode;
  // char counter
  const ta=document.querySelector('textarea[name=text]');if(ta){const c=document.getElementById('cc');const u=()=>{c.textContent=ta.value.length+' / 500';c.style.color=ta.value.length>500?'var(--bad)':''};ta.addEventListener('input',u);u();}
  // compose: manual vs AI
  const mode=document.querySelectorAll('[name=wmode]');mode.forEach(r=>r.addEventListener('change',()=>{document.getElementById('aibox').hidden=document.querySelector('[name=wmode]:checked').value!=='ai'}));
  const gen=document.getElementById('genbtn');if(gen)gen.addEventListener('click',async()=>{gen.classList.add('loading');try{const r=await fetch('/api/ai/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:document.getElementById('topic').value,tone:document.getElementById('tone').value,lang:'English'})});const j=await r.json();if(j.error)alert(j.error);else{ta.value=j.text;ta.dispatchEvent(new Event('input'))}}finally{gen.classList.remove('loading')}});
  const sm=document.querySelectorAll('[name=smode]');const syncS=()=>{const v=(document.querySelector('[name=smode]:checked')||{}).value;const a=document.getElementById('exactbox');if(a)a.hidden=v!=='exact'};sm.forEach(r=>r.addEventListener('change',syncS));syncS();
})();
