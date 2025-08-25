function buildGraphFromScan(A, B, metaIn){
  const holders = (A.holdersForBubbles || []).slice(0,500).map(h => ({
    address: h.address,
    balance: Number(h.balance ?? 0),
    pct: Number(h.pct ?? 0),
    label: null,
    tags: [],
    // peak & pctLeft will be filled from B.first25/top25 when available
    peak: null, pctLeft: null,
    fundedBy: [], connections: [], firstBuy: null, viaProxy: null
  }));

  const byAddr = new Map(holders.map(n => [n.address.toLowerCase(), n]));

  // Compute peak + % left for wallets we know (derived from panel B’s stats)
  // For first25 we have: firstInAmount, totalIn, totalOut, holdings
  for (const r of (B.first25 || [])){
    const a = (r.address||'').toLowerCase();
    const n = byAddr.get(a);
    if (!n) continue;
    const peak = Math.max(Number(r.totalIn||0), Number(r.holdings||0));
    if (peak > 0){
      n.peak = peak;
      const left = Number(r.holdings||0) / peak * 100;
      n.pctLeft = Math.max(0, Math.min(100, left));
    }
  }

  // Tag creator
  if (metaIn?.creator){
    const n = byAddr.get(String(metaIn.creator).toLowerCase());
    if (n){ n.tags.push('creator'); n.label = 'CREATOR'; }
  }

  // LP nodes (ensure present & tagged)
  const lpAddresses = (metaIn?.lpAddresses || []);
  for (const lp of lpAddresses){
    const key = String(lp).toLowerCase();
    let n = byAddr.get(key);
    if (!n){
      // include LP bubble even if 0% (renderer will show it)
      n = { address: key, balance: 0, pct: 0, label: 'LP', tags: ['lp'], peak: null, pctLeft: null, fundedBy: [], connections: [], firstBuy: null, viaProxy: null };
      holders.push(n); byAddr.set(key, n);
    } else {
      if (!n.tags.includes('lp')) n.tags.push('lp');
      if (!n.label) n.label = 'LP';
    }
  }

  // Optional: tag known proxies directly by address (seeded with your initial proxy)
  const KNOWN_PROXIES = new Set([
    '0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f'
  ]);
  for (const addr of KNOWN_PROXIES){
    const n = byAddr.get(addr);
    if (n) { if (!n.tags.includes('proxy')) n.tags.push('proxy'); }
  }

  return {
    tokenCA: A.contract || metaIn?.contract || '',
    supply: String(A.currentSupply || 0),
    holders,
    edges: [], // You can add funding/connection edges here later
    meta: {
      creator: metaIn?.creator || null,
      lp: lpAddresses[0] || null,
      burn: '0x0000000000000000000000000000000000000000',
      explorer: metaIn?.explorer || 'https://abscan.org',
      knownProxies: Array.from(KNOWN_PROXIES).map(a => ({ address:a, name:'TG Proxy', type:'telegram-bot' }))
    }
  };
}
