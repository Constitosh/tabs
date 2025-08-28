
/* === Bundle Detection vB === */
(function(global){
  const COLORS = ['#7bd389','#59a5d8','#f7a072','#f28482','#c4a7e7','#8bd3dd','#ffd166','#06d6a0','#a0c4ff','#ffadad'];
  function pickColor(i){ return COLORS[i % COLORS.length]; }
  function hashAddr(a){ return (a||'').toLowerCase(); }

  window.addEventListener('tabs:singleTokenLoaded', async (ev)=>{
    const ca = ev.detail?.token?.baseAddress;
    if (!ca) return;
    try{
      const res = await fetch(`/api/funders/${ca}`);
      const data = await res.json();
      const funders = data.funders || [];
      // Group by funder
      const groups = {};
      let idx=0;
      for (const f of funders){
        const key = hashAddr(f.wallet);
        if (!groups[key]) groups[key] = { color: pickColor(idx++), members: new Set() };
        groups[key].members.add(hashAddr(f.buyer));
      }
      const root = document.getElementById('bubble-canvas');
      if (!root) return;
      // Apply colors
      for (const g of Object.values(groups)){
        g.members.forEach(addr=>{
          const el = root.querySelector(`[data-address="${addr}"]`);
          if (el){ el.style.stroke=g.color; el.style.strokeWidth='2px'; }
        });
      }
    }catch(e){ console.error('funders fetch error',e); }
  });
})(window);


/* === Bundle Resolver (Option B) ===
   - Limit to first 100 buyers + top 100 holders
   - Resolve funding source with user existing helper `getFundingWallets` if present.
   - Rate-limited queue (3 concurrent), cached via /api/funders/batch
*/
(function(global){
  const $ = (s)=>document.querySelector(s);
  const CONCURRENCY = 3;
  const MAX_FIRST = 100;
  const MAX_TOP = 100;

  function hash(a){ try{return (a||'').toLowerCase();}catch{ return a; } }

  async function resolveBundleFunding(tokenCA, holders, firstBuyers){
    // slice
    const top = (holders||[]).slice(0, MAX_TOP);
    const first = (firstBuyers||[]).slice(0, MAX_FIRST);

    // Build unique target buyer list (addresses)
    const addrSet = new Set();
    top.forEach(h => h && h.address && addrSet.add(hash(h.address)));
    first.forEach(b => b && (b.address||b.buyer) && addrSet.add(hash(b.address||b.buyer)));
    const addresses = Array.from(addrSet);

    if (!addresses.length) return { bundles:new Map(), saved:0 };

    // pick resolver
    const hasHelper = typeof global.getFundingWallets === 'function';
    if (!hasHelper){
      console.warn('[bundles] getFundingWallets(...) not found; skipping resolver.');
      return { bundles:new Map(), saved:0 };
    }

    // simple promise pool
    let i = 0, active = 0, done = 0;
    const results = [];
    const queue = [];

    const runNext = ()=>{
      while(active < CONCURRENCY && i < addresses.length){
        const addr = addresses[i++];
        active++;
        const p = (async()=>{
          try{
            // expected shape: { funder, amountInETH, amountOutETH, firstTs }
            const r = await global.getFundingWallets(tokenCA, addr);
            if (r && r.funder){
              results.push({ funder: hash(r.funder), buyer: addr, amountInETH: Number(r.amountInETH||0), amountOutETH: Number(r.amountOutETH||0), firstTs: r.firstTs||0 });
            }
          }catch(e){ /* ignore individual errors */ }
          active--; done++;
          runNext();
        })();
        queue.push(p);
      }
    };
    runNext();
    await Promise.all(queue);

    // aggregate by funder
    const byFunder = new Map();
    for (const r of results){
      const g = byFunder.get(r.funder) || { funder: r.funder, buyers: new Set(), amountInETH:0, amountOutETH:0 };
      g.buyers.add(r.buyer);
      g.amountInETH += r.amountInETH||0;
      g.amountOutETH += r.amountOutETH||0;
      byFunder.set(r.funder, g);
    }

    // persist
    if (results.length){
      try{
        await fetch('/api/funders/batch', {
          method:'POST',
          headers: { 'content-type':'application/json' },
          body: JSON.stringify({ tokenCA, entries: results })
        });
      }catch(e){ console.warn('persist funders failed', e); }
    }

    return { bundles: byFunder, saved: results.length };
  }

  function colorizeBundles(root, bundles){
    const keys = Array.from(bundles.keys());
    const COLORS = ['#7bd389','#59a5d8','#f7a072','#f28482','#c4a7e7','#8bd3dd','#ffd166','#06d6a0','#a0c4ff','#ffadad'];
    function color(i){ return COLORS[i % COLORS.length]; }

    keys.forEach((k, idx)=>{
      const col = color(idx);
      const info = bundles.get(k);
      info.buyers.forEach(addr => {
        const el = root.querySelector(`[data-address="${addr}"]`);
        if (el){
          el.style.stroke = col;
          el.style.strokeWidth = '2px';
          el.addEventListener('mouseenter', ()=>{
            // highlight same bundle
            info.buyers.forEach(a2 => {
              const n = root.querySelector(`[data-address="${a2}"]`);
              if (n){ n.style.filter='brightness(1.5)'; n.style.opacity='1'; }
            });
            root.querySelectorAll('[data-address]').forEach(n=>{
              const a = n.getAttribute('data-address');
              if (!info.buyers.has(a)){ n.style.opacity='0.25'; n.style.filter='grayscale(0.7)'; }
            });
          });
          el.addEventListener('mouseleave', ()=>{
            root.querySelectorAll('[data-address]').forEach(n=>{ n.style.opacity=''; n.style.filter=''; });
          });
        }
      });
    });
  }

  // Wire to event
  window.addEventListener('tabs:singleTokenLoaded', async (ev)=>{
    const d = ev.detail||{};
    const tokenCA = d.token?.baseAddress || d.token?.address || d.token || '';
    const holders = d.holders || [];
    const first = d.firstBuyers || d.first || [];
    const root = document.getElementById('bubble-canvas');
    if (!tokenCA || !root) return;
    try{
      const { bundles } = await resolveBundleFunding(tokenCA, holders, first);
      colorizeBundles(root, bundles);
    }catch(e){ console.warn('bundle resolver failed', e); }
  });

})(window);


/* Ensure bubble nodes expose data-address for selectors */
(function(){
  const root = document.getElementById('bubble-canvas');
  if (!root) return;
  const nodes = root.querySelectorAll('circle, [role="bubble"]');
  nodes.forEach(n => {
    if (!n.getAttribute('data-address')){
      const a = n.getAttribute('data-addr') || n.getAttribute('data-wallet') || n.getAttribute('data-id');
      if (a) n.setAttribute('data-address', a.toLowerCase());
    }
  });
})();
