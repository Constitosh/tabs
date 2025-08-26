/* abs-tabs-integration.js — unified A+B integration (v5)
   - Cache-first deep scan via /api/token-stats (GET) with timestamp
   - Fresh scan saver via /api/token-stats/save (POST)
   - Container A: stats + D3 bubble map + snapshot ts
   - Container B: First 25 vs Top 25 + status grid + row->funders overlay
   - Funding wallets overlay (ETH + WETH inbound before first receipt)
   - Proxy detection via txlistinternal for known routers (120 min window)
   - Bubble map: zoomable, biggest-centered, % labels, peak/left in hover, LP from Dexscreener liquidity.base
*/
(function (global) {
  const TABS = {};

  // ======== Config ========
  const BASE_URL = 'https://api.etherscan.io/v2/api';
  const CHAIN_ID = 2741; // Abstract
  const ETHERSCAN_API = 'H13F5VZ64YYK4M21QMPEW78SIKJS85UTWT'; // user-provided
  const EXPLORER = 'https://abscan.org';
  const MIN_INTERVAL_MS = 250;
  const SOLD_ALL_SMALL_HOLD = 2000;  // heuristic
  const IGNORE_FUNDER_OVER_USD = 1_000_000;
  const TOP_FUNDER_LIMIT = 5;
  const TOP_COMMON_LIMIT = 5;
  const SPECIAL_HOLDERS_CA = '0x8c3d850313eb9621605cd6a1acb2830962426f67';

  // Known proxy / TG bot routers (you can add more later)
  const KNOWN_PROXIES = new Set([
    '0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f' // Telegram bot (provided)
  ]);
  const FUNDING_WINDOW_SECS = 120 * 60;  // 120 minutes

  // ======== DOM ========
  const $ = (s) => document.querySelector(s);
  const scanStatusEl = () => $('#scanStatus');
  const aSnap = () => $('#aSnapshot');
  const aStats = () => $('#aTokenStats');
  const aBubble = () => $('#bubble-canvas');
  const aBubbleNote = () => $('#a-bubble-note');
  const bStatusGrid = () => $('#statusGrid');
  const firstBtn = () => $('#btnFirst25');
  const topBtn = () => $('#btnTop25');
  const buyersTop5 = () => $('#buyersTop5');
  const buyersRest = () => $('#buyersRest');
  const buyersExpander = () => $('#buyersExpander');
  const buyersToggle = () => $('#buyersToggle');
  const holdersTop5 = () => $('#holdersTop5');
  const holdersRest = () => $('#holdersRest');
  const holdersPanel = () => $('#holdersPanelB');
  const buyersPanel = () => $('#buyersPanelB');
  const holdersExpander = () => $('#holdersExpander');
  const holdersToggle = () => $('#holdersToggle');
  const fundersOverlay = () => $('#fundersOverlay');
  const fundersInner = () => $('#fundersInner');
  const commonOverlay = () => $('#commonOverlay');
  const commonInner = () => $('#commonInner');
  const holdersTile = () => $('#tabsHolders');

  // ======== UI helpers ========
  function setScanStatus(msg) {
    if (scanStatusEl()) scanStatusEl().textContent = msg || '';
    const bubbleStatusText = document.getElementById('bubbleStatusText');
    if (bubbleStatusText) bubbleStatusText.textContent = msg || '';
  }
  function shortAddrLast3(a){ return a ? `0x…${a.slice(-3)}` : '—'; }
  function shortAddr(a){ return a ? a.slice(0,6)+'…'+a.slice(-4) : '—'; }
  const fmtNum = (n, d = 4) => {
    if (!isFinite(n)) return '0';
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(2) + 'k';
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
  };
  function unitsToNum(valueStr, dec = 18) {
    const v = BigInt(valueStr || '0'); const d = BigInt(10) ** BigInt(dec);
    const whole = v / d; const frac = v % d;
    const fs = (frac.toString().padStart(dec, '0')).replace(/0+$/, '').slice(0, 6);
    return Number(whole.toString() + (fs ? '.' + fs : ''));
  }
  function toBI(s){ try{ return BigInt(s); }catch{ return 0n; } }
  function pctUnits(numBI, denBI){
    if (denBI === 0n) return 0;
    const SCALE = 1_000_000n;
    const q = (numBI * SCALE) / denBI;
    return Number(q) / 10_000;
  }
  function topicToAddress(topic){ return '0x' + topic.slice(26).toLowerCase(); }
  function isCA(s){ return /^0x[0-9a-fA-F]{40}$/.test((s || '').trim()); }

  // ======== Rate-limited queue ========
  const q = []; let pumping = false;
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  async function pump(){ if (pumping) return; pumping = true; while(q.length){ const job=q.shift(); try{ const res=await job.fn(); job.resolve(res);}catch(e){ job.reject(e);} await sleep(MIN_INTERVAL_MS);} pumping=false; }
  function enqueue(fn){ return new Promise((resolve,reject)=>{ q.push({fn,resolve,reject}); pump(); }); }
  function apiGet(params){
    return enqueue(async ()=>{
      const url = new URL(BASE_URL);
      url.searchParams.set('chainid', CHAIN_ID);
      url.searchParams.set('apikey', ETHERSCAN_API);
      for (const [k,v] of Object.entries(params)) url.searchParams.set(k, String(v));
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error('HTTP '+res.status);
      const data = await res.json();
      if (data?.status==='0' && typeof data.result==='string') throw new Error(data.result);
      return data.result || [];
    });
  }

  // ======== Etherscan-like APIs ========
  async function apiLogsTransfer(token){
    const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    return apiGet({ module:'logs', action:'getLogs', address: token, topic0: TRANSFER_SIG, fromBlock: 0, toBlock: 'latest' });
  }
  async function apiTokentx(params){
    return apiGet({ module:'account', action:'tokentx', startblock: 0, endblock: 99999999, sort:'asc', ...params });
  }
  async function apiTxlist(address){
    return apiGet({ module:'account', action:'txlist', address, startblock:0, endblock:99999999, sort:'asc' });
  }
  async function apiTxlistinternal(address, {startblock=0, endblock=99999999}={}){
    return apiGet({ module:'account', action:'txlistinternal', address, startblock, endblock, page:1, offset:10000, sort:'asc' });
  }
  async function apiBalance(address){
    const r = await apiGet({ module:'account', action:'balance', address, tag:'latest' });
    return Number(r)/1e18;
  }
  async function tokenBalanceOf(contract, holder){
    const r = await apiGet({ module:'account', action:'tokenbalance', address: holder, contractaddress: contract, tag:'latest' });
    const raw = r != null ? String(r) : '0';
    return /^[0-9]+$/.test(raw) ? BigInt(raw) : 0n;
  }

  // ======== Dexscreener helpers ========
  // 1) Find LP pair addresses (fallback)
  async function getPairAddresses(contract){
    const out = new Set();
    try{
      const pr = await fetch(`https://api.dexscreener.com/token-pairs/v1/abstract/${contract}`);
      const pd = await pr.json();
      if (Array.isArray(pd)){
        for (const p of pd){
          let pa = String(p?.pairAddress||'').toLowerCase(); if (!pa) continue;
          if (pa.includes(':')) pa = pa.split(':')[0];
          if (/^0x[a-f0-9]{40}$/.test(pa)) out.add(pa);
        }
      }
    }catch{}
    return Array.from(out);
  }
  // 2) LP allocation from tokens/v1/abstract (liquidity.base)
  async function getLPBaseAllocation(contract){
    // returns { baseSum: number (token units, decimals-adjusted?), perPair: Map(pairAddress -> base) }
    const result = { baseSum: 0, perPair: new Map() };
    try{
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/abstract/${contract}`);
      if (!r.ok) return result;
      const arr = await r.json();
      // Depending on API shape, look into any nested "pairs" or "liquidity" entries
      // Normalize: accumulate liquidity.base across all entries that reference this token as base.
      const flat = Array.isArray(arr) ? arr : [];
      for (const t of flat){
        const ps = Array.isArray(t?.pairs) ? t.pairs : (Array.isArray(t?.markets) ? t.markets : []);
        for (const p of (ps||[])){
          const base = Number(p?.liquidity?.base || 0);
          const pa = String(p?.pairAddress || '').toLowerCase();
          if (base > 0){
            result.baseSum += base;
            if (pa) result.perPair.set(pa, (result.perPair.get(pa)||0) + base);
          }
        }
      }
    }catch{}
    return result;
  }

  async function priceUsdForToken(contract){
    try{
      const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/abstract/${contract}`);
      if (!res.ok) return 0;
      const arr = await res.json();
      if (!Array.isArray(arr) || !arr.length) return 0;
      arr.sort((a,b)=> (Number(b.liquidity?.usd||0) - Number(a.liquidity?.usd||0)));
      const px = Number(arr[0]?.priceUsd || 0);
      return isFinite(px) ? px : 0;
    }catch{ return 0; }
  }
  async function tokenPortfolioUsd(address){
    const txs = await apiTokentx({ address }).catch(()=>[]);
    const bal = new Map();
    for (const t of txs){
      const ca = (t.contractAddress||'').toLowerCase();
      const dec = Number(t.tokenDecimal||18);
      const amt = unitsToNum(t.value, dec);
      const inbound = (t.to||'').toLowerCase() === address.toLowerCase();
      if (!bal.has(ca)) bal.set(ca, { decimals:dec, symbol:t.tokenSymbol||'TKN', amount:0 });
      const r = bal.get(ca); r.amount += inbound ? amt : -amt;
    }
    const arr = Array.from(bal.entries()).map(([c,r])=>({ contract:c, ...r })).filter(x=>x.amount>0);
    let total=0;
    for (const r of arr){
      const px = await priceUsdForToken(r.contract);
      total += (px * r.amount) || 0;
      await sleep(80);
    }
    return { totalUsd: total };
  }

  // ======== Persistence API (server) ========
  async function loadCachedScan(ca){
    try{
      const r = await fetch(`/api/token-stats/${ca}`);
      const j = await r.json();
      if (j?.ok && j?.data) return { ts: j.ts, data: j.data };
    }catch{}
    return null;
  }
  async function saveScan(ca, data){
    try{
      const r = await fetch('/api/token-stats/save', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ca, data })
      });
      return await r.json();
    }catch{ return { ok:false }; }
  }

  // ======== Receivers + statuses ========
  async function getFirst27Receivers(token){
    const logs = await apiLogsTransfer(token).catch(()=>[]);
    const seen = new Set(); const out=[];
    for (const l of logs){
      if (!Array.isArray(l.topics) || l.topics.length<3) continue;
      const to = topicToAddress(l.topics[2]);
      if (seen.has(to)) continue;
      out.push({ address:to, timeStamp:Number(l.timeStamp||l.blockTimestamp||0), txHash:l.transactionHash, firstInAmount:0 });
      seen.add(to);
      if (out.length>=27) break; // we will drop the first two (likely LP/mints)
    }
    return out.slice(2);
  }
  async function enrichReceiverStats(token, rec){
    const txs = await apiTokentx({ address:rec.address, contractaddress:token }).catch(()=>[]);
    if (!txs.length) return { ...rec, totalIn:0, totalOut:0, holdings:0, firstInAmount:0, status:'sold all', sClass:'s-sold' };
    let totalIn=0, totalOut=0, firstIn=0, holdings=0, earliestTs=Infinity;
    for (const t of txs){
      const amt = unitsToNum(t.value, Number(t.tokenDecimal||18));
      const to = (t.to||'').toLowerCase(); const from=(t.from||'').toLowerCase(); const me = rec.address.toLowerCase();
      if (to===me){ totalIn+=amt; holdings+=amt; if (Number(t.timeStamp)<earliestTs){ earliestTs=Number(t.timeStamp); firstIn=amt; } }
      else if (from===me){ totalOut+=amt; holdings-=amt; }
    }
    const EPS=1e-9; let status='hold', sClass='s-hold'; const h=Math.max(0,holdings);
    if (Math.abs(h) <= EPS || h < SOLD_ALL_SMALL_HOLD - EPS){ status='sold all'; sClass='s-sold'; }
    else if (Math.abs(h-firstIn) <= EPS){ status='hold'; sClass='s-hold'; }
    else if ((totalIn-firstIn) > EPS && Math.abs(totalIn-h) <= EPS){ status='bought more'; sClass='s-more'; }
    else if (h < firstIn - EPS){ status='sold part'; sClass='s-part'; }
    return { ...rec, firstInAmount:firstIn, timeStamp: earliestTs!==Infinity ? earliestTs : rec.timeStamp, totalIn, totalOut, holdings:h, status, sClass };
  }

  // ======== Funding discovery & overlays (kept) ========
  async function getFundingWallets(addr, cutoffTs){
    const [nativeTxs, erc20Txs] = await Promise.all([
      apiTxlist(addr).catch(()=>[]),
      apiTokentx({ address:addr }).catch(()=>[])
    ]);

    const incomingEth = nativeTxs.filter(tx => (tx.to||'').toLowerCase()===addr.toLowerCase() && (!cutoffTs || Number(tx.timeStamp)<=Number(cutoffTs)));
    const ethMap = new Map();
    for (const tx of incomingEth){
      const from=(tx.from||'').toLowerCase(); const prev=ethMap.get(from)||{ count:0, amount:0 }; prev.count++; prev.amount += Number(tx.value||0)/1e18; ethMap.set(from,prev);
    }

    const incomingWeth = erc20Txs.filter(t => (t.tokenSymbol||'').toUpperCase()==='WETH' && (t.to||'').toLowerCase()===addr.toLowerCase() && (!cutoffTs || Number(t.timeStamp)<=Number(cutoffTs)));
    const wethMap = new Map();
    for (const t of incomingWeth){
      const from=(t.from||'').toLowerCase(); const dec=Number(t.tokenDecimal||18); const amt=unitsToNum(t.value, dec);
      const prev=wethMap.get(from)||{ count:0, amount:0 }; prev.count++; prev.amount+=amt; wethMap.set(from,prev);
    }

    const merged = new Map();
    const add=(src,type)=>{ for (const [a,info] of src.entries()){ const r=merged.get(a)||{ ethCount:0,ethAmount:0,wethCount:0,wethAmount:0 }; r[type+'Count']+=info.count; r[type+'Amount']+=info.amount; merged.set(a,r); } };
    add(ethMap,'eth'); add(wethMap,'weth');
    return { addrs:Array.from(merged.keys()), info:merged };
  }

  // ======== Full token overview (scan) + save ========
  async function doFreshScan(contract){
    const result = { meta:{ contract }, a:{}, b:{} };

    setScanStatus('Downloading token transfer history…');
    const txs = await fetchAllTokenTx(contract);
    if (!txs.length) throw new Error('No transactions found for this token.');
    const tokenDecimals = chooseDecimals(txs);

    setScanStatus('Resolving creator & supply metrics…');
    let creatorAddress = '';
    try{
      const cRes = await fetch(`${BASE_URL}?chainid=${CHAIN_ID}&module=contract&action=getcontractcreation&contractaddresses=${contract}&apikey=${ETHERSCAN_API}`);
      const cData = await cRes.json();
      creatorAddress = (Array.isArray(cData?.result) && cData.result[0]?.contractCreator) ? cData.result[0].contractCreator.toLowerCase() : '';
    }catch{}

    // Supply + balances
    const ZERO = '0x0000000000000000000000000000000000000000';
    const DEAD = '0x000000000000000000000000000000000000dead';
    const burnSet = new Set([ZERO, DEAD]);

    const balances = {};
    let mintedUnits=0n, burnedUnits=0n;
    const firstInMap = new Map();

    for (const t of txs){
      const from=(t.from||t.fromAddress||'').toLowerCase(); const to=(t.to||t.toAddress||'').toLowerCase();
      const v=toBI(t.value||'0'); const ts=Number(t.timeStamp)||0;
      if (from===ZERO) mintedUnits+=v;
      if (burnSet.has(to)) burnedUnits+=v;
      if (from===contract || to===contract) continue; // ignore contract self-moves
      if (!burnSet.has(from)) balances[from]=(balances[from]||0n)-v;
      if (!burnSet.has(to))   balances[to]=(balances[to]||0n)+v;
      if (!firstInMap.has(to) && !burnSet.has(to)) firstInMap.set(to, { ts, v });
    }
    const currentSupplyUnits = mintedUnits>=burnedUnits ? (mintedUnits-burnedUnits) : 0n;
    const currentSupply = Number(currentSupplyUnits)/(10**tokenDecimals);

    // LP addresses and LP allocation (liquidity.base)
    setScanStatus('Fetching LP pairs & allocation…');
    let pairAddresses = await getPairAddresses(contract);
    const lpAlloc = await getLPBaseAllocation(contract);
    const pairSet = new Set(pairAddresses);

    setScanStatus('Building holders set…');
    let holdersAll = Object.entries(balances)
      .filter(([addr,bal])=> bal>0n && !burnSet.has(addr) && !pairSet.has(addr))
      .map(([address,units])=>({ address, units }));
    holdersAll.sort((a,b)=> (b.units>a.units) ? 1 : (b.units<a.units) ? -1 : 0);

    // verify top balances against chain at head (top 150)
    setScanStatus('Verifying top balances…');
    const toVerify = holdersAll.slice(0,150).map(h=>h.address); const verified={};
    for (let i=0;i<toVerify.length;i++){ const a=toVerify[i]; verified[a]=await tokenBalanceOf(contract,a).catch(()=>null); await sleep(100); }
    const vset=new Set(toVerify); const corrected=[];
    for (const h of holdersAll){
      if (vset.has(h.address)){
        const v=verified[h.address];
        if (v===null) corrected.push(h); else if (v===0n) continue; else corrected.push({ address:h.address, units:v });
      } else corrected.push(h);
    }
    holdersAll = corrected; holdersAll.sort((a,b)=> (b.units>a.units)?1:(b.units<a.units)?-1:0);

    // Map to bubble holders (cap at 500, filter <0.001%)
    const holdersForBubblesRaw = holdersAll.slice(0,500).map(h=>{
      const pct = currentSupplyUnits>0n ? pctUnits(h.units, currentSupplyUnits) : 0;
      return { address:h.address, units:h.units, balance:Number(h.units)/(10**tokenDecimals), pct };
    }).filter(h => (h.pct || 0) >= 0.001);

    // Create LP node(s) from liquidity.base (allocation)
    const lpNodes = [];
    for (const pa of pairAddresses){
      let base = lpAlloc.perPair.get(pa) || 0;
      // Fallback to on-chain balance if API lacks base
      if (!(base > 0)){
        const units = await tokenBalanceOf(contract, pa).catch(()=>0n);
        base = Number(units)/(10**tokenDecimals);
      }
      const lpPct = currentSupply > 0 ? Math.max(0, (base / currentSupply) * 100) : 0;
      lpNodes.push({ address:pa, balance:base, pct: lpPct, __type:'lp' });
      await sleep(40);
    }

    const top10Pct = holdersForBubblesRaw.slice(0,10).reduce((s,h)=> s+(h.pct||0),0);
    const creatorPct = creatorAddress ? (holdersForBubblesRaw.find(h=>h.address.toLowerCase()===creatorAddress)?.pct || 0) : 0;

    // Detect proxy connections (txlistinternal)
    setScanStatus('Scanning proxy connections (internal tx)…');
    const viaProxyAddrs = [];
    const graphEdges = [];
    const KNOWN = KNOWN_PROXIES; // lowercase set
    // Build a fast lookup of first-receipt times for funding window
    const firstTs = new Map();
    for (const [addr, obj] of firstInMap.entries()) firstTs.set(addr.toLowerCase(), Number(obj.ts)||0);

    // Limit to speed (e.g., first 200 bubbles after filter)
    const candidates = holdersForBubblesRaw.slice(0, 200);
    for (const h of candidates){
      const addr = h.address.toLowerCase();
      const ts = firstTs.get(addr) || 0;
      const winStart = ts ? (ts - FUNDING_WINDOW_SECS) : 0;
      const winEnd   = ts ? (ts + FUNDING_WINDOW_SECS) : 0;
      try{
        const internals = await apiTxlistinternal(addr, { startblock:0, endblock:99999999 }).catch(()=>[]);
        let tagged = false;
        for (const it of internals){
          const from = String(it.from||'').toLowerCase();
          const to   = String(it.to||'').toLowerCase();
          const tts  = Number(it.timeStamp||0);
          if (KNOWN.has(from) && to === addr){
            if (!ts || (tts>=winStart && tts<=winEnd)){
              viaProxyAddrs.push(addr);
              graphEdges.push({ type:'proxy', source: from, target: addr, weight: 2 });
              tagged = true;
              break;
            }
          }
        }
        // small breath between calls
        await sleep(60);
        if (tagged) continue;
      }catch{}
    }

    // A (stats + bubble inputs)
    const holdersForBubbles = holdersForBubblesRaw.map(h => ({
      address: h.address,
      balance: h.balance,
      pct: h.pct
    }));

    result.a = {
      contract,
      tokenDecimals,
      minted: Number(mintedUnits)/(10**tokenDecimals),
      burned: Number(burnedUnits)/(10**tokenDecimals),
      currentSupply,
      currentSupplyUnits: String(currentSupplyUnits),
      totalHolders: holdersAll.length,
      top10Pct,
      creatorAddress,
      creatorPct,
      holdersForBubbles,
      lpNodes,
      viaProxyAddrs,
      graphEdges
    };

    // B (holders + receivers)
    setScanStatus('Fetching Transfer logs…');
    const receivers = await getFirst27Receivers(contract);
    const enriched=[];
    setScanStatus('Computing totals & statuses per wallet…');
    for (const r of receivers){
      const st = await enrichReceiverStats(contract, r).catch(()=>null);
      if (st) enriched.push(st);
      await sleep(50);
    }

    const top25 = holdersAll.slice(0,25).map((h,i)=>{
      const first = firstInMap.get(h.address) || { ts:0, v:0n };
      return {
        rank: i+1,
        address: h.address,
        firstIn: Number(first.v)/(10**tokenDecimals),
        holdings: Number(h.units)/(10**tokenDecimals),
        pct: currentSupplyUnits>0n ? pctUnits(h.units, currentSupplyUnits) : 0
      };
    });

    result.b = { first25: enriched.slice(0,25), top25 };

    // done
    return result;
  }

  // ======== Bubble graph builder + renderer ========
  function buildGraphFromScan(A, B){
    const holderNodes = (A.holdersForBubbles || []).map(h => ({
      address: h.address,
      balance: Number(h.balance || 0),
      pct: Number(h.pct || 0),
      tags: [],
      label: null
    }));

    const byAddr = new Map(holderNodes.map(n => [String(n.address).toLowerCase(), n]));

    // LP nodes
    for (const lp of (A.lpNodes || [])){
      const key = String(lp.address||'').toLowerCase();
      if (!byAddr.has(key)){
        byAddr.set(key, { address:key, balance:Number(lp.balance||0), pct:Number(lp.pct||0), tags:['lp'], label:'LP' });
      }else{
        const n = byAddr.get(key);
        n.tags = n.tags || [];
        if (!n.tags.includes('lp')) n.tags.push('lp');
        if (!n.label) n.label = 'LP';
        n.pct = Number(lp.pct || n.pct || 0);
        n.balance = Number(lp.balance || n.balance || 0);
      }
    }

    // Creator tag
    if (A.creatorAddress){
      const key = String(A.creatorAddress).toLowerCase();
      const n = byAddr.get(key);
      if (n){ n.tags = n.tags || []; if (!n.tags.includes('creator')) n.tags.push('creator'); if (!n.label) n.label = 'CREATOR'; }
    }

    // Proxy tag
    const via = new Set((A.viaProxyAddrs||[]).map(a=>String(a).toLowerCase()));
    for (const [k,n] of byAddr.entries()){
      if (via.has(k)){ n.tags = n.tags || []; if(!n.tags.includes('via-proxy')) n.tags.push('via-proxy'); }
    }

    // Peak/Left for everyone:
    // - If we have B.first25 enriched stats, use totalIn/holdings.
    // - Otherwise, fallback: peak = current balance; left = 100%.
    const first25By = new Map((B.first25||[]).map(r => [String(r.address).toLowerCase(), r]));
    const top25By   = new Map((B.top25||[]).map(r => [String(r.address).toLowerCase(), r]));
    for (const [k,n] of byAddr.entries()){
      const r = first25By.get(k) || top25By.get(k);
      let peak, leftTokens, leftPct;
      if (r){
        const totIn = Number(r.totalIn || r.firstIn || 0);
        const cur   = Number(r.holdings || n.balance || 0);
        peak = Math.max(totIn, cur);
        leftTokens = cur;
        leftPct = peak>0 ? (cur/peak)*100 : 0;
      }else{
        // best-effort fallback
        peak = Number(n.balance||0);
        leftTokens = Number(n.balance||0);
        leftPct = peak>0 ? 100 : 0;
      }
      n.peakTokens = peak;
      n.leftTokens = leftTokens;
      n.leftPct    = leftPct;
    }

    const edges = Array.isArray(A.graphEdges) ? A.graphEdges.slice() : [];

    return {
      explorer: EXPLORER,
      nodes: Array.from(byAddr.values()),
      edges
    };
  }

  function renderBubbleGraph(rootEl, graph){
    const EX = graph.explorer || 'https://abscan.org';
    const nodes = (graph.nodes || []).slice(0, 500);
    const edges = graph.edges || [];

    rootEl.innerHTML = '';
    const width  = rootEl.clientWidth || 960;
    const height = Math.max(560, Math.round(width * 0.48));

    const svg   = d3.select(rootEl).append('svg').attr('width', width).attr('height', height).style('cursor','grab');
    const rootG = svg.append('g');
    const linkG = rootG.append('g').attr('class','links');
    const nodeG = rootG.append('g').attr('class','nodes');

    const roleColor = (tags=[]) => {
      const set = new Set(tags.map(t => String(t).toLowerCase()));
      if (set.has('lp'))      return '#8b5cf6';  // LP
      return '#375a4e';                         // default holders & creator
    };
    const roleStroke = (tags=[]) => {
      const set = new Set(tags.map(t => String(t).toLowerCase()));
      if (set.has('lp')) return '#c4b5fd';
      return 'rgba(0,0,0,.35)';
    };

    // radius by % of supply (sqrt) — biggest centered later via forces
    const maxPct = Math.max(0.0001, ...nodes.map(n => +n.pct || 0));
    const rScale = d3.scaleSqrt().domain([0, maxPct]).range([8, 56]);
    nodes.forEach(n => { n.r = rScale(+n.pct || 0); if (!n.tags) n.tags = []; });

    // initial seeds using pack
    const pack = d3.pack().size([width, height]).padding(3);
    const pRoot = d3.hierarchy({ children: nodes }).sum(d => (d && d.r ? d.r * d.r : 1));
    const leaves = pack(pRoot).leaves();
    const addrKey = a => String(a||'').toLowerCase();
    const seed   = new Map(leaves.map(l => [addrKey(l.data.address), l]));
    nodes.forEach(n => { const s = seed.get(addrKey(n.address)); n.x = s ? s.x : Math.random()*width; n.y = s ? s.y : Math.random()*height; });

    // biggest to center + gentle drift
    const cx = width/2, cy = height/2;
    const maxR = Math.max(...nodes.map(n => n.r || 0), 1);
    const nSize = d => Math.max(0, Math.min(1, (d.r || 1)/maxR));
    const centerStrength = d => 0.06 + 0.18 * ((nSize(d) - 0.3) / 0.7);

    const sim = d3.forceSimulation(nodes)
      .alpha(0.9)
      .velocityDecay(0.35)                 // “space drift”
      .force('collide', d3.forceCollide(d => Math.max(6, d.r)).strength(0.9))
      .force('x', d3.forceX(cx).strength(d => centerStrength(d)))
      .force('y', d3.forceY(cy).strength(d => centerStrength(d)))
      .on('tick', ticked);

    nodes.forEach(n => { n.vx = (Math.random()-0.5)*0.3; n.vy = (Math.random()-0.5)*0.3; });

    // zoom/pan
    const zoom = d3.zoom().scaleExtent([0.6, 7]).on('zoom', (ev) => rootG.attr('transform', ev.transform));
    svg.call(zoom);
    svg.on('mousedown.stop-sim', () => sim.alphaTarget(0).stop());

    // edges (proxy etc.)
    const linkSel = linkG.selectAll('line').data(edges, d => `${d.source}|${d.target}|${d.type}`).join('line')
      .attr('stroke', d => d.type === 'proxy' ? '#ffd54a' : '#89b6a0')
      .attr('stroke-opacity', d => d.type === 'proxy' ? 0.9 : 0.25)
      .attr('stroke-width', d => Math.max(1.5, d.weight || 1.5));

    // nodes
    const nodeSel = nodeG.selectAll('g.node').data(nodes, d => d.address).join(enter => {
      const g = enter.append('g').attr('class','node').attr('transform', d => `translate(${d.x},${d.y})`).style('cursor','pointer');

      g.append('circle')
        .attr('r', d => Math.max(8, d.r || 8))
        .attr('fill', d => roleColor(d.tags))
        .attr('fill-opacity', 0.95)
        .attr('stroke', d => roleStroke(d.tags)).attr('stroke-width', d => (d.tags||[]).includes('lp') ? 2.5 : 1);

      // proxy ring (always visible if tagged)
      g.append('circle')
        .attr('class','proxy-ring')
        .attr('r', d => Math.max(8, d.r || 8) + 2)
        .attr('fill', 'none')
        .attr('stroke', d => {
          const tags = (d.tags||[]).map(t => String(t).toLowerCase());
          return (tags.includes('proxy') || tags.includes('via-proxy')) ? '#ffd54a' : 'none';
        })
        .attr('stroke-width', 2);

      // % label
      g.append('text')
        .text(d => `${(+d.pct || 0).toFixed(2)}%`)
        .attr('text-anchor','middle').attr('dy','0.32em')
        .attr('font-size', d => Math.max(9, Math.min(12, (d.r||12)/3 + 7)))
        .attr('pointer-events','none')
        .attr('fill','rgba(0,0,0,.85)');

      g.on('click', (ev,d)=> window.open(`${EX}/address/${d.address}`, '_blank'));

      const tip = getTip();
      g.on('mouseenter', (ev,d)=>{
        const tags = d.tags && d.tags.length ? `<div><b>Tags:</b> ${d.tags.join(', ')}</div>` : '';
        const peakTokens = isFinite(d.peakTokens) ? d.peakTokens : null;
        const leftTokens = isFinite(d.leftTokens) ? d.leftTokens : null;
        const leftPct    = isFinite(d.leftPct) ? d.leftPct : null;
        const peakHtml = `<div><b>Peak held:</b> ${peakTokens!=null ? fmtNum(peakTokens,6) : '—'} tokens</div>`;
        const leftHtml = `<div><b>Left:</b> ${leftTokens!=null ? fmtNum(leftTokens,6) : '—'} tokens${leftPct!=null ? ` (${leftPct.toFixed(1)}%)` : ''}</div>`;
        tip.html(`
          <div style="font-weight:700;margin-bottom:4px">${(+d.pct||0).toFixed(2)}% of supply</div>
          <div><b>Address:</b> ${d.address}</div>
          ${peakHtml}${leftHtml}${tags}
          <div style="opacity:.85;margin-top:6px">Click to open in ABScan ↗</div>
        `).style('opacity',1);
      }).on('mousemove', (ev)=>{
        const x = ev.clientX+12, y = ev.clientY+12;
        getTip().style('left', x+'px').style('top', y+'px');
      }).on('mouseleave', ()=> getTip().style('opacity',0));

      return g;
    });

    // fit to view
    fitToView();
    function fitToView(){
      const bbox = nodeG.node().getBBox();
      const pad = 28;
      const k = Math.min(
        (width  - pad*2) / Math.max(1, bbox.width),
        (height - pad*2) / Math.max(1, bbox.height)
      );
      const scale = Math.max(0.7, Math.min(3, k));
      const tx = (width  - scale*(bbox.x + bbox.width/2));
      const ty = (height - scale*(bbox.y + bbox.height/2));
      svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity.translate(tx,ty).scale(scale));
    }

    function ticked(){
      nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);
      linkSel
        .attr('x1', d => pos(d.source).x).attr('y1', d => pos(d.source).y)
        .attr('x2', d => pos(d.target).x).attr('y2', d => pos(d.target).y);
    }
    const index = new Map(nodes.map(n => [addrKey(n.address), n]));
    function pos(a){ const n = index.get(addrKey(a)); return n || { x: cx, y: cy }; }

    function getTip(){
      let tip = d3.select('#bubble-tip');
      if (tip.empty()){
        tip = d3.select('body').append('div').attr('id','bubble-tip')
          .style('position','fixed').style('background','#111').style('color','#fff')
          .style('padding','8px 10px').style('border','1px solid #333').style('border-radius','8px')
          .style('pointer-events','none').style('opacity',0).style('z-index',9999)
          .style('font-family','ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial');
      }
      return tip;
    }
    function fmtNum(n, d=4){
      if (!isFinite(n)) return '0';
      const abs = Math.abs(n);
      if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
      if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (abs >= 1e3) return (n / 1e3).toFixed(2) + 'k';
      return Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
    }
  }

  // ======== Container B rendering (unchanged) ========
  function renderStatusGrid(list25){
    const grid=bStatusGrid(); grid.innerHTML='';
    list25.slice(0,25).forEach(r=>{
      const el=document.createElement('div'); el.className='s-pill '+r.sClass; el.textContent=r.status; grid.appendChild(el);
    });
  }
  function rowBuyers(i,r){
    const ab = `${EXPLORER}/address/${r.address}`;
    return `<tr data-addr="${r.address}" data-ts="${r.timeStamp||0}">
      <td class="mono">#${i+1}</td>
      <td class="addr"><a href="${ab}" target="_blank" rel="noopener" title="${r.address}">${shortAddrLast3(r.address)}</a></td>
      <td class="mono">${fmtNum(r.firstInAmount)}</td>
      <td class="mono">${fmtNum(r.totalIn)}</td>
      <td class="mono">${fmtNum(r.totalOut)}</td>
      <td class="mono">${fmtNum(r.holdings)}</td>
      <td><span class="s-tag ${r.sClass}">${r.status}</span></td>
    </tr>`;
  }
  function rowHolder(i,r){
    const ab = `${EXPLORER}/address/${r.address}`;
    return `<tr>
      <td class="mono">#${i+1}</td>
      <td class="addr"><a href="${ab}" target="_blank" rel="noopener">${shortAddr(r.address)}</a></td>
      <td class="mono">${fmtNum(r.firstIn)}</td>
      <td class="mono">${fmtNum(r.holdings)}</td>
      <td class="mono">${(r.pct||0).toFixed(4)}%</td>
    </tr>`;
  }
  function wireBuyerRowClicks(){
    const wire = (tbody) => {
      if (!tbody) return;
      tbody.querySelectorAll('tr').forEach(tr=>{
        tr.addEventListener('click', ()=> openFundersForRow(tr));
        const a = tr.querySelector('a'); if (a) a.addEventListener('click', (e)=> e.stopPropagation());
      });
    };
    wire(buyersTop5()); wire(buyersRest());
  }

  async function openFundersForRow(tr){
    const addr = tr.getAttribute('data-addr'); const ts = Number(tr.getAttribute('data-ts')||0);
    if (!addr) return;
    showOverlay(fundersOverlay());
    fundersInner().innerHTML = `<div class="banner mono"><span class="spinner"></span> Finding funding wallets (ETH + WETH)…</div>`;
    setScanStatus('Finding funding wallets (ETH + WETH)…');
    try{
      const { addrs, info } = await getFundingWallets(addr, ts);
      if (!addrs.length){ fundersInner().innerHTML = `<div class="banner mono">No inbound ETH/WETH before first token receipt.</div>`; return; }
      const uniq = Array.from(new Set(addrs));
      const scored=[];
      for (const a of uniq){
        const [ethBal, port] = await Promise.all([ apiBalance(a).catch(()=>0), tokenPortfolioUsd(a).catch(()=>({ totalUsd:0 })) ]);
        if ((port.totalUsd||0) > IGNORE_FUNDER_OVER_USD) continue;
        scored.push({ address:a, eth:ethBal, tokenUsd:port.totalUsd||0, meta: info.get(a)||{ethCount:0,ethAmount:0,wethCount:0,wethAmount:0} });
        await sleep(60);
      }
      scored.sort((A,B)=> (B.tokenUsd-A.tokenUsd) || (B.eth-A.eth));
      const top = scored.slice(0, TOP_FUNDER_LIMIT);
      fundersInner().innerHTML = `
        <div class="mono" style="margin-bottom:8px">
          <b>DISCLAIMER:</b> always check the chain yourself to be 100% sure results are right.
          Top ${TOP_FUNDER_LIMIT} funders by balance. Ignored funders with &gt; $1.000.000 portfolios.
        </div>
        ${top.map(r=>{
          const portal=\`https://portal.abs.xyz/profile/\${r.address}\`; const abscan=\`${EXPLORER}/address/\${r.address}\`;
          return \`<div class="f-card" style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px;margin:8px 0;background:rgba(255,255,255,.03)">
            <div>
              <div class="addr mono" style="font-weight:700">\${r.address}</div>
              <div class="chips" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
                <span class="chip" style="border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:4px 8px">ETH in: <span class="mono">\${fmtNum(r.meta.ethAmount,6)} (\${r.meta.ethCount})</span></span>
                <span class="chip" style="border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:4px 8px">WETH in: <span class="mono">\${fmtNum(r.meta.wethAmount,6)} (\${r.meta.wethCount})</span></span>
                <span class="chip" style="border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:4px 8px">Tokens $: <span class="mono">\${fmtNum(r.tokenUsd,2)}</span></span>
                <span class="chip" style="border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:4px 8px">ETH bal: <span class="mono">\${fmtNum(r.eth,6)}</span></span>
              </div>
            </div>
            <div class="links" style="display:flex;gap:8px;flex-shrink:0">
              <button class="btn mono" onclick="window.open('\${portal}','_blank')">Portal</button>
              <a class="btn mono" href="\${abscan}" target="_blank" rel="noopener">Explorer</a>
            </div>
          </div>\`;
        }).join('')}
        <div style="margin-top:10px; display:none">
          <button id="findCommonBtn" class="btn mono">Find common funders among these</button>
        </div>
      `;
      const btn = document.getElementById('findCommonBtn');
      if (btn) btn.onclick = () => findCommonFunders(top.map(x=>x.address));
    }catch(e){
      fundersInner().innerHTML = `<div class="banner mono">Error: ${e.message||e}</div>`;
    }finally{ setScanStatus('Done. Click a wallet row to view funders.'); }
  }

  async function findCommonFunders(addrs){
    showOverlay(commonOverlay());
    commonInner().innerHTML = `<div class="banner mono"><span class="spinner"></span> Scanning for shared funders…</div>`;
    const counts = new Map();
    try{
      for (const fa of addrs){
        const { addrs } = await getFundingWallets(fa, null).catch(()=>({ addrs:[] }));
        const uniq = Array.from(new Set(addrs));
        for (const f of uniq){ const rec=counts.get(f)||{count:0,who:new Set()}; rec.count+=1; rec.who.add(fa); counts.set(f,rec); }
        await sleep(80);
      }
      let shared = Array.from(counts.entries()).map(([address,rec])=>({ address, count:rec.count, who:Array.from(rec.who) }));
      for (const s of shared){ const port=await tokenPortfolioUsd(s.address).catch(()=>({ totalUsd:0 })); s.tokenUsd=port.totalUsd||0; await sleep(50); }
      shared.sort((a,b)=> (b.tokenUsd-a.tokenUsd) || (b.count-a.count));
      shared = shared.slice(0, TOP_COMMON_LIMIT);
      if (!shared.length){ commonInner().innerHTML = `<div class="banner mono">No common funders found.</div>`; return; }
      commonInner().innerHTML = shared.map(s=>{
        const portal=`https://portal.abs.xyz/profile/${s.address}`; const abscan=`${EXPLORER}/address/${s.address}`;
        return `<div class="f-card" style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px;margin:8px 0;background:rgba(255,255,255,.03)">
          <div>
            <div class="addr mono" style="font-weight:700">${s.address}</div>
            <div class="note mono" style="opacity:.85">Token portfolio: $${fmtNum(s.tokenUsd,2)} • Seen in <span class="mono">${s.count}</span> wallets</div>
            <div class="note mono" style="opacity:.85">Wallets funded: ${s.who.map(w=>`<span class="mono">${shortAddr(w)}</span>`).join(', ')}</div>
          </div>
          <div class="links" style="display:flex;gap:8px;flex-shrink:0">
            <button class="btn mono" onclick="window.open('${portal}','_blank')">Portal</button>
            <a class="btn mono" href="${abscan}" target="_blank" rel="noopener">Explorer</a>
          </div>
        </div>`;
      }).join('');
    }catch(e){ commonInner().innerHTML = `<div class="banner mono">Error: ${e.message||e}</div>`; }
  }

  // ======== Render snapshot to UI ========
  function renderFromData(snapshot){
    if (aSnap()) aSnap().textContent = snapshot.ts ? new Date(snapshot.ts).toLocaleString() : '';

    const A = snapshot.a || {};
    aStats().innerHTML = `
      <div class="statrow mono"><b>Minted</b><span>${fmtNum(A.minted,6)}</span></div>
      <div class="statrow mono"><b>Burned</b><span>${fmtNum(A.burned,6)}</span></div>
      <div class="statrow mono"><b>Current Supply</b><span>${fmtNum(A.currentSupply,6)}</span></div>
      <div class="statrow mono"><b>Total Holders (approx)</b><span>${fmtNum(A.totalHolders,0)}</span></div>
      <div class="statrow mono"><b>Top 10 holders</b><span>${(A.top10Pct||0).toFixed(4)}%</span></div>
      <div class="statrow mono"><b>Creator</b><span>${A.creatorAddress ? `<a href="${EXPLORER}/address/${A.creatorAddress}" target="_blank" rel="noopener">${shortAddr(A.creatorAddress)}</a> <span class="muted">(${(A.creatorPct||0).toFixed(4)}%)</span>` : 'n/a'}</span></div>
    `;

    // Build & render bubble graph
    const graph = buildGraphFromScan(A, (snapshot.b || {}));
    renderBubbleGraph(aBubble(), graph);

    aBubbleNote().innerHTML = A.burned>0 ? `<span class="mono">🔥 Burn — ${fmtNum(A.burned,6)} tokens</span>` : '';

    // Container B (unchanged)
    const B = snapshot.b || {};
    const buyers = (B.first25||[]);
    const holders = (B.top25||[]);
    renderStatusGrid(buyers);

    const five = buyers.slice(0,5), rest = buyers.slice(5,25);
    buyersTop5().innerHTML = five.map((r,i)=>rowBuyers(i,r)).join('');
    buyersRest().innerHTML = rest.map((r,i)=>rowBuyers(i+5,r)).join('');
    buyersExpander().style.display = rest.length ? '' : 'none';
    if (buyersToggle()){
      buyersToggle().onclick = ()=>{
        buyersExpander().classList.toggle('open');
        buyersToggle().textContent = buyersExpander().classList.contains('open') ? 'Show less (−20)' : 'Show more (+20)';
      };
    }
    wireBuyerRowClicks();

    const hFive = holders.slice(0,5), hRest = holders.slice(5,25);
    holdersTop5().innerHTML = hFive.map((r,i)=>rowHolder(i,r)).join('');
    holdersRest().innerHTML = hRest.map((r,i)=>rowHolder(i+5,r)).join('');
    holdersExpander().style.display = hRest.length ? '' : 'none';
    if (holdersToggle()){
      holdersToggle().onclick = ()=>{
        holdersExpander().classList.toggle('open');
        holdersToggle().textContent = holdersExpander().classList.contains('open') ? 'Show less (−20)' : 'Show more (+20)';
      };
    }

    buyersPanel().style.display=''; holdersPanel().style.display='none';
    firstBtn().classList.add('active'); topBtn().classList.remove('active');
  }

  // ======== Orchestrators ========
  async function showWithCacheThenMaybeRefresh(ca, forceFresh){
    if (!forceFresh){
      const cached = await loadCachedScan(ca);
      if (cached){
        setScanStatus('Loaded cached snapshot.');
        renderFromData({ ...cached.data, ts: cached.ts });
        return { usedCache:true };
      }
    }
    const fresh = await doFreshScan(ca);
    const tsSave = await saveScan(ca, fresh);
    renderFromData({ ...fresh, ts: tsSave?.ts || Date.now() });
    setScanStatus('Overview ready. Click any wallet row to view funders.');
    return { usedCache:false };
  }

  // 5-min holders poll (special token)
  async function computeApproxHolders(contract){
    try{
      const txs = await fetchAllTokenTx(contract);
      const ZERO='0x0000000000000000000000000000000000000000';
      const DEAD='0x000000000000000000000000000000000000dead';
      const balances={};
      for (const t of txs){
        const from=(t.from||'').toLowerCase(); const to=(t.to||'').toLowerCase(); const v=toBI(t.value||'0');
        if (from===ZERO) continue; if (to===DEAD) continue;
        if (from) balances[from]=(balances[from]||0n)-v;
        if (to)   balances[to]=(balances[to]||0n)+v;
      }
      const count = Object.values(balances).filter(v=>v>0n).length;
      if (holdersTile()) holdersTile().textContent = Intl.NumberFormat('en-US').format(count);
    }catch{}
  }
  function startHoldersPoll(){
    computeApproxHolders(SPECIAL_HOLDERS_CA);
    setInterval(()=>computeApproxHolders(SPECIAL_HOLDERS_CA), 5*60*1000);
  }

  // ======== Internals ========
  async function fetchAllTokenTx(contract){
    const all=[]; const offset=10000; let page=1;
    while(true){
      const url = `${BASE_URL}?chainid=${CHAIN_ID}&module=account&action=tokentx&contractaddress=${contract}&page=${page}&offset=${offset}&sort=asc&apikey=${ETHERSCAN_API}`;
      const r = await fetch(url); const j = await r.json(); const arr = Array.isArray(j?.result)? j.result: [];
      if (!arr.length) break; all.push(...arr); if (arr.length<offset) break; page++; if (page>200) break; await sleep(MIN_INTERVAL_MS);
    }
    if (!all.length){
      const url = `${BASE_URL}?chainid=${CHAIN_ID}&module=account&action=tokentx&contractaddress=${contract}&startblock=0&endblock=99999999&sort=asc&apikey=${ETHERSCAN_API}`;
      const r = await fetch(url); const j = await r.json(); const arr = Array.isArray(j?.result)? j.result: []; all.push(...arr);
    }
    return all;
  }
  function chooseDecimals(txs){
    const freq=new Map(); for (const t of txs){ const d=parseInt(String(t.tokenDecimal||''),10); if (Number.isFinite(d)&&d>=0&&d<=18) freq.set(d,(freq.get(d)||0)+1); }
    if (!freq.size) return 18;
    let best=18, cnt=-1; for (const [d,c] of freq.entries()){ if (c>cnt || (c===cnt && d>best)){ best=d; cnt=c; } } return best;
  }

  // ======== Public API ========
  TABS.startScan = async function(ca, { force=false } = {}){
    if (!isCA(ca)){ setScanStatus('Enter a valid token contract.'); return; }
    aSnap().textContent=''; aStats().innerHTML=''; aBubble().innerHTML=''; aBubbleNote().textContent='';
    buyersTop5().innerHTML=''; buyersRest().innerHTML=''; holdersTop5().innerHTML=''; holdersRest().innerHTML='';
    bStatusGrid().innerHTML='';
    aBubble().innerHTML = `<div class="banner mono"><span class="spinner"></span> <span id="bubbleStatusText">${scanStatusEl()?.textContent||'Scanning…'}</span></div>`;
    aStats().innerHTML = `<div class="banner mono"><span class="spinner"></span> <span>Preparing…</span></div>`;
    setScanStatus(force ? 'Reloading fresh snapshot…' : 'Starting scan…');
    try{
      await showWithCacheThenMaybeRefresh(ca.toLowerCase(), force);
    }catch(e){
      setScanStatus(e.message||String(e));
      aBubble().innerHTML = `<div class="banner mono">Error: ${e.message||e}</div>`;
      aStats().innerHTML  = `<div class="banner mono">Error loading stats.</div>`;
    }
  };

  TABS.reset = function(){
    setScanStatus('');
    aSnap().textContent=''; aStats().innerHTML='<div class="muted mono">Waiting for a token…</div>';
    aBubble().innerHTML=''; aBubbleNote().textContent='';
    buyersTop5().innerHTML=''; buyersRest().innerHTML=''; holdersTop5().innerHTML=''; holdersRest().innerHTML='';
    bStatusGrid().innerHTML='';
  };

  function wireTabButtons(){
    if (!firstBtn() || !topBtn()) return;
    firstBtn().onclick = ()=>{ firstBtn().classList.add('active'); topBtn().classList.remove('active'); buyersPanel().style.display=''; holdersPanel().style.display='none'; };
    topBtn().onclick   = ()=>{ topBtn().classList.add('active'); firstBtn().classList.remove('active'); buyersPanel().style.display='none'; holdersPanel().style.display=''; };
  }
  function showOverlay(el){ if (el) el.style.display='flex'; }
  function hideOverlay(el){ if (el) el.style.display='none'; }
  function wireOverlays(){
    const x1=$('#closeFunders'); if (x1) x1.onclick=()=>hideOverlay(fundersOverlay());
    const x2=$('#closeCommon'); if (x2) x2.onclick=()=>hideOverlay(commonOverlay());
    if (fundersOverlay()) fundersOverlay().addEventListener('click',(e)=>{ if (e.target===fundersOverlay()) hideOverlay(fundersOverlay()); });
    if (commonOverlay())  commonOverlay().addEventListener('click',(e)=>{ if (e.target===commonOverlay()) hideOverlay(commonOverlay()); });
  }

  TABS.init = function(){
    wireTabButtons();
    wireOverlays();
    startHoldersPoll();
  };

  // Expose
  global.TABS_EXT = TABS;
})(window);
