/* =======================================================================
 * abs-tabs-integration.js  —  Bubble View + Bundle Detection Extension
 * =======================================================================
 * What this file adds (non-breaking):
 *  - Holder % normalization so displayed bubbles sum to 100%
 *  - Bundle detection (Phase 1): common first funding wallet
 *  - Bundle coloring + hover highlight
 *  - Bottom-left Σ% overlay
 *  - Best-effort persistence hooks:
 *      POST /api/bundles/snapshot      -> data/bundle-snapshot.json
 *      POST /api/bundles/save          -> data/token-bundles.json
 *
 * Integration choices (keep your site working as-is):
 *  1) DIRECT CALL (recommended): wherever you render the bubble map, call:
 *     renderBubblesWithBundles({ holders, txs, tokenCA, svg, containerEl, snapshotMeta })
 *
 *  2) AUTO-WRAP (optional, zero-code-change): set window.__USE_AUTO_WRAP_BUBBLES = true
 *     before your existing render runs. We will wrap window.renderBubbleMap if present and
 *     call our enhanced renderer. You can feed txs via Bundles.setTxs(tokenCA, txs).
 *
 * NOTE: This file DOES NOT fetch new data. It only uses what you pass in. If txs are not
 *       provided, bundles remain empty; normalization + Σ% overlay still apply.
 * -----------------------------------------------------------------------
 * Author: ChatGPT ($Test ABS project)
 * =====================================================================*/


