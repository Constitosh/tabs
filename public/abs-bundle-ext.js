/* =======================================================================
 * abs-bundles-ext.js — v2
 *  - FIX: percent now reflects true % of TOTAL SUPPLY (no renormalization).
 *  - NEW: first 50 buys scan + sold-out status + optional persistence.
 *  - Keeps auto-wrap option (window.__USE_AUTO_WRAP_BUBBLES = true).
 *
 * Expected holder shape (any of these is OK):
 *   { address, percent }                     // already % of total supply
 *   { address, pctOfSupply }                 // alias
 *   { address, tokens, totalSupply }         // we compute percent = tokens/totalSupply*100
 * If both 'percent' and 'tokens/totalSupply' exist, we trust 'percent' if finite.
 *
 * Persistence endpoints (best-effort, optional):
 *   POST /api/bundles/snapshot
 *     -> { token, snapshot: { ts, token, holders:[{address, percent, bundleId}] } }
 *
 *   POST /api/bundles/save
 *     -> { token, snapshot:{ts,token}, bundles:[{
 *           funding, wallets, totalBoughtETH, totalSoldETH,
 *           totalBoughtAllocationPct, totalSoldAllocationPct
 *         }]
 *        }
 *
 *   POST /api/bundles/first50
 *     -> { token, ts, items:[{
 *           address, firstInTs, firstInETH, funder, isInBundle, bundleId,
 *           holdingPct, soldAll
 *         }], bundleSummary:[{ funding, count }] }
 * ======================================================================= */
