/* ================= CONFIG ================= */
const SUPABASE_URL = 'https://prfdrpmnftegbiaglugh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_es3WrqJR1IuFySgBAV_-2g_f23h-alp';
// Must match the VAPID_PUBLIC secret set on the push-notify Edge Function.
const VAPID_PUBLIC='BABQYQDJkhd8chYRiDZCqemPnc1VF0Y7AmAy7O1OhTK4IGGhWmxBCHh0Ezlrpfj06L1ke6ppSa0PE3qwQm1wutk';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* Mirrors the current auth session into IndexedDB (kept in sync below) so
   the service worker - which has no access to this page's memory or
   localStorage - can send a message on its own when the user replies
   directly from a push notification, even with the app fully closed. */
function idbOpen(){ return new Promise((res,rej)=>{ const rq=indexedDB.open('linkup',1); rq.onupgradeneeded=()=>rq.result.createObjectStore('kv'); rq.onsuccess=()=>res(rq.result); rq.onerror=()=>rej(rq.error); }); }
async function idbGet(key){ const db=await idbOpen(); return new Promise((res,rej)=>{ const rq=db.transaction('kv','readonly').objectStore('kv').get(key); rq.onsuccess=()=>res(rq.result); rq.onerror=()=>rej(rq.error); }); }
async function idbSet(key,val){ const db=await idbOpen(); return new Promise((res,rej)=>{ const tx=db.transaction('kv','readwrite'); tx.objectStore('kv').put(val,key); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }
async function idbDel(key){ const db=await idbOpen(); return new Promise((res,rej)=>{ const tx=db.transaction('kv','readwrite'); tx.objectStore('kv').delete(key); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }
function saveSessionToIDB(session){ if(!session)return Promise.resolve(); return idbSet('session',{access_token:session.access_token,refresh_token:session.refresh_token,user_id:session.user.id,saved_at:Date.now()}).catch(()=>{}); }
function clearSessionFromIDB(){ return idbDel('session').catch(()=>{}); }

/* ================= HELPERS ================= */
const $=id=>document.getElementById(id);
let myProfile=null;
const me=()=>myProfile;
const esc=s=>(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const likeEsc=s=>(s||'').replace(/[%_]/g,'\\$&');
const userCache={};
async function getUser(id){
  if(!id)return null;
  if(userCache[id])return userCache[id];
  try{ const {data,error}=await sb.from('profiles').select('*').eq('id',id).single(); if(error)return null; userCache[id]=data; return data; }
  catch(e){ return null; }
}
function showUpload(msg){ $('upMsg').textContent=msg||'Uploading…'; setUpload(8); $('upOverlay').classList.add('on'); }
function setUpload(p){ p=Math.max(0,Math.min(100,Math.round(p))); $('upFill').style.width=p+'%'; $('upPct').textContent=p+'%'; if(p>=100)$('upMsg').textContent='Processing…'; }
function hideUpload(){ $('upOverlay').classList.remove('on'); }
function randPath(){ return (crypto.randomUUID?crypto.randomUUID():(Date.now()+'-'+Math.random().toString(36).slice(2))); }
async function uploadFile(bucket,path,file){
  const {error}=await sb.storage.from(bucket).upload(path,file,{upsert:true,contentType:(file&&file.type)||'application/octet-stream'});
  if(error) throw error;
  const {data}=sb.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}
const postRecCache={};
async function getPost(id){
  if(!id)return null;
  if(postRecCache[id])return postRecCache[id];
  try{ const {data,error}=await sb.from('posts').select('*').eq('id',id).single(); if(error)return null; postRecCache[id]=data; return data; }
  catch(e){ return null; }
}
function hydrateCards(root){ (root||document).querySelectorAll('.pcard[data-post]:not([data-hy])').forEach(async el=>{ el.setAttribute('data-hy','1'); const pid=el.getAttribute('data-post'),mid=el.getAttribute('data-mid'); const p=await getPost(pid); if(!p)return; const t=p.image_url||p.thumb_url||''; const im=document.getElementById('pcimg_'+mid); if(im&&t)im.style.backgroundImage="url('"+t+"')"; }); }
function parseTags(s){ if(!s)return []; return [...new Set(s.split(/[,\s]+/).map(x=>x.replace(/^@/,'').trim()).filter(Boolean))]; }
function tagsHtml(s){ const n=parseTags(s); if(!n.length)return ''; return '<div class="cap" style="color:var(--mut)">with '+n.map(x=>`<span class="tagm" onclick="openProfileByUsername('${x}')">@${esc(x)}</span>`).join(' ')+'</div>'; }
async function openProfileByUsername(name){ try{ const {data}=await sb.from('profiles').select('id').eq('username',name).maybeSingle(); if(data)openProfile(data.id); else toast('User not found'); }catch(e){} }
async function notifyTags(s,postId){ const names=parseTags(s); if(!names.length)return; try{ const {data:us}=await sb.from('profiles').select('id').in('username',names); (us||[]).forEach(u=>{ if(u.id!==me().id) notify('tag',u.id,postId?{post_id:postId}:{}); }); }catch(e){} }
function mediaUrl(rec,field){ return (rec&&rec[field])||''; }
function compressImage(file,maxDim,quality){return new Promise(res=>{try{if(!file||!file.type||file.type.indexOf('image/')!==0)return res(file);const img=new Image();const url=URL.createObjectURL(file);img.onload=()=>{let w=img.width,h=img.height;if(Math.max(w,h)>maxDim){if(w>=h){h=Math.round(h*maxDim/w);w=maxDim;}else{w=Math.round(w*maxDim/h);h=maxDim;}}const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);c.toBlob(b=>{URL.revokeObjectURL(url);res(b?new File([b],(file.name||'img').replace(/\.[^.]+$/,'')+'.jpg',{type:'image/jpeg'}):file);},'image/jpeg',quality||0.82);};img.onerror=()=>{URL.revokeObjectURL(url);res(file);};img.src=url;}catch(e){res(file);}});}
function avatarHtml(u,size,cls){const url=mediaUrl(u,'avatar_url');if(url)return `<img class="av ${cls||''}" style="width:${size}px;height:${size}px" src="${url}">`;const L=esc((u.username||u.name||'?')[0].toUpperCase());return `<div class="av ph ${cls||''}" style="width:${size}px;height:${size}px;font-size:${Math.round(size*0.42)}px">${L}</div>`;}
function toast(m){const t=$('toast');t.textContent=m;t.style.display='block';clearTimeout(t._t);t._t=setTimeout(()=>t.style.display='none',2200);}
function sbErr(e){ try{ return (e&&(e.message||e.error_description||e.msg))||'Unknown error'; }catch(_){ return 'Error'; } }
function timeAgo(d){const s=(Date.now()-new Date(d).getTime())/1000;if(s<60)return 'now';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';if(s<604800)return Math.floor(s/86400)+'d';return new Date(d).toLocaleDateString();}
function convKey(a,b){return [a,b].sort().join('_');}

/* ================= ICONS (inline SVG, premium line set) ================= */
const PATHS={
  home:'<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h4.5v-5.5h4V20h4.5V9.5"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  plus:'<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="M12 8.3v7.4M8.3 12h7.4"/>',
  reels:'<rect x="3" y="4" width="18" height="16" rx="4"/><path d="M10.2 8.4l5.2 3.6-5.2 3.6z" fill="currentColor" stroke="none"/>',
  message:'<path d="M21 11.5a8 8 0 0 1-11.5 7.2L4 20l1.3-4.4A8 8 0 1 1 21 11.5z"/>',
  comment:'<path d="M21 11.5a8 8 0 0 1-11.5 7.2L4 20l1.3-4.4A8 8 0 1 1 21 11.5z"/>',
  heart:'<path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.4a5 5 0 0 0 0-7z"/>',
  attach:'<path d="M20.5 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.2 3.2 0 0 1 4.5 4.5l-8.5 8.5a1.5 1.5 0 0 1-2.2-2.1l7.8-7.8"/>',
  mic:'<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>',
  trash:'<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6"/>',
  send:'<path d="M21.5 3.5 11 14"/><path d="M21.5 3.5l-6.5 17-4-8.5-8.5-4z" fill="currentColor" stroke="none"/>',
  refresh:'<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
  back:'<path d="M15 5l-7 7 7 7"/>',
  volumeOn:'<path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.3 5.7a9 9 0 0 1 0 12.6"/>',
  volumeOff:'<path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor" stroke="none"/><path d="M22 9l-6 6M16 9l6 6"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/>',
  group:'<circle cx="9" cy="8" r="3.3"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M16 5.2a3 3 0 0 1 0 5.6M17.6 14c2.2.5 3.9 2.3 3.9 4.8"/>',
  phone:'<path d="M6.6 10.8a13 13 0 0 0 5.6 5.6l1.9-1.9a1.4 1.4 0 0 1 1.5-.35 9 9 0 0 0 2.9.46 1.4 1.4 0 0 1 1.4 1.4V18a1.4 1.4 0 0 1-1.5 1.4C9.7 19 4.9 14.2 4.5 6a1.4 1.4 0 0 1 1.4-1.5H8a1.4 1.4 0 0 1 1.4 1.4 9 9 0 0 0 .46 2.9 1.4 1.4 0 0 1-.35 1.5z" fill="currentColor" stroke="none"/>',
  video:'<rect x="3" y="6" width="12.5" height="12" rx="2.5"/><path d="M15.5 10.5 21 7v10l-5.5-3.5z" fill="currentColor" stroke="none"/>',
  videoOff:'<rect x="3" y="6" width="12.5" height="12" rx="2.5"/><path d="M15.5 10.5 21 7v10l-5.5-3.5z" fill="currentColor" stroke="none"/><path d="M3 3l18 18"/>',
  micOff:'<path d="M9 9V5a3 3 0 0 1 5.9-.7M15 11a3 3 0 0 1-4.2 2.8"/><path d="M19 10v1a7 7 0 0 1-9.5 6.5M5 10v1a7 7 0 0 0 1.5 4.3M12 18v4"/><path d="M3 3l18 18"/>',
  check:'<path d="M5 13l4 4 10-11"/>',
  checks:'<path d="M2 12.5l4 4 7-8"/><path d="M11 16.5l1 1 8.5-9.5"/>',
  more:'<circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none"/>',
  bell:'<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  bookmark:'<path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1z"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  reply:'<path d="M9 14L4 9l5-5"/><path d="M4 9h9a7 7 0 0 1 7 7v3"/>',
  rlike:'<path d="M7 10v9H4V10z"/><path d="M7 10l3.4-6.4A1.8 1.8 0 0 1 13 4.6L12 9h5.6a2 2 0 0 1 2 2.4l-1.2 5.6a2 2 0 0 1-2 1.6H7"/>',
  rhaha:'<circle cx="12" cy="12" r="9"/><path d="M8 9.4c.6-.7 1.8-.7 2.4 0M13.6 9.4c.6-.7 1.8-.7 2.4 0"/><path d="M7.5 13.5h9a4.7 4.7 0 0 1-9 0z" fill="currentColor" stroke="none"/>',
  rwow:'<circle cx="12" cy="12" r="9"/><circle cx="9" cy="9.8" r="1.05" fill="currentColor" stroke="none"/><circle cx="15" cy="9.8" r="1.05" fill="currentColor" stroke="none"/><ellipse cx="12" cy="15" rx="2.1" ry="2.6"/>',
  rsad:'<circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="1.05" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.05" fill="currentColor" stroke="none"/><path d="M8.3 16.2a4.6 4.6 0 0 1 7.4 0"/>',
  rfire:'<path d="M12 3c.8 2.5-.6 3.9-1.4 5.2-.6 1-.6 2.3.3 3.1-1.6.2-2.9-1-3-2.6-1.3 1.4-2 3.1-2 5a6 6 0 0 0 12 0c0-2.4-1-4-2.2-5.6-1 .9-2 .9-2.4-.2-.5-1.4.3-2.9.7-4.4-.6-.2-1.4-.3-2-.5z"/>',
  layers:'<path d="M12 3 3 8l9 5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  qr:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 19v2"/>',
  pin:'<path d="M9 3h6l-1.2 6.5 3.2 2.5v2H7v-2l3.2-2.5L9 3z"/><path d="M12 14v7"/>',
  belloff:'<path d="M9 5a5 5 0 0 1 8 4v2M18 13v1l2 3H8"/><path d="M9.5 19a2.5 2.5 0 0 0 5 0"/><path d="M3 3l18 18"/>',
  poll:'<path d="M3 20h18"/><path d="M6 20v-6M12 20V5M18 20v-9"/>',
  verified:'<path d="M12 2l2.4 1.6 2.8-.4 1 2.7 2.5 1.4-.6 2.8.6 2.8-2.5 1.4-1 2.7-2.8-.4L12 22l-2.4-1.6-2.8.4-1-2.7-2.5-1.4.6-2.8-.6-2.8 2.5-1.4 1-2.7 2.8.4z" fill="currentColor" stroke="none"/><path d="M8.4 12.2l2.3 2.3 4.6-4.9" stroke="#fff" stroke-width="2.2"/>'
};
function icon(name,size,opts){size=size||24;opts=opts||{};const fill=opts.fill||'none';return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fill}" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="display:block">${PATHS[name]}</svg>`;}
function vbadge(u){ return (u&&u.is_verified)?`<span class="vbadge" title="Verified" style="color:var(--accent)">${icon('verified',14)}</span>`:''; }
function applyStaticIcons(){
  const map={Feed:'home',Search:'search',Create:'plus',Reels:'reels',Chats:'message'};
  document.querySelectorAll('nav button').forEach(b=>{const n=map[b.dataset.s];if(n)b.innerHTML=icon(n,26);});
  const cb=document.querySelector('nav button[data-s="Chats"]');
  if(cb&&!cb.querySelector('.nbadge'))cb.insertAdjacentHTML('beforeend','<span class="nbadge" id="chatsBadge"></span>');
  $('notifBtn').innerHTML=icon('bell',22)+'<span class="hbadge" id="notifBadge"></span>'; $('notifBtn').onclick=openNotif;
  $('profileBtn').innerHTML=icon('user',22); $('profileBtn').onclick=()=>show('Profile');
  $('refreshBtn').innerHTML=icon('refresh',22);
  $('chatBack').innerHTML=icon('back',26);
  $('ngBack').innerHTML=icon('back',26);
  $('btnVoice').innerHTML=icon('phone',22);
  $('btnVideo').innerHTML=icon('video',22);
  $('btnChatSearch').innerHTML=icon('search',22);
  $('csPrev').innerHTML=icon('back',20);
  $('csNext').innerHTML=icon('back',20);
  $('giBack').innerHTML=icon('back',26);
  $('amBack').innerHTML=icon('back',26);
  $('chatAtt').innerHTML=icon('attach',24);
  $('chatSend').innerHTML=icon('send',20);
  $('chatMic').innerHTML=icon('mic',24);
  $('recCancel').innerHTML=icon('trash',22);
  $('recSend').innerHTML=icon('send',20);
}
let globalMuted=true;
function applyMute(){
  document.querySelectorAll('.feedvid,.reelvid').forEach(v=>{v.muted=globalMuted;});
  document.querySelectorAll('.mutebtn').forEach(b=>{b.innerHTML=icon(globalMuted?'volumeOff':'volumeOn',20);});
}
function toggleMuteFor(v){globalMuted=!globalMuted;applyMute();if(!globalMuted&&v){v.muted=false;if(v.paused)v.play().catch(()=>{});}muteBurst(v);}
/* IntersectionObserver marks a video active/inactive via dataset.active;
   `.play()` right when a video scrolls into view can silently fail if not
   enough data is buffered yet (rejected promise, swallowed by .catch()) -
   this retries once the browser actually reports it's ready to play. */
function tryAutoplay(v){ if(v.dataset.active==='1') v.play().catch(()=>{}); }
/* Belt-and-suspenders: some browsers/devices still refuse a muted autoplay
   call issued with no user interaction at all yet, even though the spec
   allows it. The very first tap/scroll anywhere in the app "kicks" every
   video that's supposed to be playing (dataset.active='1') but isn't. */
function kickActiveVideos(){ document.querySelectorAll('video[data-active="1"]').forEach(v=>{ if(v.paused) v.play().catch(()=>{}); }); }
document.addEventListener('touchstart',kickActiveVideos,{passive:true});
document.addEventListener('pointerdown',kickActiveVideos,{passive:true});
document.addEventListener('scroll',kickActiveVideos,{passive:true,capture:true});
function muteBurst(tgt){
  if(!tgt)return; const r=tgt.getBoundingClientRect();
  const el=document.createElement('div'); el.className='mutepop'; el.innerHTML=icon(globalMuted?'volumeOff':'volumeOn',44);
  el.style.left=(r.left+r.width/2)+'px'; el.style.top=(r.top+r.height/2)+'px';
  document.body.appendChild(el); setTimeout(()=>el.remove(),720);
}

/* ================= AUTH UI ================= */
let signupMode=false, pickedAvatar=null;
function setAuthMode(su){
  signupMode=su;
  $('signupExtra').style.display=su?'block':'none';
  $('authSub').textContent=su?'Create your account':'Sign in to continue';
  $('authBtn').textContent=su?'Sign Up':'Log In';
  $('authSwitch').innerHTML=su?'Have an account? <b>Log in</b>':'New here? <b>Create account</b>';
  $('forgotLink').style.display=su?'none':'block';
  $('authErr').textContent='';
}
$('authSwitch').onclick=()=>setAuthMode(!signupMode);
$('forgotLink').onclick=doForgot;
let fgTimer=null, fgCooling=false;
function startForgotCooldown(secs){
  let t=secs; fgCooling=true;
  clearInterval(fgTimer);
  const tick=()=>{
    const link=$('forgotLink');
    if(t<=0){clearInterval(fgTimer);fgCooling=false;link.innerHTML='<b>Forgot password?</b>';link.style.opacity='1';return;}
    link.textContent='Resend in '+t+'s'; link.style.opacity='.6'; t--;
  };
  tick(); fgTimer=setInterval(tick,1000);
}
async function doForgot(){
  if(fgCooling)return;
  const email=$('auEmail').value.trim();
  $('authErr').textContent='';
  if(!email){$('authErr').textContent='Type your email above first, then tap this.';return;}
  try{
    const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});
    if(error) throw error;
    toast('If that email has an account, a reset link is on the way — check inbox & spam');
    startForgotCooldown(30);
  }catch(e){$('authErr').textContent='Could not send reset email';}
}
$('avpick').onclick=()=>$('avFile').click();
$('avFile').onchange=e=>{const f=e.target.files[0];if(!f)return;pickedAvatar=f;$('avpick').innerHTML=`<img src="${URL.createObjectURL(f)}">`;};
$('authBtn').onclick=doAuth;
$('auPass').addEventListener('keydown',e=>{if(e.key==='Enter')doAuth();});

async function loadMyProfile(userId,email){
  try{
    const {data,error}=await sb.from('profiles').select('*').eq('id',userId).single();
    if(error||!data) return null;
    myProfile={...data,email};
    return myProfile;
  }catch(e){ return null; }
}

async function doAuth(){
  const email=$('auEmail').value.trim(), pass=$('auPass').value;
  $('authErr').textContent='';
  if(!email||!pass){$('authErr').textContent='Email and password required';return;}
  if(signupMode&&pass.length<8){$('authErr').textContent='Password must be at least 8 characters';return;}
  $('authBtn').textContent='…';$('authBtn').disabled=true;
  try{
    if(signupMode){
      const username=$('suUser').value.trim().toLowerCase().replace(/\s+/g,'');
      if(!username){throw new Error('Pick a username');}
      const name=$('suName').value.trim()||username;
      const {data,error}=await sb.auth.signUp({email,password:pass,options:{data:{username,name},emailRedirectTo:location.origin+location.pathname}});
      if(error) throw error;
      if(!data.session){
        $('authErr').textContent='Account created — check your email to confirm, then log in.';
        setAuthMode(false);
        $('authBtn').disabled=false;$('authBtn').textContent='Log In';
        return;
      }
      await loadMyProfile(data.user.id,data.user.email);
      if(pickedAvatar){
        try{
          const cf=await compressImage(pickedAvatar,512,0.85);
          const url=await uploadFile('avatars',me().id+'/'+randPath()+'.jpg',cf);
          const {data:upd}=await sb.from('profiles').update({avatar_url:url}).eq('id',me().id).select().single();
          if(upd) myProfile={...myProfile,...upd};
        }catch(e){}
      }
    } else {
      const {data,error}=await sb.auth.signInWithPassword({email,password:pass});
      if(error) throw error;
      const ok=await loadMyProfile(data.user.id,data.user.email);
      if(!ok) throw new Error('Could not load your profile');
    }
    enterApp();
  }catch(err){
    $('authErr').textContent=authError(err);
  }finally{$('authBtn').disabled=false;$('authBtn').textContent=signupMode?'Sign Up':'Log In';}
}
function authError(err){
  const msg=(err&&err.message)||'Auth failed';
  if(/already registered|already exists|duplicate|Database error saving new user/i.test(msg)) return 'That email or username may already be registered — tap "Log in", or pick a different username.';
  return msg;
}

/* ================= APP NAV ================= */
let currentScreen='Feed', currentProfile=null, subbed=false;
function enterApp(){
  $('auth').style.display='none';
  $('app').style.display='flex';
  applyStaticIcons();
  $('navAv').outerHTML=avatarHtml(me(),26,'nav-av').replace('class="av','id="navAv" class="av');
  if(!subbed){subscribeRealtime();subscribeCalls();subscribeGroupSig();subscribeGroupCalls();subscribePollVotes();subbed=true;}
  refreshUnread(); startHeartbeat(); refreshNotif(); initPush(); loadMyGroups(); loadBlocks(); loadCloseFriends(); loadFollowing();
  show('Feed');
  rearm();
  handleDeepLinkHash();
}
/* Runs once at boot (above) AND on hashchange below - a notification's
   Answer action navigates an already-open-but-backgrounded tab's hash
   rather than reloading it, so parsing this only at startup would miss it. */
function handleDeepLinkHash(){
  try{
    const h=location.hash||'';
    const aa=h.match(/autoanswer=([A-Za-z0-9-]+)/);
    const gm=h.match(/gcall=([A-Za-z0-9-]+)/);
    const cm=h.match(/call=([A-Za-z0-9-]+)/);
    const um=h.match(/[#&]u=([^&]+)/);
    if(aa){ history.replaceState(null,'',location.pathname); autoAnswerCall(aa[1]); }
    else if(gm){ history.replaceState(null,'',location.pathname); openGroupCallFromGroup(gm[1]); }
    else if(cm){ history.replaceState(null,'',location.pathname); openCallFromId(cm[1]); }
    else if(um){ history.replaceState(null,'',location.pathname); const name=decodeURIComponent(um[1]); setTimeout(()=>openProfileByUsername(name),300); }
  }catch(_){}
}
window.addEventListener('hashchange',()=>{ if(me())handleDeepLinkHash(); });
let swReg=null;
function urlB64ToUint8(b64){ const pad='='.repeat((4-b64.length%4)%4); const s=(b64+pad).replace(/-/g,'+').replace(/_/g,'/'); const raw=atob(s); const arr=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++)arr[i]=raw.charCodeAt(i); return arr; }
async function initPush(){
  if(!('serviceWorker' in navigator)||!('PushManager' in window))return;
  try{ swReg=await navigator.serviceWorker.register('/sw.js'); }catch(e){ return; }
  if(Notification.permission==='granted'){ subscribePush(false); return; }
  /* 'default' = never asked (or dismissed without an explicit block), so ask
     on every app open. Once the user has actually chosen 'denied', browsers
     resolve this instantly with no dialog - so it's safe to call every time
     without re-annoying anyone who already said no. */
  if(Notification.permission==='default'){
    try{ if(await Notification.requestPermission()==='granted') subscribePush(false); }catch(_){}
  }
}
async function enablePush(){
  if(!('serviceWorker' in navigator)||!('PushManager' in window)){ toast('Push not supported here'); return; }
  if(!VAPID_PUBLIC||VAPID_PUBLIC.indexOf('REPLACE')===0){ toast('Set your VAPID public key in the code first'); return; }
  try{
    if(!swReg)swReg=await navigator.serviceWorker.register('/sw.js');
    const perm=await Notification.requestPermission();
    if(perm!=='granted'){ toast('Notifications are blocked'); return; }
    await subscribePush(true);
  }catch(e){ toast('Enable failed: '+(e&&e.message||e)); }
}
async function subscribePush(announce){
  try{
    if(!swReg)swReg=await navigator.serviceWorker.ready;
    let sub=await swReg.pushManager.getSubscription();
    if(sub){
      /* A subscription is permanently tied to the VAPID public key it was
         created with. If that key ever changes (key lost/rotated), the old
         subscription silently fails forever unless we detect the mismatch
         and re-subscribe under the current key. */
      try{
        const cur=new Uint8Array(sub.options.applicationServerKey);
        const want=urlB64ToUint8(VAPID_PUBLIC);
        if(cur.length!==want.length||!cur.every((b,i)=>b===want[i])){ await sub.unsubscribe(); sub=null; }
      }catch(_){}
    }
    if(!sub) sub=await swReg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlB64ToUint8(VAPID_PUBLIC)});
    const row={user_id:me().id,endpoint:sub.endpoint,sub:sub.toJSON()};
    const {data:ex}=await sb.from('push_subs').select('id').eq('endpoint',sub.endpoint).maybeSingle();
    if(ex) await sb.from('push_subs').update(row).eq('id',ex.id);
    else await sb.from('push_subs').insert(row);
    if(announce)toast('Notifications enabled');
  }catch(e){ if(announce)toast('Subscribe failed: '+sbErr(e)); }
}
function show(s){
  /* Switching screens only toggles CSS (display:none on the old one) - a
     hidden <video> keeps playing (audio included) until the
     IntersectionObserver/scroll-settle logic eventually notices it's no
     longer visible, which isn't instant. Pause everything synchronously
     right here so there's never a window where two videos' audio overlaps. */
  document.querySelectorAll('.feedvid,.reelvid').forEach(v=>{ try{v.pause();}catch(_){} v.dataset.active='0'; });
  reelActiveVideo=null;
  currentScreen=s;
  ['Feed','Search','Create','Reels','Chats','Profile'].forEach(x=>$('s'+x).classList.toggle('on',x===s));
  document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.s===s));
  $('main').classList.toggle('reels',s==='Reels');
  /* All screens share one scrollable #main. A scroll position left over from
     whatever screen you were just on (e.g. deep in the Feed) doesn't reset
     itself - the browser only clamps it to the new (often much shorter)
     content's max scrollTop, which usually isn't 0. settleReel() then
     measures "closest reel to viewport center" against that leftover
     offset and can pick the wrong reel entirely, out of sync with whatever
     actually rendered at the top. Reset it explicitly so every screen
     always starts from a known, correct position. */
  $('main').scrollTop=0;
  if(s==='Feed')loadFeed();
  if(s==='Reels')loadReels(true);
  if(s==='Chats')loadChats();
  if(s==='Profile')loadProfile(me().id);
  if(s==='Search'){$('searchInput').focus();runSearch($('searchInput').value.trim());}
}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>show(b.dataset.s));
$('refreshBtn').onclick=()=>show(currentScreen);