(function () {
  // -------------------- Small utils & state --------------------
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  const LP_HINTS = ['uniswap', 'sushiswap', 'weth', 'lp', 'pool'];
  const MIN_BUNDLE_SIZE = 2;
  const COLOR_PALETTE = [
    '#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f',
    '#edc949','#af7aa1','#ff9da7','#9c755f','#bab0ab'
  ];

  // cache for txs per token when using auto-wrap
  const __txCache = new Map();

  function isLikelyLP(addr = '', label = '') {
    const hay = (String(addr) + ' ' + String(label)).toLowerCase();
    return LP_HINTS.some(h => hay.includes(h));
  }

  function stableColorFor(key) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
  }

  function ensurePercentOverlay(containerEl) {
    let el = containerEl.querySelector('.bubble-total-overlay');
    if (!el) {
      el = document.createElement('div');
      el.className = 'bubble-total-overlay mono';
      Object.assign(el.style, {
        position: 'absolute',
        left: '10px',
        bottom: '8px',
        fontSize: '11px',
        opacity: '0.8',
        pointerEvents: 'none',
        userSelect: 'none',
      });
      if (getComputedStyle(containerEl).position === 'static') {
        containerEl.style.position = 'relative';
      }
      containerEl.appendChild(el);
    }
    return el;
  }

  // --------------- 1) Normalize visible holders to 100% ---------------
  function normalizeHolderPercents(rawHolders) {
    const cleaned = (rawHolders || [])
      .filter(h => Number.isFinite(h?.percent) && h.percent > 0)
      .map(h => ({ ...h, percentRaw: h.percent }));

    const sumRaw = cleaned.reduce((a, b) => a + b.percentRaw, 0);
    if (sumRaw <= 0) return cleaned.map(h => ({ ...h, percent: 0 }));

    return cleaned.map(h => ({
      ...h,
      percent: (h.percentRaw / sumRaw) * 100
    }));
  }

  // --------------- 2) Bundle detection by first funder ---------------
  // txs: [{ from, to, valueEth, ts }]
  function detectBundlesByFunding(holdersList, txsList) {
    if (!Array.isArray(txsList) || txsList.length === 0) {
      return { augmented: holdersList.map(h => ({ ...h, bundleId: null })), bundles: [] };
    }

    const byTo = new Map(); // to -> inbound list
    for (const t of txsList) {
      if (!t || !t.to) continue;
      const key = String(t.to).toLowerCase();
      if (!byTo.has(key)) byTo.set(key, []);
      byTo.get(key).push(t);
    }
    for (const arr of byTo.values()) arr.sort((a, b) => (a.ts || 0) - (b.ts || 0));

    const fundingOf = new Map(); // holder -> first sensible funder
    for (const h of holdersList) {
      const addr = String(h.address || '').toLowerCase();
      const inList = byTo.get(addr);
      let funder = null;
      if (inList && inList.length) {
        for (const tx of inList) {
          const from = String(tx.from || '').toLowerCase();
          if (!from || from === ZERO_ADDR) continue;
          if (isLikelyLP(from, h.label)) continue;
          funder = from; break;
        }
      }
      fundingOf.set(addr, funder);
    }

    const buckets = new Map(); // funder -> [holderAddr...]
    for (const h of holdersList) {
      const addr = String(h.address || '').toLowerCase();
      const funder = fundingOf.get(addr);
      if (!funder) continue;
      if (!buckets.has(funder)) buckets.set(funder, []);
      buckets.get(funder).push(addr);
    }

    const bundles = [];
    for (const [funder, members] of buckets.entries()) {
      const uniq = Array.from(new Set(members));
      if (uniq.length >= MIN_BUNDLE_SIZE) bundles.push({ funder, wallets: uniq });
    }

    const bundleOf = new Map();
    for (const b of bundles) for (const w of b.wallets) bundleOf.set(w, b.funder);

    const augmented = holdersList.map(h => {
      const addr = String(h.address || '').toLowerCase();
      const bid = bundleOf.get(addr) || null;
      return { ...h, bundleId: bid };
    });

    return { augmented, bundles };
  }

  // ----- 3) Aggregate bundle totals (allocation + buys/sells in ETH) -----
  function aggregateBundleTotals(bundles, holdersAug, txsList) {
    const byAddr = new Map();
    holdersAug.forEach(h => byAddr.set(String(h.address || '').toLowerCase(), h));

    const res = bundles.map(b => ({
      funding: b.funder,
      wallets: b.wallets,
      totalBoughtETH: 0,
      totalSoldETH: 0,
      totalBoughtAllocationPct: 0,
      totalSoldAllocationPct: 0
    }));

    const byFunder = new Map(res.map(r => [r.funding, r]));

    // treat current % as "held allocation" for the bundle
    for (const h of holdersAug) {
      if (!h.bundleId) continue;
      const bucket = byFunder.get(h.bundleId);
      if (!bucket) continue;
      bucket.totalBoughtAllocationPct += (h.percent || 0);
    }

    for (const t of (txsList || [])) {
      const from = String(t.from || '').toLowerCase();
      const to = String(t.to || '').toLowerCase();
      const val = Number(t.valueEth) || 0;
      if (byAddr.has(to)) {
        const bId = byAddr.get(to).bundleId;
        if (bId && byFunder.has(bId)) byFunder.get(bId).totalBoughtETH += val;
      }
      if (byAddr.has(from)) {
        const bId = byAddr.get(from).bundleId;
        if (bId && byFunder.has(bId)) byFunder.get(bId).totalSoldETH += val;
      }
    }
    return res;
  }

  // ---------------- 4) Persistence (best-effort, async) ----------------
  async function persistBundles(tokenCA, snapshot, bundles) {
    try {
      await fetch('/api/bundles/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenCA, snapshot, bundles })
      });
    } catch (e) {
      console.warn('Bundle save endpoint not available:', e?.message || e);
    }
  }
  async function persistBundleSnapshot(tokenCA, snapshot) {
    try {
      await fetch('/api/bundles/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenCA, snapshot })
      });
    } catch (e) {
      console.warn('Bundle snapshot endpoint not available:', e?.message || e);
    }
  }

  // --------------- 5) Main renderer (non-breaking) ---------------
  // opts: { holders, txs, tokenCA, svg, containerEl, snapshotMeta }
  window.renderBubblesWithBundles = function (opts) {
    const {
      holders,
      txs,
      tokenCA,
      svg,             // d3 selection for the bubble chart root
      containerEl,     // DOM element wrapping the chart (for overlay)
      snapshotMeta     // { ts, tokenName, symbol } (optional)
    } = (opts || {});

    if (!holders || !holders.length || !svg) return;
    const d3sel = (typeof svg.select === 'function') ? svg : null;
    if (!d3sel) return;

    // 5.1 Normalize
    const normHolders = normalizeHolderPercents(holders);

    // 5.2 Bundles
    const { augmented: holdersAug, bundles } = detectBundlesByFunding(normHolders, txs || []);

    // 5.3 Aggregate
    const bundleTotals = aggregateBundleTotals(bundles, holdersAug, txs || []);

    // 5.4 Persist (fire-and-forget)
    if (snapshotMeta) {
      persistBundleSnapshot(tokenCA, {
        ts: snapshotMeta.ts || Date.now(),
        token: tokenCA,
        holders: holdersAug.map(h => ({
          address: h.address,
          percent: h.percent,
          bundleId: h.bundleId
        }))
      });
      if (bundles.length) {
        persistBundles(tokenCA, {
          ts: snapshotMeta.ts || Date.now(),
          token: tokenCA
        }, bundleTotals);
      }
    }

    // 5.5 Draw — keeps to a minimal DOM shape to avoid breaking your existing CSS
    const node = svg.selectAll('.holder-bubble')
      .data(holdersAug, d => String(d.address || '').toLowerCase());

    const nodeEnter = node.enter()
      .append('g')
      .attr('class', 'holder-bubble')
      .style('cursor', 'pointer');

    nodeEnter.append('circle')
      .attr('r', d => {
        const p = Math.max(0, d.percent || 0);
        // NOTE: feel free to replace with your own radius scale
        return Math.sqrt(p) * 5 + 3;
      })
      .attr('stroke-width', 1);

    nodeEnter.append('title');

    const merged = nodeEnter.merge(node);

    merged.select('circle')
      .attr('fill', d => d.bundleId ? stableColorFor(d.bundleId) : '#888')
      .attr('stroke', d => d.bundleId ? '#000' : '#555');

    merged.select('title')
      .text(d => {
        const pct = (d.percent || 0).toFixed(4);
        return d.bundleId
          ? `${d.address}\n${pct}%\nBundle: ${d.bundleId}`
          : `${d.address}\n${pct}%`;
      });

    // Hover highlight by bundle
    merged
      .on('mouseenter', function (event, d) {
        const bid = d.bundleId;
        if (!bid) {
          svg.selectAll('.holder-bubble').style('opacity', 0.85);
          return;
        }
        svg.selectAll('.holder-bubble').style('opacity', 0.15);
        svg.selectAll('.holder-bubble')
          .filter(n => n.bundleId === bid)
          .style('opacity', 1);
      })
      .on('mouseleave', function () {
        svg.selectAll('.holder-bubble').style('opacity', 1);
      });

    node.exit().remove();

    // 5.6 Σ% overlay
    const panel = containerEl || (document.getElementById('bubblePanel') || document.body);
    const overlay = ensurePercentOverlay(panel);
    const sumPct = holdersAug.reduce((a, b) => a + (b.percent || 0), 0);
    overlay.textContent = `Σ ${sumPct.toFixed(6)}% of allocation`;
  };

  // --------------- 6) Optional: AUTO-WRAP integration ---------------
  // If your code already calls window.renderBubbleMap(holders, tokenCA, svg, containerEl)
  // you can enable transparent wrapping by setting: window.__USE_AUTO_WRAP_BUBBLES = true
  // and (optionally) feed txs via Bundles.setTxs(tokenCA, txArray)
  function tryAutoWrap() {
    if (!window.__USE_AUTO_WRAP_BUBBLES) return;
    if (!window.renderBubbleMap || window.renderBubbleMap.__wrapped) return;

    const original = window.renderBubbleMap;
    window.renderBubbleMap = function wrappedRenderBubbleMap(holders, tokenCA, svg, containerEl) {
      try {
        const txs = __txCache.get(String(tokenCA || '').toLowerCase()) || [];
        window.renderBubblesWithBundles({
          holders,
          txs,
          tokenCA,
          svg,
          containerEl,
          snapshotMeta: { ts: Date.now() }
        });
      } catch (err) {
        console.warn('Bundles wrapper fell back to original renderBubbleMap:', err?.message || err);
        return original.apply(this, arguments);
      }
    };
    window.renderBubbleMap.__wrapped = true;
    console.log('[Bundles] Auto-wrap enabled for renderBubbleMap');
  }

  // public tiny API to set txs for auto-wrap path
  window.Bundles = window.Bundles || {};
  window.Bundles.setTxs = function (tokenCA, txs) {
    __txCache.set(String(tokenCA || '').toLowerCase(), Array.isArray(txs) ? txs : []);
  };

  // immediately attempt auto-wrap (no-op if flag not set)
  tryAutoWrap();
  // re-attempt if someone defines renderBubbleMap later
  const _desc = Object.getOwnPropertyDescriptor(window, 'renderBubbleMap');
  if (!_desc || !(_desc.get || _desc.set)) {
    // simple polling as a fallback
    let attempts = 0;
    const iv = setInterval(() => {
      attempts++;
      tryAutoWrap();
      if (window.renderBubbleMap?.__wrapped || attempts > 50) clearInterval(iv);
    }, 200);
  }

})();
