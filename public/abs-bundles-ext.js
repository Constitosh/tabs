/*! abs-bundles-ext vB.5 — DOM-observing, non-blocking
 *  - Waits for single-token mode by observing DOM changes (no fixed timeouts).
 *  - Option B: resolve first 100 buyers + top 100 holders (when helper exists).
 *  - Never throws; logs only. Does not touch your math or core modules.
 */
(function(){
  const VERSION = 'vB.5';
  const log  = (...a)=>console.log('[bundles-ext '+VERSION+']', ...a);
  const warn = (...a)=>console.warn('[bundles-ext '+VERSION+']', ...a);

  // Quick backend reachability check (optional, won’t crash)
  fetch('/api/snapshot/latest', { cache:'no-store' })
    .then(r => r.ok ? log('backend OK') : warn('backend not OK', r.status))
    .catch(()=> warn('backend unreachable'));

  // ——— utils
  const lower = s => { try{return (s||'').toLowerCase();}catch{return s} };

  function getTokenCA(){
    try{
      if (window.__currentTokenRow?.baseAddress) return lower(window.__currentTokenRow.baseAddress);
      const caEl = document.querySelector('[data-token-ca]');
      if (caEl) return lower(caEl.getAttribute('data-token-ca'));
      // Fallback: read from visible “Token CA” card if present
      const b = Array.from(document.querySelectorAll('.card b'))
        .map(el=>el.textContent.trim())
        .find(t=>/^0x[0-9a-fA-F]{40}$/.test(t));
      if (b) return lower(b);
    }catch(e){}
    return '';
  }

  function collectBubbles(){
    const root = document.getElementById('bubble-canvas');
    if (!root) return { root:null, nodes:[] };
    // Prefer elements that already expose the address
    let nodes = Array.from(root.querySelectorAll('[data-address]'));
    if (nodes.length === 0) {
      // Fallbacks: common shapes/attrs your renderer might use
      nodes = Array.from(root.querySelectorAll('[data-addr],[data-wallet],[role="bubble"],circle'));
    }
    return { root, nodes };
  }

  function ensureDataAddress(nodes){
    for (const n of nodes){
      if (!n || !n.getAttribute) continue;
      if (!n.getAttribute('data-address')){
        const a = n.getAttribute('data-addr') || n.getAttribute('data-wallet') || n.getAttribute('data-id') || '';
        if (/^0x[0-9a-f]{40}$/i.test(a)) n.setAttribute('data-address', lower(a));
      }
    }
  }

  async function resolveBundles(tokenCA, addresses){
    if (typeof window.getFundingWallets !== 'function'){
      warn('getFundingWallets(...) not found; skipping bundle resolve.');
      return new Map();
    }
    // Option B: 100 top + 100 first. We only see bubbles (holders) here; addresses list is deduped to 200.
    const uniq = Array.from(new Set(addresses.map(lower))).slice(0, 200);
    const CONC = 3;
    let i=0, active=0;
    const results = [];

    const runNext = ()=>{
      while(active<CONC && i<uniq.length){
        const addr = uniq[i++];
        active++;
        (async ()=>{
          try{
            const r = await window.getFundingWallets(tokenCA, addr);
            if (r && r.funder){
              results.push({
                funder: lower(r.funder),
                buyer:  lower(addr),
                amountInETH: Number(r.amountInETH||0),
                amountOutETH: Number(r.amountOutETH||0),
                firstTs: r.firstTs||0
              });
            }
          }catch(e){ /* ignore individual failures */ }
          active--; runNext();
        })();
      }
    };

    await new Promise(res=>{
      runNext();
      const check = setInterval(()=>{
        if (active===0 && i>=uniq.length){ clearInterval(check); res(); }
      }, 50);
    });

    if (results.length){
      // Persist aggregate to backend cache
      fetch('/api/funders/batch', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body: JSON.stringify({ tokenCA, entries: results })
      }).catch(()=>{});
    }

    const by = new Map();
    for (const r of results){
      const g = by.get(r.funder) || { funder:r.funder, buyers:new Set() };
      g.buyers.add(r.buyer);
      by.set(r.funder, g);
    }
    return by;
  }

  function colorize(root, bundles){
    const COLORS = ['#7bd389','#59a5d8','#f7a072','#f28482','#c4a7e7','#8bd3dd','#ffd166','#06d6a0','#a0c4ff','#ffadad'];
    const keys = Array.from(bundles.keys());
    keys.forEach((k, idx)=>{
      const g   = bundles.get(k);
      const col = COLORS[idx % COLORS.length];
      g.buyers.forEach(addr=>{
        const el = root.querySelector(`[data-address="${addr}"]`);
        if (!el) return;
        el.style.stroke = col;
        el.style.strokeWidth = '2px';
        el.addEventListener('mouseenter', ()=>{
          g.buyers.forEach(a=>{
            const n = root.querySelector(`[data-address="${a}"]`);
            if (n){ n.style.filter='brightness(1.5)'; n.style.opacity='1'; }
          });
          root.querySelectorAll('[data-address]').forEach(n=>{
            const a = n.getAttribute('data-address');
            if (!g.buyers.has(a)){ n.style.opacity='0.25'; n.style.filter='grayscale(0.7)'; }
          });
        });
        el.addEventListener('mouseleave', ()=>{
          root.querySelectorAll('[data-address]').forEach(n=>{ n.style.opacity=''; n.style.filter=''; });
        });
      });
    });
  }

  // ——— main: observe DOM until bubbles exist (works even if single-token loads later)
  let activatedForToken = '';   // prevent double-run on the same token
  function maybeRunForCurrentToken(){
    const tokenCA = getTokenCA();
    const { root, nodes } = collectBubbles();
    if (!tokenCA || !root || nodes.length===0) return false;

    // Only run once per token view
    if (activatedForToken === tokenCA) return true;
    activatedForToken = tokenCA;

    ensureDataAddress(nodes);
    const addresses = nodes.map(n => (n.getAttribute && n.getAttribute('data-address')) || '').filter(Boolean);

    resolveBundles(tokenCA, addresses)
      .then(bundles=>{
        if (bundles.size>0) colorize(root, bundles);
        else log('no bundles resolved (helper missing or no overlaps)');
      })
      .catch(e=> warn('bundle step failed', e));
    return true;
  }

  function setupObserver(){
    const obs = new MutationObserver(() => {
      // Try to run whenever DOM changes (new single-token view or bubbles)
      maybeRunForCurrentToken();
    });
    obs.observe(document.documentElement, { childList:true, subtree:true });

    // Also try on initial load and on popstate/navigation
    window.addEventListener('popstate', maybeRunForCurrentToken);
    window.addEventListener('hashchange', maybeRunForCurrentToken);

    // Try a couple times immediately (in case single-token is already visible)
    setTimeout(maybeRunForCurrentToken, 100);
    setTimeout(maybeRunForCurrentToken, 600);
    setTimeout(maybeRunForCurrentToken, 1500);

    log('observer ready');
  }

  window.addEventListener('DOMContentLoaded', setupObserver);
  log('loaded');
})();