/* ================= FEED ================= */
const likeState={};   // postId -> {count, myLikeId|null}
const saveState={};   // postId -> saveId|null
const viewedPosts=new Set();   // session de-dupe for view registration
let blockedIds=new Set();      // ids I have blocked
let blockMap={};               // blockedId -> block record id (for unblock)
let followingIds=new Set();    // ids I follow - drives the "liked by people you follow" line
let socialProof={};            // postId -> usernames of followers-of-mine who liked it
async function loadFollowing(){
  try{
    const {data,error}=await sb.from('follows').select('following_id').eq('follower_id',me().id);
    if(error) throw error;
    followingIds=new Set((data||[]).map(f=>f.following_id));
  }catch(e){ followingIds=new Set(); }
}
/* Social proof: "Liked by someone you actually follow" is a far stronger
   signal than a raw like count, and it's all already in follows+likes -
   one batched profile lookup per page for the names. */
async function loadSocialProof(posts,likes){
  (posts||[]).forEach(p=>{delete socialProof[p.id];});
  if(!followingIds.size)return;
  const byPost={}, need=new Set();
  (posts||[]).forEach(p=>{
    const ids=(likes||[]).filter(l=>l.post_id===p.id&&l.user_id!==me().id&&followingIds.has(l.user_id)).map(l=>l.user_id);
    if(ids.length){ byPost[p.id]=ids; ids.forEach(i=>need.add(i)); }
  });
  if(!need.size)return;
  try{
    const {data}=await sb.from('profiles').select('id,username').in('id',[...need]);
    const names={}; (data||[]).forEach(u=>names[u.id]=u.username);
    Object.keys(byPost).forEach(pid=>{ const l=byPost[pid].map(i=>names[i]).filter(Boolean); if(l.length)socialProof[pid]=l; });
  }catch(e){}
}
function socialProofHtml(pid){
  const n=socialProof[pid]; if(!n||!n.length)return '';
  const first=`<b>${esc(n[0])}</b>`;
  if(n.length===1)return `<div class="sproof">Liked by ${first}</div>`;
  return `<div class="sproof">Liked by ${first} and ${n.length-1} other${n.length-1===1?'':'s'} you follow</div>`;
}
function skBlock(w,h,r,extra){let s='width:'+w+';border-radius:'+(r==null?'8px':r);if(h)s+=';height:'+h;if(extra)s+=';'+extra;return '<div class="sk" style="'+s+'"></div>';}
function skPost(){return `<div class="post"><div class="phead">${skBlock('34px','34px','50%')}<div style="margin-left:10px">${skBlock('120px','12px')}</div></div>${skBlock('100%','','0','aspect-ratio:1/1')}<div class="pacts">${skBlock('26px','26px','50%')}${skBlock('26px','26px','50%')}${skBlock('26px','26px','50%')}</div><div class="pmeta">${skBlock('100px','12px','6px','margin-bottom:8px')}${skBlock('85%','10px','5px','margin-bottom:6px')}${skBlock('55%','10px','5px')}</div></div>`;}
function skFeed(n){return Array.from({length:n||3},skPost).join('');}
function skGrid(n){return '<div class="grid">'+Array.from({length:n||9},()=>skBlock('100%','','0','aspect-ratio:1/1')).join('')+'</div>';}
function skRows(n){return Array.from({length:n||7},()=>`<div class="row">${skBlock('44px','44px','50%')}<div class="last" style="flex:1;margin-left:12px">${skBlock('40%','12px','6px','margin-bottom:8px')}${skBlock('65%','10px','5px')}</div></div>`).join('');}
function skChat(){return Array.from({length:7},(_,i)=>`<div class="bub ${i%2?'me':'them'}" style="background:var(--soft)">${skBlock((90+(i*53)%120)+'px','12px','6px')}</div>`).join('');}
function skProfile(){return `<div class="prof"><div class="phdr">${skBlock('76px','76px','50%')}<div class="pstats" style="align-items:center">${skBlock('40px','30px','8px')}${skBlock('40px','30px','8px')}${skBlock('40px','30px','8px')}</div></div>${skBlock('140px','14px','7px','margin:12px 0 8px')}${skBlock('70%','11px','5px','margin-bottom:14px')}`+skGrid(9)+'</div>';}
function skReel(){return `<div class="reel">${skBlock('100%','100%','0')}</div>`;}
function skStories(n){return Array.from({length:n||5},()=>`<div class="scell">${skBlock('58px','58px','50%')}${skBlock('44px','10px','5px','margin-top:6px')}</div>`).join('');}
async function loadFeed(){
  const box=$('sFeed');
  box.innerHTML=`<div class="stray" id="storyTray"></div><div class="ftabs" id="ftabs"></div><div id="feedPosts"></div>`;
  renderFeedTabs(); loadStories(); loadFeedPosts(true);
}
let feedPage=1, feedLoading=false, feedDone=false, feedFollowIds=null, feedToken=0, feedMoreObs=null;
let feedCursor=null; // {score,created_at,id} keyset cursor for the "For You" ranked feed
async function loadFeedPosts(reset){
  const box=$('feedPosts'); if(!box)return;
  if(!reset && (feedLoading||feedDone)) return;
  if(reset){ feedPage=1; feedDone=false; feedFollowIds=null; feedCursor=null; feedToken++; feedActiveVideo=null; clearTimeout(feedScrollT); box.innerHTML=skFeed(3); }
  const myTok=feedToken; feedLoading=true;
  try{
    let posts=[], count=null;
    if(feedMode==='following'){
      if(reset){
        let ids=[];
        try{ const {data}=await sb.from('follows').select('following_id').eq('follower_id',me().id); ids=(data||[]).map(f=>f.following_id); }catch(e){}
        ids.push(me().id); feedFollowIds=ids;
      }
      if(myTok!==feedToken){feedLoading=false;return;}
      const from=(feedPage-1)*9, to=feedPage*9-1;
      let q=sb.from('posts').select('*, author:author_id(id,username,name,avatar_url,is_verified)',{count:'exact'}).order('created_at',{ascending:false}).range(from,to);
      if(feedFollowIds) q=q.in('author_id',feedFollowIds);
      const {data:items,count:c,error}=await q;
      if(error) throw error;
      posts=items||[]; count=c;
    }else{
      /* "For You": relevance-ranked (author/topic affinity + popularity +
         recency - see supabase/migrations/20260912000001_feed_ranking.sql
         for the full formula) instead of plain reverse-chronological.
         Keyset-paginated since ranked scores can shift between page loads
         as new engagement comes in, unlike a stable created_at ordering
         where plain offset paging works fine. */
      const {data:items,error}=await sb.rpc('get_feed_for_you',{
        cursor_score: feedCursor&&feedCursor.score,
        cursor_created_at: feedCursor&&feedCursor.created_at,
        cursor_id: feedCursor&&feedCursor.id,
        page_size: 9
      });
      if(error) throw error;
      posts=items||[];
      if(posts.length){
        const last=posts[posts.length-1];
        feedCursor={score:last.score,created_at:last.created_at,id:last.id};
        const authorIds=[...new Set(posts.map(p=>p.author_id))];
        const {data:authors}=await sb.from('profiles').select('id,username,name,avatar_url,is_verified').in('id',authorIds);
        const aMap={}; (authors||[]).forEach(a=>aMap[a.id]=a);
        posts.forEach(p=>p.author=aMap[p.author_id]);
      }
      if(posts.length<9) feedDone=true;
    }
    if(myTok!==feedToken){feedLoading=false;return;}
    posts=posts.filter(p=>!blockedIds.has(p.author_id));
    if(reset) box.innerHTML='';
    if(feedPage===1 && !posts.length){ box.innerHTML='<div class="empty">'+(feedMode==='following'?'No posts from people you follow yet.':'No posts yet.<br>Create your first post!')+'</div>'; feedDone=true; feedLoading=false; return; }
    if(posts.length){
      const pids=posts.map(p=>p.id);
      let likes=[],comments=[],saves=[];
      try{ const {data}=await sb.from('likes').select('*').in('post_id',pids); likes=data||[]; }catch(e){ console.warn('likes read failed:',sbErr(e)); }
      try{ const {data}=await sb.from('comments').select('*, user:user_id(id,username,name,avatar_url)').in('post_id',pids).order('created_at'); comments=data||[]; }catch(e){ console.warn('comments read failed:',sbErr(e)); }
      try{ const {data}=await sb.from('saves').select('*').in('post_id',pids).eq('user_id',me().id); saves=data||[]; }catch(e){ console.warn('saves read failed:',sbErr(e)); }
      if(myTok!==feedToken){feedLoading=false;return;}
      await loadCommentLikes(comments);
      await loadPollVotes(posts);
      if(myTok!==feedToken){feedLoading=false;return;}
      const cByPost={}; comments.forEach(c=>{(cByPost[c.post_id]=cByPost[c.post_id]||[]).push(c);});
      posts.forEach(p=>{setLikeState(p.id,likes.filter(l=>l.post_id===p.id)); saveState[p.id]=(saves.find(s=>s.post_id===p.id)||{}).id||null;});
      await loadSocialProof(posts,likes);
      if(myTok!==feedToken){feedLoading=false;return;}
      box.insertAdjacentHTML('beforeend',posts.map(p=>renderPost(p,cByPost[p.id]||[])).join(''));
      setupFeedAutoplay();
      setupViewObs();
    }
    feedPage++;
    if(feedMode==='following'&&(!count || feedPage>Math.ceil(count/9))) feedDone=true;
    armFeedPrefetch();
  }catch(e){ if(reset)box.innerHTML='<div class="empty">Could not load feed.<br>'+esc(sbErr(e))+'</div>'; }
  feedLoading=false;
}
function armFeedPrefetch(){
  if(feedMoreObs){ feedMoreObs.disconnect(); feedMoreObs=null; }
  if(feedDone) return;
  const posts=document.querySelectorAll('#feedPosts .post');
  if(!posts.length) return;
  const target=posts[Math.max(0,posts.length-4)];
  feedMoreObs=new IntersectionObserver(es=>{
    for(const en of es){ if(en.isIntersecting){ feedMoreObs.disconnect(); feedMoreObs=null; loadFeedPosts(false); break; } }
  },{root:$('main'),rootMargin:'1200px 0px'});
  feedMoreObs.observe(target);
}
function renderFeedTabs(){const t=$('ftabs');if(!t)return;t.innerHTML=`<button class="${feedMode==='all'?'on':''}" onclick="setFeedMode('all')">For You</button><button class="${feedMode==='following'?'on':''}" onclick="setFeedMode('following')">Following</button>`;}
function setFeedMode(m){feedMode=m;renderFeedTabs();loadFeedPosts(true);}
$('main').addEventListener('scroll',()=>{ const m=$('main'); if(currentScreen==='Feed'){ onFeedScroll(); if(m.scrollTop+m.clientHeight>=m.scrollHeight-1800) loadFeedPosts(false); } else if(currentScreen==='Reels'){ onReelsScroll(); if(m.scrollTop+m.clientHeight>=m.scrollHeight-1400) loadReels(false); } });
function applyVideoCrop(video,crop){
  if(!crop)return;
  const nw=video.videoWidth,nh=video.videoHeight; if(!nw||!nh)return;
  const box=video.parentElement, W=box.clientWidth||1, H=box.clientHeight||W;
  /* "Contain", not "cover" - matches makeVideoFramer()'s base scale so the
     unzoomed (zoom=1) default replayed here shows the whole frame instead
     of cropping it to fill the square. */
  const scale=Math.min(W/nw,H/nh)*(crop.zoom||1);
  const cx=(crop.fx||0.5)*nw, cy=(crop.fy||0.5)*nh;
  video.style.position='absolute';
  video.style.width=(nw*scale)+'px'; video.style.height=(nh*scale)+'px';
  video.style.left=(W/2-cx*scale)+'px'; video.style.top=(H/2-cy*scale)+'px';
}
function postMedia(p){
  if(p.video_url){
    const cropAttr=p.video_crop?` data-crop='${esc(JSON.stringify(p.video_crop))}' onloadedmetadata="applyVideoCrop(this,JSON.parse(this.dataset.crop))"`:'';
    return `<div class="vidwrap"><video class="pimg feedvid" onclick="mediaTap(event,'${p.id}','feedvid')" src="${p.video_url}#t=0.1" ${p.thumb_url?`poster="${p.thumb_url}"`:''} muted loop playsinline preload="metadata" oncanplay="tryAutoplay(this)"${cropAttr}></video><button class="mutebtn" onclick="toggleMuteFor(this.parentNode.querySelector('video'))">${icon('volumeOff',20)}</button></div>`;
  }
  if(Array.isArray(p.photos)&&p.photos.length>1){
    const slides=p.photos.map(url=>`<img class="cslide blur-load" loading="lazy" decoding="async" src="${url}" onload="this.classList.add('loaded')" onclick="mediaTap(event,'${p.id}','feed')">`).join('');
    const dots=p.photos.map((_,i)=>`<span class="${i===0?'on':''}"></span>`).join('');
    return `<div class="carousel"><div class="cartrack" id="cart_${p.id}" onscroll="carScroll(this,'${p.id}',${p.photos.length})">${slides}</div><div class="ccount" id="ccount_${p.id}">1/${p.photos.length}</div><div class="cdots" id="cdots_${p.id}">${dots}</div></div>`;
  }
  return `<img class="pimg blur-load" loading="lazy" decoding="async" src="${p.image_url||''}" onload="this.classList.add('loaded')" onclick="mediaTap(event,'${p.id}','feed')">`;
}
let carScrollT={};
function carScroll(track,pid,n){
  clearTimeout(carScrollT[pid]);
  carScrollT[pid]=setTimeout(()=>{
    const idx=Math.max(0,Math.min(n-1,Math.round(track.scrollLeft/track.clientWidth)));
    const dots=document.getElementById('cdots_'+pid); if(dots)[...dots.children].forEach((d,i)=>d.classList.toggle('on',i===idx));
    const c=document.getElementById('ccount_'+pid); if(c)c.textContent=(idx+1)+'/'+n;
  },60);
}
function renderPost(p,cmts,full){
  const a=p.author||{username:'user',id:p.author_id};
  postCaption[p.id]=p.caption||'';
  postAuthor[p.id]=a.id||p.author_id;
  postVideo[p.id]=!!p.video_url;
  const st=likeState[p.id]||{count:0,myLikeId:null};
  const liked=!!st.myLikeId;
  const saved=!!saveState[p.id];
  const cap=p.caption?`<div class="cap"><b>${esc(a.username)}</b>${esc(p.caption)}</div>`:'';
  const tree=buildCommentTree(cmts);
  const rootsShown=full?tree.roots:tree.roots.slice(-2);
  const shown=rootsShown.map(r=>commentBlock(r,tree.childrenOf[r.id]||[],full,p.id)).join('');
  const more=(!full&&cmts.length>rootsShown.length)?`<div class="viewall" onclick="openPostView('${p.id}')" style="cursor:pointer;color:var(--mut);margin-bottom:2px">View all ${cmts.length} comments</div>`:'';
  return `<div class="post" id="post_${p.id}" data-pid="${p.id}">
    <div class="phead">${avatarHtml(a,34)}<div><div class="nm" onclick="openProfile('${a.id}')" style="cursor:pointer">${esc(a.username)}${vbadge(a)}</div>${p.audience==='close'?`<div class="cfbadge">${icon('group',11)} Close Friends</div>`:''}</div>
      <div style="margin-left:auto;color:var(--mut);font-size:12px">${timeAgo(p.created_at)}</div>
      ${a.id===me().id?`<button class="pmore" onclick="openPostMenu('${p.id}')">${icon('more',20)}</button>`:`<button class="pmore" onclick="openOtherPostMenu('${p.id}','${a.id}','${esc(a.username)}')">${icon('more',20)}</button>`}</div>
    ${p.poll?pollBlock(p):postMedia(p)}
    <div class="pacts"><span class="like ${liked?'liked':''}" onclick="toggleLike('${p.id}')">${likeBtnHtml(p.id)}</span><span onclick="$('ci_${p.id}').focus()">${icon('comment',26)}</span><span onclick="openShare('${p.id}')">${icon('send',26)}</span><span class="bm ${saved?'saved':''}" id="bm_${p.id}" onclick="toggleSave('${p.id}')">${icon('bookmark',26,{fill:saved?'currentColor':'none'})}</span></div>
    <div class="pmeta"><div class="rchips prchips" id="rx_${p.id}">${postReactChips(p.id)}</div><div class="likes" id="lc_${p.id}">${st.count} like${st.count===1?'':'s'}</div>${socialProofHtml(p.id)}${cap}${tagsHtml(p.tags)}<div class="vcount" data-pid="${p.id}"></div></div>
    <div class="cmts" id="cl_${p.id}">${more}${shown}</div>
    <div class="cadd"><input id="ci_${p.id}" placeholder="Add a comment…"><button onclick="addComment('${p.id}')">Post</button></div>
  </div>`;
}
/* One place that turns raw `likes` rows into the shape the UI reads, so
   the feed, reels and post-view load paths can't drift apart. A row with
   no reaction is a plain heart ('love'), which is what every like was
   before reactions existed. */
function setLikeState(pid,rows){
  rows=rows||[];
  const mine=rows.find(l=>l.user_id===me().id);
  const counts={};
  rows.forEach(l=>{const k=l.reaction||'love';counts[k]=(counts[k]||0)+1;});
  likeState[pid]={count:rows.length,myLikeId:mine?mine.id:null,myReaction:mine?(mine.reaction||'love'):null,counts};
  return likeState[pid];
}
function bumpReact(pid,key,delta){
  if(!key)return;
  const st=likeState[pid]; if(!st)return;
  st.counts=st.counts||{};
  st.counts[key]=Math.max(0,(st.counts[key]||0)+delta);
  if(!st.counts[key])delete st.counts[key];
}
function likeBtnHtml(pid){
  const st=likeState[pid]||{};
  if(st.myLikeId&&st.myReaction&&st.myReaction!=='love')return reactIcon(st.myReaction,26);
  return icon('heart',26,{fill:st.myLikeId?'currentColor':'none'});
}
function postReactChips(pid){
  const st=likeState[pid]||{}; const counts=st.counts||{};
  const keys=REACT_ORDER.filter(k=>counts[k]);
  if(!keys.length)return '';
  return keys.map(k=>`<span class="rchip ${st.myReaction===k?'mine':''}" onclick="reactPost('${pid}','${k}')">${reactIcon(k,14)}${counts[k]>1?`<i>${counts[k]}</i>`:''}</span>`).join('');
}
async function toggleLike(pid){
  if(likeLPFired){likeLPFired=false;return;}   // the long-press already opened the picker
  const st=likeState[pid]; if(!st)return;
  try{
    if(st.myLikeId){const id=st.myLikeId;bumpReact(pid,st.myReaction,-1);st.myLikeId=null;st.myReaction=null;st.count--;updLike(pid);if(id!=='tmp')await sb.from('likes').delete().eq('id',id);}
    else{st.myLikeId='tmp';st.myReaction='love';st.count++;bumpReact(pid,'love',1);updLike(pid);const {data:r}=await sb.from('likes').insert({post_id:pid,user_id:me().id,reaction:'love'}).select().single();st.myLikeId=r.id;notify('like',postAuthor[pid],{post_id:pid});}
  }catch(e){toast('Like failed');loadFeed();}
}
/* Long-press the like button to pick one of the six reactions DMs already
   use. Replacing an existing reaction is an UPDATE, not delete+insert, so
   the row keeps its id and created_at (the ranking functions read
   likes.created_at for recency-weighted affinity). */
async function reactPost(pid,key){
  const st=likeState[pid]||setLikeState(pid,[]);
  const prev={count:st.count,myLikeId:st.myLikeId,myReaction:st.myReaction,counts:{...(st.counts||{})}};
  try{
    if(st.myReaction===key){           // tapping your current reaction clears it
      const id=st.myLikeId;
      bumpReact(pid,key,-1); st.myLikeId=null; st.myReaction=null; st.count--;
      updLike(pid);
      if(id&&id!=='tmp')await sb.from('likes').delete().eq('id',id);
      return;
    }
    if(st.myLikeId){
      const id=st.myLikeId;
      bumpReact(pid,st.myReaction,-1); bumpReact(pid,key,1); st.myReaction=key;
      updLike(pid);
      if(id!=='tmp')await sb.from('likes').update({reaction:key}).eq('id',id);
    }else{
      st.myLikeId='tmp'; st.myReaction=key; st.count++; bumpReact(pid,key,1);
      updLike(pid);
      const {data:r}=await sb.from('likes').insert({post_id:pid,user_id:me().id,reaction:key}).select().single();
      st.myLikeId=r.id;
      notify('like',postAuthor[pid],{post_id:pid});
    }
  }catch(e){ likeState[pid]=prev; updLike(pid); toast('Reaction failed: '+sbErr(e)); }
}
function updLike(pid){
  const st=likeState[pid]||{count:0,myLikeId:null};
  const el=document.querySelector('#post_'+pid+' .like');
  if(el){el.innerHTML=likeBtnHtml(pid);el.classList.toggle('liked',!!st.myLikeId);}
  const lc=$('lc_'+pid); if(lc)lc.textContent=st.count+' like'+(st.count===1?'':'s');
  const ch=$('rx_'+pid); if(ch)ch.innerHTML=postReactChips(pid);
}
let _tap={id:null,t:0,timer:null};
function mediaTap(e,pid,kind){
  const tgt=e.currentTarget, now=Date.now();
  if(_tap.id===pid && now-_tap.t<300){
    if(_tap.timer){clearTimeout(_tap.timer);_tap.timer=null;}
    _tap.t=0; _tap.id=null;
    likeOn(pid); heartBurst(tgt);
  } else {
    _tap.id=pid; _tap.t=now;
    if(_tap.timer)clearTimeout(_tap.timer);
    if(kind==='reel'){ _tap.timer=setTimeout(()=>{ _tap.timer=null; toggleMuteFor(tgt); },280); }
    else if(kind==='feedvid'){ const ct=tgt.currentTime||0; _tap.timer=setTimeout(()=>{ _tap.timer=null; openReelAt(pid,ct); },280); }
  }
}
async function likeOn(pid){
  const st=likeState[pid]||setLikeState(pid,[]); likeState[pid]=st;
  if(st.myLikeId)return;               // already liked: keep it, just show the heart
  st.myLikeId='tmp'; st.myReaction='love'; st.count++; bumpReact(pid,'love',1);
  if(document.querySelector('#post_'+pid+' .like'))updLike(pid);
  const rc=$('rlc_'+pid); if(rc){rc.textContent=st.count;const rb=rc.closest('.ract');if(rb){rb.classList.add('liked');const svg=rb.querySelector('svg');if(svg)svg.setAttribute('fill','currentColor');}}
  try{ const {data:r}=await sb.from('likes').insert({post_id:pid,user_id:me().id,reaction:'love'}).select().single(); st.myLikeId=r.id; notify('like',postAuthor[pid],{post_id:pid}); }
  catch(e){ st.myLikeId=null; st.myReaction=null; st.count=Math.max(0,st.count-1); bumpReact(pid,'love',-1); if(document.querySelector('#post_'+pid+' .like'))updLike(pid); if(rc)rc.textContent=st.count; }
}
function heartBurst(tgt){
  if(!tgt)return; const r=tgt.getBoundingClientRect();
  const h=document.createElement('div'); h.className='heartpop'; h.innerHTML=icon('heart',96,{fill:'currentColor'});
  h.style.left=(r.left+r.width/2)+'px'; h.style.top=(r.top+r.height/2)+'px';
  document.body.appendChild(h); setTimeout(()=>h.remove(),820);
}
async function addComment(pid){
  const inp=$('ci_'+pid); const text=inp.value.trim(); if(!text)return;
  const parent=inp.dataset.parent||''; inp.value=''; delete inp.dataset.parent;
  try{
    const row={post_id:pid,user_id:me().id,text}; if(parent)row.parent_id=parent;
    const {data:r,error}=await sb.from('comments').insert(row).select().single();
    if(error) throw error;
    const full=$('postView').classList.contains('on');
    const rec={id:r.id,user_id:me().id,post_id:pid,text,parent_id:parent||null,user:me()};
    if(parent){
      const rep=document.getElementById('crep_'+parent);
      if(rep){ rep.insertAdjacentHTML('beforeend',commentRow(rec,full,pid,true)); rep.classList.add('open'); rep.style.display='block'; const tog=document.getElementById('reptog_'+parent); if(tog){const n=rep.children.length;tog.style.display='block';tog.textContent='Hide '+(n===1?'reply':'replies');} }
      else { const list=$('cl_'+pid); if(list)list.insertAdjacentHTML('beforeend',commentBlock(rec,[],full,pid)); }
    } else {
      const list=$('cl_'+pid); if(list)list.insertAdjacentHTML('beforeend',commentBlock(rec,[],full,pid));
    }
    if(parent){
      const parentAuthor=commentAuthor[parent];
      if(parentAuthor&&parentAuthor!==postAuthor[pid]) notify('reply',parentAuthor,{post_id:pid,comment_id:parent,text:text.slice(0,80)});
    }
    notify('comment',postAuthor[pid],{post_id:pid,text:text.slice(0,80)});
  }
  catch(e){toast('Comment failed');}
}

