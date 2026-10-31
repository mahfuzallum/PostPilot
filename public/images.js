// Local-folder mode: pick a folder, score images in the browser (resolution, contrast, sharpness), upload chosen ones.
(function(){
  const grid=document.getElementById('lgrid'),status=document.getElementById('lstatus'),up=document.getElementById('upbtn');
  let items=[];
  async function hash(file){const b=await file.arrayBuffer();const h=await crypto.subtle.digest('SHA-256',b);return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('')}
  function score(img){
    const W=256,H=Math.max(1,Math.round(W*img.naturalHeight/img.naturalWidth));const c=document.createElement('canvas');c.width=W;c.height=H;const x=c.getContext('2d');x.drawImage(img,0,0,W,H);
    const d=x.getImageData(0,0,W,H).data,L=new Float32Array(W*H);let sum=0;for(let i=0;i<W*H;i++){L[i]=.299*d[i*4]+.587*d[i*4+1]+.114*d[i*4+2];sum+=L[i]}
    const mean=sum/(W*H);let v=0;for(let i=0;i<W*H;i++)v+=(L[i]-mean)**2;const contrast=Math.sqrt(v/(W*H));
    let lap=0,lm=0,n=0;const lv=[];for(let y=1;y<H-1;y++)for(let q=1;q<W-1;q++){const i=y*W+q;const l=4*L[i]-L[i-1]-L[i+1]-L[i-W]-L[i+W];lv.push(l);lm+=l;n++}
    lm/=n||1;for(const l of lv)lap+=(l-lm)**2;const sharp=lap/(n||1);
    const mp=img.naturalWidth*img.naturalHeight/1e6;
    const sRes=Math.min(1,mp/2),sCon=Math.min(1,contrast/70),sSharp=Math.min(1,Math.log10(1+sharp)/3);
    return {total:Math.round(100*(.35*sRes+.3*sCon+.35*sSharp)),res:`${img.naturalWidth}×${img.naturalHeight}`,contrast:Math.round(contrast),sharp:Math.round(sharp)};
  }
  async function load(files){
    files=[...files].filter(f=>/^image\/(jpeg|png|webp)$/.test(f.type)).slice(0,200);
    status.textContent=`Scoring ${files.length} images…`;items=[];
    const used=new Set((()=>{try{return JSON.parse(document.getElementById('used-hashes').dataset.h)}catch(e){return []}})());
    for(const f of files){const url=URL.createObjectURL(f);const img=new Image();img.src=url;await img.decode().catch(()=>{});if(!img.naturalWidth)continue;
      const h=await hash(f);items.push({f,url,s:score(img),h,used:used.has(h),sel:false})}
    items.sort((a,b)=>b.s.total-a.s.total);items.slice(0,4).forEach(i=>{if(!i.used)i.sel=true});render();
    status.textContent=`${items.length} images scored. Best first.`;
  }
  function render(){grid.innerHTML='';items.forEach((it,i)=>{const d=document.createElement('div');d.className='it'+(it.sel?' sel':'');
    d.innerHTML=`<img src="${it.url}" alt=""><span class="pill sc ${it.s.total>60?'published':it.s.total>35?'posting':'failed'}">${it.s.total}</span><div class="meta">${it.s.res} · C${it.s.contrast} · S${it.s.sharp}${it.used?' · <b style="color:var(--bad)">used</b>':''}</div>`;
    d.onclick=()=>{if(it.used)return;it.sel=!it.sel;render()};grid.appendChild(d)});up.disabled=!items.some(i=>i.sel)}
  document.getElementById('folder').addEventListener('change',e=>load(e.target.files));
  const fsa=document.getElementById('fsabtn');if(fsa){if(!window.showDirectoryPicker)fsa.hidden=true;fsa.onclick=async()=>{const dir=await window.showDirectoryPicker();const fs=[];for await(const e of dir.values())if(e.kind==='file')fs.push(await e.getFile());load(fs)}}
  up.onclick=async()=>{up.classList.add('loading');let ok=0,dup=0;for(const it of items.filter(i=>i.sel)){const fd=new FormData();fd.append('file',it.f);fd.append('score',it.s.total);
    const r=await fetch('/media/upload',{method:'POST',body:fd});const j=await r.json();if(j.duplicate)dup++;else if(j.url)ok++;else alert(j.error)}
    up.classList.remove('loading');location.href='/media?up='+ok+'&dup='+dup};
})();
