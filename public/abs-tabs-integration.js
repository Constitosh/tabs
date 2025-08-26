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
    '0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f',
    '0x20BF96Ad879bA4D6904595ed05BC8d0Ce226B99a',
    '0xcca5047E4C9f9D72F11C199B4ff1960f88A4748d' // Telegram bot (provided)
  ]);
  const FUNDING_WINDOW_SECS = 720 * 60;  // 120 minutes

   // ---- Proxy / connections tuning ----
const PROXY_MIN_DISTINCT_RECIPIENTS = 3;   // fan-out recipients to call a sender a bot/router
const PROXY_OUTFLOW_SHARE_NUM       = 90n; // >=90% outflow
const PROXY_OUTFLOW_SHARE_DEN       = 100n;
const CROSS_TX_WINDOW_SEC           = 600; // 10 min window to detect burst fan-out
const CROSS_TX_MAX_DEPTH            = 6;   // (kept for future multi-hop; current heuristics use depth 1)


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

async function doFreshScan(contract){
  const VERIFY_TOP_LIMIT = 0; // keep fast. Set to 50 if you want on-chain verification for top 50.
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

  // ===== Scan transfers once; compute balances + first inbound sender per holder
  const ZERO='0x0000000000000000000000000000000000000000';
  const DEAD='0x000000000000000000000000000000000000dead';
  const burnSet = new Set([ZERO,DEAD]);

  const balances = {};
  let mintedUnits=0n, burnedUnits=0n;

  const firstInMap = new Map(); // holder -> { ts, v, from }
  const outTxBySender = new Map(); // sender -> [{to,ts,v}]
  const inAmtBySender  = new Map(); // sender -> bigint (inbound value)
  const outAmtBySender = new Map(); // sender -> bigint (outbound value)

  for (const t of txs){
    const from=(t.from||t.fromAddress||'').toLowerCase();
    const to  =(t.to||t.toAddress||'').toLowerCase();
    const vBI = toBI(t.value||'0');
    const ts  = Number(t.timeStamp)||0;

    if (from===ZERO) mintedUnits += vBI;
    if (burnSet.has(to)) burnedUnits += vBI;

    if (from===contract || to===contract) continue;

    if (!burnSet.has(from)) balances[from] = (balances[from]||0n) - vBI;
    if (!burnSet.has(to))   balances[to]   = (balances[to]  ||0n) + vBI;

    // first inbound per receiver
    if (!firstInMap.has(to) && !burnSet.has(to)) firstInMap.set(to, { ts, v:vBI, from });

    // per-sender flow stats for proxy detection
    if (!burnSet.has(from)){
      const arr = outTxBySender.get(from) || [];
      arr.push({ to, ts, v:vBI });
      outTxBySender.set(from, arr);
      outAmtBySender.set(from, (outAmtBySender.get(from)||0n) + vBI);
    }
    if (!burnSet.has(to)){
      inAmtBySender.set(to, (inAmtBySender.get(to)||0n) + vBI);
    }
  }

  const currentSupplyUnits = mintedUnits>=burnedUnits ? (mintedUnits-burnedUnits) : 0n;
  const currentSupply = Number(currentSupplyUnits)/(10**tokenDecimals);

  // ===== LPs & allocation from tokens/v1/abstract (liquidity.base)
  setScanStatus('Fetching LP pairs & allocation…');
  const pairAddresses = await getPairAddresses(contract);
  const pairSet = new Set(pairAddresses);
  const lpAlloc  = await getLPBaseAllocation(contract);

  // ===== Holders (exclude ZERO/DEAD/LP); (verify optional); compute pct; filter >=0.001%
  setScanStatus('Building holders set…');
  let holdersAll = Object.entries(balances)
    .filter(([addr,bal])=> bal>0n && !burnSet.has(addr) && !pairSet.has(addr))
    .map(([address,units])=>({ address, units }));
  holdersAll.sort((a,b)=> (b.units>a.units)?1:(b.units<a.units)?-1:0);

  if (VERIFY_TOP_LIMIT > 0){
    setScanStatus('Verifying top balances…');
    const toVerify = holdersAll.slice(0,VERIFY_TOP_LIMIT).map(h=>h.address);
    const verified={};
    for (let i=0;i<toVerify.length;i++){
      verified[toVerify[i]] = await tokenBalanceOf(contract,toVerify[i]).catch(()=>null);
      await sleep(60);
    }
    const vset=new Set(toVerify), corrected=[];
    for (const h of holdersAll){
      if (vset.has(h.address)){
        const v=verified[h.address];
        if (v===null) corrected.push(h);
        else if (v===0n) continue;
        else corrected.push({ address:h.address, units:v });
      } else corrected.push(h);
    }
    holdersAll = corrected.sort((a,b)=> (b.units>a.units)?1:(b.units<a.units)?-1:0);
  }

  // ===== Proxy detection (fast, from the same tx list)
  // Heuristic 1: fan-out window — distinct recipients within 10m window >= PROXY_MIN_DISTINCT_RECIPIENTS
  function isFanoutRouter(sender){
    const arr = (outTxBySender.get(sender)||[]).slice().sort((a,b)=>a.ts-b.ts);
    let i=0, best=0;
    while(i<arr.length){
      const start = arr[i].ts, seen = new Set([arr[i].to]);
      let j=i+1;
      while(j<arr.length && (arr[j].ts - start) <= CROSS_TX_WINDOW_SEC){ seen.add(arr[j].to); j++; }
      best = Math.max(best, seen.size);
      i++;
      if (best >= PROXY_MIN_DISTINCT_RECIPIENTS) return true;
    }
    return best >= PROXY_MIN_DISTINCT_RECIPIENTS;
  }
  // Heuristic 2: outflow share >= 90% of flow
  function hasHighOutflow(sender){
    const out = outAmtBySender.get(sender)||0n;
    const inn = inAmtBySender.get(sender)||0n;
    const tot = out + inn;
    if (tot===0n) return false;
    return (out * PROXY_OUTFLOW_SHARE_DEN) >= (PROXY_OUTFLOW_SHARE_NUM * tot);
  }

  // Build proxy set from heuristics + known list
  const proxySet = new Set([...KNOWN_PROXIES].map(a=>String(a).toLowerCase()));
  for (const sender of outTxBySender.keys()){
    if (isFanoutRouter(sender) || hasHighOutflow(sender)) proxySet.add(sender);
  }

  // Map holder -> firstSender
  const holderFirstSender = new Map();
  for (const h of holdersAll){
    const rec = firstInMap.get(h.address);
    if (rec && rec.from) holderFirstSender.set(h.address.toLowerCase(), String(rec.from).toLowerCase());
  }

  // Connected groups:
  //  - viaProxy: sender ∈ proxySet
  //  - sharedFunder: sender funded >=2 holders but NOT a proxy
  const bySenderRecipients = new Map();
  for (const [holder, sender] of holderFirstSender.entries()){
    const m = bySenderRecipients.get(sender) || new Set();
    m.add(holder);
    bySenderRecipients.set(sender, m);
  }
  const sharedFunderSet = new Set();
  for (const [sender, set] of bySenderRecipients.entries()){
    if (proxySet.has(sender)) continue;
    if (set.size >= 2) sharedFunderSet.add(sender);
  }

  // Build holder list for bubbles (drop proxies themselves as holders)
  const holdersForBubblesRaw = holdersAll
    .filter(h => !proxySet.has(String(h.address).toLowerCase())) // exclude proxy addresses from bubble map
    .map(h => {
      const pct = currentSupplyUnits>0n ? pctUnits(h.units, currentSupplyUnits) : 0;
      return { address:h.address, units:h.units, balance:Number(h.units)/(10**tokenDecimals), pct };
    })
    .filter(h => (h.pct||0) >= 0.001)
    .slice(0, 500);

  // LP nodes from Dexscreener 'liquidity.base' (fallback to on-chain)
  const lpNodes=[];
  for (const pa of pairAddresses){
    let base = lpAlloc.perPair.get(pa) || 0;
    if (!(base>0)){
      const units = await tokenBalanceOf(contract, pa).catch(()=>0n);
      base = Number(units)/(10**tokenDecimals);
    }
    const lpPct = currentSupply>0 ? (base/currentSupply)*100 : 0;
    if (lpPct>0) lpNodes.push({ address:pa, balance:base, pct:lpPct, __type:'lp' });
    await sleep(25);
  }

  const top10Pct  = holdersForBubblesRaw.slice(0,10).reduce((s,h)=>s+(h.pct||0),0);
  const creatorPct= creatorAddress ? (holdersForBubblesRaw.find(h=>h.address.toLowerCase()===creatorAddress)?.pct || 0) : 0;

  // Maps for UI tagging
  const proxyMap = {};       // holder -> proxyId
  const connectedMap = {};   // holder -> sharedFunderId
  for (const h of holdersForBubblesRaw){
    const hl = h.address.toLowerCase();
    const s  = holderFirstSender.get(hl);
    if (!s) continue;
    if (proxySet.has(s))      proxyMap[hl] = s;
    else if (sharedFunderSet.has(s)) connectedMap[hl] = s;
  }

  // A (stats)
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
    holdersForBubbles: holdersForBubblesRaw.map(h => ({ address:h.address, balance:h.balance, pct:h.pct })),
    lpNodes,
    proxyMap,
    connectedMap
  };

  // ===== B (first 25 + top 25) — exclude proxy addresses from both views =====
  setScanStatus('Preparing tables…');

  // Build “early receivers” from our single-pass firstInMap (faster & accurate)
  // Only keep addresses that currently hold (>0), are NOT proxies/LP/burn.
  const holderSetNow = new Set(holdersAll.map(h => h.address.toLowerCase()));
  const earlyReceiversRaw = [];
  for (const [addr, rec] of firstInMap.entries()){
    const a = String(addr).toLowerCase();
    if (!holderSetNow.has(a)) continue;               // only real current holders
    if (proxySet.has(a)) continue;                    // exclude any proxy address itself
    if (pairSet.has(a)) continue;                     // exclude LP
    if (a === ZERO || a === DEAD || a === contract) continue;
    earlyReceiversRaw.push({
      address: addr,
      timeStamp: Number(rec.ts)||0,
      firstInAmount: Number(rec.v)/(10**tokenDecimals)
    });
  }
  // Oldest first, then take 25
  earlyReceiversRaw.sort((a,b)=> (a.timeStamp - b.timeStamp));
  const early25 = earlyReceiversRaw.slice(0,25);

  // Enrich the 25 for the status grid (re-using existing helper)
  const enriched = [];
  setScanStatus('Computing totals & statuses per wallet…');
  for (const r of early25){
    const st = await enrichReceiverStats(contract, r).catch(()=>null);
    if (st) enriched.push(st);
    await sleep(30);
  }

  // Top 25 holders (exclude proxy addresses)
  const top25 = holdersAll
    .filter(h => !proxySet.has(String(h.address).toLowerCase()))
    .slice(0,25)
    .map((h,i)=>{
      const first = firstInMap.get(h.address) || { ts:0, v:0n };
      return {
        rank: i+1,
        address: h.address,
        firstIn: Number(first.v)/(10**tokenDecimals),
        holdings: Number(h.units)/(10**tokenDecimals),
        pct: currentSupplyUnits>0n ? pctUnits(h.units, currentSupplyUnits) : 0
      };
    });

  result.b = { first25: enriched, top25 };
  return result;
}