/* ============ SAVE / BOOKMARK ============ */
async function toggleSave(pid){
  const cur=saveState[pid];
  const el=$('bm_'+pid);
  try{
    if(cur){ saveState[pid]=null; if(el){el.classList.remove('saved');el.innerHTML=icon('bookmark',26,{fill:'none'});} await sb.from('saves').delete().eq('id',cur); toast('Removed from saved'); }
    else{ saveState[pid]='tmp'; if(el){el.classList.add('saved');el.innerHTML=icon('bookmark',26,{fill:'currentColor'});} const {data:r}=await sb.from('saves').insert({post_id:pid,user_id:me().id}).select().single(); saveState[pid]=r.id; toast('Saved'); }
  }catch(e){ saveState[pid]=cur||null; if(el){el.classList.toggle('saved',!!saveState[pid]);el.innerHTML=icon('bookmark',26,{fill:saveState[pid]?'currentColor':'none'});} toast('Save failed: '+sbErr(e)); }
}
async function openSaved(){
  $('saved').classList.add('on'); rearm();
  const body=$('savedBody');
  body.innerHTML='<div style="padding:30px;text-align:center;color:var(--mut)">Loading...</div>';
  try{
    const {data:rows,error}=await sb.from('saves').select('post_id').eq('user_id',me().id).order('created_at',{ascending:false});
    if(error) throw error;
    if(!rows.length){ body.innerHTML='<div class="empty">No saved posts yet</div>'; return; }
    const posts=[];
    for(const r of rows){ const p=await getPost(r.post_id); if(p) posts.push(p); }
    body.innerHTML=posts.length?`<div class="grid">${posts.map(gridCell).join('')}</div>`:'<div class="empty">No saved posts yet</div>';
  }catch(e){ body.innerHTML='<div class="empty">Could not load saved posts<br><span style="font-size:12px;opacity:.7">'+esc(sbErr(e))+'</span></div>'; }
}
function closeSaved(){ $('saved').classList.remove('on'); }
/* ============ PROFILE QR ============ */
function myProfileLink(){ return location.origin+'/#u='+encodeURIComponent(me().username); }
let qrLibLoading=null;
function loadQRLib(){
  if(window.QRCode)return Promise.resolve();
  if(qrLibLoading)return qrLibLoading;
  qrLibLoading=new Promise((res,rej)=>{ const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; s.onload=res; s.onerror=()=>rej(new Error('Could not load QR library (offline?)')); document.head.appendChild(s); });
  return qrLibLoading;
}
async function openQR(){
  $('qr').classList.add('on'); rearm();
  $('qrName').textContent='@'+me().username;
  const box=$('qrBox'); box.innerHTML='<div style="color:#888;font-size:13px">Loading...</div>';
  try{
    await loadQRLib();
    box.innerHTML='';
    new QRCode(box,{text:myProfileLink(),width:208,height:208,colorDark:'#0b0b12',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
  }catch(e){ box.innerHTML='<div style="color:#b00;font-size:12px;text-align:center;padding:10px">QR unavailable.<br>Use Copy my link below.</div>'; }
}
function closeQR(){ $('qr').classList.remove('on'); }
function shareMyLink(){
  const link=myProfileLink();
  if(navigator.share){ navigator.share({title:'LinkUp',text:'Find me on LinkUp: @'+me().username,url:link}).catch(()=>{}); return; }
  try{ navigator.clipboard.writeText(link); toast('Link copied'); }catch(e){ toast(link); }
}

/* ============ POST VIEWS ============ */
/* One row per (post_id,user_id) is enforced by a unique constraint in the DB,
   so a view can never be double-counted server-side even if this session's
   in-memory viewedPosts set gets reset (app relaunch, browser restart, etc).
   Upsert+ignoreDuplicates just avoids a noisy conflict error on repeats. */
function registerView(pid){ if(!pid||viewedPosts.has(pid))return; viewedPosts.add(pid); sb.from('postviews').upsert({post_id:pid,user_id:me().id},{onConflict:'post_id,user_id',ignoreDuplicates:true}).then(()=>{}).catch(()=>{}); }
async function getViewCount(pid){ try{ const {count}=await sb.from('postviews').select('id',{count:'exact',head:true}).eq('post_id',pid); return count||0; }catch(e){ return null; } }
function fillViews(pid){
  getViewCount(pid).then(n=>{
    if(n===null)return;
    const label=n+' view'+(n===1?'':'s');
    document.querySelectorAll('.vcount[data-pid="'+pid+'"]').forEach(el=>{ el.innerHTML=icon('eye',13)+'<span>'+label+'</span>'; });
    const rv=document.getElementById('rvc_'+pid); if(rv)rv.innerHTML=icon('eye',13)+'<span>'+label+'</span>';
  });
}
let viewObs=null;
function setupViewObs(){
  if(viewObs)viewObs.disconnect();
  viewObs=new IntersectionObserver(es=>es.forEach(en=>{
    if(en.isIntersecting&&en.intersectionRatio>0.55){ const pid=en.target.getAttribute('data-pid'); if(pid){ registerView(pid); fillViews(pid); } viewObs.unobserve(en.target); }
  }),{root:$('main'),threshold:[0,0.55,1]});
  document.querySelectorAll('#feedPosts .post[data-pid]').forEach(el=>viewObs.observe(el));
}

/* ============ CLOSE FRIENDS / AUDIENCE ============ */
let closeFriendIds=new Set(), cfMap={}, postAudience='public';
const pollState={};
async function loadCloseFriends(){
  try{
    const {data:rows,error}=await sb.from('closefriends').select('*').eq('owner_id',me().id);
    if(error) throw error;
    closeFriendIds=new Set(); cfMap={};
    (rows||[]).forEach(r=>{ closeFriendIds.add(r.friend_id); cfMap[r.friend_id]=r.id; });
  }catch(e){ console.warn('closefriends read failed:',sbErr(e)); }
}
async function toggleCloseFriend(uid){
  const on=!closeFriendIds.has(uid);
  try{
    if(on){ const {data:r}=await sb.from('closefriends').insert({owner_id:me().id,friend_id:uid}).select().single(); closeFriendIds.add(uid); cfMap[uid]=r.id; toast('Added to Close Friends'); }
    else { const id=cfMap[uid]; if(id)await sb.from('closefriends').delete().eq('id',id); closeFriendIds.delete(uid); delete cfMap[uid]; toast('Removed from Close Friends'); }
  }catch(e){ toast('Failed: '+sbErr(e)); }
}
function setAudience(a){ postAudience=a; $('audAll').classList.toggle('on',a==='public'); $('audClose').classList.toggle('on',a==='close'); }

/* ============ POLLS ============ */
function seedPoll(p){ if(pollState[p.id])return; const d=p.poll; if(!d)return; pollState[p.id]={q:d.q||'',opts:d.opts||[],counts:(d.opts||[]).map(()=>0),total:0,my:null,voteId:null}; }
function pollBlock(p){ seedPoll(p); return pollHtml(p.id); }
function pollHtml(pid){
  const st=pollState[pid]; if(!st)return '';
  const rows=st.opts.map((o,i)=>{ const c=st.counts[i]||0; const pct=st.total?Math.round(c*100/st.total):0; const mine=st.my===i;
    return `<button class="pollopt ${mine?'mine':''}" onclick="votePoll('${pid}',${i})"><span class="pollbar" style="width:${st.total?pct:0}%"></span><span class="polltext">${esc(o)}${mine?' '+icon('check',14):''}</span><span class="pollpct">${st.total?pct+'%':''}</span></button>`; }).join('');
  return `<div class="pollwrap" id="pollw_${pid}"><div class="pollq">${icon('poll',16)} ${esc(st.q)}</div>${rows}<div class="polltotal">${st.total} vote${st.total===1?'':'s'}</div></div>`;
}
function renderPollDom(pid){ const w=document.getElementById('pollw_'+pid); if(w)w.outerHTML=pollHtml(pid); }
async function votePoll(pid,idx){
  const st=pollState[pid]; if(!st)return; const old=st.my; if(old===idx)return;
  const prev={counts:st.counts.slice(),total:st.total,my:st.my,voteId:st.voteId};
  if(old!=null)st.counts[old]=Math.max(0,(st.counts[old]||0)-1);
  st.counts[idx]=(st.counts[idx]||0)+1; if(old==null)st.total++; st.my=idx; renderPollDom(pid);
  try{
    if(st.voteId){ const {error}=await sb.from('pollvotes').update({choice:idx}).eq('id',st.voteId); if(error)throw error; }
    else { const {data:r,error}=await sb.from('pollvotes').insert({post_id:pid,user_id:me().id,choice:idx}).select().single(); if(error)throw error; st.voteId=r.id; }
  }catch(e){ pollState[pid]=Object.assign(st,prev); renderPollDom(pid); toast('Vote failed: '+sbErr(e)); }
}
async function loadPollVotes(posts){
  const polls=posts.filter(p=>p.poll); if(!polls.length)return;
  polls.forEach(seedPoll);
  const ids=polls.map(p=>p.id);
  let votes=[]; try{ const {data}=await sb.from('pollvotes').select('*').in('post_id',ids); votes=data||[]; }catch(e){ console.warn('pollvotes read failed:',sbErr(e)); }
  polls.forEach(p=>{ const st=pollState[p.id]; if(!st)return; st.counts=st.opts.map(()=>0); st.total=0; st.my=null; st.voteId=null; votes.filter(v=>v.post_id===p.id).forEach(v=>{ const ci=+v.choice; if(ci>=0&&ci<st.counts.length){st.counts[ci]++;st.total++;} if(v.user_id===me().id){st.my=ci;st.voteId=v.id;} }); });
}
async function refreshPoll(pid){
  const st=pollState[pid]; if(!st)return;
  try{ const {data:votes}=await sb.from('pollvotes').select('*').eq('post_id',pid); st.counts=st.opts.map(()=>0); st.total=0; st.my=null; st.voteId=null; (votes||[]).forEach(v=>{ const ci=+v.choice; if(ci>=0&&ci<st.counts.length){st.counts[ci]++;st.total++;} if(v.user_id===me().id){st.my=ci;st.voteId=v.id;} }); renderPollDom(pid); }catch(e){}
}
let pollRefreshT={};
function subscribePollVotes(){
  const bump=payload=>{
    const pid=payload.new&&payload.new.post_id; if(!pid||!pollState[pid])return; if(payload.new.user_id===me().id)return;
    clearTimeout(pollRefreshT[pid]); pollRefreshT[pid]=setTimeout(()=>refreshPoll(pid),400);
  };
  sb.channel('pollvotes-ch')
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'pollvotes'},bump)
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'pollvotes'},bump)
    .subscribe();
}
/* poll composer */
function openPollCompose(){ $('pollCompose').classList.add('on'); rearm(); $('pollQ').value=''; $('pollOpts').innerHTML=''; addPollOpt(); addPollOpt(); }
function closePollCompose(){ $('pollCompose').classList.remove('on'); }
function addPollOpt(){ const box=$('pollOpts'); if(box.children.length>=4){toast('Up to 4 options');return;} const i=box.children.length+1; box.insertAdjacentHTML('beforeend',`<input class="polloptin" maxlength="60" placeholder="Option ${i}" style="width:100%;background:var(--soft);border:1px solid var(--line);border-radius:12px;color:var(--txt);padding:11px;font-size:14px;margin-bottom:8px">`); }
async function submitPoll(){
  const q=$('pollQ').value.trim(); const opts=[...document.querySelectorAll('.polloptin')].map(i=>i.value.trim()).filter(Boolean);
  if(!q){toast('Add a question');return;} if(opts.length<2){toast('Add at least 2 options');return;}
  try{ await sb.from('posts').insert({author_id:me().id,poll:{q,opts},audience:'public'}); toast('Poll posted'); closePollCompose(); show('Feed'); loadFeed(); }
  catch(e){ toast('Poll failed: '+sbErr(e)); }
}

/* ============ BLOCK / REPORT ============ */
async function loadBlocks(){
  try{
    const {data:rows,error}=await sb.from('blocks').select('*').eq('blocker_id',me().id);
    if(error) throw error;
    blockedIds=new Set(); blockMap={};
    (rows||[]).forEach(r=>{ blockedIds.add(r.blocked_id); blockMap[r.blocked_id]=r.id; });
  }catch(e){ console.warn('blocks read failed:',sbErr(e)); }
}
async function blockUser(uid){
  try{ const {data:r}=await sb.from('blocks').insert({blocker_id:me().id,blocked_id:uid}).select().single(); blockedIds.add(uid); blockMap[uid]=r.id; toast('User blocked'); }
  catch(e){ toast('Block failed: '+sbErr(e)); }
}
async function unblockUser(uid){
  const id=blockMap[uid];
  if(!id){ blockedIds.delete(uid); return; }
  try{ await sb.from('blocks').delete().eq('id',id); blockedIds.delete(uid); delete blockMap[uid]; toast('Unblocked'); }
  catch(e){ toast('Unblock failed: '+sbErr(e)); }
}
async function toggleBlock(uid,fromProfile){
  const wasBlocked=blockedIds.has(uid);
  await (wasBlocked?unblockUser(uid):blockUser(uid));
  if(fromProfile&&currentScreen==='Profile')loadProfile(uid);
  else if(currentScreen==='Feed')loadFeedPosts(true);
}
function reportTarget(kind,target){
  openTextEditor('Report '+(kind==='post'?'post':'user'),'',async reason=>{
    try{ await sb.from('reports').insert({reporter_id:me().id,kind:kind,target_id:target,reason:(reason||'').slice(0,500)}); toast('Report submitted. Thank you.'); }
    catch(e){ toast('Report failed: '+sbErr(e)); }
  });
}
function closeActMenu(){ $('actMenuWrap').classList.remove('on'); }
$('actMenuWrap').onclick=e=>{ if(e.target.id==='actMenuWrap')closeActMenu(); };
function openUserMenu(uid){
  const blocked=blockedIds.has(uid); const cf=closeFriendIds.has(uid);
  $('actMenu').innerHTML=
    `<button onclick="closeActMenu();toggleCloseFriend('${uid}')">${cf?'Remove from Close Friends':'Add to Close Friends'}</button>`+
    `<button onclick="closeActMenu();reportTarget('user','${uid}')">Report user</button>`+
    `<button class="danger" onclick="closeActMenu();toggleBlock('${uid}',true)">${blocked?'Unblock user':'Block user'}</button>`+
    `<button onclick="closeActMenu()">Cancel</button>`;
  $('actMenuWrap').classList.add('on');rearm();
}
function openOtherPostMenu(pid,uid,uname){
  const blocked=blockedIds.has(uid);
  $('actMenu').innerHTML=
    `<button onclick="closeActMenu();notInterested('${pid}')">Not interested</button>`+
    `<button onclick="closeActMenu();reportTarget('post','${pid}')">Report post</button>`+
    `<button class="danger" onclick="closeActMenu();toggleBlock('${uid}',false)">${blocked?'Unblock @'+esc(uname):'Block @'+esc(uname)}</button>`+
    `<button onclick="closeActMenu()">Cancel</button>`;
  $('actMenuWrap').classList.add('on');rearm();
}
async function notInterested(pid){
  try{
    const {error}=await sb.rpc('mark_not_interested',{p_post_id:pid});
    if(error) throw error;
    const el=$('post_'+pid); if(el)el.remove();
    if(pvId===pid)closePostView();
    toast("You'll see less like this");
  }catch(e){ toast('Could not update: '+sbErr(e)); }
}

/* ================= REELS ================= */
let reelPage=1, reelLoading=false, reelDone=false, reelTok=0, reelStartId=null, reelSeek=0;
let reelCursor=null; // {score,created_at,id} keyset cursor for the ranked reel feed
function reelHTML(p){
  const a=p.author||{username:'user',id:p.author_id};
  const st=likeState[p.id]||{count:0,myLikeId:null}; const liked=!!st.myLikeId;
  return `<div class="reel" id="reel_${p.id}"><video class="reelvid" onclick="mediaTap(event,'${p.id}','reel')" src="${p.video_url}#t=0.1" ${p.thumb_url?`poster="${p.thumb_url}"`:''} loop muted playsinline preload="metadata" oncanplay="tryAutoplay(this)"></video><button class="mutebtn top" onclick="toggleMuteFor(this.parentNode.querySelector('video'))">${icon('volumeOff',20)}</button><div class="reelacts"><button class="ract like ${liked?'liked':''}" onclick="reelLike('${p.id}',this)">${icon('heart',28,{fill:liked?'currentColor':'none'})}<span class="rc" id="rlc_${p.id}">${st.count}</span></button><button class="ract" onclick="openPostView('${p.id}')">${icon('comment',28)}</button><button class="ract" onclick="openShare('${p.id}')">${icon('send',26)}</button></div><div class="reelinfo"><div class="rrow">${avatarHtml(a,34)}<span class="nm" onclick="openProfile('${a.id}')">${esc(a.username)}</span></div>${p.caption?`<div class="rcap">${esc(p.caption)}</div>`:''}${tagsHtml(p.tags)}<span class="rviews" id="rvc_${p.id}"></span></div></div>`;
}
async function reelPrep(posts){
  const pids=posts.map(p=>p.id);
  let likes=[]; try{const {data}=await sb.from('likes').select('*').in('post_id',pids);likes=data||[];}catch(e){}
  posts.forEach(p=>{setLikeState(p.id,likes.filter(l=>l.post_id===p.id));postAuthor[p.id]=(p.author?p.author.id:p.author_id);postVideo[p.id]=true;});
}
function openReelAt(pid,t){ reelStartId=pid; reelSeek=t||0; show('Reels'); }
async function loadReels(reset){
  const box=$('sReels'); if(!box)return;
  if(!reset&&(reelLoading||reelDone))return;
  if(reset){ reelPage=1; reelDone=false; reelTok++; reelCursor=null; reelActiveVideo=null; clearTimeout(reelScrollT); box.innerHTML=skReel(); }
  const tok=reelTok; reelLoading=true; let startedId=null;
  try{
    if(reset){
      box.innerHTML='';
      if(reelStartId){
        const want=reelStartId; reelStartId=null;
        try{
          const {data:sp}=await sb.from('posts').select('*, author:author_id(id,username,name,avatar_url,is_verified)').eq('id',want).single();
          if(tok!==reelTok){reelLoading=false;return;}
          if(sp&&sp.video_url){ await reelPrep([sp]); box.insertAdjacentHTML('beforeend',reelHTML(sp)); startedId=sp.id; }
        }catch(e){}
      }
    }
    /* Relevance-ranked (same author/topic-affinity + popularity + recency
       formula as the Feed's "For You" tab - see
       supabase/migrations/20260912000001_feed_ranking.sql), keyset-paginated
       since ranked scores can shift between page loads. A reel jumped to
       directly (openReelAt, inserted above) has no score of its own, so
       subsequent pages just resume from the top of the ranking and dedupe
       it out if it happens to reappear. */
    const {data:items,error}=await sb.rpc('get_reels_for_you',{
      cursor_score: reelCursor&&reelCursor.score,
      cursor_created_at: reelCursor&&reelCursor.created_at,
      cursor_id: reelCursor&&reelCursor.id,
      page_size: 4
    });
    if(error) throw error;
    const raw=items||[];
    let posts=raw.filter(p=>p.id!==startedId&&!blockedIds.has(p.author_id));
    // Advance the cursor from the raw (unfiltered) results regardless of
    // whether client-side filtering emptied this batch, so a page that's
    // entirely blocked/duplicate authors can't stall pagination forever.
    if(raw.length){ const last=raw[raw.length-1]; reelCursor={score:last.score,created_at:last.created_at,id:last.id}; }
    if(reelPage===1 && !posts.length && !box.querySelector('.reel') && !raw.length){box.innerHTML='<div class="empty">No reels yet.<br>Post a video to start!</div>';reelDone=true;reelLoading=false;return;}
    if(posts.length){
      const authorIds=[...new Set(posts.map(p=>p.author_id))];
      const {data:authors}=await sb.from('profiles').select('id,username,name,avatar_url,is_verified').in('id',authorIds);
      const aMap={}; (authors||[]).forEach(a=>aMap[a.id]=a);
      posts.forEach(p=>p.author=aMap[p.author_id]);
      await reelPrep(posts);
      if(tok!==reelTok){reelLoading=false;return;}
      box.insertAdjacentHTML('beforeend',posts.map(reelHTML).join(''));
      setupReelAutoplay();
    }
    reelPage++; if(raw.length<4) reelDone=true;
    if(startedId){
      const sv=document.querySelector('#reel_'+startedId+' video');
      if(sv&&reelSeek>0){ sv.dataset.noreset='1'; const ap=()=>{try{sv.currentTime=reelSeek;}catch(_){}}; if(sv.readyState>=1)ap(); else sv.addEventListener('loadedmetadata',ap,{once:true}); }
      box.scrollTop=0; reelSeek=0;
    }
  }catch(e){ if(reset && !box.querySelector('.reel'))box.innerHTML='<div class="empty">Could not load reels</div>'; }
  reelLoading=false;
}
/* Reels switch on scroll-SETTLE, not on scroll progress: while the user is
   mid-swipe nothing changes, so there's no flicker/replay as a reel drags
   partway into view. Only once scrolling actually stops do we pause
   whichever reel was playing and start the one now centered. */
let reelActiveVideo=null, reelScrollT=null;
function setupReelAutoplay(){
  document.querySelectorAll('.reelvid').forEach(v=>{v.muted=globalMuted;});
  applyMute();
  settleReel();
}
function onReelsScroll(){ clearTimeout(reelScrollT); reelScrollT=setTimeout(settleReel,120); }
function settleReel(){
  const box=$('main');
  const reels=[...box.querySelectorAll('.reel')];
  if(!reels.length)return;
  const boxRect=box.getBoundingClientRect(), center=boxRect.top+boxRect.height/2;
  let best=null,bestDist=Infinity;
  reels.forEach(r=>{
    const rc=r.getBoundingClientRect(), d=Math.abs((rc.top+rc.height/2)-center);
    if(d<bestDist){bestDist=d;best=r;}
  });
  const v=best.querySelector('video'); if(!v)return;
  // Defensive: whatever else may have started playing (a stray canplay retry,
  // a leftover reference, anything), only "best" is allowed to be active.
  reels.forEach(r=>{
    const rv=r.querySelector('video');
    if(rv&&rv!==v&&!rv.paused){ rv.dataset.active='0'; rv.pause(); try{rv.currentTime=0;}catch(_){} }
  });
  if(v===reelActiveVideo){ if(v.paused)v.play().catch(()=>{}); return; }
  if(reelActiveVideo){ reelActiveVideo.dataset.active='0'; reelActiveVideo.pause(); try{reelActiveVideo.currentTime=0;}catch(_){} }
  reelActiveVideo=v; v.dataset.active='1';
  if(v.preload!=='auto')v.preload='auto';
  if(v.dataset.noreset){delete v.dataset.noreset;}else{try{v.currentTime=0;}catch(_){}}
  v.play().catch(()=>{});
  const pid=best.id.replace('reel_','');if(pid){registerView(pid);fillViews(pid);}
}
/* Feed videos settle the same way reels do: nearest-to-viewport-center once
   scrolling actually stops, not an IntersectionObserver ratio threshold. The
   old ratio approach (isIntersecting && ratio>0.6) paused videos almost
   instantly on real devices - a post's header+caption+action row commonly
   leaves the video's own box under 60% visible even when it's the top post
   right after Feed opens, so the observer's first callback would fire,
   decide "not visible enough", and pause whatever had just started via the
   native autoplay attribute a frame earlier. */
let feedActiveVideo=null, feedScrollT=null;
function setupFeedAutoplay(){
  document.querySelectorAll('#sFeed .feedvid').forEach(v=>{v.muted=globalMuted;});
  applyMute();
  settleFeed();
}
function onFeedScroll(){ clearTimeout(feedScrollT); feedScrollT=setTimeout(settleFeed,120); }
function settleFeed(){
  const box=$('main');
  const vids=[...document.querySelectorAll('#sFeed .feedvid')];
  if(!vids.length)return;
  const boxRect=box.getBoundingClientRect(), center=boxRect.top+boxRect.height/2;
  let best=null,bestDist=Infinity;
  vids.forEach(v=>{
    const r=v.getBoundingClientRect();
    const visible=Math.min(r.bottom,boxRect.bottom)-Math.max(r.top,boxRect.top);
    if(visible/r.height<0.3)return; // barely on screen - not a real candidate
    const d=Math.abs((r.top+r.height/2)-center);
    if(d<bestDist){bestDist=d;best=v;}
  });
  vids.forEach(v=>{
    if(v!==best&&!v.paused){ v.dataset.active='0'; v.pause(); try{v.currentTime=0;}catch(_){} }
  });
  if(!best){ feedActiveVideo=null; return; }
  if(best===feedActiveVideo){ if(best.paused)best.play().catch(()=>{}); return; }
  feedActiveVideo=best; best.dataset.active='1';
  if(best.preload!=='auto')best.preload='auto';
  best.play().catch(()=>{});
}

/* ================= CREATE POST (pinch-to-zoom crop + video reframe) ================= */
let mediaKind=null, postVideoFile=null, postPhotos=[];

/* Reusable pinch/wheel/drag crop tool for a still image, rendered into a
   canvas at a fixed target aspect ratio (W:H). Independent of any global
   state so multiple instances can coexist (one per photo, one per story). */
function makeImageCropper(canvas,img,W,H){
  canvas.width=W; canvas.height=H;
  /* Base scale is "contain" (Math.min), not "cover" - at zoom=1 (the
     default nobody changes unless they deliberately pinch/zoom) this shows
     the whole photo letterboxed instead of silently cropping it to fill
     the square, matching the same fix applied to video posts. Unlike the
     video reframe (a CSS transform on a live element, which always fills
     its box), this draws into a canvas that gets re-encoded as the actual
     uploaded file - so letterboxing here means computing a smaller,
     centered destination rect, not just swapping which axis fills. */
  const state={zoom:1,cx:img.naturalWidth/2,cy:img.naturalHeight/2,cover:Math.min(W/img.naturalWidth,H/img.naturalHeight),W,H};
  function frame(total,dstW,dstH){
    const rawSw=dstW/total, rawSh=dstH/total;
    const sw=Math.min(img.naturalWidth,rawSw), sh=Math.min(img.naturalHeight,rawSh);
    state.cx = sw<img.naturalWidth ? Math.max(sw/2,Math.min(img.naturalWidth-sw/2,state.cx)) : img.naturalWidth/2;
    state.cy = sh<img.naturalHeight ? Math.max(sh/2,Math.min(img.naturalHeight-sh/2,state.cy)) : img.naturalHeight/2;
    const dw=sw*total, dh=sh*total;
    return { sx:state.cx-sw/2, sy:state.cy-sh/2, sw, sh, dx:(dstW-dw)/2, dy:(dstH-dh)/2, dw, dh };
  }
  function draw(){
    const ctx=canvas.getContext('2d');
    const f=frame(state.cover*state.zoom,state.W,state.H);
    ctx.clearRect(0,0,state.W,state.H);
    ctx.fillStyle='#000'; ctx.fillRect(0,0,state.W,state.H);
    ctx.drawImage(img,f.sx,f.sy,f.sw,f.sh,f.dx,f.dy,f.dw,f.dh);
  }
  function setZoom(z){ state.zoom=Math.max(1,Math.min(4,z)); draw(); }
  bindPinchPanZoom(canvas,{
    pan:(dx,dy)=>{ const s=state.cover*state.zoom; state.cx-=dx/s; state.cy-=dy/s; draw(); },
    zoomBy:f=>setZoom(state.zoom*f)
  });
  draw();
  return {
    state, setZoom, redraw:draw,
    exportBlob(outW,outH,quality){
      return new Promise(res=>{
        const out=document.createElement('canvas'); out.width=outW; out.height=outH;
        const octx=out.getContext('2d');
        const total=(state.cover*state.zoom)*(outW/state.W);
        const f=frame(total,outW,outH);
        octx.fillStyle='#000'; octx.fillRect(0,0,outW,outH);
        octx.drawImage(img,f.sx,f.sy,f.sw,f.sh,f.dx,f.dy,f.dw,f.dh);
        out.toBlob(b=>res(b),'image/jpeg',quality||0.85);
      });
    }
  };
}
/* Same gesture math, but drives a CSS transform on a live <video> instead of
   a canvas redraw ("visual reframe" - the source file is never re-encoded). */
