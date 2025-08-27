/* -------------------------- BUBBLE VIEW EXTENSIONS -------------------------- */
/* Adds: holder normalization, bundle detection, coloring, hover highlight,
   % overlay, and persistence hooks (bundle-snapshot.json & token-bundles.json).
   This code assumes you already have:
   - `holders`: Array<{ address, percent, ... }> used by your bubble map
   - `txs`: Array of transfers for this token (minimally: { from, to, valueEth, ts })
   - `tokenCA`: current token contract address (string, lowercase 0x…)
   - an existing D3 bubble render area `svg` (or container) you use today.

   If your variables differ, adjust the integration points marked BELOW.
*/

(function () {
  // ——— Config/small utilities ———
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  const LP_HINTS = ['uniswap', 'sushiswap', 'weth', 'lp', 'pool'];
  const MIN_BUNDLE_SIZE = 2; // groups of 2+ wallets qualify as a bundle
  const COLOR_PALETTE = [
    '#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f',
    '#edc949','#af7aa1','#ff9da7','#9c755f','#bab0ab'
  ];

  // Create (or reuse) a total-overlay DOM element in bubble panel
  function ensurePercentOverlay(containerEl) {
    let el = containerEl.querySelector('.bubble-total-overlay');
    if (!el) {
      el = document.createElement('div');
      el.className = 'bubble-total-overlay mono';
      // style inline to avoid CSS edits elsewhere; adjust as needed to fit theme
      Object.assign(el.style, {
        position: 'absolute',
        left: '10px',
        bottom: '8px',
        fontSize: '11px',
        opacity: '0.8',
        pointerEvents: 'none',
        userSelect: 'none',
      });
      containerEl.style.position = 'relative'; // ensure positioning context
      containerEl.appendChild(el);
    }
    return el;
  }

  function isLikelyLP(addr = '', label = '') {
    const hay = (addr + ' ' + (label || '')).toLowerCase();
    return LP_HINTS.some(h => hay.includes(h));
  }

  function stableColorFor(key) {
    // deterministic color pick from palette
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    const idx = Math.abs(hash) % COLOR_PALETTE.length;
    return COLOR_PALETTE[idx];
  }

  // ——— 1) Normalize holders so Σ% <= 100 and equals 100 for displayed set ———
  function normalizeHolderPercents(rawHolders) {
    // take only positive percents
    const cleaned = rawHolders
      .filter(h => Number.isFinite(h.percent) && h.percent > 0)
      .map(h => ({ ...h, percentRaw: h.percent }));

    const sumRaw = cleaned.reduce((a, b) => a + b.percentRaw, 0);
    if (sumRaw <= 0) return cleaned.map(h => ({ ...h, percent: 0 }));

    return cleaned.map(h => ({
      ...h,
      percent: (h.percentRaw / sumRaw) * 100
    }));
  }

  // ——— 2) Bundle detection by common first funding source ———
  // txs: Array<{ from, to, valueEth, ts }> (ts ascending or not; we’ll sort)
  function detectBundlesByFunding(holdersList, txsList) {
    if (!Array.isArray(txsList) || txsList.length === 0) {
      return { augmented: holdersList.map(h => ({ ...h, bundleId: null })), bundles: [] };
    }

    // Map first inbound funding tx for each holder => funding wallet
    const byTo = new Map(); // toAddr -> array of inbound tx
    for (const t of txsList) {
      if (!t || !t.to) continue;
      const key = t.to.toLowerCase();
      if (!byTo.has(key)) byTo.set(key, []);
      byTo.get(key).push(t);
    }
    // sort each inbound list by timestamp asc
    for (const arr of byTo.values()) {
      arr.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    }

    // find first non-zero, non-LP, meaningful funder for each holder
    const fundingOf = new Map(); // holderAddr -> funderAddr | null
    for (const h of holdersList) {
      const addr = (h.address || '').toLowerCase();
      const inList = byTo.get(addr);
      let funder = null;
      if (inList && inList.length) {
        for (const tx of inList) {
          const from = (tx.from || '').toLowerCase();
          if (!from || from === ZERO_ADDR) continue;
          if (isLikelyLP(from, h.label)) continue;
          // take the first sensible inbound as "funding"
          funder = from;
          break;
        }
      }
      fundingOf.set(addr, funder);
    }

    // group holders by funder
    const buckets = new Map(); // funder -> [holderAddr...]
    for (const h of holdersList) {
      const addr = (h.address || '').toLowerCase();
      const funder = fundingOf.get(addr);
      if (!funder) continue;
      if (!buckets.has(funder)) buckets.set(funder, []);
      buckets.get(funder).push(addr);
    }

    // keep only bundles of size >= MIN_BUNDLE_SIZE
    const bundles = [];
    for (const [funder, members] of buckets.entries()) {
      const uniq = Array.from(new Set(members));
      if (uniq.length >= MIN_BUNDLE_SIZE) {
        bundles.push({ funder, wallets: uniq });
      }
    }

    // Create a quick lookup addr->bundleId (bundleId = funder)
    const bundleOf = new Map();
    for (const b of bundles) {
      for (const w of b.wallets) bundleOf.set(w, b.funder);
    }

    const augmented = holdersList.map(h => {
      const addr = (h.address || '').toLowerCase();
      const bid = bundleOf.get(addr) || null;
      return { ...h, bundleId: bid };
    });

    return { augmented, bundles };
  }

  // ——— 3) Compute bundle totals (allocation + buys/sells in ETH/WETH) ———
  function aggregateBundleTotals(bundles, holdersAug, txsList) {
    // Quick helper for ETH value; assumes tx.valueEth is already in ETH units.
    const byAddr = new Map();
    holdersAug.forEach(h => byAddr.set((h.address || '').toLowerCase(), h));

    const res = bundles.map(b => ({
      funding: b.funder,
      wallets: b.wallets,
      totalBoughtETH: 0,
      totalSoldETH: 0,
      totalBoughtAllocationPct: 0,
      totalSoldAllocationPct: 0
    }));

    const byFunder = new Map(res.map(r => [r.funding, r]));
    // Allocation from holder snapshot
    for (const h of holdersAug) {
      if (!h.bundleId) continue;
      const bucket = byFunder.get(h.bundleId);
      if (!bucket) continue;
      // Consider current percent as "held allocation"
      bucket.totalBoughtAllocationPct += h.percent || 0;
    }

    // Buys/Sells from txs (very rough aggregation per address direction)
    for (const t of (txsList || [])) {
      const from = (t.from || '').toLowerCase();
      const to = (t.to || '').toLowerCase();
      const val = Number(t.valueEth) || 0;

      // if a bundle wallet is TO, count as "bought"
      if (byAddr.has(to)) {
        const bId = byAddr.get(to).bundleId;
        if (bId && byFunder.has(bId)) byFunder.get(bId).totalBoughtETH += val;
      }
      // if a bundle wallet is FROM, count as "sold"
      if (byAddr.has(from)) {
        const bId = byAddr.get(from).bundleId;
        if (bId && byFunder.has(bId)) byFunder.get(bId).totalSoldETH += val;
      }
    }

    return res;
  }

  // ——— 4) Persist (graceful if API missing) ———
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

  // ——— 5) Integrate into existing bubble render ———
  // Call this instead of your current render function, or wrap your call:
  // renderBubblesWithBundles({ holders, txs, tokenCA, svg, containerEl, snapshotMeta })
  window.renderBubblesWithBundles = function (opts) {
    const {
      holders,
      txs,
      tokenCA,
      svg,             // existing D3 SVG selection (root of bubble chart)
      containerEl,     // DOM element that wraps the bubble chart
      snapshotMeta     // { ts, tokenName, symbol } or whatever you have
    } = opts;

    if (!holders || !holders.length) return;

    // 5.1 Normalize holders (fix Σ% to 100)
    const normHolders = normalizeHolderPercents(holders);

    // 5.2 Detect bundles by common funder
    const { augmented: holdersAug, bundles } = detectBundlesByFunding(normHolders, txs || []);

    // 5.3 Aggregate totals for token-bundles.json
    const bundleTotals = aggregateBundleTotals(bundles, holdersAug, txs || []);

    // 5.4 Persist (best effort, non-blocking)
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

    // 5.5 Draw bubbles (reusing your existing layout/simulation; only fill/hover changed)
    // NOTE: Replace this node join with your own selection if it differs.
    const node = svg.selectAll('.holder-bubble')
      .data(holdersAug, d => (d.address || '').toLowerCase());

    const nodeEnter = node.enter()
      .append('g')
      .attr('class', 'holder-bubble')
      .style('cursor', 'pointer');

    // your existing circles/text:
    nodeEnter.append('circle')
      .attr('r', d => {
        // keep your size function; placeholder uses sqrt scale of percent
        const p = Math.max(0, d.percent || 0);
        return Math.sqrt(p) * 5 + 3; // tweak to match your visuals
      })
      .attr('stroke-width', 1);

    nodeEnter.append('title'); // hover tooltip fallback

    const merged = nodeEnter.merge(node);

    // Colors: bundle-colored; non-bundled = default muted
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

    // Hover: highlight whole bundle
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

    // TODO: Keep your existing simulation/forces/positions as-is.
    // If you want bundle clustering (optional), you can nudge nodes:
    // e.g., add a small positional bias by bundleId to your existing tick func.

    node.exit().remove();

    // 5.6 Bottom-left Σ% overlay
    const overlay = ensurePercentOverlay(containerEl);
    const sumPct = holdersAug.reduce((a, b) => a + (b.percent || 0), 0);
    overlay.textContent = `Σ ${sumPct.toFixed(6)}% of allocation`;

    // 5.7 Optional: add a UI toggle to emphasize bundles (color vs. mono)
    // You can wire a global toggle state and re-render fills accordingly if desired.
  };

  /* ----------------------- END BUBBLE VIEW EXTENSIONS ----------------------- */
})();
