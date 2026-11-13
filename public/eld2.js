/* Reinos de Eldmor · menu e utilidades compartilhadas do site */
(function(){
const PLAY='https://eldmor-server.onrender.com/';
const NAV=[['inicio','site.html','🏠','Início'],['jogo','jogo.html','🎮','O Jogo'],['classes','jogo.html#classes','⚔️','Classes'],['mundo','jogo.html#mundo','🗺️','Mundo'],['loja','loja.html','🏪','Loja'],['passe','passe.html','👑','Passe'],['eventos','eventos.html','📅','Eventos'],['ranking','eventos.html#ranking','🏆','Ranking'],['guildas','guildas.html','🛡️','Guildas'],['codigos','eventos.html#codigos','🎁','Códigos']];
const h=document.querySelector('header.top');if(!h)return;
const page=h.dataset.page||'';const keep=h.querySelector('.diac');
h.innerHTML=`<div class="wrap"><a class="logo" href="site.html"><span class="cr">👑</span><b>Reinos de Eldmor</b></a><nav class="nav">${NAV.map(([id,href,i,n])=>`<a href="${href}" data-id="${id}"${id===page?' class="on"':''}><span class="i">${i}</span>${n}</a>`).join('')}</nav><a class="btn gold s play" href="${PLAY}">▶ Jogar Agora</a><button class="burger" aria-label="Menu">☰</button></div>`;
const w=h.querySelector('.wrap');if(keep)w.insertBefore(keep,h.querySelector('.burger'));
h.querySelector('.burger').onclick=()=>h.classList.toggle('open');
h.querySelectorAll('.nav a').forEach(a=>a.addEventListener('click',()=>h.classList.remove('open')));
/* marca a aba pelo #hash nas páginas com seções */
function mark(){const hs=location.hash.slice(1);const m={classes:'classes',mundo:'mundo',ranking:'ranking',codigos:'codigos'}[hs];if(m&&(page==='jogo'||page==='eventos')){h.querySelectorAll('.nav a').forEach(a=>a.classList.toggle('on',a.dataset.id===m))}}
mark();addEventListener('hashchange',mark);
if(window.ELD_SAME)document.querySelectorAll('a[href^="'+PLAY+'"]').forEach(a=>a.href='/');
/* utilidades */
window.ELD={API:(window.ELD_SAME?location.origin:'https://eldmor-server.onrender.com')+'/api/',
 esc:t=>String(t==null?'':t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]),
 tok(){try{return (JSON.parse(localStorage.getItem('eldsite-acc')||'null')||{}).tok||null}catch(_){return null}},
 async api(p,b){const t=this.tok();const r=await fetch(this.API+p,{method:b?'POST':'GET',cache:'no-store',headers:Object.assign({'content-type':'application/json'},t?{authorization:'Bearer '+t}:{}),body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(_){}if(!r.ok){const e=new Error(j.err||('Erro '+r.status));e.need=j.need;e.status=r.status;throw e}return j},
 fmt:n=>(+n||0).toLocaleString('pt-BR'),
 MED:['🥇','🥈','🥉'],CLS:{warrior:'Guerreiro',mage:'Mago',archer:'Arqueiro'}};
})();