function makeVideoFramer(container,video,W,H){
  const nw=video.videoWidth||W, nh=video.videoHeight||H;
  /* Base scale is "contain" (Math.min), not "cover" - every upload gets a
     video_crop row by default even if the user never touches the zoom
     slider, so a "cover" default here would silently crop every video post
     to fill the square. Starting at zoom=1 now shows the whole frame
     (letterboxed on the shorter axis); zooming in (still up to 4x below)
     is an explicit choice to crop closer, same gesture UI as before. */
  const state={zoom:1,cx:nw/2,cy:nh/2,cover:Math.min(W/nw,H/nh),W,H};
  function apply(){
    const scale=state.cover*state.zoom;
    const rw=nw*scale, rh=nh*scale;
    const hw=(state.W/scale)/2, hh=(state.H/scale)/2;
    /* Only clamp/pan an axis that's actually been zoomed past the box size
       (cropped). An axis still fully contained within the box (letterboxed
       - always true for at least one axis at the zoom=1 default) has
       nothing to pan, so pin it dead-center instead of running it through
       the crop-only clamp math below, which assumes there's a valid pan
       range and would otherwise pull it off-center. */
    state.cx = rw>state.W ? Math.max(hw,Math.min(nw-hw,state.cx)) : nw/2;
    state.cy = rh>state.H ? Math.max(hh,Math.min(nh-hh,state.cy)) : nh/2;
    video.style.width=rw+'px'; video.style.height=rh+'px';
    video.style.left=(state.W/2-state.cx*scale)+'px'; video.style.top=(state.H/2-state.cy*scale)+'px';
  }
  function setZoom(z){ state.zoom=Math.max(1,Math.min(4,z)); apply(); }
  bindPinchPanZoom(container,{
    pan:(dx,dy)=>{ const s=state.cover*state.zoom; state.cx-=dx/s; state.cy-=dy/s; apply(); },
    zoomBy:f=>setZoom(state.zoom*f)
  });
  apply();
  return { state, setZoom, exportCrop:()=>({zoom:state.zoom,fx:state.cx/nw,fy:state.cy/nh}) };
}
/* Shared touch (pinch + one-finger pan) / mouse-drag / wheel handling. */
function bindPinchPanZoom(el,{pan,zoomBy}){
  let drag=false,lx=0,ly=0,pd=0;
  const dist=e=>Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
  el.addEventListener('mousedown',e=>{drag=true;lx=e.clientX;ly=e.clientY;});
  el.addEventListener('mousemove',e=>{if(drag){pan(e.clientX-lx,e.clientY-ly);lx=e.clientX;ly=e.clientY;}});
  el.addEventListener('mouseup',()=>drag=false); el.addEventListener('mouseleave',()=>drag=false);
  el.addEventListener('wheel',e=>{e.preventDefault();zoomBy(e.deltaY<0?1.08:0.92);},{passive:false});
  el.addEventListener('touchstart',e=>{if(e.touches.length===1){drag=true;lx=e.touches[0].clientX;ly=e.touches[0].clientY;}else if(e.touches.length===2){drag=false;pd=dist(e);}},{passive:false});
  el.addEventListener('touchmove',e=>{e.preventDefault();if(e.touches.length===2){const d=dist(e);if(pd)zoomBy(d/pd);pd=d;}else if(drag){pan(e.touches[0].clientX-lx,e.touches[0].clientY-ly);lx=e.touches[0].clientX;ly=e.touches[0].clientY;}},{passive:false});
  el.addEventListener('touchend',()=>{drag=false;pd=0;});
}

let photoCropper=null, photoCroppers=[], activeCropper=null, videoFramer=null;
$('postDrop').onclick=()=>{ if(!mediaKind)$('postFile').click(); };
$('mediaReset').onclick=()=>{ resetCreate(); $('postFile').click(); };
$('postFile').onchange=e=>{ const files=[...e.target.files]; if(!files.length)return; const f=files[0]; if(f.type.startsWith('video')){ setupVideo(f); return; } const imgs=files.filter(x=>x.type.startsWith('image')); if(imgs.length>1) setupPhotos(imgs.slice(0,10)); else setupCrop(f); };
$('cropZoom').oninput=e=>{ if(activeCropper) activeCropper.setZoom(parseFloat(e.target.value)); };
function resetCreate(){
  mediaKind=null;postVideoFile=null;postPhotos=[];photoCropper=null;photoCroppers=[];activeCropper=null;videoFramer=null;
  const d=$('postDrop'); if(d)d.innerHTML='Tap to choose photos or a video';
  $('cropZoom').style.display='none'; $('mediaReset').style.display='none'; $('postFile').value=''; setAudience('public');
}
function setupCrop(file){
  const img=new Image();
  img.onload=()=>{
    mediaKind='image';
    const drop=$('postDrop'), V=drop.clientWidth||300;
    drop.innerHTML='<canvas id="cropCanvas" style="width:100%;height:100%;display:block;touch-action:none;cursor:grab"></canvas>';
    photoCropper=makeImageCropper($('cropCanvas'),img,V,V);
    activeCropper=photoCropper;
    $('cropZoom').value=1; $('cropZoom').style.display='block'; $('mediaReset').style.display='block';
  };
  img.onerror=()=>toast('Could not read image');
  img.src=URL.createObjectURL(file);
}
function setupPhotos(files){
  postPhotos=files; mediaKind='photos'; postVideoFile=null;
  const drop=$('postDrop'), V=drop.clientWidth||300;
  drop.innerHTML='<div class="mpstage">'+files.map((_,i)=>`<canvas class="mpCanvas" id="mpc_${i}" style="display:${i?'none':'block'}"></canvas>`).join('')+'</div><div class="mpstrip" id="mpStrip"></div>';
  photoCroppers=new Array(files.length);
  Promise.all(files.map((f,i)=>new Promise(res=>{
    const img=new Image();
    img.onload=()=>{ photoCroppers[i]=makeImageCropper($('mpc_'+i),img,V,V); res(); };
    img.onerror=()=>res();
    img.src=URL.createObjectURL(f);
  }))).then(()=>{
    activeCropper=photoCroppers[0];
    $('mpStrip').innerHTML=files.map((f,i)=>`<img data-i="${i}" class="${i?'':'on'}" src="${URL.createObjectURL(f)}" onclick="selectMpPhoto(${i})">`).join('');
  });
  $('cropZoom').value=1; $('cropZoom').style.display='block'; $('mediaReset').style.display='block';
}
function selectMpPhoto(i){
  if(!photoCroppers[i])return;
  activeCropper=photoCroppers[i];
  document.querySelectorAll('.mpCanvas').forEach((cv,idx)=>{cv.style.display=idx===i?'block':'none';});
  document.querySelectorAll('#mpStrip img').forEach((im,idx)=>im.classList.toggle('on',idx===i));
  $('cropZoom').value=photoCroppers[i].state.zoom;
}
function setupVideo(file){
  if(file.size>60*1024*1024){toast('Video too large (max ~60MB)');resetCreate();return;}
  postVideoFile=file; mediaKind='video';
  const drop=$('postDrop'), V=drop.clientWidth||300;
  drop.innerHTML=`<div id="vidFrameBox"><video id="vidFrameEl" src="${URL.createObjectURL(file)}" muted loop playsinline></video></div>`;
  const vEl=$('vidFrameEl');
  vEl.onloadedmetadata=()=>{ videoFramer=makeVideoFramer($('vidFrameBox'),vEl,V,V); activeCropper=videoFramer; $('cropZoom').value=1; };
  vEl.play().catch(()=>{});
  $('cropZoom').style.display='block'; $('mediaReset').style.display='block';
}
function generatePoster(file){
  return new Promise(resolve=>{
    let done=false; const finish=b=>{if(done)return;done=true;resolve(b);};
    const v=document.createElement('video');
    v.muted=true; v.playsInline=true; v.preload='metadata'; v.src=URL.createObjectURL(file);
    v.onloadeddata=()=>{ try{v.currentTime=0.1;}catch(e){finish(null);} };
    v.onseeked=()=>{ try{
      const w=v.videoWidth||720,h=v.videoHeight||1280,sc=Math.min(1,720/Math.max(w,h));
      const c=document.createElement('canvas'); c.width=Math.round(w*sc); c.height=Math.round(h*sc);
      c.getContext('2d').drawImage(v,0,0,c.width,c.height);
      c.toBlob(b=>finish(b),'image/jpeg',0.72);
    }catch(e){finish(null);} };
    v.onerror=()=>finish(null);
    setTimeout(()=>finish(null),6000);
  });
}
const backfilling={};
function posterFromUrl(url){
  return new Promise(res=>{
    let done=false; const fin=b=>{if(done)return;done=true;res(b);};
    const v=document.createElement('video'); v.crossOrigin='anonymous'; v.muted=true; v.playsInline=true; v.preload='metadata'; v.src=url;
    v.onloadeddata=()=>{try{v.currentTime=0.1;}catch(e){fin(null);}};
    v.onseeked=()=>{try{const w=v.videoWidth||720,h=v.videoHeight||1280,sc=Math.min(1,720/Math.max(w,h));const c=document.createElement('canvas');c.width=Math.round(w*sc);c.height=Math.round(h*sc);c.getContext('2d').drawImage(v,0,0,c.width,c.height);c.toBlob(b=>fin(b),'image/jpeg',0.72);}catch(e){fin(null);}};
    v.onerror=()=>fin(null); setTimeout(()=>fin(null),8000);
  });
}
async function backfillThumb(p){
  if(!(p&&p.video_url&&!p.thumb_url&&p.author_id===me().id)||backfilling[p.id])return false;
  backfilling[p.id]=1;
  try{
    const b=await posterFromUrl(p.video_url);
    if(b){
      const url=await uploadFile('posts',me().id+'/'+randPath()+'-thumb.jpg',new File([b],'thumb.jpg',{type:'image/jpeg'}));
      await sb.from('posts').update({thumb_url:url}).eq('id',p.id);
      return true;
    }
  }catch(e){}
  return false;
}
$('shareBtn').onclick=async()=>{
  if(!mediaKind){toast('Choose a photo or video first');return;}
  $('shareBtn').textContent='Sharing…';$('shareBtn').disabled=true;
  try{
    const tagStr=$('postTags').value.trim();
    const folder=me().id+'/'+randPath();
    const row={author_id:me().id,caption:$('postCap').value.trim(),audience:postAudience==='close'?'close':'public'};
    if(tagStr)row.tags=tagStr;
    showUpload('Posting…'); setUpload(15);
    if(mediaKind==='image'){
      const blob=await photoCropper.exportBlob(1000,1000,0.85);
      row.image_url=await uploadFile('posts',folder+'/image.jpg',new File([blob],'post.jpg',{type:'image/jpeg'}));
    } else if(mediaKind==='photos'){
      const urls=[];
      for(let i=0;i<postPhotos.length;i++){
        const blob=await photoCroppers[i].exportBlob(1000,1000,0.85);
        urls.push(await uploadFile('posts',folder+'/photo-'+i+'.jpg',new File([blob],'photo-'+i+'.jpg',{type:'image/jpeg'})));
        setUpload(15+Math.round(60*(i+1)/postPhotos.length));
      }
      row.photos=urls; row.image_url=urls[0];
    } else {
      setUpload(30);
      row.video_url=await uploadFile('posts',folder+'/video.mp4',postVideoFile);
      if(videoFramer) row.video_crop=videoFramer.exportCrop();
      setUpload(75);
      const poster=await generatePoster(postVideoFile);
      if(poster) row.thumb_url=await uploadFile('posts',folder+'/thumb.jpg',new File([poster],'thumb.jpg',{type:'image/jpeg'}));
    }
    setUpload(95);
    const {data:rec,error}=await sb.from('posts').insert(row).select().single();
    if(error) throw error;
    setUpload(100); hideUpload();
    notifyTags(tagStr,rec.id);
    resetCreate(); $('postCap').value=''; $('postTags').value=''; toast('Posted!'); show('Feed');
  }catch(e){hideUpload();toast('Post failed: '+sbErr(e));}
  finally{$('shareBtn').disabled=false;$('shareBtn').textContent='Share';}
};

/* ================= SEARCH ================= */
let searchT=null;
$('searchInput').oninput=e=>{clearTimeout(searchT);const q=e.target.value.trim();searchT=setTimeout(()=>runSearch(q),300);};
async function runSearch(q){
  const box=$('searchResults');
  if(!q){loadExplore();return;}
  const eq=likeEsc(q);
  try{
    const {data:userRows}=await sb.from('profiles').select('*').or('username.ilike.%'+eq+'%,name.ilike.%'+eq+'%').limit(25);
    const users=(userRows||[]).filter(u=>u.id!==me().id&&!blockedIds.has(u.id));
    let html=users.length?('<div class="slabel">People</div>'+users.map(u=>`<div class="row" onclick="openProfile('${u.id}')">${avatarHtml(u,42)}<div><div class="nm">${esc(u.username)}${vbadge(u)}</div><div class="mut">${esc(u.name||'')}</div></div></div>`).join('')):'';
    let posts=[];
    try{ const {data}=await sb.from('posts').select('*').ilike('caption','%'+eq+'%').order('created_at',{ascending:false}).limit(18); posts=(data||[]).filter(p=>!blockedIds.has(p.author_id)); }catch(e){}
    if(posts.length) html+='<div class="slabel">Posts</div><div class="grid">'+posts.map(gridCell).join('')+'</div>';
    box.innerHTML=html||'<div class="empty">No results</div>';
  }catch(e){box.innerHTML='<div class="empty">Search failed</div>';}
}
async function loadExplore(){
  const box=$('searchResults'); box.innerHTML=skGrid(9);
  try{ const {data}=await sb.from('posts').select('*').order('created_at',{ascending:false}).limit(18); const posts=(data||[]).filter(p=>!blockedIds.has(p.author_id)); box.innerHTML=posts.length?('<div class="slabel">Explore</div><div class="grid">'+posts.map(gridCell).join('')+'</div>'):'<div class="empty">Nothing to explore yet</div>'; }catch(e){box.innerHTML='';}
}
function gridCell(p){
  if(p.poll&&!p.image_url&&!p.thumb_url){ const q=(p.poll&&p.poll.q)||''; return `<div class="gcell gpoll" onclick="openPostView('${p.id}')"><span class="gpollicon">${icon('poll',26)}</span><span class="gpollq">${esc(q)}</span></div>`; }
  const t=p.image_url||p.thumb_url||'';
  postVideo[p.id]=!!p.video_url;
  const play=p.video_url?`<span class="gvid">${icon('reels',16)}</span>`:'';
  const multi=(Array.isArray(p.photos)&&p.photos.length>1)?`<span class="gmulti">${icon('layers',16)}</span>`:'';
  const fb=icon(p.video_url?'reels':'image',24);
  const img=t?`<img class="blur-load" src="${t}" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.remove();this.closest('.gcell').classList.add('gph')">`:'';
  return `<div class="gcell ${t?'':'gph'}" onclick="openPostView('${p.id}')">${img}<span class="gfallback">${fb}</span>${play}${multi}</div>`;
}