function buildGraphFromScan(A, B){
  const holderNodes = (A.holdersForBubbles || []).map(h => ({
    address: h.address,
    balance: Number(h.balance || 0),
    pct: Number(h.pct || 0),
    tags: [],
    label: null,
    proxyId: null,       // for via-proxy groups
    connectId: null,     // for shared-funder groups
    peakTokens: Number(h.balance || 0),
    leftTokens: Number(h.balance || 0),
    leftPct: 100
  }));

  const byAddr = new Map(holderNodes.map(n => [String(n.address).toLowerCase(), n]));

  // LP nodes
  for (const lp of (A.lpNodes || [])){
    const key = String(lp.address||'').toLowerCase();
    if (!byAddr.has(key)){
      byAddr.set(key, { address:key, balance:Number(lp.balance||0), pct:Number(lp.pct||0), tags:['lp'], label:'LP', peakTokens:Number(lp.balance||0), leftTokens:Number(lp.balance||0), leftPct:100 });
    }else{
      const n = byAddr.get(key);
      if (!n.tags.includes('lp')) n.tags.push('lp');
      if (!n.label) n.label = 'LP';
      n.pct = Number(lp.pct || n.pct || 0);
      n.balance = Number(lp.balance || n.balance || 0);
    }
  }

  // Creator
  if (A.creatorAddress){
    const key = String(A.creatorAddress).toLowerCase();
    const n = byAddr.get(key);
    if (n){ if (!n.tags.includes('creator')) n.tags.push('creator'); if (!n.label) n.label = 'CREATOR'; }
  }

  // Tag via-proxy vs shared-funder
  for (const [holderLower, proxyLower] of Object.entries(A.proxyMap || {})){
    const n = byAddr.get(holderLower); if (!n) continue;
    n.proxyId = String(proxyLower);
    if (!n.tags.includes('via-proxy')) n.tags.push('via-proxy');
  }
  for (const [holderLower, funderLower] of Object.entries(A.connectedMap || {})){
    const n = byAddr.get(holderLower); if (!n) continue;
    n.connectId = String(funderLower);
    if (!n.tags.includes('connected')) n.tags.push('connected');
  }

  // Peak/Left from B tables (when available)
  const first25By = new Map((B.first25||[]).map(r => [String(r.address).toLowerCase(), r]));
  const top25By   = new Map((B.top25||[]).map(r => [String(r.address).toLowerCase(), r]));
  for (const [k,n] of byAddr.entries()){
    const r = first25By.get(k) || top25By.get(k);
    if (r){
      const totIn = Number(r.totalIn || r.firstIn || 0);
      const cur   = Number(r.holdings || n.balance || 0);
      const peak  = Math.max(totIn, cur);
      n.peakTokens = peak;
      n.leftTokens = cur;
      n.leftPct    = peak>0 ? (cur/peak)*100 : 0;
    }
  }

  return { explorer: EXPLORER, nodes: Array.from(byAddr.values()) };
}


