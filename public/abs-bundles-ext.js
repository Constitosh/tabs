/*! abs-bundles-ext vB.4 — safe loader
 *  - Non-blocking: waits for bubble nodes, never throws, won't affect rendering if nothing is ready.
 *  - Option B: (first 100 buyers + top 100 holders) when helpers are present.
 */
(function(){
  const VERSION = 'vB.4';
  const log = (...a)=>console.log('[bundles-ext '+VERSION+']', ...a);
  const warn = (...a)=>console.warn('[bundles-ext '+VERSION+']', ...a);

  fetch('/api/snapshot/latest', { cache:'no-store' }).then(r=>{
    if (!r.ok) warn('backend not OK', r.status);
    else log('backend OK');
  }).catch(()=>warn('backend unreachable'));

  function lower(s){ try{return (s||'').toLowerCase();}catch{return s} }

  function getTokenCA(){
    try {
      if (window.__currentTokenRow?.baseAddress) return lower(window.__currentTokenRow.baseAddress);
      const caEl = document.querySelector('[data-token-ca]');
      if (caEl) return lower(caEl.getAttribute('data-token-ca'));
      const card = Array.from(document.querySelectorAll('.card b'))
        .map(el=>el.textContent.trim())
        .find(t=>/^0x[0-9a-fA-F]{40}$/.test(t));
      if (card) return lower(card);
    } catch(e){}
    return '';
  }

  function collectBubbles(){
    const root = document.getElementById('bubble-canvas');
    if (!root) return { root:null, nodes:[] };
    const nodes = root.querySelectorAll('[data-address], [data-addr], [role="bubble"], circle');
    return { root, nodes: Array.from(nodes) };
  }

  function ensureDataAddress(nodes){
    nodes.forEach(n=>{
      if (!n.getAttribute) return;
      if (!n.getAttribute('data-address')){
        const a = n.getAttribute('data-addr') || n.getAttribute('data-wallet') || n.getAttribute('data-id') || '';
        if (/^0x[0-9a-f]{40}$/i.test(a)) n.setAttribute('data-address', lower(a));
      }
    });
  }

  async function resolveBundles(tokenCA, addresses){
    if (typeof window.getFundingWallets !== 'function'){
      warn('getFundingWallets(...) helper not found; skipping bundle resolve.');
      return new Map();
    }
    const uniq = Array.from(new Set(addresses.map(lower))).slice(0,200);
    const CONC = 3;
    let i=0, active=0;
    const results=[];

    const runNext=()=>{
      while(active<CONC && i<uniq.length){
        const addr = uniq[i++];
        active++;
        (async()=>{
          try{
            const r = await window.getFundingWallets(tokenCA, addr);
            if (r && r.funder){
              results.push({ funder: lower(r.funder), buyer: lower(addr),
                amountInETH: Number(r.amountInETH||0), amountOutETH: Number(r.amountOutETH||0), firstTs: r.firstTs||0 });
            }
          }catch(e){}
          active--; runNext();
        })();
      }
    };
    await new Promise(res=>{ runNext(); const t=setInterval(()=>{ if(active===0 && i>=uniq.length){clearInterval(t);res();}},50);});

    if (results.length){
      fetch('/api/funders/batch',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({ tokenCA, entries: results })
      }).catch(()=>{});
    }

    const by=new Map();
    for(const r of results){
      const g=by.get(r.funder)||{funder:r.funder,buyers:new Set()};
      g.buyers.add(r.buyer);
      by.set(r.funder,g);
    }
    return by;
  }

  function colorize(root,bundles){
    const COLORS=['#7bd389','#59a5d8','#f7a072','#f28482','#c4a7e7','#8bd3dd','#ffd166','#06d6a0','#a0c4ff','#ffadad'];
    Array.from(bundles.keys()).forEach((k,idx)=>{
      const g=bundles.get(k);
      const col=COLORS[idx%COLORS.length];
      g.buyers.forEach(addr=>{
        const el=root.querySelector(`[data-address="${addr}"]`);
        if(!el) return;
        el.style.stroke=col; el.style.strokeWidth='2px';
        el.addEventListener('mouseenter',()=>{
          g.buyers.forEach(a=>{ const n=root.querySelector(`[data-address="${a}"]`); if(n){n.style.filter='brightness(1.5)'; n.style.opacity='1';}});
          root.querySelectorAll('[data-address]').forEach(n=>{ const a=n.getAttribute('data-address'); if(!g.buyers.has(a)){n.style.opacity='0.25'; n.style.filter='grayscale(0.7)';}});
        });
        el.addEventListener('mouseleave',()=>{ root.querySelectorAll('[data-address]').forEach(n=>{ n.style.opacity=''; n.style.filter='';}); });
      });
    });
  }

  function startWhenReady(){
    let tries=0; const maxTries=100;
    const iv=setInterval(async()=>{
      tries++;
      const {root,nodes}=collectBubbles();
      if(!root||nodes.length===0){
        if(tries%20===0) log('waiting for bubble nodes…');
        if(tries>=maxTries){ clearInterval(iv); warn('no bubbles found; giving up'); }
        return;
      }
      clearInterval(iv);
      ensureDataAddress(nodes);
      const addresses=nodes.map(n=>(n.getAttribute&&n.getAttribute('data-address'))||'').filter(Boolean);
      const tokenCA=getTokenCA();
      if(!tokenCA){ warn('token CA not detected; skip bundles'); return; }
      try{
        const bundles=await resolveBundles(tokenCA,addresses);
        if(bundles.size>0) colorize(root,bundles);
        else log('no bundles resolved');
      }catch(e){ warn('bundle step failed',e); }
    },100);
  }

  window.addEventListener('DOMContentLoaded', startWhenReady);
  log('loaded');
})();