/* ================= PROFILE ================= */
async function loadProfile(uid){
  const box=$('sProfile');box.innerHTML=skProfile();
  currentScreen='Profile';
  ['Feed','Search','Create','Reels','Chats','Profile'].forEach(x=>$('s'+x).classList.toggle('on',x==='Profile'));
  document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.s==='Profile'));
  $('main').classList.remove('reels');
  try{
    const isMe=uid===me().id;
    const u=isMe?me():await getUser(uid);
    if(!u) throw new Error('User not found');
    const {data:postRows}=await sb.from('posts').select('*').eq('author_id',uid).order('created_at',{ascending:false}).limit(60);
    const posts=postRows||[];
    let followersN=0,followingN=0,followId=null;
    try{
      const {count:fr}=await sb.from('follows').select('id',{count:'exact',head:true}).eq('following_id',uid);
      const {count:fg}=await sb.from('follows').select('id',{count:'exact',head:true}).eq('follower_id',uid);
      followersN=fr||0; followingN=fg||0;
      if(!isMe){ const {data:mf}=await sb.from('follows').select('id').eq('follower_id',me().id).eq('following_id',uid).maybeSingle(); followId=mf?mf.id:null; }
    }catch(e){}
    const blocked=!isMe&&blockedIds.has(uid);
    const grid=blocked?'<div class="empty">You blocked this user</div>':(posts.length?`<div class="grid">${posts.map(gridCell).join('')}</div>`:'<div class="empty">No posts yet</div>');
    const btns=isMe
      ?`<button onclick="openEdit()">Edit profile</button><button onclick="openSaved()">Saved</button><button onclick="openQR()">My QR</button><button onclick="enablePush()">Enable alerts</button><button onclick="logout()">Log out</button>`
      :(blocked
        ?`<button class="grad" style="color:#fff" onclick="toggleBlock('${uid}',true)">Unblock</button><button class="morebtn" onclick="openUserMenu('${uid}')">${icon('more',18)}</button>`
        :`<button id="followBtn" class="${followId?'':'grad'}" ${followId?'':'style="color:#fff"'} onclick="toggleFollow('${uid}','${followId||''}')">${followId?'Following':'Follow'}</button><button onclick="openChat('${u.id}')">Message</button><button class="morebtn" onclick="openUserMenu('${uid}')">${icon('more',18)}</button>`);
    box.innerHTML=`<div class="prof">
      <div class="phdr">${avatarHtml(u,76)}<div class="pstats"><div><b>${posts.length}</b><span>posts</span></div><div onclick="openFollowList('${uid}','followers')" style="cursor:pointer"><b>${followersN}</b><span>followers</span></div><div onclick="openFollowList('${uid}','following')" style="cursor:pointer"><b>${followingN}</b><span>following</span></div></div></div>
      <div class="pname">${esc(u.name||u.username)}${vbadge(u)}</div>
      <div class="mut" style="color:var(--mut);font-size:13px;margin-bottom:6px">@${esc(u.username)}</div>
      ${(!isMe&&!blocked)?(isOnline(u)?`<div class="ppresence" style="color:#3ddc84"><span class="odot on"></span>Online</div>`:(u.last_seen?`<div class="ppresence" style="color:var(--mut)">last seen ${timeAgo(u.last_seen)}</div>`:'')):''}
      <div class="pbio">${esc(u.bio||'')}</div>
      <div class="pbtns">${btns}</div>
    </div>${grid}`;
    if(isMe){const need=posts.filter(p=>p.video_url&&!p.thumb_url);if(need.length)(async()=>{let any=false;for(const p of need){if(await backfillThumb(p))any=true;}if(any&&currentScreen==='Profile')loadProfile(me().id);})();}
  }catch(e){box.innerHTML='<div class="empty">Could not load profile</div>';}
}
function openProfile(uid){loadProfile(uid);}
function isOnline(u){ return !!(u&&u.last_seen&&(Date.now()-new Date(u.last_seen).getTime())<45000); }
function openEdit(){
  const u=me();
  const box=$('sProfile');
  box.innerHTML=`<div class="create">
    <div class="drop" id="editAvDrop" style="width:96px;height:96px;border-radius:50%;margin:0 auto 16px">${avatarHtml(u,94)}</div>
    <input type="file" id="editAvFile" accept="image/*" style="display:none">
    <input class="field" id="editName" placeholder="Display name" value="${esc(u.name||'')}">
    <textarea id="editBio" rows="3" placeholder="Bio">${esc(u.bio||'')}</textarea>
    <button class="btn grad" id="saveProf">Save</button>
    <button class="btn" style="background:var(--soft);margin-top:8px;color:var(--txt)" onclick="openChangePw()">Change password</button>
    <button class="btn" style="background:var(--soft);margin-top:8px;color:var(--txt)" onclick="loadProfile(me().id)">Cancel</button>
  </div>`;
  let newAv=null;
  $('editAvDrop').onclick=()=>$('editAvFile').click();
  $('editAvFile').onchange=e=>{const f=e.target.files[0];if(!f)return;newAv=f;$('editAvDrop').innerHTML=`<img src="${URL.createObjectURL(f)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;};
  $('saveProf').onclick=async()=>{
    $('saveProf').textContent='Saving…';$('saveProf').disabled=true;
    try{
      const patch={name:$('editName').value.trim(),bio:$('editBio').value.trim()};
      if(newAv){ const ca=await compressImage(newAv,512,0.85); patch.avatar_url=await uploadFile('avatars',me().id+'/'+randPath()+'.jpg',ca); }
      const {data,error}=await sb.from('profiles').update(patch).eq('id',me().id).select().single();
      if(error) throw error;
      myProfile={...myProfile,...data};
      toast('Profile updated');
      $('navAv').outerHTML=avatarHtml(me(),26,'nav-av').replace('class="av','id="navAv" class="av');
      loadProfile(me().id);
    }catch(e){toast('Save failed');$('saveProf').disabled=false;$('saveProf').textContent='Save';}
  };
}
function logout(){ sb.auth.signOut().finally(()=>location.reload()); }
function openChangePw(){
  const box=$('sProfile');
  box.innerHTML=`<div class="create">
    <div class="pname" style="margin-bottom:12px">Change password</div>
    <div class="err" id="cpErr" style="margin-bottom:8px"></div>
    <input class="field" id="cpCur" type="password" placeholder="Current password">
    <input class="field" id="cpNew" type="password" placeholder="New password (min 8)">
    <input class="field" id="cpNew2" type="password" placeholder="Confirm new password">
    <button class="btn grad" id="cpBtn">Change password</button>
    <button class="btn" style="background:var(--soft);margin-top:8px;color:var(--txt)" onclick="loadProfile(me().id)">Cancel</button>
  </div>`;
  $('cpBtn').onclick=async()=>{
    const err=$('cpErr'); err.textContent='';
    const cur=$('cpCur').value, np=$('cpNew').value, np2=$('cpNew2').value;
    if(!cur||!np){err.textContent='Enter current and new password';return;}
    if(np.length<8){err.textContent='New password must be at least 8 characters';return;}
    if(np!==np2){err.textContent='New passwords do not match';return;}
    $('cpBtn').disabled=true; $('cpBtn').textContent='Updating…';
    try{
      const {error:reErr}=await sb.auth.signInWithPassword({email:me().email,password:cur});
      if(reErr) throw new Error('Current password is incorrect');
      const {error}=await sb.auth.updateUser({password:np});
      if(error) throw error;
      toast('Password changed');
      loadProfile(me().id);
    }catch(e){ err.textContent=authError(e); $('cpBtn').textContent='Change password'; $('cpBtn').disabled=false; }
  };
}

/* ================= CHATS LIST ================= */
function getLSset(k){ try{ return new Set(JSON.parse(localStorage.getItem(k)||'[]')); }catch(e){ return new Set(); } }
function setLSset(k,s){ try{ localStorage.setItem(k,JSON.stringify([...s])); }catch(e){} }
function getPinned(){ return getLSset('linkup_pinned'); }
function getMuted(){ return getLSset('linkup_muted'); }
function togglePin(id){ const s=getPinned(); const on=!s.has(id); on?s.add(id):s.delete(id); setLSset('linkup_pinned',s); toast(on?'Pinned':'Unpinned'); loadChats(); }
function toggleMute(id){ const s=getMuted(); const on=!s.has(id); on?s.add(id):s.delete(id); setLSset('linkup_muted',s); toast(on?'Muted':'Unmuted'); loadChats(); }
function openChatRowMenu(id){
  const pinned=getPinned().has(id), muted=getMuted().has(id);
  $('actMenu').innerHTML=
    `<button onclick="closeActMenu();togglePin('${id}')">${pinned?'Unpin chat':'Pin to top'}</button>`+
    `<button onclick="closeActMenu();toggleMute('${id}')">${muted?'Unmute':'Mute'}</button>`+
    `<button onclick="closeActMenu()">Cancel</button>`;
  $('actMenuWrap').classList.add('on');rearm();
}
let chatLPTimer=null, suppressChatClick=false;
$('sChats').addEventListener('pointerdown',e=>{ const row=e.target.closest('.row[data-id]'); if(!row)return; clearTimeout(chatLPTimer); chatLPTimer=setTimeout(()=>{ suppressChatClick=true; openChatRowMenu(row.getAttribute('data-id')); },500); });
['pointerup','pointermove','pointercancel','pointerleave'].forEach(ev=>$('sChats').addEventListener(ev,()=>clearTimeout(chatLPTimer)));
$('sChats').addEventListener('click',e=>{ if(suppressChatClick){ e.stopPropagation(); e.preventDefault(); suppressChatClick=false; } },true);
$('sChats').addEventListener('contextmenu',e=>{ if(e.target.closest('.row[data-id]'))e.preventDefault(); });
async function loadChats(){
  const box=$('sChats');box.innerHTML=skRows(7);
  try{
    await loadMyGroups();
    await loadDmStreaks();
    const {data:msgRows,error}=await sb.from('messages').select('*').or('sender_id.eq.'+me().id+',receiver_id.eq.'+me().id).is('group_id',null).order('created_at',{ascending:false}).limit(150);
    if(error) throw error;
    const msgs=msgRows||[];
    const seen={},order=[],unread={};
    msgs.forEach(m=>{const other=m.sender_id===me().id?m.receiver_id:m.sender_id;if(!other)return;if(blockedIds.has(other))return;if(m.receiver_id===me().id&&!m.read)unread[m.sender_id]=(unread[m.sender_id]||0)+1;if(seen[other])return;seen[other]=m;order.push(other);});
    const users={};
    await Promise.all(order.map(async id=>{users[id]=await getUser(id);}));
    const entries=[];
    order.forEach(id=>{const u=users[id];if(!u)return;const m=seen[id];entries.push({id,ts:new Date(m.created_at).getTime(),html:dmRow(id,u,m,unread[id]||0)});});
    let reads={};
    try{ const {data:rr}=await sb.from('group_reads').select('group_id,last_read_at').eq('user_id',me().id); (rr||[]).forEach(r=>{reads[r.group_id]=r.last_read_at;}); }catch(e){}
    for(const g of myGroups){
      let last=null,uc=0;
      try{
        const {data:r}=await sb.from('messages').select('*').eq('group_id',g.id).order('created_at',{ascending:false}).limit(30);
        last=(r&&r[0])||null;
        const seenTs=reads[g.id]?new Date(reads[g.id]).getTime():0;
        uc=(r||[]).filter(x=>x.sender_id!==me().id&&new Date(x.created_at).getTime()>seenTs).length;
      }catch(e){}
      entries.push({id:g.id,ts:last?new Date(last.created_at).getTime():new Date(g.created_at).getTime(),html:groupRow(g,last,uc)});
    }
    const pinnedSet=getPinned();
    entries.sort((a,b)=>((pinnedSet.has(b.id)?1:0)-(pinnedSet.has(a.id)?1:0))||(b.ts-a.ts));
    const newBtn=`<div class="row" data-newgroup="1" onclick="openNewGroup()"><div class="cav" style="width:48px;height:48px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff">${icon('group',24)}</div><div class="last"><div class="nm" style="color:var(--accent2)">New group</div><div class="snip">Start a group chat</div></div></div>`;
    const search=`<div class="chatsearch">${icon('search',18)}<input id="chatSearchInp" placeholder="Search chats" oninput="filterChats(this.value)"><span id="chatSearchEmpty"></span></div>`;
    box.innerHTML=search+'<div id="chatRows">'+newBtn+(entries.length?entries.map(e=>e.html).join(''):'<div class="empty" style="padding:30px 0">No chats yet.<br>Find people in Search.</div>')+'</div>';
  }catch(e){box.innerHTML='<div class="empty">Could not load chats</div>';}
}
function filterChats(q){
  q=(q||'').trim().toLowerCase();
  const rows=document.querySelectorAll('#chatRows .row');
  let any=false;
  rows.forEach(r=>{
    if(r.hasAttribute('data-newgroup')){ r.style.display=q?'none':''; return; }
    const n=r.getAttribute('data-name')||'';
    const match=n.includes(q); r.style.display=match?'':'none'; if(match)any=true;
  });
  const empty=$('chatSearchEmpty');
  let none=document.getElementById('chatNoMatch');
  if(q&&!any){ if(!none){ none=document.createElement('div'); none.id='chatNoMatch'; none.className='empty'; none.style.padding='24px 0'; none.textContent='No chats match "'+q+'"'; $('chatRows').appendChild(none);} else none.style.display='';none.textContent='No chats match "'+q+'"'; }
  else if(none){ none.style.display='none'; }
}
function callSnip(m){const p=(m.call||'').split(':'),k=p[0]||'audio',st=p[1]||'ended';if(st==='missed')return 'Missed '+(k==='video'?'video ':'')+'call';if(st==='declined')return 'Call declined';return (k==='video'?'Video':'Voice')+' call';}
function dmRow(id,u,m,uc){const snip=m.call?callSnip(m):m.audio_url?'Voice message':m.image_url?'Photo':m.post_id?'Shared a post':esc(m.text||'');const mine=(m.sender_id===me().id&&!m.call)?'You: ':'';const pin=getPinned().has(id)?`<span class="rowic">${icon('pin',14)}</span>`:'';const mu=getMuted().has(id)?`<span class="rowic">${icon('belloff',14)}</span>`:'';const stk=streakHtml(id);const right=uc>0?`<div class="cbadge">${uc>99?'99+':uc}</div>`:`<div class="mut">${timeAgo(m.created_at)}</div>`;return `<div class="row" data-id="${id}" data-name="${esc(((u.username||'')+' '+(u.name||'')).toLowerCase())}" onclick="openChat('${id}')"><div class="cav">${avatarHtml(u,48)}${isOnline(u)?'<span class="cdot"></span>':''}</div><div class="last"><div class="nm">${esc(u.username)}${stk}${pin}${mu}</div><div class="snip ${uc>0?'unread':''}">${mine}${snip}</div></div>${right}</div>`;}
/* DM streaks: consecutive days you and one other person BOTH messaged.
   Shown from 2 days - a single day isn't a streak, and showing "1" on
   every new conversation would make the flame meaningless. */
let dmStreaks={};
const STREAK_MIN=2;
async function loadDmStreaks(){
  try{
    const {data,error}=await sb.rpc('my_dm_streaks');
    if(error) throw error;
    dmStreaks={}; (data||[]).forEach(r=>{dmStreaks[r.other_id]=r.streak;});
  }catch(e){ dmStreaks={}; }
}
function streakHtml(uid){
  const n=dmStreaks[uid]||0;
  if(n<STREAK_MIN)return '';
  return `<span class="streak" title="${n}-day streak">${icon('rfire',13,{fill:'currentColor'})}<i>${n}</i></span>`;
}
function groupRow(g,m,uc){const snip=m?(m.sys?esc(m.sys):m.audio_url?'Voice message':m.image_url?'Photo':m.post_id?'Shared a post':esc(m.text||'')):'No messages yet';const pre=(m&&m.sender_id===me().id&&!m.sys)?'You: ':'';const pin=getPinned().has(g.id)?`<span class="rowic">${icon('pin',14)}</span>`:'';const mu=getMuted().has(g.id)?`<span class="rowic">${icon('belloff',14)}</span>`:'';const right=uc>0?`<div class="cbadge">${uc>99?'99+':uc}</div>`:(m?`<div class="mut">${timeAgo(m.created_at)}</div>`:'');return `<div class="row" data-id="${g.id}" data-name="${esc((g.name||'group').toLowerCase())}" onclick="openGroup('${g.id}')"><div class="cav">${groupAvatar(g,48)}</div><div class="last"><div class="nm">${esc(g.name||'Group')}${pin}${mu}</div><div class="snip ${uc>0?'unread':''}">${pre}${snip}</div></div>${right}</div>`;}

/* ================= CHAT THREAD ================= */
let chatUser=null, chatImage=null, typingRecId=null, lastTypingSent=0;
let chatGroup=null, myGroups=[], myGroupIds=new Set(), grpUsers={};
async function loadMyGroups(){
  try{
    const {data:rows,error}=await sb.from('group_members').select('group_id, groups:group_id(*)').eq('user_id',me().id);
    if(error) throw error;
    myGroups=(rows||[]).map(r=>r.groups).filter(Boolean).sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at));
    myGroupIds=new Set(myGroups.map(g=>g.id));
    refreshUnread();
  }catch(e){ myGroups=[]; myGroupIds=new Set(); }
}
async function getGroupMemberIds(gid){
  try{ const {data,error}=await sb.from('group_members').select('user_id').eq('group_id',gid); if(error)throw error; return (data||[]).map(r=>r.user_id); }
  catch(e){ return []; }
}
function groupAvatar(g,size){ const url=mediaUrl(g,'avatar_url'); if(url)return `<img class="av" style="width:${size}px;height:${size}px" src="${url}">`; const L=esc(((g.name||'G').trim()[0]||'G').toUpperCase()); return `<div class="av gav" style="width:${size}px;height:${size}px;font-size:${Math.round(size*0.42)}px">${L}</div>`; }
/* If a notification reply failed to send in the background (session
   expired, offline), sw.js stashes the text under this key so it isn't
   silently lost - restore it into the input the next time this chat opens. */
async function restoreDraft(conversationKey){
  try{
    const text=await idbGet('draft:'+conversationKey);
    if(text){ $('chatInput').value=text; await idbDel('draft:'+conversationKey); }
  }catch(_){}
}
/* Push notifications for a conversation stick around in the OS tray until
   something dismisses them - opening that exact chat here counts as having
   seen it, so close whatever sw.js left showing under this tag. */
function clearChatNotifications(tag){
  if(!('serviceWorker' in navigator))return;
  navigator.serviceWorker.ready.then(reg=>reg.getNotifications({tag})).then(list=>list.forEach(n=>n.close())).catch(()=>{});
}
function buildMessageBase(){
  const row={sender_id:me().id};
  if(chatGroup){ row.group_id=chatGroup.id; row.conversation=chatGroup.id; }
  else { row.receiver_id=chatUser.id; row.conversation=convKey(me().id,chatUser.id); }
  if(replyTarget){ row.reply_to_id=replyTarget.id; row.reply_meta={u:replyTarget.u,t:replyTarget.t}; }
  return row;
}
async function openGroup(gid){
  cleanupPresence(); closeChatSearch();
  const {data:g,error}=await sb.from('groups').select('*').eq('id',gid).single();
  if(error||!g){ toast('Group not found'); return; }
  chatGroup=g; chatUser=null;
  clearChatNotifications('grp:'+gid);
  typingRecId=null; lastTypingSent=0; $('typing').style.display='none';
  $('chatAv').innerHTML=groupAvatar(g,38);
  $('chatName').textContent=g.name||'Group';
  $('chatDot').classList.remove('on');
  const mem=await getGroupMemberIds(gid);
  $('chatStatusTxt').textContent=mem.length+' member'+(mem.length===1?'':'s');
  $('chatStatusTxt').style.color='var(--mut)';
  $('callBtns').style.display='flex';
  $('chatAv').onclick=()=>openGroupInfo(g.id); $('chatName').onclick=()=>openGroupInfo(g.id);
  $('chat').style.display='flex';
  grpUsers={}; await Promise.all(mem.map(async id=>{grpUsers[id]=await getUser(id);}));
  const body=$('chatBody'); body.innerHTML=skChat();
  try{
    const {data:msgRows,error:mErr}=await sb.from('messages').select('*').eq('group_id',gid).order('created_at');
    if(mErr) throw mErr;
    const msgs=(msgRows||[]).filter(m=>!blockedIds.has(m.sender_id));
    body.innerHTML=msgs.length?msgs.map(bubble).join(''):'<div class="empty" style="padding:30px 0">No messages yet. Say hello!</div>';
    hydrateCards(body); body.scrollTop=body.scrollHeight;
    try{ await sb.from('group_reads').upsert({group_id:gid,user_id:me().id,last_read_at:new Date().toISOString()}); }catch(_){}
    refreshUnread();
  }catch(e){ body.innerHTML='<div class="empty">Could not load messages<br><span style="font-size:12px;opacity:.7">'+esc(sbErr(e))+'</span></div>'; }
  restoreDraft(gid);
}
function openNewGroup(){
  $('ngName').value=''; $('newGroup').classList.add('on');rearm();
  const body=$('ngMembers'); body.innerHTML=skRows(5);
  (async()=>{
    let ids=[];
    try{ const {data}=await sb.from('follows').select('following_id').eq('follower_id',me().id); ids=(data||[]).map(f=>f.following_id); }catch(e){}
    try{ const {data}=await sb.from('messages').select('sender_id,receiver_id').or('sender_id.eq.'+me().id+',receiver_id.eq.'+me().id).is('group_id',null).order('created_at',{ascending:false}).limit(80); (data||[]).forEach(m=>{const o=m.sender_id===me().id?m.receiver_id:m.sender_id;if(o)ids.push(o);}); }catch(e){}
    ids=[...new Set(ids)].filter(id=>id&&id!==me().id);
    if(!ids.length){body.innerHTML='<div class="empty">Follow or chat with people first</div>';return;}
    const users={}; await Promise.all(ids.map(async id=>{users[id]=await getUser(id);}));
    body.innerHTML=ids.filter(id=>users[id]).map(id=>{const u=users[id];return `<label class="row ngrow"><div class="cav">${avatarHtml(u,44)}</div><div class="last"><div class="nm">${esc(u.username)}</div></div><input type="checkbox" class="ngchk" value="${id}"></label>`;}).join('');
  })();
}
function closeNewGroup(){ $('newGroup').classList.remove('on'); }
async function createGroup(){
  const name=$('ngName').value.trim();
  const picked=[...document.querySelectorAll('.ngchk:checked')].map(c=>c.value);
  if(!name){toast('Enter a group name');return;}
  if(!picked.length){toast('Select at least one member');return;}
  try{
    const {data:g,error}=await sb.from('groups').insert({name,owner_id:me().id}).select().single();
    if(error) throw error;
    const rows=[me().id,...picked].map(uid=>({group_id:g.id,user_id:uid}));
    await sb.from('group_members').insert(rows);
    groupSys(g.id,(me().username||'Someone')+' created the group'); closeNewGroup(); await loadMyGroups(); openGroup(g.id);
  }
  catch(e){ toast('Create failed: '+sbErr(e)); }
}
async function groupSys(gid,text){ try{ const {data:r}=await sb.from('messages').insert({sender_id:me().id,group_id:gid,conversation:gid,sys:text}).select().single(); if(chatGroup&&chatGroup.id===gid&&$('chat').style.display==='flex'){appendBubble(r);} }catch(e){} }
let giGroup=null, addMemGid=null;
async function openGroupInfo(gid){
  const {data:g,error}=await sb.from('groups').select('*').eq('id',gid).single();
  if(error||!g){ toast('Group not found'); return; }
  giGroup=g; $('groupInfo').classList.add('on'); rearm(); renderGroupInfo(g);
}
function closeGroupInfo(){ $('groupInfo').classList.remove('on'); }
async function renderGroupInfo(g){
  const isOwner=g.owner_id===me().id;
  $('giAvatar').innerHTML=groupAvatar(g,90);
  $('giName').textContent=g.name||'Group';
  $('giName').setAttribute('data-edit',isOwner?'1':'0');
  $('giName').onclick=isOwner?()=>renameGroup(g.id):null;
  const mem=await getGroupMemberIds(g.id);
  $('giMeta').textContent=mem.length+' member'+(mem.length===1?'':'s');
  const box=$('giMembers'); box.innerHTML=skRows(Math.min(mem.length,4)||3);
  const users={}; await Promise.all(mem.map(async id=>{users[id]=await getUser(id);}));
  box.innerHTML=mem.map(id=>{const u=users[id]||{username:'user'};const own=id===g.owner_id;const meTag=id===me().id?' (You)':'';const rm=(isOwner&&!own)?`<button class="gmx" onclick="removeMember('${id}')">${icon('trash',18)}</button>`:'';return `<div class="row"><div class="cav">${avatarHtml(u,44)}</div><div class="last"><div class="nm">${esc(u.username||'user')}${meTag}</div><div class="snip">${own?'Owner':''}</div></div>${rm}</div>`;}).join('');
}
function renameGroup(gid){
  openTextEditor('Rename group',(giGroup&&giGroup.name)||'',async v=>{ v=(v||'').trim(); if(!v)return;
    try{ const {data,error}=await sb.from('groups').update({name:v}).eq('id',gid).select().single(); if(error)throw error; giGroup=data; groupSys(gid,(me().username||'Someone')+' changed the group name to "'+v+'"'); renderGroupInfo(giGroup); if(chatGroup&&chatGroup.id===gid){chatGroup=giGroup;$('chatName').textContent=v;} loadMyGroups(); }
    catch(e){ toast('Rename failed: '+sbErr(e)); } });
}
async function removeMember(uid){
  if(!giGroup||giGroup.owner_id!==me().id)return;
  const gid=giGroup.id, ru=await getUser(uid);
  try{ await sb.from('group_members').delete().eq('group_id',gid).eq('user_id',uid); groupSys(gid,(me().username||'Someone')+' removed '+((ru&&ru.username)||'a member')); renderGroupInfo(giGroup); loadMyGroups(); toast('Removed'); }
  catch(e){ toast('Failed: '+sbErr(e)); }
}
async function leaveGroup(){
  if(!giGroup)return; const gid=giGroup.id;
  try{
    const mem=(await getGroupMemberIds(gid)).filter(x=>x!==me().id);
    if(mem.length)await groupSys(gid,(me().username||'Someone')+' left');
    await sb.from('group_members').delete().eq('group_id',gid).eq('user_id',me().id);
    if(!mem.length){ await sb.from('groups').delete().eq('id',gid); }
    else if(giGroup.owner_id===me().id){ await sb.from('groups').update({owner_id:mem[0]}).eq('id',gid); }
    closeGroupInfo(); await loadMyGroups();
    if(chatGroup&&chatGroup.id===gid){ chatGroup=null; closeChat(); }
    show('Chats'); toast('Left group');
  }catch(e){ toast('Failed: '+sbErr(e)); }
}
function openAddMembers(){
  if(!giGroup)return; addMemGid=giGroup.id; $('addMem').classList.add('on');rearm();
  const box=$('amList'); box.innerHTML=skRows(5);
  (async()=>{
    const cur=new Set(await getGroupMemberIds(giGroup.id));
    let ids=[];
    try{ const {data}=await sb.from('follows').select('following_id').eq('follower_id',me().id); ids=(data||[]).map(f=>f.following_id); }catch(e){}
    try{ const {data}=await sb.from('messages').select('sender_id,receiver_id').or('sender_id.eq.'+me().id+',receiver_id.eq.'+me().id).is('group_id',null).order('created_at',{ascending:false}).limit(80); (data||[]).forEach(m=>{const o=m.sender_id===me().id?m.receiver_id:m.sender_id;if(o)ids.push(o);}); }catch(e){}
    ids=[...new Set(ids)].filter(id=>id&&!cur.has(id));
    if(!ids.length){box.innerHTML='<div class="empty">No one left to add</div>';return;}
    const users={}; await Promise.all(ids.map(async id=>{users[id]=await getUser(id);}));
    box.innerHTML=ids.filter(id=>users[id]).map(id=>{const u=users[id];return `<label class="row ngrow"><div class="cav">${avatarHtml(u,44)}</div><div class="last"><div class="nm">${esc(u.username)}</div></div><input type="checkbox" class="amchk" value="${id}"></label>`;}).join('');
  })();
}
function closeAddMembers(){ $('addMem').classList.remove('on'); }
async function confirmAddMembers(){
  const picked=[...document.querySelectorAll('.amchk:checked')].map(c=>c.value);
  if(!picked.length){ closeAddMembers(); return; }
  try{
    const rows=picked.map(uid=>({group_id:addMemGid,user_id:uid}));
    await sb.from('group_members').upsert(rows);
    const us=await Promise.all(picked.map(id=>getUser(id))); const names=us.map(u=>(u&&u.username)||'someone').join(', ');
    groupSys(addMemGid,(me().username||'Someone')+' added '+names);
    closeAddMembers();
    const {data:g}=await sb.from('groups').select('*').eq('id',addMemGid).single(); giGroup=g;
    renderGroupInfo(giGroup); loadMyGroups(); toast('Added');
  }
  catch(e){ toast('Failed: '+sbErr(e)); }
}

/* ================= CALLS (1:1 WebRTC, non-trickle ICE) ================= */
const ICE=[
  {urls:'stun:stun.l.google.com:19302'},
  {urls:'stun:stun.relay.metered.ca:80'},
  // ===== Metered.ca free TURN (NO credit card). Sign up, generate a credential, paste the
  //       username + credential from your dashboard into all four lines, then uncomment them: =====
  // {urls:'turn:global.relay.metered.ca:80',username:'PASTE_USERNAME',credential:'PASTE_CREDENTIAL'},
  // {urls:'turn:global.relay.metered.ca:80?transport=tcp',username:'PASTE_USERNAME',credential:'PASTE_CREDENTIAL'},
  // {urls:'turn:global.relay.metered.ca:443',username:'PASTE_USERNAME',credential:'PASTE_CREDENTIAL'},
  // {urls:'turns:global.relay.metered.ca:443?transport=tcp',username:'PASTE_USERNAME',credential:'PASTE_CREDENTIAL'},
  // ===== Public fallback (works right now with zero setup): =====
  {urls:'turn:openrelay.metered.ca:80',username:'openrelayproject',credential:'openrelayproject'},
  {urls:'turn:openrelay.metered.ca:443',username:'openrelayproject',credential:'openrelayproject'},
  {urls:'turn:openrelay.metered.ca:443?transport=tcp',username:'openrelayproject',credential:'openrelayproject'}
];
let pc=null, localStream=null, remoteStream=null, curCall=null, callRole=null, callState=null;
let callPeer=null, callKind='audio', callTimer=null, callT0=0, callTimeoutT=null;
let answerSet=false, callConnected=false, micOff=false, vidOff=false, callLogged=false;
let ringTimer=null, ringCtx=null, ringVib=null;

function makePc(){
  const p=new RTCPeerConnection({iceServers:ICE});
  p.ontrack=e=>{
    remoteStream=remoteStream||new MediaStream();
    (e.streams[0]?e.streams[0].getTracks():[e.track]).forEach(t=>{ if(!remoteStream.getTracks().includes(t))remoteStream.addTrack(t); });
    const rv=$('rVideo'); rv.srcObject=remoteStream; rv.play&&rv.play().catch(()=>{});
  };
  p.onconnectionstatechange=()=>{
    if(p.connectionState==='connected')onCallConnected();
    if(['failed','closed'].includes(p.connectionState)){ if(curCall)endCall(false); }
  };
  return p;
}
function waitIce(p){ return new Promise(res=>{ if(p.iceGatheringState==='complete')return res(); let done=false; const fin=()=>{if(done)return;done=true;res();}; p.addEventListener('icegatheringstatechange',()=>{if(p.iceGatheringState==='complete')fin();}); setTimeout(fin,2500); }); }
async function getMedia(video){ return navigator.mediaDevices.getUserMedia({audio:true,video:video?{facingMode:'user'}:false}); }
function applyLocalVideo(){ if(callKind==='video'&&localStream){ const lv=$('lVideo'); lv.srcObject=localStream; lv.play&&lv.play().catch(()=>{}); } }

function showCallUI(peer,kind,state){
  callPeer=peer; callKind=kind;
  const c=$('call'); c.classList.toggle('audio',kind!=='video'); c.classList.add('on');
  $('callName').textContent=(peer&&(peer.name||peer.username))||'Call';
  $('callAvatar').innerHTML=peer?avatarHtml(peer,124):'';
  setCallState(state);
}
function setCallState(s){
  callState=s; const st=$('callStatus');
  if(s==='outgoing')st.textContent='Ringing...';
  else if(s==='incoming')st.textContent=(callKind==='video'?'Incoming video call':'Incoming voice call');
  else if(s==='connecting')st.textContent='Connecting...';
  else if(s==='connected'){}
  renderCallCtrls();
}
function renderCallCtrls(){
  const box=$('callCtrls');
  if(callState==='incoming'){
    box.innerHTML=`<button class="cbtn end" onclick="declineCall()">${icon('phone',26)}</button><button class="cbtn accept" onclick="acceptCall()">${icon('phone',26)}</button>`;
    return;
  }
  const mic=`<button class="cbtn tog ${micOff?'off':''}" onclick="toggleMic()">${icon(micOff?'micOff':'mic',24)}</button>`;
  const vid=callKind==='video'?`<button class="cbtn tog ${vidOff?'off':''}" onclick="toggleVid()">${icon(vidOff?'videoOff':'video',24)}</button>`:'';
  const end=`<button class="cbtn end" onclick="endCall(true)">${icon('phone',26)}</button>`;
  box.innerHTML=mic+vid+end;
}
function toggleMic(){ if(!localStream)return; micOff=!micOff; localStream.getAudioTracks().forEach(t=>t.enabled=!micOff); renderCallCtrls(); }
function toggleVid(){ if(!localStream)return; vidOff=!vidOff; localStream.getVideoTracks().forEach(t=>t.enabled=!vidOff); renderCallCtrls(); }
function onCallConnected(){ if(callState==='connected')return; clearTimeout(callTimeoutT); callConnected=true; stopRing(); setCallState('connected'); callT0=Date.now(); clearInterval(callTimer); callTimer=setInterval(()=>{ const s=Math.floor((Date.now()-callT0)/1000); $('callStatus').textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); },1000); }

async function startCall(kind){
  if(!chatUser){toast('Open a direct chat to call');return;}
  if(curCall||pc){toast('Already in a call');return;}
  try{ localStream=await getMedia(kind==='video'); }catch(e){ toast('Allow mic/camera to call'); return; }
  pc=makePc(); localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  callRole='caller'; answerSet=false; callConnected=false; micOff=false; vidOff=false;
  showCallUI(chatUser,kind,'outgoing'); applyLocalVideo();
  try{
    const offer=await pc.createOffer(); await pc.setLocalDescription(offer); await waitIce(pc);
    const {data,error}=await sb.from('calls').insert({caller_id:me().id,callee_id:chatUser.id,kind,status:'ringing',offer:JSON.stringify(pc.localDescription)}).select().single();
    if(error) throw error;
    curCall=data;
  }catch(e){ toast('Call failed: '+sbErr(e)); endCall(false); return; }
  callTimeoutT=setTimeout(()=>{ if(curCall&&!callConnected&&callRole==='caller'){ toast('No answer'); endCall(true,'missed'); } },35000);
}
function onIncoming(rec){
  if(curCall||pc||gcall){ sb.from('calls').update({status:'declined'}).eq('id',rec.id).then(()=>{}).catch(()=>{}); return; }
  curCall=rec; callRole='callee'; answerSet=false; callConnected=false; micOff=false; vidOff=false;
  getUser(rec.caller_id).then(u=>{ showCallUI(u||{username:'Caller'},rec.kind,'incoming'); startRing(); });
}
async function acceptCall(){
  if(!curCall)return; stopRing(); const rec=curCall;
  try{ localStream=await getMedia(rec.kind==='video'); }catch(e){ toast('Allow mic/camera'); declineCall(); return; }
  pc=makePc(); localStream.getTracks().forEach(t=>pc.addTrack(t,localStream)); applyLocalVideo();
  try{
    await pc.setRemoteDescription(JSON.parse(rec.offer));
    const ans=await pc.createAnswer(); await pc.setLocalDescription(ans); await waitIce(pc);
    const {error}=await sb.from('calls').update({status:'accepted',answer:JSON.stringify(pc.localDescription)}).eq('id',rec.id);
    if(error) throw error;
  }catch(e){ toast('Answer failed: '+sbErr(e)); endCall(false); return; }
  setCallState('connecting');
}
function declineCall(){ endCall(true,'declined'); }
function endCall(updateRemote,status,logState){
  stopRing();
  const cur=curCall;
  if(cur&&callRole==='caller'&&!callLogged){
    callLogged=true;
    const st=logState||(callConnected?'ended':'missed');
    const dur=callConnected?Math.max(0,Math.round((Date.now()-callT0)/1000)):0;
    const callee=cur.callee_id, conv=convKey(me().id,callee), kind=callKind;
    sb.from('messages').insert({sender_id:me().id,receiver_id:callee,conversation:conv,call:kind+':'+st+':'+dur}).select().single().then(({data:r})=>{
      if(r&&chatUser&&chatUser.id===callee&&$('chat').style.display==='flex')appendBubble(r);
      if(currentScreen==='Chats')loadChats();
    }).catch(()=>{});
  }
  if(updateRemote&&cur){ sb.from('calls').update({status:status||'ended'}).eq('id',cur.id).then(()=>{}).catch(()=>{}); }
  if(pc){try{pc.close();}catch(_){}}
  if(localStream){localStream.getTracks().forEach(t=>t.stop());}
  try{$('rVideo').srcObject=null;$('lVideo').srcObject=null;}catch(_){}
  clearInterval(callTimer); clearTimeout(callTimeoutT);
  pc=null;localStream=null;remoteStream=null;curCall=null;callRole=null;callState=null;
  answerSet=false;callConnected=false;micOff=false;vidOff=false;callLogged=false;
  $('call').classList.remove('on');
}
function startRing(){
  try{ ringCtx=ringCtx||new (window.AudioContext||window.webkitAudioContext)(); ringCtx.resume&&ringCtx.resume();
    const beep=()=>{ try{ const o=ringCtx.createOscillator(),g=ringCtx.createGain(); o.frequency.value=520; o.type='sine'; o.connect(g); g.connect(ringCtx.destination); const t=ringCtx.currentTime; g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(0.25,t+0.05); g.gain.exponentialRampToValueAtTime(0.0001,t+0.5); o.start(t); o.stop(t+0.55); }catch(_){} };
    beep(); clearInterval(ringTimer); ringTimer=setInterval(beep,1600);
  }catch(_){}
  try{ if(navigator.vibrate){ navigator.vibrate([400,250,400]); clearInterval(ringVib); ringVib=setInterval(()=>navigator.vibrate([400,250,400]),1600); } }catch(_){}
}
function stopRing(){ clearInterval(ringTimer); ringTimer=null; clearInterval(ringVib); ringVib=null; try{navigator.vibrate&&navigator.vibrate(0);}catch(_){} }
async function openCallFromId(cid){
  try{ const {data:rec}=await sb.from('calls').select('*').eq('id',cid).single(); if(rec&&rec.callee_id===me().id&&rec.status==='ringing')onIncoming(rec); }catch(e){}
}
/* Tapping "Answer" on the OS notification should skip the extra "now also
   tap Accept inside the app" step. */
async function autoAnswerCall(cid){
  try{
    const {data:rec}=await sb.from('calls').select('*').eq('id',cid).single();
    if(rec&&rec.callee_id===me().id&&rec.status==='ringing'){ onIncoming(rec); await acceptCall(); }
  }catch(e){}
}
/* ===== GROUP CALLS (mesh, non-trickle) ===== */
let gcall=null, gLocal=null, gpeers={}, gMic=false, gVid=false, gIncoming=null, gcTimer=null, gcT0=0;
function gMakePc(uid){
  const p=new RTCPeerConnection({iceServers:ICE});
  p.ontrack=e=>{
    let st=gpeers[uid]&&gpeers[uid].stream; if(!st){st=new MediaStream();if(gpeers[uid])gpeers[uid].stream=st;}
    (e.streams[0]?e.streams[0].getTracks():[e.track]).forEach(t=>{ if(!st.getTracks().includes(t))st.addTrack(t); });
    const v=document.getElementById('gv_'+uid); if(v){v.srcObject=st;v.play&&v.play().catch(()=>{});}
    const t=document.getElementById('gtile_'+uid); if(t)t.classList.add('live');
  };
  p.onconnectionstatechange=()=>{
    const t=document.getElementById('gtile_'+uid);
    if(p.connectionState==='connected'){ if(t)t.classList.add('live'); startGcTimer(); }
    if(['failed','closed'].includes(p.connectionState))removeGPeer(uid);
  };
  return p;
}
function startGcTimer(){ if(gcTimer)return; gcT0=Date.now(); const tick=()=>{const s=Math.floor((Date.now()-gcT0)/1000);const el=$('gcStatus');if(el)el.textContent=fmtDur(s);}; tick(); gcTimer=setInterval(tick,1000); }
function gcDiag(msg){ toast(msg); }
function gAddLocal(pc){ if(gLocal)gLocal.getTracks().forEach(t=>pc.addTrack(t,gLocal)); }
function gsigSend(to,type,data){ if(!gcall)return; sb.from('gsig').insert({group_id:gcall.group,from_id:me().id,to_id:to,type:type,data:data||''}).then(()=>{}).catch(e=>gcDiag('signal err: '+sbErr(e))); }
function layoutGrid(){ const grid=$('gcGrid'); grid.style.gridTemplateColumns = grid.children.length<=1?'1fr':'1fr 1fr'; }
function addGTile(uid){
  if(document.getElementById('gtile_'+uid))return;
  const isMe=uid==='me', u=isMe?me():(grpUsers[uid]||{username:'user'}), name=isMe?'You':(u.username||'user');
  const t=document.createElement('div');
  t.className='gctile'+(isMe?'':' remote')+(gcall&&gcall.kind!=='video'?' audio':''); t.id='gtile_'+uid;
  t.innerHTML=`<video id="gv_${uid}" autoplay playsinline ${isMe?'muted':''}></video><div class="gcav">${avatarHtml(u,76)}</div><div class="gclbl">${esc(name)}</div>`;
  $('gcGrid').appendChild(t);
  if(isMe&&gLocal){ const v=t.querySelector('video'); v.srcObject=gLocal; v.play&&v.play().catch(()=>{}); }
  layoutGrid();
}
function removeGPeer(uid){ const p=gpeers[uid]; if(p&&p.pc){try{p.pc.close();}catch(_){}} delete gpeers[uid]; const t=document.getElementById('gtile_'+uid); if(t)t.remove(); layoutGrid(); }
function renderGCtrls(){
  const mic=`<button class="cbtn tog ${gMic?'off':''}" onclick="gToggleMic()">${icon(gMic?'micOff':'mic',24)}</button>`;
  const vid=(gcall&&gcall.kind==='video')?`<button class="cbtn tog ${gVid?'off':''}" onclick="gToggleVid()">${icon(gVid?'videoOff':'video',24)}</button>`:'';
  $('gcCtrls').innerHTML=mic+vid+`<button class="cbtn end" onclick="endGroupCall()">${icon('phone',26)}</button>`;
}
function gToggleMic(){ if(!gLocal)return; gMic=!gMic; gLocal.getAudioTracks().forEach(t=>t.enabled=!gMic); renderGCtrls(); }
function gToggleVid(){ if(!gLocal)return; gVid=!gVid; gLocal.getVideoTracks().forEach(t=>t.enabled=!gVid); renderGCtrls(); }
function showGCallUI(rec){
  const g=(myGroups.find(x=>x.id===rec.group_id))||{name:'Group'};
  $('gcName').textContent=g.name||'Group'; $('gcStatus').textContent='Connecting...';
  $('gcall').classList.toggle('audio',rec.kind!=='video'); $('gcall').classList.add('on');
  renderGCtrls();
}
async function startGroupCall(kind){
  if(!chatGroup)return; if(gcall||curCall||pc){toast('Already in a call');return;}
  const gid=chatGroup.id;
  try{
    const {data:rec,error}=await sb.from('groupcalls').insert({group_id:gid,kind,starter_id:me().id,active:true}).select().single();
    if(error) throw error;
    await sb.from('groupcall_participants').insert({groupcall_id:rec.id,user_id:me().id});
    groupSys(gid,(me().username||'Someone')+' started a group '+(kind==='video'?'video ':'')+'call'); joinGroupCall(rec);
  }
  catch(e){ toast('Call failed: '+sbErr(e)); }
}
async function joinGroupCall(rec){
  if(gcall)return;
  try{ gLocal=await getMedia(rec.kind==='video'); }catch(e){ toast('Allow mic/camera'); return; }
  gcall={group:rec.group_id,kind:rec.kind,id:rec.id}; gMic=false; gVid=false; gpeers={};
  try{ const mem=await getGroupMemberIds(rec.group_id); await Promise.all(mem.map(async id=>{grpUsers[id]=await getUser(id);})); }catch(e){}
  showGCallUI(rec); $('gcGrid').innerHTML=''; addGTile('me');
  let existing=[];
  try{
    const {data:parts}=await sb.from('groupcall_participants').select('user_id').eq('groupcall_id',rec.id);
    existing=(parts||[]).map(p=>p.user_id).filter(id=>id&&id!==me().id);
    await sb.from('groupcall_participants').upsert({groupcall_id:rec.id,user_id:me().id});
    await sb.from('groupcalls').update({active:true}).eq('id',rec.id);
  }catch(e){}
  for(const uid of existing){ await gOffer(uid); }
}
async function gOffer(uid){
  if(gpeers[uid]&&gpeers[uid].pc)return;
  const p=gMakePc(uid); gpeers[uid]={pc:p,stream:null}; addGTile(uid); gAddLocal(p);
  try{ const o=await p.createOffer(); await p.setLocalDescription(o); await waitIce(p); gsigSend(uid,'offer',JSON.stringify(p.localDescription)); }catch(e){ gcDiag('offer err: '+sbErr(e)); }
}
async function gOnOffer(from,sdp){
  if(gpeers[from]&&gpeers[from].pc){try{gpeers[from].pc.close();}catch(_){}}
  const p=gMakePc(from); gpeers[from]={pc:p,stream:null}; addGTile(from); gAddLocal(p);
  try{ await p.setRemoteDescription(JSON.parse(sdp)); const a=await p.createAnswer(); await p.setLocalDescription(a); await waitIce(p); gsigSend(from,'answer',JSON.stringify(p.localDescription)); }catch(e){ gcDiag('answer err: '+sbErr(e)); }
}
function gOnAnswer(from,sdp){ const peer=gpeers[from]; if(peer&&peer.pc){ peer.pc.setRemoteDescription(JSON.parse(sdp)).catch(e=>gcDiag('setans err: '+sbErr(e))); } }
function gShowIncoming(rec){
  if(curCall||gcall||gIncoming)return;
  gIncoming=rec;
  const g=(myGroups.find(x=>x.id===rec.group_id))||{name:'Group'};
  $('gcName').textContent=g.name||'Group'; $('gcStatus').textContent='Incoming group '+(rec.kind==='video'?'video ':'')+'call';
  $('gcGrid').innerHTML=''; $('gcall').classList.toggle('audio',rec.kind!=='video'); $('gcall').classList.add('on');
  $('gcCtrls').innerHTML=`<button class="cbtn end" onclick="gDecline()">${icon('phone',26)}</button><button class="cbtn accept" onclick="gAccept()">${icon('phone',26)}</button>`;
  startRing();
}
function gAccept(){ stopRing(); const rec=gIncoming; gIncoming=null; $('gcStatus').textContent=''; if(rec)joinGroupCall(rec); }
function gDecline(){ stopRing(); gIncoming=null; $('gcall').classList.remove('on'); }
async function endGroupCall(){
  stopRing();
  clearInterval(gcTimer); gcTimer=null; gcT0=0;
  const g=gcall;
  Object.keys(gpeers).forEach(uid=>gsigSend(uid,'leave',''));
  Object.keys(gpeers).forEach(uid=>{try{gpeers[uid].pc.close();}catch(_){}});
  gpeers={};
  if(gLocal){gLocal.getTracks().forEach(t=>t.stop());gLocal=null;}
  $('gcGrid').innerHTML=''; $('gcStatus').textContent=''; $('gcall').classList.remove('on');
  gcall=null; gMic=false; gVid=false;
  if(g){
    try{
      await sb.from('groupcall_participants').delete().eq('groupcall_id',g.id).eq('user_id',me().id);
      const {count}=await sb.from('groupcall_participants').select('user_id',{count:'exact',head:true}).eq('groupcall_id',g.id);
      if(!count) await sb.from('groupcalls').update({active:false}).eq('id',g.id);
    }catch(e){}
  }
}
async function openGroupCallFromGroup(gid){ try{ const {data}=await sb.from('groupcalls').select('*').eq('group_id',gid).eq('active',true).order('created_at',{ascending:false}).limit(1); if(data&&data[0])gShowIncoming(data[0]); }catch(e){} }
function subscribeGroupSig(){
  sb.channel('gsig-ch').on('postgres_changes',{event:'INSERT',schema:'public',table:'gsig'},payload=>{
    const s=payload.new;
    if(s.to_id!==me().id||s.from_id===me().id||!gcall||s.group_id!==gcall.group)return;
    if(s.type==='offer')gOnOffer(s.from_id,s.data);
    else if(s.type==='answer')gOnAnswer(s.from_id,s.data);
    else if(s.type==='leave')removeGPeer(s.from_id);
  }).subscribe();
}
function subscribeGroupCalls(){
  sb.channel('groupcalls-ch').on('postgres_changes',{event:'INSERT',schema:'public',table:'groupcalls'},payload=>{
    const r=payload.new;
    if(r.active&&r.starter_id!==me().id&&myGroupIds.has(r.group_id)&&!gcall&&!curCall){ gShowIncoming(r); }
  }).subscribe();
}
function placeCall(kind){ if(chatGroup)startGroupCall(kind); else startCall(kind); }

function subscribeCalls(){
  sb.channel('calls-ch')
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'calls'},payload=>{
      const r=payload.new;
      if(r.caller_id!==me().id&&r.callee_id!==me().id)return;
      if(r.callee_id===me().id&&r.status==='ringing')onIncoming(r);
    })
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'calls'},payload=>{
      const r=payload.new;
      if(r.caller_id!==me().id&&r.callee_id!==me().id)return;
      if(curCall&&r.id===curCall.id){
        if(callRole==='caller'&&r.answer&&!answerSet){ answerSet=true; pc.setRemoteDescription(JSON.parse(r.answer)).then(()=>setCallState('connecting')).catch(()=>{}); }
        if(['declined','ended','missed'].includes(r.status)){ const m=r.status==='declined'?'Call declined':'Call ended'; endCall(false,null,r.status==='declined'?'declined':undefined); toast(m); }
      }
    })
    .subscribe();
}

/* ================= PRESENCE ================= */
let hbTimer=null, presenceChannel=null, presenceTimer=null;
async function heartbeat(){ try{ await sb.from('profiles').update({last_seen:new Date().toISOString()}).eq('id',me().id); }catch(e){} }
function startHeartbeat(){ heartbeat(); clearInterval(hbTimer); hbTimer=setInterval(()=>{if(document.visibilityState==='visible')heartbeat();},25000); document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')heartbeat();}); }
function renderPresence(){
  if(!chatUser)return; const dot=$('chatDot'),txt=$('chatStatusTxt');
  if(isOnline(chatUser)){dot.classList.add('on');txt.textContent='Online';txt.style.color='#3ddc84';}
  else if(chatUser.last_seen){dot.classList.remove('on');txt.textContent='last seen '+timeAgo(chatUser.last_seen);txt.style.color='var(--mut)';}
  else {dot.classList.remove('on');txt.textContent='@'+chatUser.username;txt.style.color='var(--mut)';}
}
async function startPresence(){
  cleanupPresence();
  presenceTimer=setInterval(renderPresence,15000);
  try{
    presenceChannel=sb.channel('presence-'+chatUser.id)
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'profiles',filter:'id=eq.'+chatUser.id},payload=>{
        if(chatUser&&payload.new.id===chatUser.id){ chatUser={...chatUser,...payload.new}; renderPresence(); }
      })
      .subscribe();
  }catch(e){}
}
function cleanupPresence(){ if(presenceChannel){ try{sb.removeChannel(presenceChannel);}catch(e){} presenceChannel=null; } if(presenceTimer){clearInterval(presenceTimer);presenceTimer=null;} }

/* ============ STORIES / FOLLOW / POST MENU ============ */
let feedMode='all', postCaption={}, postAuthor={}, postVideo={}, pmId=null, capEditId=null, pvId=null, commentText={}, clikeState={}, commentAuthor={}, commentPost={};
let storyGroups={}, storyUsers={}, storyOrder=[];
let svUser=null, svList=[], svIdx=0, svTimer=null, storyFileInput=null, storyViewed=new Set();
async function loadStories(){
  const tray=$('storyTray'); if(!tray)return;
  const fallback=`<div class="scell sadd"><div class="sring" onclick="addStory()"><div class="cav">${avatarHtml(me(),58)}<span class="plus" onclick="event.stopPropagation();addStory()">+</span></div></div><div class="nm">Your story</div></div>`;
  tray.innerHTML=fallback+skStories(4);
  try{
    const since=new Date(Date.now()-86400000).toISOString();
    const {data:items,error}=await sb.from('stories').select('*').gte('created_at',since).order('created_at');
    if(error) throw error;
    storyGroups={}; const order=[];
    (items||[]).forEach(s=>{ if(!storyGroups[s.author_id]){storyGroups[s.author_id]=[]; if(s.author_id!==me().id)order.push(s.author_id);} storyGroups[s.author_id].push(s); });
    let seenSet=new Set();
    try{ const {data:sv}=await sb.from('story_views').select('story_id').eq('viewer_id',me().id); (sv||[]).forEach(v=>seenSet.add(v.story_id)); }catch(e){}
    const users={};
    await Promise.all(order.map(async id=>{users[id]=await getUser(id);}));
    users[me().id]=me(); storyUsers=users;
    const mine=storyGroups[me().id]&&storyGroups[me().id].length;
    storyOrder=(mine?[me().id]:[]).concat(order.filter(id=>users[id]));
    let cells=`<div class="scell sadd"><div class="sring ${mine?'has':''}" onclick="${mine?`openStory('${me().id}')`:'addStory()'}"><div class="cav">${avatarHtml(me(),58)}<span class="plus" onclick="event.stopPropagation();addStory()">+</span></div></div><div class="nm">Your story</div></div>`;
    cells+=order.filter(id=>users[id]).map(id=>{const allSeen=storyGroups[id].every(s=>seenSet.has(s.id));return `<div class="scell" onclick="openStory('${id}')"><div class="sring has ${allSeen?'seen':''}">${avatarHtml(users[id],58)}</div><div class="nm">${esc(users[id].username)}</div></div>`;}).join('');
    tray.innerHTML=cells;
  }catch(e){ tray.innerHTML=fallback; }
}
let storyComposeFile=null, storyComposeUrl=null, storyCropper=null;
function addStory(){
  if(!storyFileInput){ storyFileInput=document.createElement('input'); storyFileInput.type='file'; storyFileInput.accept='image/*'; document.body.appendChild(storyFileInput);
    storyFileInput.onchange=()=>{ const f=storyFileInput.files[0]; storyFileInput.value=''; if(!f)return; openStoryCompose(f); };
  }
  storyFileInput.click();
}
function openStoryCompose(f){
  storyComposeFile=f; storyCropper=null;
  if(storyComposeUrl)URL.revokeObjectURL(storyComposeUrl);
  storyComposeUrl=URL.createObjectURL(f);
  $('scTags').value='';
  $('storyCompose').classList.add('on');rearm();
  const img=new Image();
  img.onload=()=>{
    const box=$('scPrev'), bw=box.clientWidth||360, bh=box.clientHeight||640;
    let H=bh, W=Math.round(H*9/16);
    if(W>bw){ W=bw; H=Math.round(W*16/9); }
    box.innerHTML=`<canvas id="storyCropCanvas" style="width:${W}px;height:${H}px;touch-action:none;cursor:grab;border-radius:10px"></canvas>`;
    storyCropper=makeImageCropper($('storyCropCanvas'),img,W,H);
  };
  img.onerror=()=>toast('Could not read image');
  img.src=storyComposeUrl;
}
function closeStoryCompose(){ $('storyCompose').classList.remove('on'); if(storyComposeUrl){URL.revokeObjectURL(storyComposeUrl);storyComposeUrl=null;} storyComposeFile=null; storyCropper=null; }
$('scClose').onclick=closeStoryCompose;
$('scPost').onclick=async()=>{
  if(!storyComposeFile||!storyCropper)return;
  const tagStr=$('scTags').value.trim(); const btn=$('scPost'); btn.disabled=true; btn.textContent='Posting…';
  try{
    showUpload('Posting story…'); setUpload(30);
    const blob=await storyCropper.exportBlob(1080,1920,0.82);
    const url=await uploadFile('stories',me().id+'/'+randPath()+'.jpg',new File([blob],'story.jpg',{type:'image/jpeg'}));
    setUpload(80);
    const row={author_id:me().id,image_url:url}; if(tagStr)row.tags=tagStr;
    const {error}=await sb.from('stories').insert(row);
    if(error) throw error;
    hideUpload();
    notifyTags(tagStr,'');
    toast('Story added'); closeStoryCompose(); loadStories();
  }
  catch(e){ hideUpload(); toast('Story failed: '+sbErr(e)); }
  finally{ btn.disabled=false; btn.textContent='Post'; }
};
function openStory(uid,startIdx){
  svList=(storyGroups[uid]||[]).slice(); if(!svList.length){toast('No active story');return;}
  svUser=storyUsers[uid]||{username:'user',id:uid};
  svIdx=(startIdx==null)?0:Math.max(0,Math.min(startIdx,svList.length-1));
  buildStoryView(); $('storyView').classList.add('on'); rearm(); playStory();
}
function adjStoryUser(dir){
  if(!svUser)return null;
  const i=storyOrder.indexOf(svUser.id); if(i<0)return null;
  const j=i+dir; if(j<0||j>=storyOrder.length)return null;
  const uid=storyOrder[j];
  return (storyGroups[uid]&&storyGroups[uid].length)?uid:null;
}
function buildStoryView(){
  const bars=svList.map((_,i)=>`<div class="sbar"><i id="sbar_${i}"></i></div>`).join('');
  const x='<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  $('storyView').innerHTML=`<div class="sbars">${bars}</div>
    <div class="shead">${avatarHtml(svUser,32)}<div class="nm">${esc(svUser.username||'You')}</div><span class="sleft" id="svLeft"></span><button class="sclose" onclick="closeStory()">${x}</button></div>
    <div class="simg" id="svImg"></div>
    <div class="szones"><div onclick="prevStory()"></div><div onclick="nextStory()"></div></div>
    <div id="svTags" style="position:absolute;bottom:${svUser.id===me().id?'84px':'134px'};left:16px;right:80px;color:#fff;font-size:13px;z-index:3;text-shadow:0 1px 4px #000"></div>
    ${svUser.id===me().id?`<div id="svSeen" onclick="openSeenList()" style="position:absolute;bottom:24px;left:16px;color:#fff;font-size:13px;z-index:3;cursor:pointer"></div><button id="svDel" class="btn" style="position:absolute;bottom:18px;right:16px;width:auto;padding:9px 20px;border-radius:22px;background:rgba(0,0,0,.55);color:#fff;border:1px solid rgba(255,255,255,.25);z-index:3">Delete</button>`:`<div class="sreacts">${REACT_ORDER.map(k=>`<button class="sreactbtn" onclick="sReact('${k}')">${reactIcon(k,30)}</button>`).join('')}</div><div class="sreply"><input id="sReplyInput" placeholder="Reply to ${esc(svUser.username||'')}…" onfocus="clearTimeout(svTimer)" onkeydown="if(event.key==='Enter')sReply()"><button id="sLikeBtn" class="sheart" onclick="sLike()">${icon('heart',26)}</button></div>`}`;
  const d=$('svDel'); if(d)d.onclick=delStory;
}
function showStoryFrame(){
  const s=svList[svIdx]; if(!s)return;
  $('svImg').innerHTML=`<img class="blur-load" src="${s.image_url}" onload="this.classList.add('loaded')">`;
  svList.forEach((_,i)=>{const b=$('sbar_'+i);if(b){b.style.transition='none';b.style.width=i<svIdx?'100%':'0';}});
  const tg=$('svTags'); if(tg)tg.innerHTML=storyTagsLine(s.tags);
  const lf=$('svLeft');
  if(lf){ const t=storyTimeLeft(s.created_at); lf.textContent=t?t.label:''; lf.classList.toggle('urgent',!!(t&&t.urgent)); }
  if(svUser.id!==me().id){
    refreshStoryLike();
    if(!storyViewed.has(s.id)){ storyViewed.add(s.id); sb.from('story_views').upsert({story_id:s.id,viewer_id:me().id},{onConflict:'story_id,viewer_id',ignoreDuplicates:true}).then(()=>{}).catch(()=>{}); }
  } else { updateSeen(s.id); }
}
function playStory(){ showStoryFrame(); clearTimeout(svTimer); const bar=$('sbar_'+svIdx); if(bar){bar.style.transition='none';bar.style.width='0';requestAnimationFrame(()=>{bar.style.transition='width 5000ms linear';bar.style.width='100%';});} svTimer=setTimeout(nextStory,5000); }
function nextStory(){ clearTimeout(svTimer); const bar=$('sbar_'+svIdx); if(bar){bar.style.transition='none';bar.style.width='100%';} if(svIdx+1<svList.length){svIdx++;playStory();return;} const nu=adjStoryUser(1); if(nu){openStory(nu);return;} closeStory(); }
function prevStory(){ clearTimeout(svTimer); if(svIdx>0){const bar=$('sbar_'+svIdx); if(bar){bar.style.transition='none';bar.style.width='0';} svIdx--; playStory(); return;} const pu=adjStoryUser(-1); if(pu){openStory(pu,(storyGroups[pu]||[]).length-1);return;} playStory(); }
function closeStory(){ clearTimeout(svTimer); $('storyView').classList.remove('on'); $('storyView').innerHTML=''; svList=[]; loadStories(); }
function storyTagsLine(s){ const n=parseTags(s); if(!n.length)return ''; return 'with '+n.map(x=>`<span class="tagm" onclick="openProfileByUsername('${x}')">@${esc(x)}</span>`).join(' '); }
async function refreshStoryLike(){
  const s=svList[svIdx],b=$('sLikeBtn'); if(!s||!b)return;
  try{
    const {data}=await sb.from('story_likes').select('id').eq('story_id',s.id).eq('user_id',me().id).maybeSingle();
    const liked=!!data; b.dataset.lid=liked?data.id:''; b.classList.toggle('liked',liked);
    const g=b.querySelector('svg'); if(g)g.setAttribute('fill',liked?'currentColor':'none');
  }catch(e){}
}
async function sLike(){
  const s=svList[svIdx],b=$('sLikeBtn'); if(!s||!b)return; const lid=b.dataset.lid;
  try{
    if(lid){ await sb.from('story_likes').delete().eq('id',lid); b.dataset.lid=''; b.classList.remove('liked'); const g=b.querySelector('svg'); if(g)g.setAttribute('fill','none'); }
    else{ const {data:r}=await sb.from('story_likes').insert({story_id:s.id,user_id:me().id,reaction:'love'}).select().single(); b.dataset.lid=r.id; b.classList.add('liked'); const g=b.querySelector('svg'); if(g)g.setAttribute('fill','currentColor'); if(svUser&&svUser.id!==me().id)notify('storylike',svUser.id,{}); }
  }catch(e){toast('Like failed: '+sbErr(e));}
}
async function sReply(){ const inp=$('sReplyInput'); if(!inp)return; const t=inp.value.trim(); if(!t||!svUser)return; inp.value=''; try{ const key=convKey(me().id,svUser.id); await sb.from('messages').insert({sender_id:me().id,receiver_id:svUser.id,conversation:key,text:t}); toast('Reply sent'); }catch(e){toast('Reply failed: '+sbErr(e));} clearTimeout(svTimer); svTimer=setTimeout(nextStory,3000); }
const STORY_EMOJI={like:0x1F44D,love:0x2764,haha:0x1F602,wow:0x1F62E,sad:0x1F622,fire:0x1F525};
async function sReact(key){
  const s=svList[svIdx];
  if(!svUser||!s)return; clearTimeout(svTimer);
  const emoji=String.fromCodePoint(STORY_EMOJI[key]||0x2764);
  try{
    /* Record it as a real reaction as well as DM-ing the emoji. The DM is
       what the viewer expects (that's how story reactions read), but on
       its own it left the author no way to see reactions in aggregate -
       the story just showed a view count. */
    await sb.from('story_likes').upsert({story_id:s.id,user_id:me().id,reaction:key},{onConflict:'story_id,user_id'});
    const k=convKey(me().id,svUser.id);
    await sb.from('messages').insert({sender_id:me().id,receiver_id:svUser.id,conversation:k,text:emoji});
    toast('Reaction sent');
    if(svUser.id!==me().id)notify('storylike',svUser.id,{});
    refreshStoryLike();
  }
  catch(e){ toast('Reaction failed: '+sbErr(e)); }
  svTimer=setTimeout(nextStory,2500);
}
async function delStory(){ const s=svList[svIdx]; if(!s)return; try{ await sb.from('stories').delete().eq('id',s.id); svList.splice(svIdx,1); toast('Story deleted'); loadStories(); if(!svList.length){closeStory();return;} if(svIdx>=svList.length)svIdx=svList.length-1; buildStoryView(); playStory(); }catch(e){toast('Delete failed');} }
/* Author-side feedback loop: raw view count, how many of those landed in
   the last hour (the "it's happening right now" pull), and how many people
   reacted - reactions were previously invisible to the author entirely. */
async function updateSeen(storyId){
  const el=$('svSeen'); if(!el)return;
  el.dataset.story=storyId; el.textContent='Seen by …';
  try{
    const hourAgo=new Date(Date.now()-3600000).toISOString();
    const [{count:views},{count:recent},{count:reacts}]=await Promise.all([
      sb.from('story_views').select('id',{count:'exact',head:true}).eq('story_id',storyId),
      sb.from('story_views').select('id',{count:'exact',head:true}).eq('story_id',storyId).gte('created_at',hourAgo),
      sb.from('story_likes').select('id',{count:'exact',head:true}).eq('story_id',storyId)
    ]);
    let txt='Seen by '+(views||0);
    if(recent)txt+=' · '+recent+' in the last hour';
    if(reacts)txt+=' · '+reacts+' reaction'+(reacts===1?'':'s');
    el.textContent=txt;
  }catch(e){ el.textContent=''; }
}
/* Stories are gone 24h after they're posted (loadStories only fetches that
   window). Showing the time left is the whole point of an ephemeral post -
   it's what turns "I'll look later" into "I'll look now". */
function storyTimeLeft(createdAt){
  const msLeft=86400000-(Date.now()-new Date(createdAt).getTime());
  if(msLeft<=0)return null;
  const mins=Math.floor(msLeft/60000);
  if(mins<60)return {label:mins+'m left',urgent:true};
  const hrs=Math.floor(mins/60);
  return {label:hrs+'h left',urgent:hrs<3};
}
async function openSeenList(){
  const el=$('svSeen'); const sid=el&&el.dataset.story; if(!sid)return; clearTimeout(svTimer);
  $('listView').classList.add('on'); rearm(); $('listTitle').textContent='Viewers'; const body=$('listBody'); body.innerHTML=skRows(8);
  try{
    const {data:rows,error}=await sb.from('story_views').select('viewer_id').eq('story_id',sid);
    if(error) throw error;
    const ids=[...new Set((rows||[]).map(r=>r.viewer_id))];
    if(!ids.length){body.innerHTML='<div class="empty">No views yet</div>';return;}
    const users={}; await Promise.all(ids.map(async id=>{users[id]=await getUser(id);}));
    body.innerHTML=ids.filter(id=>users[id]).map(id=>{const u=users[id];return `<div class="row" onclick="openProfile('${id}');closeList();"><div class="cav">${avatarHtml(u,44)}</div><div class="last"><div class="nm">${esc(u.username)}</div></div></div>`;}).join('');
  }catch(e){ body.innerHTML='<div class="empty">Could not load viewers</div>'; }
}
async function toggleFollow(uid,followId){
  const btn=$('followBtn'); if(btn)btn.disabled=true;
  try{ if(followId){await sb.from('follows').delete().eq('id',followId);} else {await sb.from('follows').insert({follower_id:me().id,following_id:uid});notify('follow',uid);} loadProfile(uid); }
  catch(e){ toast('Follow failed: '+sbErr(e)); if(btn)btn.disabled=false; }
}
function openPostMenu(pid){pmId=pid;$('pmRegen').style.display=postVideo[pid]?'block':'none';$('postMenuWrap').classList.add('on');rearm();}
function closePostMenu(){$('postMenuWrap').classList.remove('on');}
$('pmCancel').onclick=closePostMenu;
$('postMenuWrap').onclick=e=>{if(e.target.id==='postMenuWrap')closePostMenu();};
$('pmDelete').onclick=async()=>{const id=pmId;closePostMenu();if(!id)return;try{await sb.from('posts').delete().eq('id',id);const el=$('post_'+id);if(el)el.remove();if($('postView').classList.contains('on')){closePostView();if(currentScreen==='Search')runSearch($('searchInput').value.trim());else if(currentScreen==='Profile')loadProfile(me().id);else loadFeedPosts(true);}toast('Post deleted');}catch(e){toast('Delete failed: '+sbErr(e));}};
$('pmRegen').onclick=()=>{const id=pmId;closePostMenu();regenThumb(id);};
$('pmInsights').onclick=()=>{const id=pmId;closePostMenu();openInsights(id);};
$('insightsClose').onclick=closeInsights;
$('insightsWrap').onclick=e=>{if(e.target.id==='insightsWrap')closeInsights();};
function closeInsights(){$('insightsWrap').classList.remove('on');}
function insightsRow(label,val){return `<div style="display:flex;justify-content:space-between;align-items:center"><span style="color:var(--mut)">${label}</span><b style="font-size:16px">${val}</b></div>`;}
async function openInsights(pid){
  if(!pid)return;
  $('insightsWrap').classList.add('on'); rearm();
  const body=$('insightsBody'); body.innerHTML=insightsRow('Views','…')+insightsRow('Likes','…')+insightsRow('Comments','…')+insightsRow('From people you follow','…');
  try{
    const [{count:views},{count:likes},{count:comments},{data:viewers}]=await Promise.all([
      sb.from('postviews').select('id',{count:'exact',head:true}).eq('post_id',pid),
      sb.from('likes').select('id',{count:'exact',head:true}).eq('post_id',pid),
      sb.from('comments').select('id',{count:'exact',head:true}).eq('post_id',pid),
      sb.from('postviews').select('user_id').eq('post_id',pid)
    ]);
    let fromFollowing=0;
    try{
      const viewerIds=[...new Set((viewers||[]).map(v=>v.user_id))];
      if(viewerIds.length){
        const {count}=await sb.from('follows').select('id',{count:'exact',head:true}).eq('follower_id',me().id).in('following_id',viewerIds);
        fromFollowing=count||0;
      }
    }catch(e){}
    if(!$('insightsWrap').classList.contains('on'))return;
    body.innerHTML=insightsRow('Views',views||0)+insightsRow('Likes',likes||0)+insightsRow('Comments',comments||0)+insightsRow('From people you follow',fromFollowing);
  }catch(e){ body.innerHTML='<div class="empty">Could not load insights</div>'; }
}
async function regenThumb(pid){
  if(!pid)return; toast('Regenerating thumbnail…');
  try{
    const {data:p,error}=await sb.from('posts').select('*').eq('id',pid).single();
    if(error) throw error;
    if(!p.video_url){toast('Not a video post');return;}
    if(p.author_id!==me().id){toast('Only the owner can do this');return;}
    const b=await posterFromUrl(p.video_url);
    if(!b){toast('Could not capture frame (server CORS?)');return;}
    const url=await uploadFile('posts',me().id+'/'+randPath()+'-thumb.jpg',new File([b],'thumb.jpg',{type:'image/jpeg'}));
    await sb.from('posts').update({thumb_url:url}).eq('id',pid);
    toast('Thumbnail updated');
    if(currentScreen==='Profile')loadProfile(me().id);
    else if(currentScreen==='Reels')loadReels(true);
    if($('postView').classList.contains('on')&&pvId===pid)openPostView(pid);
  }catch(e){toast('Failed: '+sbErr(e));}
}
async function reelLike(pid,btn){
  const st=likeState[pid]||setLikeState(pid,[]);
  try{
    if(st.myLikeId){const id=st.myLikeId;bumpReact(pid,st.myReaction,-1);st.myLikeId=null;st.myReaction=null;st.count=Math.max(0,st.count-1);if(id!=='tmp')await sb.from('likes').delete().eq('id',id);}
    else{st.myLikeId='tmp';st.myReaction='love';st.count++;bumpReact(pid,'love',1);const {data:r}=await sb.from('likes').insert({post_id:pid,user_id:me().id,reaction:'love'}).select().single();st.myLikeId=r.id;notify('like',postAuthor[pid],{post_id:pid});}
    likeState[pid]=st;
    btn.classList.toggle('liked',!!st.myLikeId);
    const svg=btn.querySelector('svg'); if(svg)svg.setAttribute('fill',st.myLikeId?'currentColor':'none');
    const c=$('rlc_'+pid); if(c)c.textContent=st.count;
  }catch(e){toast('Action failed');}
}
let sharePostId=null, forwardMid=null;
async function openForward(mid){
  closeMsgMenu();
  forwardMid=mid;
  $('listView').classList.add('on'); $('listTitle').textContent='Forward to'; rearm();
  const body=$('listBody'); body.innerHTML=skRows(8);
  try{
    await loadMyGroups();
    let ids=[];
    try{ const {data}=await sb.from('messages').select('sender_id,receiver_id').or('sender_id.eq.'+me().id+',receiver_id.eq.'+me().id).is('group_id',null).order('created_at',{ascending:false}).limit(60); (data||[]).forEach(m=>{const o=m.sender_id===me().id?m.receiver_id:m.sender_id;if(o)ids.push(o);}); }catch(e){}
    try{ const {data}=await sb.from('follows').select('following_id').eq('follower_id',me().id); (data||[]).forEach(f=>ids.push(f.following_id)); }catch(e){}
    ids=[...new Set(ids)].filter(id=>id&&id!==me().id&&!blockedIds.has(id));
    const grpRows=(await Promise.all(myGroups.map(async g=>({g,n:(await getGroupMemberIds(g.id)).length})))).map(({g,n})=>`<div class="row" onclick="doForwardTo('group','${g.id}')"><div class="cav">${groupAvatar(g,44)}</div><div class="last"><div class="nm">${esc(g.name||'Group')}</div><div class="snip">${n} members</div></div></div>`).join('');
    const users={}; await Promise.all(ids.map(async id=>{users[id]=await getUser(id);}));
    const userRows=ids.filter(id=>users[id]).map(id=>{const u=users[id];return `<div class="row" onclick="doForwardTo('user','${id}')"><div class="cav">${avatarHtml(u,44)}</div><div class="last"><div class="nm">${esc(u.username)}</div><div class="snip">${esc(u.name||'')}</div></div></div>`;}).join('');
    body.innerHTML=(grpRows+userRows)||'<div class="empty">Start a chat or follow people to forward</div>';
  }catch(e){ body.innerHTML='<div class="empty">Could not load</div>'; }
}
async function doForwardTo(type,id){
  const mid=forwardMid; closeList(); if(!mid)return;
  let m=msgCache[mid];
  if(!m){ try{ const {data,error}=await sb.from('messages').select('*').eq('id',mid).single(); if(error)throw error; m=data; }catch(e){ toast('Message unavailable'); return; } }
  if(!m.text&&!m.post_id&&!m.image_url&&!m.audio_url){ toast('Cannot forward this message'); return; }
  toast('Forwarding...');
  try{
    const row={sender_id:me().id};
    if(type==='group'){ row.group_id=id; row.conversation=id; }
    else { row.receiver_id=id; row.conversation=convKey(me().id,id); }
    if(m.text)row.text=m.text;
    if(m.post_id)row.post_id=m.post_id;
    const folder=(type==='group'?id:convKey(me().id,id))+'/'+randPath();
    if(m.image_url){ const b=await (await fetch(m.image_url)).blob(); row.image_url=await uploadFile('chat',folder+'.jpg',new File([b],'forward.jpg',{type:b.type||'image/jpeg'})); }
    if(m.audio_url){ const b=await (await fetch(m.audio_url)).blob(); const ext=(b.type.indexOf('mp4')>=0)?'m4a':'webm'; row.audio_url=await uploadFile('chat',folder+'.'+ext,new File([b],'forward.'+ext,{type:b.type||'audio/webm'})); }
    const {error}=await sb.from('messages').insert(row);
    if(error) throw error;
    toast('Forwarded');
  }catch(e){ toast('Forward failed: '+sbErr(e)); }
}
async function openShare(pid){
  sharePostId=pid;
  $('listView').classList.add('on'); rearm(); $('listTitle').textContent='Share to';
  const body=$('listBody'); body.innerHTML=skRows(8);
  try{
    await loadMyGroups();
    let ids=[];
    try{ const {data}=await sb.from('follows').select('following_id').eq('follower_id',me().id); ids=(data||[]).map(f=>f.following_id); }catch(e){}
    try{ const {data}=await sb.from('messages').select('sender_id,receiver_id').or('sender_id.eq.'+me().id+',receiver_id.eq.'+me().id).is('group_id',null).order('created_at',{ascending:false}).limit(50); (data||[]).forEach(m=>{const o=m.sender_id===me().id?m.receiver_id:m.sender_id;if(o)ids.push(o);}); }catch(e){}
    ids=[...new Set(ids)].filter(id=>id&&id!==me().id);
    const grpRows=(await Promise.all(myGroups.map(async g=>({g,n:(await getGroupMemberIds(g.id)).length})))).map(({g,n})=>`<div class="row" onclick="doShareGroup('${g.id}')"><div class="cav">${groupAvatar(g,44)}</div><div class="last"><div class="nm">${esc(g.name||'Group')}</div><div class="snip">${n} members</div></div></div>`).join('');
    if(!ids.length&&!grpRows){body.innerHTML='<div class="empty">Follow people or start a chat to share</div>';return;}
    const users={}; await Promise.all(ids.map(async id=>{users[id]=await getUser(id);}));
    const userRows=ids.filter(id=>users[id]).map(id=>{const u=users[id];return `<div class="row" onclick="doShare('${id}')"><div class="cav">${avatarHtml(u,44)}</div><div class="last"><div class="nm">${esc(u.username)}</div><div class="snip">${esc(u.name||'')}</div></div></div>`;}).join('');
    body.innerHTML=grpRows+userRows;
  }catch(e){ body.innerHTML='<div class="empty">Could not load</div>'; }
}
async function doShareGroup(gid){
  const pid=sharePostId; closeList(); if(!pid)return;
  try{ await sb.from('messages').insert({sender_id:me().id,group_id:gid,conversation:gid,text:'Shared a post',post_id:pid}); toast('Shared'); }
  catch(e){ toast('Share failed: '+sbErr(e)); }
}
async function doShare(uid){
  const pid=sharePostId; closeList(); if(!pid)return;
  const key=convKey(me().id,uid);
  try{ await sb.from('messages').insert({sender_id:me().id,receiver_id:uid,conversation:key,text:'Shared a post',post_id:pid}); toast('Shared'); }
  catch(e){ try{ await sb.from('messages').insert({sender_id:me().id,receiver_id:uid,conversation:key,text:'Shared a post'}); toast('Shared'); }catch(e2){ toast('Share failed: '+sbErr(e2)); } }
}
let capOnSave=null;
function openTextEditor(title,val,onSave){$('capTitle').textContent=title;$('capText').value=val||'';capOnSave=onSave;$('capWrap').classList.add('on');rearm();setTimeout(()=>$('capText').focus(),50);}
$('pmEdit').onclick=()=>{const id=pmId;closePostMenu();if(!id)return;openTextEditor('Edit caption',postCaption[id],async v=>{try{await sb.from('posts').update({caption:v}).eq('id',id);postCaption[id]=v;toast('Caption updated');if($('postView').classList.contains('on')&&pvId)openPostView(pvId);else loadFeedPosts(true);}catch(e){toast('Update failed');}});};
$('capCancel').onclick=()=>{$('capWrap').classList.remove('on');capOnSave=null;};
$('capWrap').onclick=e=>{if(e.target.id==='capWrap'){$('capWrap').classList.remove('on');capOnSave=null;}};
$('capSave').onclick=async()=>{const v=$('capText').value.trim();$('capWrap').classList.remove('on');const fn=capOnSave;capOnSave=null;if(fn)await fn(v);};
function buildCommentTree(cmts){
  const ids=new Set(cmts.map(c=>c.id));
  const roots=cmts.filter(c=>!c.parent_id||!ids.has(c.parent_id));
  const childrenOf={};
  cmts.forEach(c=>{ if(c.parent_id&&ids.has(c.parent_id)){ (childrenOf[c.parent_id]=childrenOf[c.parent_id]||[]).push(c); } });
  return {roots,childrenOf};
}
function commentBlock(root,kids,full,pid){
  let html=commentRow(root,full,pid,false);
  if(full){
    const tog=kids.length?`<div class="reptoggle" id="reptog_${root.id}" onclick="toggleReplies('${root.id}')">View ${kids.length} ${kids.length===1?'reply':'replies'}</div>`:`<div class="reptoggle" id="reptog_${root.id}" onclick="toggleReplies('${root.id}')" style="display:none"></div>`;
    html+=tog+`<div class="creplies" id="crep_${root.id}">${kids.map(k=>commentRow(k,true,pid,true)).join('')}</div>`;
  }
  return html;
}
function toggleReplies(rid){
  const rep=document.getElementById('crep_'+rid), tog=document.getElementById('reptog_'+rid); if(!rep)return;
  const isOpen=rep.classList.contains('open');
  rep.classList.toggle('open'); rep.style.display=isOpen?'none':'block';
  const n=rep.children.length;
  if(tog)tog.textContent=isOpen?`View ${n} ${n===1?'reply':'replies'}`:`Hide ${n===1?'reply':'replies'}`;
}
function commentRow(c,full,pid,isReply){
  const u=c.user||{username:'user'};
  commentText[c.id]=c.text;
  commentAuthor[c.id]=c.user_id;
  commentPost[c.id]=pid;
  const mine=c.user_id===me().id;
  const cl=clikeState[c.id]||{count:0,myId:null};
  const liked=!!cl.myId;
  const heart=`<span class="chk ${liked?'on':''}" onclick="toggleCLike('${c.id}')">${icon('heart',13,{fill:liked?'currentColor':'none'})}</span>`;
  const cnt=`<span class="clk" id="clc_${c.id}">${cl.count?cl.count:''}</span>`;
  const replyTo=c.parent_id||c.id;
  const acts=full?`<span class="cact"><span onclick="startCReply('${pid}','${replyTo}','${esc(u.username)}')">Reply</span>${mine?`<span onclick="editComment('${c.id}')">Edit</span><span onclick="delComment('${c.id}')">Delete</span>`:''}</span>`:'';
  return `<div class="c${isReply?' creply':''}" id="cm_${c.id}"><div class="crow"><div class="ctxt"><b>${esc(u.username)}</b>${esc(c.text)}${acts}</div><div class="chearts">${heart}${cnt}</div></div></div>`;
}
function startCReply(pid,parentId,uname){ const inp=$('ci_'+pid); if(!inp)return; inp.value='@'+uname+' '; inp.dataset.parent=parentId; inp.focus(); }
async function toggleCLike(cid){
  const cl=clikeState[cid]||{count:0,myId:null}; const prev={count:cl.count,myId:cl.myId};
  try{
    if(cl.myId){ const id=cl.myId; cl.myId=null; cl.count=Math.max(0,cl.count-1); clikeState[cid]=cl; updateCLikeDom(cid); if(id!=='tmp')await sb.from('clikes').delete().eq('id',id); }
    else { cl.myId='tmp'; cl.count++; clikeState[cid]=cl; updateCLikeDom(cid); const {data:r}=await sb.from('clikes').insert({comment_id:cid,user_id:me().id}).select().single(); cl.myId=r.id; clikeState[cid]=cl; notify('commentlike',commentAuthor[cid],{comment_id:cid,post_id:commentPost[cid]}); }
  }catch(e){ clikeState[cid]=prev; updateCLikeDom(cid); toast('Like failed: '+sbErr(e)); }
}
function updateCLikeDom(cid){
  const cl=clikeState[cid]||{count:0,myId:null};
  const h=document.querySelector('#cm_'+cid+' .chk'); if(h){h.classList.toggle('on',!!cl.myId);h.innerHTML=icon('heart',13,{fill:cl.myId?'currentColor':'none'});}
  const c=document.getElementById('clc_'+cid); if(c)c.textContent=cl.count?cl.count:'';
}
async function loadCommentLikes(cmts){
  const cids=cmts.map(c=>c.id); if(!cids.length)return;
  let clikes=[];
  try{ const {data}=await sb.from('clikes').select('*').in('comment_id',cids); clikes=data||[]; }catch(e){ console.warn('clikes read failed:',sbErr(e)); }
  cmts.forEach(c=>{ const cl=clikes.filter(l=>l.comment_id===c.id); clikeState[c.id]={count:cl.length,myId:(cl.find(l=>l.user_id===me().id)||{}).id||null}; });
}
async function delComment(cid){ try{ await sb.from('comments').delete().eq('id',cid); if($('postView').classList.contains('on')&&pvId){ openPostView(pvId); } else { const el=$('cm_'+cid); if(el)el.remove(); } toast('Comment deleted'); }catch(e){ toast('Delete failed: '+sbErr(e)); } }
function editComment(cid){ openTextEditor('Edit comment',commentText[cid]||'',async v=>{ if(!v)return; try{ await sb.from('comments').update({text:v}).eq('id',cid); commentText[cid]=v; toast('Comment updated'); if($('postView').classList.contains('on')&&pvId)openPostView(pvId); }catch(e){ toast('Update failed: '+sbErr(e)); } }); }
/* ============ NOTIFICATIONS / FOLLOW LISTS ============ */
async function notify(type,toId,extra){
  if(!toId||toId===me().id)return;
  try{ await sb.from('notifications').insert(Object.assign({user_id:toId,actor_id:me().id,type:type,read:false},extra||{})); }catch(e){}
}
async function refreshNotif(){
  try{ const {count}=await sb.from('notifications').select('id',{count:'exact',head:true}).eq('user_id',me().id).eq('read',false); const n=count||0,b=$('notifBadge'); if(b){if(n>0){b.textContent=n>99?'99+':n;b.classList.add('on');}else{b.textContent='';b.classList.remove('on');}} }catch(e){const b=$('notifBadge');if(b){b.textContent='';b.classList.remove('on');}}
}
function closeNotif(){$('notif').classList.remove('on');}
async function openNotif(){
  $('notif').classList.add('on');rearm();
  const body=$('notifBody'); body.innerHTML=skRows(8);
  try{
    const {data:items,error}=await sb.from('notifications').select('*').eq('user_id',me().id).order('created_at',{ascending:false}).limit(80);
    if(error) throw error;
    if(!items.length){ body.innerHTML='<div class="empty">No notifications yet</div>'; }
    else{
      const actorIds=[...new Set(items.map(n=>n.actor_id))]; const users={};
      await Promise.all(actorIds.map(async id=>{users[id]=await getUser(id);}));
      const NOTIF_VERB={like:'liked your post',comment:n=>'commented: '+esc(n.text||''),reply:n=>'replied: '+esc(n.text||''),commentlike:'liked your comment',tag:'tagged you in a post',storylike:'liked your story',follow:'started following you'};
      body.innerHTML=items.map(n=>{
        const u=users[n.actor_id]||{username:'someone'};
        const v=NOTIF_VERB[n.type]; const verb=typeof v==='function'?v(n):(v||'started following you');
        const openAction=n.post_id?`openPostView('${n.post_id}')`:`openProfile('${n.actor_id}')`;
        return `<div class="row ${n.read?'':'nrow'}" onclick="${openAction};closeNotif();"><div class="cav">${avatarHtml(u,44)}</div><div class="last"><div class="snip"><b>${esc(u.username)}</b> ${verb}</div></div><div class="mut">${timeAgo(n.created_at)}</div></div>`;
      }).join('');
    }
    const unread=items.filter(n=>!n.read);
    if(unread.length){ await sb.from('notifications').update({read:true}).in('id',unread.map(n=>n.id)); refreshNotif(); }
  }catch(e){ body.innerHTML='<div class="empty">Could not load notifications.<br>Check the notifications table.</div>'; }
}
function closeList(){$('listView').classList.remove('on'); if($('storyView').classList.contains('on'))playStory();}
async function openFollowList(uid,mode){
  $('listView').classList.add('on'); rearm(); $('listTitle').textContent=mode==='followers'?'Followers':'Following';
  const body=$('listBody'); body.innerHTML=skRows(8);
  try{
    const matchField=mode==='followers'?'following_id':'follower_id';
    const {data:rows,error}=await sb.from('follows').select('*').eq(matchField,uid);
    if(error) throw error;
    const ids=[...new Set((rows||[]).map(r=>mode==='followers'?r.follower_id:r.following_id))];
    if(!ids.length){body.innerHTML='<div class="empty">No '+(mode==='followers'?'followers':'following')+' yet</div>';return;}
    const users={}; await Promise.all(ids.map(async id=>{users[id]=await getUser(id);}));
    body.innerHTML=ids.filter(id=>users[id]).map(id=>{const u=users[id];return `<div class="row" onclick="openProfile('${id}');closeList();"><div class="cav">${avatarHtml(u,44)}</div><div class="last"><div class="nm">${esc(u.username)}</div><div class="snip">${esc(u.name||'')}</div></div></div>`;}).join('');
  }catch(e){ body.innerHTML='<div class="empty">Could not load list</div>'; }
}
$('notifBack').onclick=closeNotif;
$('listBack').onclick=closeList;
async function openPostView(pid){
  $('postView').classList.add('on');rearm();
  const body=$('postViewBody'); body.innerHTML=skPost();
  try{
    const {data:p,error}=await sb.from('posts').select('*, author:author_id(id,username,name,avatar_url,is_verified)').eq('id',pid).single();
    if(error) throw error;
    const {data:likes}=await sb.from('likes').select('*').eq('post_id',pid);
    const {data:comments}=await sb.from('comments').select('*, user:user_id(id,username,name,avatar_url)').eq('post_id',pid).order('created_at');
    setLikeState(p.id,likes||[]);
    await loadSocialProof([p],likes||[]);
    await loadCommentLikes(comments||[]);
    await loadPollVotes([p]);
    try{ const {data:sv}=await sb.from('saves').select('id').eq('post_id',pid).eq('user_id',me().id).maybeSingle(); saveState[pid]=sv?sv.id:null; }catch(e){}
    pvId=pid;
    body.innerHTML=renderPost(p,comments||[],true);
    setupFeedAutoplay();
    registerView(pid); fillViews(pid);
  }catch(e){ body.innerHTML='<div class="empty">Could not load post</div>'; }
}
function closePostView(){$('postView').classList.remove('on');}
$('postViewBack').onclick=closePostView;

/* Long-press the like button for the reaction picker (tap still just
   hearts it). Delegated from the document so it works for posts rendered
   later, and pointer events cover touch and mouse in one path. */
let likeLPTimer=null, likeLPFired=false, likeLPFrom=null;
document.addEventListener('pointerdown',e=>{
  const el=e.target.closest('.pacts .like'); if(!el)return;
  const post=el.closest('.post'); const pid=post&&post.getAttribute('data-pid'); if(!pid)return;
  likeLPFired=false; likeLPFrom={x:e.clientX,y:e.clientY};
  clearTimeout(likeLPTimer);
  likeLPTimer=setTimeout(()=>{ likeLPTimer=null; likeLPFired=true; openPostReact(pid); },450);
});
function cancelLikeLP(){ clearTimeout(likeLPTimer); likeLPTimer=null; likeLPFrom=null; }
['pointerup','pointercancel'].forEach(ev=>document.addEventListener(ev,cancelLikeLP));
/* Only a real drag cancels the press - a finger never holds perfectly
   still, and cancelling on any movement at all made the picker almost
   impossible to open on a touchscreen. */
document.addEventListener('pointermove',e=>{
  if(!likeLPTimer||!likeLPFrom)return;
  if(Math.abs(e.clientX-likeLPFrom.x)>10||Math.abs(e.clientY-likeLPFrom.y)>10)cancelLikeLP();
});
function openPostReact(pid){
  reactPid=pid;
  const mine=(likeState[pid]||{}).myReaction;
  $('postReactRow').innerHTML=REACT_ORDER.map(k=>`<button class="rbtn ${mine===k?'on':''}" onclick="closePostReact();reactPost('${pid}','${k}')">${reactIcon(k,26)}</button>`).join('');
  $('postReactWrap').classList.add('on'); rearm();
}
function closePostReact(){ $('postReactWrap').classList.remove('on'); }
$('postReactCancel').onclick=closePostReact;
$('postReactWrap').onclick=e=>{ if(e.target.id==='postReactWrap')closePostReact(); };
/* ============ BACK-BUTTON ROUTER ============ */
let rootBackT=0;
function rearm(){ try{history.pushState({linkup:1},'');}catch(e){} }
function topLayerClose(){
  if($('gcall').classList.contains('on'))return true;
  if($('call').classList.contains('on'))return true;
  if($('capWrap').classList.contains('on')){$('capWrap').classList.remove('on');capOnSave=null;return true;}
  if($('insightsWrap').classList.contains('on')){closeInsights();return true;}
  if($('postReactWrap').classList.contains('on')){closePostReact();return true;}
  if($('postMenuWrap').classList.contains('on')){closePostMenu();return true;}
  if($('msgMenuWrap').classList.contains('on')){closeMsgMenu();return true;}
  if($('actMenuWrap').classList.contains('on')){closeActMenu();return true;}
  if($('addMem').classList.contains('on')){closeAddMembers();return true;}
  if($('groupInfo').classList.contains('on')){closeGroupInfo();return true;}
  if($('newGroup').classList.contains('on')){closeNewGroup();return true;}
  if($('listView').classList.contains('on')){closeList();return true;}
  if($('storyCompose').classList.contains('on')){closeStoryCompose();return true;}
  if($('storyView').classList.contains('on')){closeStory();return true;}
  if($('postView').classList.contains('on')){closePostView();return true;}
  if($('saved').classList.contains('on')){closeSaved();return true;}
  if($('qr').classList.contains('on')){closeQR();return true;}
  if($('pollCompose').classList.contains('on')){closePollCompose();return true;}
  if($('notif').classList.contains('on')){closeNotif();return true;}
  if($('chatSearchBar')&&$('chatSearchBar').style.display==='flex'){closeChatSearch();return true;}
  if($('chat').style.display==='flex'){closeChat();return true;}
  return false;
}
window.addEventListener('popstate',()=>{
  if(!me()){return;}
  if(topLayerClose()){rearm();return;}
  if(currentScreen!=='Feed'){show('Feed');rearm();return;}
  const now=Date.now();
  if(now-rootBackT<1800){history.back();return;}
  rootBackT=now; toast('Press back again to exit'); rearm();
});

async function openChat(uid){
  cleanupPresence(); closeChatSearch();
  try{ chatUser=(uid===me().id)?me():await getUser(uid); if(!chatUser) throw new Error('not found'); }catch(e){toast('User not found');return;}
  clearChatNotifications('msg:'+convKey(me().id,chatUser.id));
  typingRecId=null; lastTypingSent=0; $('typing').style.display='none';
  $('chatAv').innerHTML=avatarHtml(chatUser,38);
  $('chatName').textContent=chatUser.name||chatUser.username;
  /* Show the cached streak immediately, then refresh - opening the chat is
     exactly when it may have just changed (they replied since you looked). */
  $('chatStreak').innerHTML=streakHtml(chatUser.id);
  loadDmStreaks().then(()=>{ if(chatUser&&$('chatStreak'))$('chatStreak').innerHTML=streakHtml(chatUser.id); });
  renderPresence();
  $('chatAv').onclick=null; $('chatName').onclick=null;
  $('callBtns').style.display='flex';
  $('chat').style.display='flex';
  rearm();
  startPresence();
  const body=$('chatBody');body.innerHTML=skChat();
  try{
    const key=convKey(me().id,chatUser.id);
    const {data:msgs,error}=await sb.from('messages').select('*').eq('conversation',key).is('group_id',null).order('created_at');
    if(error) throw error;
    body.innerHTML=(msgs||[]).map(bubble).join('');
    hydrateCards(body);
    body.scrollTop=body.scrollHeight;
    markRead((msgs||[]).filter(m=>m.receiver_id===me().id&&!m.read));
  }catch(e){body.innerHTML='<div class="empty">Could not load messages</div>';}
  restoreDraft(convKey(me().id,chatUser.id));
}
function fmtDur(s){const m=Math.floor(s/60),x=s%60;return m+':'+String(x).padStart(2,'0');}
function callBubble(m){
  const p=(m.call||'').split(':'),k=p[0]||'audio',st=p[1]||'ended',du=+(p[2]||0),mine=m.sender_id===me().id,isVid=k==='video';
  let label;
  if(st==='missed')label=mine?'No answer':('Missed '+(isVid?'video ':'')+'call');
  else if(st==='declined')label='Call declined';
  else label=(mine?'Outgoing ':'Incoming ')+(isVid?'video ':'')+'call';
  const dur=(st==='ended'&&du>0)?(' · '+fmtDur(du)):'';
  const miss=(st==='missed'||st==='declined')?' missed':'';
  return `<div class="callmsg${miss}">${icon(isVid?'video':'phone',16)}<span>${label}${dur}</span><span class="cmtime">${timeAgo(m.created_at)}</span></div>`;
}
const msgCache={};
function msgPreview(m){ return m.text?m.text:(m.audio_url?'Voice message':m.image_url?'Photo':m.post_id?'Shared a post':m.call?'Call':(m.sys||'')); }
const REACT={like:{i:'rlike',c:'#5b8cff'},love:{i:'heart',c:'#ff4d8d',f:1},haha:{i:'rhaha',c:'#ffb33e'},wow:{i:'rwow',c:'#ffb33e'},sad:{i:'rsad',c:'#ffb33e'},fire:{i:'rfire',c:'#ff7a3d',f:1}};
const REACT_ORDER=['like','love','haha','wow','sad','fire'];
function reactIcon(k,size){const r=REACT[k]||REACT.like;return `<span style="color:${r.c};display:inline-flex">${icon(r.i,size||16,{fill:r.f?'currentColor':'none'})}</span>`;}
function parseRx(v){ return v||{}; }
function reactionsHtml(mid,rx){
  rx=parseRx(rx); const keys=Object.keys(rx); if(!keys.length)return '';
  const counts={}; keys.forEach(u=>{counts[rx[u]]=(counts[rx[u]]||0)+1;});
  const mineKey=rx[me().id];
  const chips=REACT_ORDER.filter(k=>counts[k]).map(k=>`<span class="rchip ${mineKey===k?'mine':''}" onclick="event.stopPropagation();reactMsg('${mid}','${k}')">${reactIcon(k,14)}${counts[k]>1?`<i>${counts[k]}</i>`:''}</span>`).join('');
  return `<div class="rchips">${chips}</div>`;
}
function bubble(m){
  if(m.sys)return `<div class="sysmsg">${esc(m.sys)}</div>`;
  if(m.call)return callBubble(m);
  msgCache[m.id]=m;
  const mine=m.sender_id===me().id;
  const grp=!!m.group_id;
  const su=grp&&!mine?(grpUsers[m.sender_id]||null):null;
  const sender=su?`<div class="bsender">${esc(su.username||su.name||'user')}</div>`:'';
  let reply='';
  if(m.reply_to_id&&m.reply_meta){ const r=parseRx(m.reply_meta); reply=`<div class="rquote" onclick="event.stopPropagation();jumpToMsg('${m.reply_to_id}')"><span class="rqu">${esc(r.u||'')}</span><span class="rqt">${esc(r.t||'')}</span></div>`; }
  const img=m.image_url?`<img class="blur-load" loading="lazy" decoding="async" src="${m.image_url}" onload="this.classList.add('loaded')" onclick="window.open('${m.image_url}','_blank')">`:'';
  const card=m.post_id?`<div class="pcard" data-post="${m.post_id}" data-mid="${m.id}" onclick="openPostView('${m.post_id}')"><span class="pcimg" id="pcimg_${m.id}"></span><span>View post</span></div>`:'';
  const txt=m.text?esc(m.text):'';
  const voice=m.audio_url?`<div class="voice${mine&&!grp&&m.played?' played':''}" data-mid="${m.id}"><button class="vplay" onclick="vtoggle(this)">${PLAY_SVG}</button><div class="vbar" onclick="vseek(event,this)"><div class="vfill"></div></div><span class="vtime">0:00</span><audio preload="metadata" src="${m.audio_url}" onloadedmetadata="vmeta(this)" ontimeupdate="vprog(this)" onended="vend(this)"></audio></div>`:'';
  const seen=(mine&&!grp)?`<span class="seen ${m.read?'on':''}">${icon(m.read?'checks':'check',14)}</span>`:'';
  return `<div class="bub ${mine?'me':'them'}" id="m_${m.id}">${sender}${reply}${txt}${img}${voice}${card}<div class="btime">${timeAgo(m.created_at)}${seen}</div>${reactionsHtml(m.id,m.reactions)}</div>`;
}
function appendBubble(m){const b=$('chatBody');b.insertAdjacentHTML('beforeend',bubble(m));hydrateCards(b);b.scrollTop=b.scrollHeight;}
function closeChat(){ if(mediaRec||recStream)cancelRec(); cleanupPresence(); cancelReply(); closeChatSearch(); $('chat').style.display='none'; chatUser=null; chatGroup=null; clearChatImg(); if(currentScreen==='Chats')loadChats(); }
let csMatches=[], csIdx=-1;
function toggleChatSearch(){ const bar=$('chatSearchBar'); if(bar.style.display==='flex'){ closeChatSearch(); } else { bar.style.display='flex'; rearm(); const i=$('chatSearchMsg'); i.value=''; $('csCount').textContent=''; setTimeout(()=>i.focus(),30); } }
function closeChatSearch(){ const bar=$('chatSearchBar'); if(bar)bar.style.display='none'; const i=$('chatSearchMsg'); if(i)i.value=''; clearChatSearch(); }
function clearChatSearch(){ csMatches.forEach(el=>el.classList.remove('searchhit','searchcur')); csMatches=[]; csIdx=-1; const c=$('csCount'); if(c)c.textContent=''; }
function runChatSearch(q){
  q=(q||'').trim().toLowerCase(); clearChatSearch(); if(!q)return;
  document.querySelectorAll('#chatBody .bub').forEach(el=>{ const m=msgCache[el.id.replace('m_','')]; const t=(m&&m.text)?m.text.toLowerCase():''; if(t.includes(q)){ el.classList.add('searchhit'); csMatches.push(el); } });
  if(csMatches.length){ csIdx=csMatches.length-1; focusMatch(); } else $('csCount').textContent='0/0';
}
function focusMatch(){
  csMatches.forEach(el=>el.classList.remove('searchcur'));
  const el=csMatches[csIdx]; if(!el)return;
  el.classList.add('searchcur'); el.scrollIntoView({behavior:'smooth',block:'center'});
  $('csCount').textContent=(csIdx+1)+'/'+csMatches.length;
}
function chatSearchNav(dir){ if(!csMatches.length)return; csIdx=(csIdx+dir+csMatches.length)%csMatches.length; focusMatch(); }
$('chatBack').onclick=closeChat;
$('chatAtt').onclick=()=>$('chatFile').click();
$('chatFile').onchange=e=>{const f=e.target.files[0];if(!f)return;chatImage=f;$('chatPrevImg').src=URL.createObjectURL(f);$('chatPrev').style.display='block';};
function clearChatImg(){chatImage=null;$('chatPrev').style.display='none';}
$('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter')sendMessage();});
$('chatInput').addEventListener('input',typingPing);
$('chatSend').onclick=sendMessage;
let lpTimer=null, menuMsgId=null;
$('chatBody').addEventListener('pointerdown',e=>{const bub=e.target.closest('.bub');if(!bub)return;const id=bub.id.replace('m_','');clearTimeout(lpTimer);lpTimer=setTimeout(()=>openMsgMenu(id),480);});
['pointerup','pointermove','pointercancel','pointerleave'].forEach(ev=>$('chatBody').addEventListener(ev,()=>clearTimeout(lpTimer)));
$('chatBody').addEventListener('contextmenu',e=>{if(e.target.closest('.bub'))e.preventDefault();});
function openMsgMenu(id){
  menuMsgId=id;
  const m=msgCache[id]||{}; const mine=m.sender_id===me().id;
  const rrow=`<div class="reactrow">${REACT_ORDER.map(k=>`<button class="rbtn" onclick="reactMsg('${id}','${k}')">${reactIcon(k,26)}</button>`).join('')}</div>`;
  let btns=`<button onclick="startReply('${id}')">Reply</button>`;
  btns+=`<button onclick="openForward('${id}')">Forward</button>`;
  if(m.text)btns+=`<button onclick="copyMsg('${id}')">Copy text</button>`;
  if(mine)btns+=`<button class="danger" onclick="doUnsend('${id}')">Unsend message</button>`;
  btns+=`<button onclick="closeMsgMenu()">Cancel</button>`;
  $('msgMenu').innerHTML=rrow+btns;
  $('msgMenuWrap').classList.add('on');rearm();
}
function closeMsgMenu(){menuMsgId=null;$('msgMenuWrap').classList.remove('on');}
$('msgMenuWrap').onclick=e=>{if(e.target.id==='msgMenuWrap')closeMsgMenu();};
async function doUnsend(id){closeMsgMenu();if(!id)return;try{await sb.from('messages').delete().eq('id',id);const el=document.getElementById('m_'+id);if(el)el.remove();refreshUnread();toast('Message unsent');}catch(err){toast('Could not unsend');}}
function copyMsg(id){closeMsgMenu();const m=msgCache[id];if(!m||!m.text)return;try{navigator.clipboard.writeText(m.text);toast('Copied');}catch(e){toast('Copy failed');}}
async function reactMsg(mid,key){
  closeMsgMenu();
  try{
    let rec=msgCache[mid];
    if(!rec){ const {data,error}=await sb.from('messages').select('*').eq('id',mid).single(); if(error)throw error; rec=data; }
    const rx=Object.assign({},rec.reactions||{});
    if(rx[me().id]===key)delete rx[me().id]; else rx[me().id]=key;
    const {error}=await sb.from('messages').update({reactions:rx}).eq('id',mid);
    if(error) throw error;
    if(msgCache[mid])msgCache[mid].reactions=rx;
    setReactionsDom(mid,rx);
  }catch(e){ toast('Could not react'); }
}
function setReactionsDom(mid,rx){
  const el=document.getElementById('m_'+mid); if(!el)return;
  const html=reactionsHtml(mid,rx);
  const chips=el.querySelector('.rchips');
  if(chips){ if(html)chips.outerHTML=html; else chips.remove(); }
  else if(html)el.insertAdjacentHTML('beforeend',html);
}
/* reply */
let replyTarget=null;
async function startReply(mid){
  closeMsgMenu();
  let m=msgCache[mid];
  if(!m){ try{ const {data,error}=await sb.from('messages').select('*').eq('id',mid).single(); if(error)throw error; m=data; }catch(e){ return; } }
  let u; if(m.sender_id===me().id)u=me().username; else u=(grpUsers[m.sender_id]&&grpUsers[m.sender_id].username)||(chatUser&&chatUser.username)||((await getUser(m.sender_id))||{}).username||'user';
  replyTarget={id:mid,u:u,t:msgPreview(m).slice(0,90)};
  $('replyU').textContent=u; $('replyT').textContent=replyTarget.t; $('replyBar').style.display='flex';
  $('chatInput').focus();
}
function cancelReply(){ replyTarget=null; $('replyBar').style.display='none'; }
function jumpToMsg(mid){
  const el=document.getElementById('m_'+mid);
  if(!el){ toast('Original message not loaded'); return; }
  el.scrollIntoView({behavior:'smooth',block:'center'});
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  setTimeout(()=>el.classList.remove('flash'),1300);
}
const PLAY_SVG='<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_SVG='<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
function fmtT(s){ if(!isFinite(s)||s<0)s=0; const m=Math.floor(s/60),x=Math.floor(s%60); return m+':'+(x<10?'0':'')+x; }
function vtoggle(btn){ const bub=btn.closest('.bub'),v=btn.closest('.voice'),a=v.querySelector('audio'); document.querySelectorAll('.voice audio').forEach(o=>{if(o!==a){o.pause();const ob=o.closest('.voice').querySelector('.vplay');if(ob)ob.innerHTML=PLAY_SVG;}}); if(a.paused){a.play();btn.innerHTML=PAUSE_SVG; if(bub&&!bub.classList.contains('me'))markVoicePlayed(v.dataset.mid);}else{a.pause();btn.innerHTML=PLAY_SVG;} }
const playedSet=new Set();
async function markVoicePlayed(mid){ if(!mid||playedSet.has(mid))return; playedSet.add(mid); try{ await sb.from('messages').update({played:true}).eq('id',mid); }catch(e){} }
function vmeta(a){ const v=a.closest('.voice'),t=v.querySelector('.vtime'); let d=a.duration; if(!isFinite(d)){ a.currentTime=1e101; const fix=()=>{ a.removeEventListener('timeupdate',fix); a.currentTime=0; const dd=a.duration; v.dataset.dur=isFinite(dd)?dd:0; if(t)t.textContent=fmtT(isFinite(dd)?dd:0); }; a.addEventListener('timeupdate',fix); } else { v.dataset.dur=d; if(t)t.textContent=fmtT(d); } }
function vprog(a){ const v=a.closest('.voice'); const d=parseFloat(v.dataset.dur)||a.duration||0; const r=d?Math.min(1,a.currentTime/d):0; const f=v.querySelector('.vfill'); if(f)f.style.width=(r*100)+'%'; const t=v.querySelector('.vtime'); if(t)t.textContent=fmtT((a.paused&&a.currentTime===0)?d:a.currentTime); }
function vseek(e,bar){ const v=bar.closest('.voice'),a=v.querySelector('audio'); const d=parseFloat(v.dataset.dur)||a.duration||0; const rc=bar.getBoundingClientRect(); const r=Math.min(1,Math.max(0,(e.clientX-rc.left)/rc.width)); if(d)a.currentTime=r*d; }
function vend(a){ const v=a.closest('.voice'); const b=v.querySelector('.vplay'); if(b)b.innerHTML=PLAY_SVG; const f=v.querySelector('.vfill'); if(f)f.style.width='0%'; a.currentTime=0; }
let mediaRec=null, recChunks=[], recStream=null, recTimer=null, recSecs=0, recMime='';
async function startRec(){
  if(!chatUser&&!chatGroup)return;
  if(!navigator.mediaDevices||!window.MediaRecorder){ toast('Recording not supported here'); return; }
  try{ recStream=await navigator.mediaDevices.getUserMedia({audio:true}); }catch(e){ toast('Microphone permission denied'); return; }
  recMime=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(t=>MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported(t))||'';
  recChunks=[];
  try{ mediaRec=new MediaRecorder(recStream, recMime?{mimeType:recMime}:undefined); }catch(e){ mediaRec=new MediaRecorder(recStream); }
  mediaRec.ondataavailable=e=>{ if(e.data&&e.data.size)recChunks.push(e.data); };
  mediaRec.start();
  recSecs=0; $('recTime').textContent='0:00';
  recTimer=setInterval(()=>{ recSecs++; $('recTime').textContent=fmtT(recSecs); if(recSecs>=120)stopAndSendRec(); },1000);
  $('recBar').classList.add('on'); $('cFoot').classList.add('hide');
}
function stopRecStream(){ if(recStream){recStream.getTracks().forEach(t=>t.stop());recStream=null;} clearInterval(recTimer); recTimer=null; }
function stopRecTracks(){ stopRecStream(); $('recBar').classList.remove('on'); $('cFoot').classList.remove('hide'); }
function cancelRec(){ if(mediaRec&&mediaRec.state!=='inactive'){ mediaRec.onstop=null; try{mediaRec.stop();}catch(e){} } recChunks=[]; mediaRec=null; stopRecTracks(); }
function stopAndSendRec(){
  if(!mediaRec){ stopRecTracks(); return; }
  mediaRec.onstop=async()=>{
    const blob=new Blob(recChunks,{type:recMime||'audio/webm'}); recChunks=[];
    stopRecStream();
    if(!chatUser&&!chatGroup||blob.size<800){ mediaRec=null; stopRecTracks(); return; }
    const ext=(recMime.indexOf('mp4')>=0)?'m4a':'webm';
    /* Keep the recording bar up (instead of instantly hiding it, which is
       what stopRecTracks() used to do right here) so there's somewhere to
       show upload progress - a mic recording with nothing left to look at
       while it silently uploads is exactly the missing feedback reported. */
    const sendBtn=$('recSend'), prevIcon=sendBtn.innerHTML;
    sendBtn.innerHTML='<span class="spinner"></span>'; sendBtn.disabled=true; $('recCancel').disabled=true;
    try{
      const row=buildMessageBase();
      const folder=(chatGroup?chatGroup.id:convKey(me().id,chatUser.id));
      row.audio_url=await uploadFile('chat',folder+'/'+randPath()+'.'+ext,new File([blob],'voice.'+ext,{type:blob.type}));
      const {data:r,error}=await sb.from('messages').insert(row).select().single();
      if(error) throw error;
      appendBubble(r); cancelReply();
    }catch(e){ toast('Send failed: '+sbErr(e)); }
    sendBtn.innerHTML=prevIcon; sendBtn.disabled=false; $('recCancel').disabled=false;
    mediaRec=null;
    stopRecTracks();
  };
  try{ mediaRec.stop(); }catch(e){ stopRecTracks(); mediaRec=null; }
}
async function sendMessage(){
  if(!chatUser&&!chatGroup)return;
  const text=$('chatInput').value.trim();
  if(!text&&!chatImage)return;
  $('chatInput').value='';
  const hasImage=!!chatImage;
  const sendBtn=$('chatSend'), prevIcon=sendBtn.innerHTML;
  if(hasImage){ sendBtn.innerHTML='<span class="spinner"></span>'; sendBtn.disabled=true; $('chatPrev').classList.add('uploading'); }
  try{
    const row=buildMessageBase();
    if(text)row.text=text;
    if(chatImage){
      const folder=(chatGroup?chatGroup.id:convKey(me().id,chatUser.id));
      const compressed=await compressImage(chatImage,1600,0.8);
      row.image_url=await uploadFile('chat',folder+'/'+randPath()+'.jpg',compressed);
    }
    const {data:r,error}=await sb.from('messages').insert(row).select().single();
    if(error) throw error;
    appendBubble(r); clearChatImg(); cancelReply();
  }catch(e){toast('Send failed: '+sbErr(e));}
  finally{ if(hasImage){ sendBtn.innerHTML=prevIcon; sendBtn.disabled=false; $('chatPrev').classList.remove('uploading'); } }
}
function markRead(list){
  const todo=(list||[]).filter(m=>m.receiver_id===me().id&&!m.read);
  if(!todo.length)return;
  Promise.all(todo.map(m=>sb.from('messages').update({read:true}).eq('id',m.id).then(()=>{}).catch(()=>{}))).then(refreshUnread);
}
async function refreshUnread(){
  let total=0;
  try{
    const {count}=await sb.from('messages').select('id',{count:'exact',head:true}).eq('receiver_id',me().id).eq('read',false);
    total+=count||0;
  }catch(e){}
  try{
    const gids=[...myGroupIds];
    if(gids.length){
      const {data:reads}=await sb.from('group_reads').select('group_id,last_read_at').eq('user_id',me().id);
      const readMap={}; (reads||[]).forEach(r=>{readMap[r.group_id]=r.last_read_at;});
      const {data:msgs}=await sb.from('messages').select('group_id,sender_id,created_at').in('group_id',gids).neq('sender_id',me().id).order('created_at',{ascending:false}).limit(200);
      (msgs||[]).forEach(m=>{ const st=readMap[m.group_id]?new Date(readMap[m.group_id]).getTime():0; if(new Date(m.created_at).getTime()>st)total++; });
    }
  }catch(e){}
  const b=$('chatsBadge');
  if(b){ b.textContent=total>99?'99+':total; b.classList.toggle('on',total>0); }
}
let typingHideTimer=null;
function showTyping(){ $('typing').style.display='flex'; const b=$('chatBody'); b.scrollTop=b.scrollHeight; clearTimeout(typingHideTimer); typingHideTimer=setTimeout(()=>{$('typing').style.display='none';},3500); }
async function typingPing(){
  if(!chatUser)return; const now=Date.now(); if(now-lastTypingSent<1500)return; lastTypingSent=now;
  const key=convKey(me().id,chatUser.id);
  try{ await sb.from('typing').upsert({conversation:key,user_id:me().id,updated_at:new Date().toISOString()}); }catch(e){}
}

/* ================= REALTIME ================= */
function subscribeRealtime(){
  sb.channel('messages-ch')
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'messages'},payload=>{
      const m=payload.new;
      const forMe=m.sender_id===me().id||m.receiver_id===me().id||(m.group_id&&myGroupIds.has(m.group_id));
      if(!forMe)return;
      if(m.sender_id!==me().id&&blockedIds.has(m.sender_id))return;
      if(m.group_id){
        if(chatGroup&&$('chat').style.display==='flex'&&m.group_id===chatGroup.id){
          if(m.sender_id!==me().id)appendBubble(m);
        }else{
          if(m.sender_id!==me().id&&!getMuted().has(m.group_id))toast('New message');
          if(currentScreen==='Chats')loadChats();
        }
        refreshUnread();return;
      }
      const other=m.sender_id===me().id?m.receiver_id:m.sender_id;
      if(chatUser&&$('chat').style.display==='flex'&&other===chatUser.id){
        if(m.sender_id!==me().id){appendBubble(m);markRead([m]);$('typing').style.display='none';}
      }else{
        if(m.sender_id!==me().id&&!getMuted().has(m.sender_id))toast('New message');
        if(currentScreen==='Chats')loadChats();
      }
      refreshUnread();
    })
    .on('postgres_changes',{event:'DELETE',schema:'public',table:'messages'},payload=>{
      const m=payload.old;
      const forMe=m.sender_id===me().id||m.receiver_id===me().id||(m.group_id&&myGroupIds.has(m.group_id));
      if(!forMe)return;
      const el=document.getElementById('m_'+m.id);if(el)el.remove();if(currentScreen==='Chats')loadChats();refreshUnread();
    })
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'messages'},payload=>{
      const m=payload.new;
      const forMe=m.sender_id===me().id||m.receiver_id===me().id||(m.group_id&&myGroupIds.has(m.group_id));
      if(!forMe)return;
      const el=document.getElementById('m_'+m.id);
      if(el&&m.read){const s=el.querySelector('.seen');if(s){s.innerHTML=icon('checks',14);s.classList.add('on');}}
      if(el&&m.played){const v=el.querySelector('.voice');if(v)v.classList.add('played');}
      if(msgCache[m.id])msgCache[m.id].reactions=m.reactions;
      setReactionsDom(m.id,m.reactions);
    })
    .subscribe();

  sb.channel('typing-ch').on('postgres_changes',{event:'*',schema:'public',table:'typing'},payload=>{
    const r=payload.new; if(!r)return;
    if(!chatUser||$('chat').style.display!=='flex')return;
    if(r.conversation===convKey(me().id,chatUser.id)&&r.user_id===chatUser.id)showTyping();
  }).subscribe();

  sb.channel('notifications-ch').on('postgres_changes',{event:'INSERT',schema:'public',table:'notifications'},payload=>{
    if(payload.new.user_id===me().id){ if($('notif').classList.contains('on'))openNotif(); else {refreshNotif();toast('New notification');} }
  }).subscribe();

  sb.channel('posts-ch').on('postgres_changes',{event:'INSERT',schema:'public',table:'posts'},payload=>{
    if(currentScreen==='Feed'&&payload.new.author_id!==me().id) toast('New post available');
  }).subscribe();
}

/* ================= BOOT ================= */
(async function(){
  try{
    let {data:{session}}=await sb.auth.getSession();
    if(session){
      /* If the service worker sent a reply while the app was closed, it may
         have rotated the refresh token (Supabase issues a new one on every
         refresh and invalidates the old). Adopt whatever IndexedDB has if
         it's newer, so this session doesn't get logged out using a
         refresh token the SW already spent. */
      try{
        const idbSess=await idbGet('session');
        if(idbSess&&idbSess.refresh_token&&idbSess.refresh_token!==session.refresh_token){
          const {data,error}=await sb.auth.setSession({access_token:idbSess.access_token,refresh_token:idbSess.refresh_token});
          if(!error&&data.session)session=data.session;
        }
      }catch(_){}
      await saveSessionToIDB(session);
      const ok=await loadMyProfile(session.user.id,session.user.email);
      if(ok) enterApp(); else { await sb.auth.signOut(); setAuthMode(false); }
    } else { setAuthMode(false); }
  }catch(e){ setAuthMode(false); }
  sb.auth.onAuthStateChange((event,session)=>{
    if(event==='SIGNED_OUT'){ myProfile=null; clearSessionFromIDB(); }
    else if(session){ saveSessionToIDB(session); }
  });
})();
