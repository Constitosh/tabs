
/* abs-bundles-ext.js — Option B bundles (first 100 buyers + top 100 holders), non-invasive
   - No dependency on internal vars; works if `getFundingWallets(tokenCA, address)` is present.
   - Persists funders aggregate via /api/funders/batch.
   - Colors bubbles by bundle and highlights group on hover.
   - Defensive: never throws; logs a small version banner.
*/
(function(global){
  console.log('%cabs-bundles-ext vB.3 loaded','color:#0f0');
  const $ = (s)=>document.querySelector(s);
  const sleep = (ms)=> new Promise(r=> setTimeout(r,ms));
  const CONCURRENCY = 3;
  const MAX_FIRST = 100;
  const MAX_TOP = 100;
  const COLORS = ['#7bd389','#59a5d8','#f7a072','#f28482','#c4a7e7','#8bd3dd','#ffd166','#06d6a0','#a0c4ff','#ffadad'];

  function hash(a){ try{return (a||'').toLowerCase();}catch{return a;} }
  function chooseColor(i){ return COLORS[i % COLORS.length]; }

  function readHoldersFromBubbles(){
    const root = $('#bubble-canvas');
    if (!root) return [];
    const nodes = root.querySelectorAll('[data-address]');
    const arr = [];
    nodes.forEach(n=>{
      const address = n.getAttribute('data-address');
      if (!address) return;
      // try to read pct from text content like "1.23%"
      let pct = 0;
      const t = (n.textContent||'').trim();
      const m = t.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
      if (m) pct = parseFloat(m[1]);
      arr.push({ address: hash(address), balancePct: pct });
    });
    // sort desc pct
    arr.sort((a,b)=> (b.balancePct-a.balancePct));
    return arr;
  }

  function readFirstBuyers(){
    // best-effort: if page exposes first25 list
    const lst = global.first25 || global.__first25 || [];
    return Array.isArray(lst) ? lst.map(x => ({ address: hash(x.address || x.buyer || x.addr || x.wallet || x[0] || '') })).filter(x=>x.address) : [];
  }

  function waitForBubbles(timeoutMs=8000){
    const root = $('#bubble-canvas');
    if (!root) return null;
    const nodes = root.querySelectorAll('[data-address], circle');
    if (nodes.length>20) return root;
    const start = Date.now();
    return new Promise(async (resolve)=>{
      const mo = new MutationObserver(()=>{
        const nds = root.querySelectorAll('[data-address], circle');
        if (nds.length>20){ mo.disconnect(); resolve(root); }
      });
      mo.observe(root, { childList:true, subtree:true });
      const tick = async ()=>{
        while(Date.now()-start < timeoutMs){
          await sleep(200);
          const nds = root.querySelectorAll('[data-address], circle');
          if (nds.length>20){ mo.disconnect(); resolve(root); return; }
        }
        mo.disconnect(); resolve(root);
      };
      tick();
    });
  }

  async function resolveFunders(tokenCA, holders, firstBuyers){
    const top = holders.slice(0, MAX_TOP);
    const first = firstBuyers.slice(0, MAX_FIRST);
    const addrs = Array.from(new Set([...top.map(h=>h.address), ...first.map(f=>f.address)])).filter(Boolean);
    if (!addrs.length) return new Map();
    if (typeof global.getFundingWallets !== 'function'){
      console.warn('[bundles] getFundingWallets not found. Skipping live resolve.');
      return new Map();
    }
    // simple pool
    let i=0, active=0; const results=[]; const tasks=[];
    function run(){
      while(active<CONCURRENCY && i<addrs.length){
        const a = addrs[i++]; active++;
        tasks.push((async()=>{
          try{
            const r = await global.getFundingWallets(tokenCA, a);
            if (r && r.funder){
              results.push({ funder: hash(r.funder), buyer: a, amountInETH:Number(r.amountInETH||0), amountOutETH:Number(r.amountOutETH||0), firstTs:r.firstTs||0 });
            }
          }catch(e){}
          active--; run();
        })());
      }
    }
    run();
    await Promise.all(tasks);
    if (results.length){
      try{
        await fetch('/api/funders/batch', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ tokenCA, entries: results }) });
      }catch(e){ console.warn('persist failed', e); }
    }
    const byFunder = new Map();
    for (const r of results){
      const g = byFunder.get(r.funder) || { buyers:new Set() };
      g.buyers.add(r.buyer); byFunder.set(r.funder, g);
    }
    return byFunder;
  }

  function applyBundleColors(root, bundles){
    const keys = Array.from(bundles.keys());
    keys.forEach((k, idx)=>{
      const col = chooseColor(idx);
      const buyers = bundles.get(k).buyers || new Set();
      buyers.forEach(addr=>{
        const el = root.querySelector(`[data-address="${addr}"]`);
        if (!el) return;
        el.style.stroke = col; el.style.strokeWidth = '2px';
        el.addEventListener('mouseenter', ()=>{
          buyers.forEach(a2=>{
            const n = root.querySelector(`[data-address="${a2}"]`);
            if (n){ n.style.filter='brightness(1.5)'; n.style.opacity='1'; }
          });
          root.querySelectorAll('[data-address]').forEach(n=>{
            const a = n.getAttribute('data-address');
            if (!buyers.has(a)){ n.style.opacity='0.25'; n.style.filter='grayscale(0.7)'; }
          });
        });
        el.addEventListener('mouseleave', ()=>{
          root.querySelectorAll('[data-address]').forEach(n=>{ n.style.opacity=''; n.style.filter=''; });
        });
      });
    });
  }

  async function main(){
    const root = await waitForBubbles();
    if (!root) return;
    // ensure data-address population: copy from plausible fallbacks
    root.querySelectorAll('circle').forEach(n=>{
      if (!n.getAttribute('data-address')){
        const a = n.getAttribute('data-addr') || n.getAttribute('data-wallet') || n.getAttribute('data-id');
        if (a) n.setAttribute('data-address', hash(a));
      }
    });
    // obtain tokenCA if page exposes it
    const tokenCA = (global.__currentTokenRow && (global.__currentTokenRow.baseAddress||global.__currentTokenRow.address)) || (global.CURRENT_TOKEN && CURRENT_TOKEN.address) || '';
    // holders + first buyers (best-effort)
    const holders = readHoldersFromBubbles();
    const first = readFirstBuyers();
    if (!tokenCA || !holders.length) return;
    const bundles = await resolveFunders(tokenCA, holders, first);
    applyBundleColors(root, bundles);
  }

  // Run once page is interactive
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();
})(window);