// Toggle if you ever want LP bubbles back on the right column
const SHOW_LP = false;

function renderBubbleGraph(rootEl, graph){
  const EX = graph.explorer || 'https://abscan.org';
  const allNodes = (graph.nodes || []);

  // holders only in this map
  const holders = allNodes.filter(n => !(n.tags||[]).includes('lp'));

  rootEl.innerHTML = '';
  const width  = rootEl.clientWidth || 960;
  const height = Math.max(560, Math.round(width * 0.48));

  const svg   = d3.select(rootEl).append('svg')
    .attr('width', width)
    .attr('height', height)
    .style('cursor','grab');
  const rootG = svg.append('g');

  // Colors & strokes
  const FILL_HOLDER  = '#375a4e';
  const STROKE_DEF   = 'rgba(0,0,0,.35)';
  const STROKE_CONN  = '#00d1b2'; // shared funder (non-proxy)

  // Per-proxy color palette
  const proxyIds = Array.from(new Set(holders.filter(n=>n.proxyId).map(n=>n.proxyId)));
  const proxyColor = d3.scaleOrdinal()
    .domain(proxyIds)
    .range([
      '#f59e0b', '#60a5fa', '#ef4444', '#10b981', '#a78bfa',
      '#f472b6', '#22d3ee', '#f43f5e', '#34d399', '#eab308',
      '#38bdf8', '#fb7185', '#84cc16', '#c084fc'
    ]);

  // Radius by % of supply (sqrt)
  const maxPct = Math.max(0.0001, ...holders.map(n => +n.pct || 0));
  const rScale = d3.scaleSqrt().domain([0, maxPct]).range([8, 56]);
  holders.forEach(n => n.r = rScale(+n.pct || 0));

  // 1) Pack to produce reasonable seeds (bigger tend toward center)
  const pack = d3.pack().size([width*0.8, height*0.9]).padding(8);
  const pRoot = d3.hierarchy({ children: holders }).sum(d => (d && d.r ? d.r * d.r : 1));
  const leaves = pack(pRoot).leaves();
  const seed   = new Map(leaves.map(l => [String(l.data.address).toLowerCase(), l]));
  holders.forEach(n => { const s = seed.get(String(n.address).toLowerCase()); n.x = s ? s.x : 0; n.y = s ? s.y : 0; });

  // 2) One-time settle with size-weighted center pull → big in the middle
  const cx = width * 0.4, cy = height * 0.5;
  const maxR = Math.max(...holders.map(n => n.r||0), 1);
  const sizeNorm = d => Math.max(0, Math.min(1, (d.r||1)/maxR));
  const centerStrength = d => 0.03 + 0.32 * Math.pow(sizeNorm(d), 1.25); // small → weak pull, big → strong pull

  const sim = d3.forceSimulation(holders)
    .alpha(1)
    .velocityDecay(0.25)
    .force('collide', d3.forceCollide(d => (d.r||8) + 3).strength(1)) // +3px gap
    .force('x', d3.forceX(cx).strength(d => centerStrength(d)))
    .force('y', d3.forceY(cy).strength(d => centerStrength(d)))
    .stop();
  for (let i=0;i<160;i++) sim.tick(); // settle, then freeze

  // Zoom (manual; no simulation on drag)
  const zoom = d3.zoom().scaleExtent([0.6, 7]).on('zoom', (ev) => rootG.attr('transform', ev.transform));
  svg.call(zoom);

  // Draw nodes
  const nodeSel = rootG.selectAll('g.node').data(holders, d => d.address).join(enter => {
    const g = enter.append('g').attr('class','node')
      .attr('transform', d => `translate(${d.x},${d.y})`)
      .style('cursor','pointer');

    g.append('circle')
      .attr('r', d => Math.max(8, d.r || 8))
      .attr('fill', FILL_HOLDER)
      .attr('fill-opacity', 0.95)
      .attr('stroke', d => d.proxyId ? proxyColor(d.proxyId) : (d.connectId ? STROKE_CONN : STROKE_DEF))
      .attr('stroke-width', d => (d.proxyId || d.connectId) ? 2 : 1.2);

    g.append('text')
      .text(d => `${(+d.pct || 0).toFixed(2)}%`)
      .attr('text-anchor','middle').attr('dy','0.32em')
      .attr('pointer-events','none')
      .attr('fill','rgba(255,255,255,.88)')
      .attr('font-size', d => {
        const maxFs = Math.max(8, (d.r||12) * 0.48); // ≤ ~48% of diameter
        const base  = Math.max(9, Math.min(14, (d.r||14)/3 + 7));
        return Math.min(base, maxFs);
      });

    const tip = getTip();
    g.on('mouseenter', (ev,d)=>{
      if (d.proxyId){
        nodeSel.selectAll('circle').attr('opacity', n => (n.proxyId && n.proxyId===d.proxyId) ? 1 : 0.35);
        nodeSel.selectAll('circle').attr('stroke-width', n => (n.proxyId && n.proxyId===d.proxyId) ? 3.5 : (n.connectId ? 2 : 1.2));
      } else if (d.connectId){
        nodeSel.selectAll('circle').attr('opacity', n => (n.connectId && n.connectId===d.connectId) ? 1 : 0.35);
        nodeSel.selectAll('circle').attr('stroke-width', n => (n.connectId && n.connectId===d.connectId) ? 3.5 : (n.proxyId ? 2 : 1.2));
      }
      tip.html(`
        <div style="font-weight:700;margin-bottom:4px">${(+d.pct||0).toFixed(2)}% of supply</div>
        <div><b>Address:</b> ${d.address}</div>
        <div><b>Peak held:</b> ${isFinite(d.peakTokens)? fmtNum(d.peakTokens,6):'—'} tokens</div>
        <div><b>Left:</b> ${isFinite(d.leftTokens)? fmtNum(d.leftTokens,6):'—'} tokens${isFinite(d.leftPct)? ` (${d.leftPct.toFixed(1)}%)` : ''}</div>
        ${d.proxyId  ? `<div class="mono" style="opacity:.85">Proxy group</div>` : ''}
        ${d.connectId? `<div class="mono" style="opacity:.85">Shared funder</div>` : ''}
        <div style="opacity:.85;margin-top:6px">Click to open in ABScan ↗</div>
      `).style('opacity',1);
    }).on('mousemove', (ev)=>{
      getTip().style('left',(ev.clientX+12)+'px').style('top',(ev.clientY+12)+'px');
    }).on('mouseleave', ()=>{
      nodeSel.selectAll('circle').attr('opacity', 1).attr('stroke-width', d => (d.proxyId || d.connectId) ? 2 : 1.2);
      getTip().style('opacity',0);
    });

    g.on('click', (ev,d)=> window.open(`${EX}/address/${d.address}`, '_blank'));
    return g;
  });

  // Fit view once
  fitToView();
  function fitToView(){
    const bbox = rootG.node().getBBox();
    const pad = 24;
    const k = Math.min((width-pad*2)/Math.max(1,bbox.width),(height-pad*2)/Math.max(1,bbox.height));
    const scale = Math.max(0.7, Math.min(3, k));
    const tx = (width  - scale*(bbox.x + bbox.width/2));
    const ty = (height - scale*(bbox.y + bbox.height/2));
    const z = d3.zoom().scaleExtent([0.6,7]).on('zoom', (ev)=> rootG.attr('transform', ev.transform));
    svg.call(z).transition().duration(450).call(z.transform, d3.zoomIdentity.translate(tx,ty).scale(scale));
  }

  // Tiny legend to tell "proxy color vs shared funder"
  const legend = svg.append('g').attr('transform', `translate(${width-170},${14})`);
  legend.append('rect').attr('width',156).attr('height', proxyIds.length ? 46 : 28)
    .attr('fill','rgba(0,0,0,.35)').attr('rx',8);
  legend.append('text').attr('x',10).attr('y',18).attr('fill','#fff').attr('font-size',11).text('Group strokes:');
  if (proxyIds.length){
    legend.append('line').attr('x1',12).attr('y1',28).attr('x2',44).attr('y2',28)
      .attr('stroke', proxyColor(proxyIds[0])).attr('stroke-width',3.5);
    legend.append('text').attr('x',50).attr('y',31).attr('fill','#fff').attr('font-size',11).text('Proxy group');
    legend.append('line').attr('x1',12).attr('y1',40).attr('x2',44).attr('y2',40)
      .attr('stroke', STROKE_CONN).attr('stroke-width',3.5);
    legend.append('text').attr('x',50).attr('y',43).attr('fill','#fff').attr('font-size',11).text('Shared funder');
  } else {
    legend.append('line').attr('x1',12).attr('y1',28).attr('x2',44).attr('y2',28)
      .attr('stroke', STROKE_CONN).attr('stroke-width',3.5);
    legend.append('text').attr('x',50).attr('y',31).attr('fill','#fff').attr('font-size',11).text('Shared funder');
  }

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
    if (abs >= 1e9) return (n/1e9).toFixed(2)+'B';
    if (abs >= 1e6) return (n/1e6).toFixed(2)+'M';
    if (abs >= 1e3) return (n/1e3).toFixed(2)+'k';
    return Number(n).toLocaleString(undefined,{ maximumFractionDigits:d });
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
    const portal = `https://portal.abs.xyz/profile/${r.address}`;
    const abscan = `${EXPLORER}/address/${r.address}`;
    return `
      <div class="f-card" style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px;margin:8px 0;background:rgba(255,255,255,.03)">
        <div>
          <div class="addr mono" style="font-weight:700">${r.address}</div>
          <div class="chips" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
            <span class="chip" style="border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:4px 8px">ETH in: <span class="mono">${fmtNum(r.meta.ethAmount,6)} (${r.meta.ethCount})</span></span>
            <span class="chip" style="border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:4px 8px">WETH in: <span class="mono">${fmtNum(r.meta.wethAmount,6)} (${r.meta.wethCount})</span></span>
            <span class="chip" style="border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:4px 8px">Tokens $: <span class="mono">${fmtNum(r.tokenUsd,2)}</span></span>
            <span class="chip" style="border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:4px 8px">ETH bal: <span class="mono">${fmtNum(r.eth,6)}</span></span>
          </div>
        </div>
        <div class="links" style="display:flex;gap:8px;flex-shrink:0">
          <button class="btn mono" onclick="window.open('${portal}','_blank')">Portal</button>
          <a class="btn mono" href="${abscan}" target="_blank" rel="noopener">Explorer</a>
        </div>
      </div>
    `;
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