(function(){
  if (window.__ABS_BUNDLES_EXT_V2__) return; window.__ABS_BUNDLES_EXT_V2__ = true;

  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  const LP_HINTS = ['uniswap','sushiswap','weth','lp','pool'];
  const MIN_BUNDLE_SIZE = 2;
  const COLOR_PALETTE = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc949','#af7aa1','#ff9da7','#9c755f','#bab0ab'];

  const __txCache = new Map();
  const __supplyCache = new Map(); // optional totalSupply per token for tokens->percent calc

  function isLikelyLP(addr = '', label = ''){
    const hay = (String(addr) + ' ' + String(label)).toLowerCase();
    return LP_HINTS.some(h => hay.includes(h));
  }
  function stableColorFor(key){
    let hash=0; for(let i=0;i<key.length;i++) hash=((hash<<5)-hash+key.charCodeAt(i))|0;
    return COLOR_PALETTE[Math.abs(hash)%COLOR_PALETTE.length];
  }
  function ensurePercentOverlay(containerEl){
    let el = containerEl.querySelector('.bubble-total-overlay');
    if(!el){
      el = document.createElement('div');
      el.className = 'bubble-total-overlay mono';
      Object.assign(el.style, {position:'absolute',left:'10px',bottom:'8px',fontSize:'11px',opacity:'0.8',pointerEvents:'none',userSelect:'none'});
      if(getComputedStyle(containerEl).position==='static'){ containerEl.style.position='relative'; }
      containerEl.appendChild(el);
    }
    return el;
  }

  // ---- percent calculator (NO re-normalization) ----
  function computePercent(h, tokenCA){
    // prefer explicit 'percent' if finite
    const p = Number(h.percent);
    if (Number.isFinite(p)) return p;

    const p2 = Number(h.pctOfSupply);
    if (Number.isFinite(p2)) return p2;

    // tokens/totalSupply route
    const bal = Number(h.tokens);
    const sup = Number(h.totalSupply ?? __supplyCache.get(tokenCA?.toLowerCase() || ''));
    if (Number.isFinite(bal) && bal>=0 && Number.isFinite(sup) && sup>0){
      return (bal / sup) * 100;
    }
    return 0;
  }

  // ---- bundle detection by first inbound funder ----
  function detectBundlesByFunding(holdersList, txsList){
    if(!Array.isArray(txsList) || txsList.length===0){
      return { augmented: holdersList.map(h=>({...h,bundleId:null})), bundles:[] };
    }
    const byTo = new Map();
    for(const t of txsList){
      if(!t || !t.to) continue;
      const key = String(t.to).toLowerCase();
      if(!byTo.has(key)) byTo.set(key, []);
      byTo.get(key).push(t);
    }
    for(const arr of byTo.values()) arr.sort((a,b)=>(a.ts||0)-(b.ts||0));

    const fundingOf = new Map();
    for(const h of holdersList){
      const addr = String(h.address||'').toLowerCase();
      const inList = byTo.get(addr);
      let funder=null;
      if(inList && inList.length){
        for(const tx of inList){
          const from = String(tx.from||'').toLowerCase();
          if(!from || from===ZERO_ADDR) continue;
          if(isLikelyLP(from, h.label)) continue;
          funder=from; break;
        }
      }
      fundingOf.set(addr, funder);
    }

    const buckets = new Map();
    for(const h of holdersList){
      const addr = String(h.address||'').toLowerCase();
      const funder = fundingOf.get(addr);
      if(!funder) continue;
      if(!buckets.has(funder)) buckets.set(funder, []);
      buckets.get(funder).push(addr);
    }

    const bundles=[];
    for(const [funder,members] of buckets.entries()){
      const uniq = Array.from(new Set(members));
      if(uniq.length>=MIN_BUNDLE_SIZE) bundles.push({funder, wallets:uniq});
    }

    const bundleOf = new Map();
    for(const b of bundles) for(const w of b.wallets) bundleOf.set(w, b.funder);

    const augmented = holdersList.map(h=>{
      const addr = String(h.address||'').toLowerCase();
      const bid = bundleOf.get(addr) || null;
      return {...h, bundleId: bid};
    });

    return { augmented, bundles, fundingOf };
  }

  function aggregateBundleTotals(bundles, holdersAug, txsList){
    const byAddr = new Map(); holdersAug.forEach(h=>byAddr.set(String(h.address||'').toLowerCase(), h));
    const res = bundles.map(b=>({
      funding:b.funder, wallets:b.wallets,
      totalBoughtETH:0, totalSoldETH:0,
      totalBoughtAllocationPct:0, totalSoldAllocationPct:0
    }));
    const byFunder = new Map(res.map(r=>[r.funding,r]));
    for(const h of holdersAug){
      if(!h.bundleId) continue;
      const bucket = byFunder.get(h.bundleId); if(!bucket) continue;
      bucket.totalBoughtAllocationPct += Number(h.percent)||0;
    }
    for(const t of (txsList||[])){
      const from=String(t.from||'').toLowerCase();
      const to  =String(t.to||'').toLowerCase();
      const val = Number(t.valueEth)||0;
      if(byAddr.has(to)){ const bId=byAddr.get(to).bundleId; if(bId && byFunder.has(bId)) byFunder.get(bId).totalBoughtETH += val; }
      if(byAddr.has(from)){ const bId=byAddr.get(from).bundleId; if(bId && byFunder.has(bId)) byFunder.get(bId).totalSoldETH += val; }
    }
    return res;
  }

  // ---- First 50 buys scan ----
  function computeFirstNBuys(txsList, n=50){
    if(!Array.isArray(txsList)) return [];
    const seen = new Set();
    const arr = [...txsList].filter(t=>t && t.to && t.from).sort((a,b)=>(a.ts||0)-(b.ts||0));
    const out = [];
    for(const t of arr){
      const to = String(t.to).toLowerCase();
      if(seen.has(to)) continue;
      // ignore LP/zero as recipient (rare, but safe)
      if(to===ZERO_ADDR || isLikelyLP(to)) continue;
      seen.add(to);
      out.push({ address: to, firstInTs: t.ts||0, firstInETH: Number(t.valueEth)||0, firstTx: t });
      if(out.length>=n) break;
    }
    return out;
  }

  async function persist(path, payload){
    try{
      await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    }catch(e){ console.warn('Persist failed', path, e?.message||e); }
  }

  // ---- Main renderer ----
  // opts: { holders, txs, tokenCA, svg, containerEl, snapshotMeta, totalSupply }
  window.renderBubblesWithBundles = function(opts){
    const { holders, txs, tokenCA, svg, containerEl, snapshotMeta, totalSupply } = (opts||{});
    if(!holders || !holders.length || !svg) return;
    if(totalSupply && Number(totalSupply)>0) __supplyCache.set(String(tokenCA||'').toLowerCase(), Number(totalSupply));

    // 1) Tie each holder to TRUE percent of total supply
    const mapped = holders.map(h => {
      const pct = computePercent(h, tokenCA);
      return { ...h, percent: pct };
    });

    // 2) Bundles + augmented holders
    const { augmented: holdersAug, bundles, fundingOf } = detectBundlesByFunding(mapped, txs||[]);

    // 3) Aggregates & persistence (snapshot + bundles)
    const bundleTotals = aggregateBundleTotals(bundles, holdersAug, txs||[]);
    const tsNow = snapshotMeta?.ts || Date.now();
    const tokenKey = String(tokenCA||'').toLowerCase();

    if(snapshotMeta){
      persist('/api/bundles/snapshot', {
        token: tokenKey,
        snapshot: {
          ts: tsNow,
          token: tokenKey,
          holders: holdersAug.map(h => ({ address:h.address, percent:h.percent, bundleId:h.bundleId }))
        }
      });
      if(bundles.length){
        persist('/api/bundles/save', {
          token: tokenKey,
          snapshot: { ts: tsNow, token: tokenKey },
          bundles: bundleTotals
        });
      }
    }

    // 4) First 50 buys (if txs are present)
    let first50 = [];
    if (Array.isArray(txs) && txs.length){
      first50 = computeFirstNBuys(txs, 50);
      const byAddr = new Map(holdersAug.map(h => [String(h.address||'').toLowerCase(), h]));
      const summarized = first50.map(x => {
        const h = byAddr.get(x.address);
        const funder = fundingOf.get(x.address) || null;
        const inBundle = !!(h && h.bundleId);
        const holdingPct = Number(h?.percent || 0);
        return {
          address: x.address,
          firstInTs: x.firstInTs,
          firstInETH: x.firstInETH,
          funder,
          isInBundle: inBundle,
          bundleId: h?.bundleId || null,
          holdingPct,
          soldAll: holdingPct <= 0
        };
      });
      const bundleSummaryMap = new Map();
      for(const it of summarized){
        if(!it.funder) continue;
        bundleSummaryMap.set(it.funder, (bundleSummaryMap.get(it.funder)||0)+1);
      }
      const bundleSummary = Array.from(bundleSummaryMap, ([funding,count]) => ({ funding, count }));

      // persist
      persist('/api/bundles/first50', {
        token: tokenKey, ts: tsNow,
        items: summarized,
        bundleSummary
      });
    }

    // 5) Draw bubbles (non-destructive to your CSS/layout)
    const node = svg.selectAll('.holder-bubble').data(holdersAug, d => String(d.address||'').toLowerCase());
    const nodeEnter = node.enter().append('g').attr('class','holder-bubble').style('cursor','pointer');
    nodeEnter.append('circle')
      .attr('r', d => { const p=Math.max(0, d.percent||0); return Math.sqrt(p)*5 + 3; })
      .attr('stroke-width', 1);
    nodeEnter.append('title');

    const merged = nodeEnter.merge(node);
    merged.select('circle')
      .attr('fill', d => d.bundleId ? stableColorFor(d.bundleId) : '#888')
      .attr('stroke', d => d.bundleId ? '#000' : '#555');

    merged.select('title').text(d => {
      const pct = (d.percent || 0).toFixed(4);
      return d.bundleId ? `${d.address}\n${pct}%\nBundle: ${d.bundleId}` : `${d.address}\n${pct}%`;
    });

    merged.on('mouseenter', function(evt, d){
      const bid = d.bundleId;
      if(!bid){ svg.selectAll('.holder-bubble').style('opacity',0.85); return; }
      svg.selectAll('.holder-bubble').style('opacity',0.15);
      svg.selectAll('.holder-bubble').filter(n=>n.bundleId===bid).style('opacity',1);
    }).on('mouseleave', function(){ svg.selectAll('.holder-bubble').style('opacity',1); });

    node.exit().remove();

    // 6) Σ% overlay (true sum of displayed holders)
    const panel = containerEl || (document.getElementById('bubblePanel') || document.body);
    const overlay = ensurePercentOverlay(panel);
    const sumPct = holdersAug.reduce((a,b)=>a+(Number(b.percent)||0),0);
    overlay.textContent = `Σ ${sumPct.toFixed(6)}% of allocation (true supply)`;
  };

  // ---- Auto-wrap (optional) ----
  function tryAutoWrap(){
    if(!window.__USE_AUTO_WRAP_BUBBLES) return;
    if(!window.renderBubbleMap || window.renderBubbleMap.__wrapped) return;
    const original = window.renderBubbleMap;
    window.renderBubbleMap = function wrapped(holders, tokenCA, svg, containerEl){
      try{
        const txs = __txCache.get(String(tokenCA||'').toLowerCase()) || [];
        const totalSupply = __supplyCache.get(String(tokenCA||'').toLowerCase());
        window.renderBubblesWithBundles({
          holders, txs, tokenCA, svg, containerEl,
          snapshotMeta:{ ts: Date.now() }, totalSupply
        });
      }catch(err){
        console.warn('Bundles wrapper fallback -> original renderBubbleMap:', err?.message||err);
        return original.apply(this, arguments);
      }
    };
    window.renderBubbleMap.__wrapped = true;
    console.log('[Bundles v2] Auto-wrap enabled');
  }

  // tiny API
  window.Bundles = window.Bundles || {};
  window.Bundles.setTxs = function(tokenCA, txs){ __txCache.set(String(tokenCA||'').toLowerCase(), Array.isArray(txs)?txs:[]); };
  window.Bundles.setTotalSupply = function(tokenCA, totalSupply){ if(Number(totalSupply)>0) __supplyCache.set(String(tokenCA||'').toLowerCase(), Number(totalSupply)); };

  tryAutoWrap();
  const _desc = Object.getOwnPropertyDescriptor(window, 'renderBubbleMap');
  if(!_desc || !(_desc.get||_desc.set)){
    let attempts=0; const iv=setInterval(()=>{ attempts++; tryAutoWrap(); if(window.renderBubbleMap?.__wrapped || attempts>50) clearInterval(iv); },200);
  }
})();
