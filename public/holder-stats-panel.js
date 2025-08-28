/* holder-stats-panel.js — renders distribution buckets & quick holder facts
   Requirements:
   - Do NOT change any existing calculations in abs-tabs-integration.js.
   - This module listens for `tabs:singleTokenLoaded` (custom event we trigger in abs-tabs-integration.js).
   - Expects payload like { token, holders, supply, burned, bucketsReady? } (defensive).
   - Renders beneath the burned token row inside Container A ("boxLeft").
*/
(function (global){
  const $ = (s) => document.querySelector(s);

  // Create panel scaffold if missing
  function ensurePanel(){
    let c = document.getElementById('holderStatsPanel');
    if (!c){
      const anchor = document.getElementById('aTokenStats') || document.getElementById('boxLeft');
      c = document.createElement('div');
      c.id = 'holderStatsPanel';
      c.className = 'panel mono';
      c.style.marginTop = '10px';
      c.innerHTML = `
        <h4 class="mono" style="margin:0 0 6px 0">Holder Stats</h4>
        <div id="holderStatsRows"></div>
        <div id="holderBuckets" class="holder-buckets"></div>
      `;
      anchor?.after(c);
    }
    return c;
  }

  function fmtPct(v){ if(!Number.isFinite(v)) return '—'; return (v>=0?'+':'') + v.toFixed(2) + '%'; }
  function fmtNum(n){
    if (n==null || isNaN(n)) return '—';
    const abs = Math.abs(n);
    if (abs>=1e9) return (n/1e9).toFixed(2)+'B';
    if (abs>=1e6) return (n/1e6).toFixed(2)+'M';
    if (abs>=1e3) return (n/1e3).toFixed(2)+'k';
    return String(n);
  }

  // Compute simple buckets from holder list with {address,balancePct}
  function computeBuckets(holders){
    const buckets = [
      { label: '≥ 1%', min: 1.0, max: Infinity, count:0, pctSum:0 },
      { label: '0.1% – 1%', min: 0.1, max: 1.0, count:0, pctSum:0 },
      { label: '0.01% – 0.1%', min: 0.01, max: 0.1, count:0, pctSum:0 },
      { label: '0.001% – 0.01%', min: 0.001, max: 0.01, count:0, pctSum:0 },
      { label: '< 0.001%', min: 0.0, max: 0.001, count:0, pctSum:0 },
    ];
    for (const h of (holders||[])){
      const p = Number(h.balancePct)||0;
      for (const b of buckets){
        if (p >= b.min && p < b.max){ b.count++; b.pctSum += p; break; }
      }
    }
    return buckets;
  }

  function renderPanel(payload){
    const panel = ensurePanel();
    const slot = document.getElementById('holderStatsRows');
    const bucketsEl = document.getElementById('holderBuckets');
    if (!panel || !slot || !bucketsEl) return;

    const holders = payload?.holders || [];
    // holders assumed sorted by balance descending (existing scripts do this already)
    const top10 = holders.slice(0,10);
    const top10Pct = top10.reduce((a,h)=>a+(Number(h.balancePct)||0),0);
    const lessTinyCount = holders.filter(h => (Number(h.balancePct)||0) < 0.001).length;

    // Quick rows
    slot.innerHTML = `
      <div class="row"><small>Top 10 hold</small> <b>${fmtPct(top10Pct)}</b> <small>of supply</small></div>
      <div class="row"><small>Holders &lt; 0.001%</small> <b>${fmtNum(lessTinyCount)}</b></div>
    `;

    // Buckets
    const buckets = computeBuckets(holders);
    bucketsEl.innerHTML = buckets.map(b => {
      const w = Math.max(1, Math.min(100, b.pctSum)); // percentage bar width (cap to [1,100])
      return `
        <div class="bucket">
          <div class="label">${b.label}</div>
          <div class="bar"><div class="fill" style="width:${w}%"></div></div>
          <div class="meta">${fmtNum(b.count)} holders • ${fmtPct(b.pctSum)}</div>
        </div>
      `;
    }).join('');
  }

  // Listen for data
  window.addEventListener('tabs:singleTokenLoaded', (ev)=>{
    try{ renderPanel(ev.detail||{}); }catch(e){ console.error('holder-stats render error', e); }
  });

  // Minimal CSS (scoped)
  const css = document.createElement('style');
  css.textContent = `
  #holderStatsPanel .row{ display:flex; gap:8px; align-items:baseline; margin:4px 0; }
  #holderBuckets .bucket{ display:grid; grid-template-columns: 120px 1fr auto; gap:10px; align-items:center; margin:6px 0; }
  #holderBuckets .bar{ height:8px; background:rgba(255,255,255,.08); border-radius:6px; overflow:hidden; }
  #holderBuckets .fill{ height:100%; background:var(--abs-green); }
  #holderBuckets .label{ color:var(--muted); }
  #holderStatsPanel h4{ color:var(--text); }
  `;
  document.head.appendChild(css);

})(window);
